import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { sql } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import { runLoop, type Clock } from '../../shared/loop.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { checkLoop, loginForJob, refreshWindowMs, type CheckLoopSettings } from './check-loop.ts';
import type { Checks } from './checks.ts';
import { codexLogin } from '../../shared/codex-login.ts';
import { read, refreshable, type Check, type Checked } from './kinds.ts';
import { open, replace, sealFor, writeBack, type WriteBack } from './store.ts';
import { simulatorSchema, violations, type PropertyName, type Violation } from './invariants.ts';
import { fakeGithubToken, fakeLogin, newKey } from './world.ts';

export const mutantName = z.enum(['one_live_check_per_credential', 'one_refresh_per_login', 'blind-write-back', 'raw-job-copy']);

export type MutantName = z.infer<typeof mutantName>;

type Mutant = { readonly breaks: readonly [PropertyName, ...PropertyName[]]; readonly dropIndex?: string };

export const mutants: Readonly<Record<MutantName, Mutant>> = {
  one_live_check_per_credential: { breaks: ['OneLiveCheck'], dropIndex: 'one_live_check_per_credential' },
  one_refresh_per_login: { breaks: ['NoRefreshTokenReused'], dropIndex: 'one_refresh_per_login' },
  'blind-write-back': { breaks: ['StoredLoginIsNewest'] },
  'raw-job-copy': { breaks: ['JobsNeverRefresh'] },
};

export const noMutantYet: Readonly<Record<string, readonly string[]>> = {
  'the engine writes a finished check only with its outcome in one statement, so no move reaches a mismatch; the TypeOK plant proves the predicate': ['finished_check_has_outcome'],
  'no move deletes a credential, so the cascade from a credential to its checks is never exercised': ['check_of_credential'],
};

export type Plan = { readonly seeds: readonly number[]; readonly steps: number; readonly checkers: number; readonly mutant?: MutantName };

export type Failure = { readonly step: number; readonly move: string; readonly broken: readonly Violation[] };

export type Run = {
  readonly seed: number;
  readonly plan: Plan;
  readonly failure: Failure | undefined;
  readonly refreshed: number;
  readonly interrupted: number;
  readonly crashes: number;
  readonly jobs: number;
  readonly log: readonly string[];
};

const startedAt = Date.parse('2026-01-01T00:00:00.000Z');
const loginLifeMs = 30 * 60_000;
const everyMs = 60_000;
const leaseMs = 5 * 60_000;
const moves = ['advance', 'release', 'crash', 'replace', 'job'] as const;
type Move = (typeof moves)[number];
const weights: Readonly<Record<Move, number>> = { advance: 40, release: 45, crash: 4, replace: 5, job: 6 };

export const fingerprint = createHash('sha256').update(JSON.stringify({ moves, weights, loginLifeMs, everyMs, leaseMs, refreshWindowMs })).digest('hex').slice(0, 16);

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Token = { readonly family: number; readonly generation: number; used: boolean };

type Issuer = {
  readonly login: (family: number, now: number) => string;
  readonly present: (token: string, by: string, now: number) => Promise<string | undefined>;
};

function issuer(db: Database): Issuer {
  const tokens = new Map<string, Token>();
  const mint = (family: number, generation: number, now: number): string => {
    const token = `rt-${String(family)}-${String(generation)}`;
    tokens.set(token, { family, generation, used: false });
    return fakeLogin(new Date(now + loginLifeMs), token).text;
  };
  return {
    login: (family, now) => mint(family, 0, now),
    present: async (token, by, now) => {
      await sql`insert into sim_refresh (token, by_actor) values (${token}, ${by})`.execute(db);
      const found = tokens.get(token);
      if (found === undefined || found.used) return undefined;
      found.used = true;
      return mint(found.family, found.generation + 1, now);
    },
  };
}

type Status = 'running' | 'sleeping' | 'gated' | 'crashed' | 'stopped';

type Checker = { readonly id: string; status: Status; release: (() => void) | undefined; readonly stop: AbortController; readonly done: Promise<void> };

type Sleeper = { readonly due: number; readonly wake: () => void; readonly checker: string };

type Sim = {
  readonly db: Database;
  readonly issuer: Issuer;
  readonly checkers: Checker[];
  readonly sleepers: Sleeper[];
  readonly log: string[];
  time: number;
  made: number;
  crashes: number;
  jobs: number;
  families: number;
};

const blindWriteBack: WriteBack = async (db, key, held, login) => {
  const found = read({ connector: 'codex', login, madeForAutoWorker: true });
  if ('refused' in found || found.expiresAt === null) return { written: false, reason: 'refused' };
  const sealed = sealFor(key, held.slot, found.text);
  await db.updateTable('credential').set({ ciphertext: sealed.ciphertext, key_version: sealed.keyVersion, expires_at: found.expiresAt }).where('id', '=', held.credential).execute();
  return { written: true, expiresAt: found.expiresAt };
};

const expiryOf = (login: string): number | undefined => {
  const parsed = codexLogin.safeParse(login);
  return parsed.success ? parsed.data.tokens.access_token.exp * 1000 : undefined;
};

const refreshTokenOf = (login: string): string => {
  const parsed = codexLogin.safeParse(login);
  return parsed.success ? parsed.data.tokens.refresh_token : '';
};

function gated(checker: () => Checker | undefined, run: (secret: string, now: Date) => Promise<Checked>): Check['run'] {
  return async (secret, now) => {
    const checked = await run(secret, now);
    const held = checker();
    if (held !== undefined) {
      await new Promise<void>(resolve => {
        held.status = 'gated';
        held.release = resolve;
      });
      held.status = 'running';
      held.release = undefined;
    }
    return checked;
  };
}

function fakeChecks(sim: Sim, checker: () => Checker | undefined, by: string): Checks {
  return {
    codex: {
      rotates: refreshable,
      run: gated(checker, async (secret, now) => {
        const expires = expiryOf(secret);
        if (expires === undefined) return { verdict: 'invalid', cause: 'not a Codex login', expiresAt: null };
        const token = refreshTokenOf(secret);
        if (token.trim() !== '' && expires - now.getTime() <= refreshWindowMs) {
          const rotated = await sim.issuer.present(token, by, now.getTime());
          if (rotated === undefined) return { verdict: 'invalid', cause: 'the issuer refused a reused refresh token (401)', expiresAt: new Date(expires) };
          return { verdict: 'valid', cause: 'ack after a refresh', expiresAt: new Date(expiryOf(rotated) ?? expires), rotated };
        }
        return expires > now.getTime() ? { verdict: 'valid', cause: 'ack', expiresAt: new Date(expires) } : { verdict: 'invalid', cause: 'expired (401)', expiresAt: new Date(expires) };
      }),
    },
    github: {
      rotates: () => false,
      run: gated(checker, () => Promise.resolve({ verdict: 'valid', cause: '200 from GET /user', expiresAt: null })),
    },
  };
}

function clockFor(sim: Sim, id: string): Clock {
  return {
    now: () => new Date(sim.time),
    sleep: (ms, stop) =>
      new Promise<void>(resolve => {
        const checker = sim.checkers.find(entry => entry.id === id);
        if (checker !== undefined && checker.status !== 'crashed') checker.status = 'sleeping';
        const wake = (): void => {
          const current = sim.checkers.find(entry => entry.id === id);
          if (current !== undefined && current.status === 'sleeping') current.status = 'running';
          resolve();
        };
        if (stop.aborted) wake();
        else {
          sim.sleepers.push({ due: sim.time + ms, wake, checker: id });
          stop.addEventListener('abort', wake, { once: true });
        }
      }),
  };
}

function settingsFor(sim: Sim, key: CheckLoopSettings['key'], id: string, mutant: MutantName | undefined, checker: () => Checker | undefined): CheckLoopSettings {
  return {
    everyMs,
    leaseMs,
    key,
    checks: fakeChecks(sim, checker, id),
    checker: id,
    now: () => new Date(sim.time),
    writeBack: mutant === 'blind-write-back' ? blindWriteBack : writeBack,
  };
}

function startChecker(sim: Sim, key: CheckLoopSettings['key'], mutant: MutantName | undefined): void {
  sim.made += 1;
  const id = `engine ${String(sim.made)}`;
  const stop = new AbortController();
  const find = (): Checker | undefined => sim.checkers.find(entry => entry.id === id);
  const done = runLoop(checkLoop(settingsFor(sim, key, id, mutant, find)), sim.db, clockFor(sim, id), stop.signal, line => sim.log.push(`${new Date(sim.time).toISOString()} ${id} ${line}`)).then(() => {
    const entry = find();
    if (entry !== undefined) entry.status = 'stopped';
  });
  sim.checkers.push({ id, status: 'running', release: undefined, stop, done });
}

async function settle(sim: Sim): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (sim.checkers.some(checker => checker.status === 'running')) {
    if (performance.now() > deadline) throw new Error(`checkers ${sim.checkers.filter(checker => checker.status === 'running').map(checker => checker.id).join(', ')} never went idle`);
    await wait(1);
  }
}

async function wakeDue(sim: Sim): Promise<void> {
  for (;;) {
    const due = sim.sleepers.filter(sleeper => sleeper.due <= sim.time).sort((a, b) => a.due - b.due || a.checker.localeCompare(b.checker))[0];
    if (due === undefined) return;
    sim.sleepers.splice(sim.sleepers.indexOf(due), 1);
    due.wake();
    await settle(sim);
  }
}

const pick = <T>(next: () => number, from: readonly T[]): T | undefined => from[Math.floor(next() * from.length)];

function chooseMove(next: () => number, sim: Sim): Move {
  const open = moves.filter(move => (move === 'release' || move === 'crash' ? sim.checkers.some(checker => checker.status === 'gated') : true));
  const total = open.reduce((sum, move) => sum + weights[move], 0);
  let roll = next() * total;
  for (const move of open) {
    roll -= weights[move];
    if (roll < 0) return move;
  }
  return 'advance';
}

type People = { readonly ada: string; readonly bo: string };

async function storeLogin(sim: Sim, key: CheckLoopSettings['key'], owner: string, by: string): Promise<void> {
  sim.families += 1;
  const login = sim.issuer.login(sim.families, sim.time);
  const stored = await replace(sim.db, key, { action: randomUUID(), by, at: new Date(sim.time), owner, secret: { connector: 'codex', login, madeForAutoWorker: true } });
  if ('refused' in stored) throw new Error(`storing a Codex login was refused: ${stored.reason}`);
}

async function runJob(sim: Sim, key: CheckLoopSettings['key'], owner: string, mutant: MutantName | undefined): Promise<string> {
  sim.jobs += 1;
  const launcher = settingsFor(sim, key, `launcher ${String(sim.jobs)}`, undefined, () => undefined);
  const copy =
    mutant === 'raw-job-copy'
      ? await open(sim.db, key, { connector: 'codex', owner }).then(opened => ('secret' in opened ? opened.secret : undefined))
      : await loginForJob(sim.db, launcher, owner).then(given => ('login' in given ? given.login : undefined));
  if (copy === undefined) return 'no login to give';
  const token = refreshTokenOf(copy);
  const expires = expiryOf(copy) ?? 0;
  if (token.trim() !== '' && expires - sim.time <= refreshWindowMs) {
    await sim.issuer.present(token, `job ${String(sim.jobs)}`, sim.time);
    return 'refreshed its own copy';
  }
  return token.trim() === '' ? 'ran on an access-only copy' : 'ran on a copy that holds a refresh token';
}

async function applyMove(sim: Sim, move: Move, next: () => number, key: CheckLoopSettings['key'], people: People, mutant: MutantName | undefined): Promise<string> {
  switch (move) {
    case 'advance': {
      const ms = 10_000 + Math.floor(next() * 350_000);
      sim.time += ms;
      await wakeDue(sim);
      return `advanced ${String(ms)} ms`;
    }
    case 'release': {
      const checker = pick(next, sim.checkers.filter(entry => entry.status === 'gated'));
      checker?.release?.();
      await settle(sim);
      return `released ${checker?.id ?? 'nobody'}`;
    }
    case 'crash': {
      const checker = pick(next, sim.checkers.filter(entry => entry.status === 'gated'));
      if (checker === undefined) return 'crashed nobody';
      checker.status = 'crashed';
      sim.crashes += 1;
      startChecker(sim, key, mutant);
      await settle(sim);
      return `crashed ${checker.id} mid-check and started a replacement`;
    }
    case 'replace': {
      const owner = next() < 0.5 ? people.ada : people.bo;
      await storeLogin(sim, key, owner, owner);
      await settle(sim);
      return `person ${owner} stored a fresh login`;
    }
    case 'job': {
      const said = await runJob(sim, key, people.ada, mutant);
      await settle(sim);
      return `a job for person ${people.ada} ${said}`;
    }
  }
}

async function addPerson(db: Database, email: string, name: string): Promise<string> {
  const { id } = await db.insertInto('person').values({ email, name, kind: 'person' }).returning('id').executeTakeFirstOrThrow();
  return id;
}

async function counts(db: Database): Promise<{ readonly refreshed: number; readonly interrupted: number }> {
  const { rows } = await sql<{ refreshed: number; interrupted: number }>`
    select (select count(*)::int from credential_check where refreshes and outcome = 'valid') as refreshed,
           (select count(*)::int from credential_check where cause like 'A check that may have refreshed%') as interrupted`.execute(db);
  return rows[0] ?? { refreshed: 0, interrupted: 0 };
}

async function simulateSeed(postgres: TestPostgres, plan: Plan, seed: number): Promise<Run> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 8);
  const sim: Sim = { db, issuer: issuer(db), checkers: [], sleepers: [], log: [], time: startedAt, made: 0, crashes: 0, jobs: 0, families: 0 };
  const key = newKey(1);
  const next = random(seed);
  let failure: Failure | undefined;
  try {
    for (const statement of simulatorSchema) await statement.execute(db);
    const drop = plan.mutant === undefined ? undefined : mutants[plan.mutant].dropIndex;
    if (drop !== undefined) await sql`drop index ${sql.id(drop)}`.execute(db);
    const people = { ada: await addPerson(db, 'ada@example.com', 'Ada'), bo: await addPerson(db, 'bo@example.com', 'Bo') };
    await storeLogin(sim, key, people.ada, people.ada);
    await storeLogin(sim, key, people.bo, people.bo);
    const github = await replace(db, key, { action: randomUUID(), by: people.ada, at: new Date(sim.time), owner: people.ada, secret: { connector: 'github', token: fakeGithubToken() } });
    if ('refused' in github) throw new Error(`storing a GitHub token was refused: ${github.reason}`);
    for (let index = 0; index < plan.checkers; index += 1) startChecker(sim, key, plan.mutant);
    await settle(sim);
    for (let step = 1; step <= plan.steps && failure === undefined; step += 1) {
      const move = chooseMove(next, sim);
      const said = await applyMove(sim, move, next, key, people, plan.mutant);
      sim.log.push(`${new Date(sim.time).toISOString()} step ${String(step)}: ${said}`);
      const broken = await violations(db);
      if (broken.length > 0) failure = { step, move: said, broken };
    }
    const tally = await counts(db);
    return { seed, plan, failure, ...tally, crashes: sim.crashes, jobs: sim.jobs, log: sim.log };
  } finally {
    for (const checker of sim.checkers) checker.stop.abort();
    await Promise.race([Promise.all(sim.checkers.filter(checker => checker.status !== 'crashed' && checker.status !== 'gated').map(checker => checker.done)), wait(5_000)]);
    await db.destroy();
    await scratch.drop();
  }
}

export async function simulate(postgres: TestPostgres, plans: readonly Plan[], parallel = 8): Promise<readonly Run[]> {
  const jobs = plans.flatMap(plan => plan.seeds.map(seed => ({ plan, seed })));
  const runs: Run[] = [];
  let taken = 0;
  const worker = async (): Promise<void> => {
    while (taken < jobs.length) {
      const job = jobs[taken];
      taken += 1;
      if (job !== undefined) runs.push(await simulateSeed(postgres, job.plan, job.seed));
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, jobs.length) }, worker));
  return runs.sort((a, b) => a.seed - b.seed);
}
