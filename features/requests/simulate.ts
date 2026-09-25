import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { sql } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import { neverStops, runLoop, type Clock, type Loop } from '../../shared/loop.ts';
import { request, requestKinds, type Asked, type RequestKind, type TargetKind } from '../../shared/requests.ts';
import { note } from '../../shared/review.ts';
import { inTransaction, type Transacting } from '../../shared/transaction.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { applyClaimed, claimOldest, coreParts, limitTime, refuseOpen, requests, writeAnswer, type Claim, type Handler, type Handlers, type Parts, type Refuse, type RequestSettings } from './apply.ts';
import { watch, world as worldStatements, type PropertyName, type Violation, type Watch } from './invariants.ts';

export const profileName = z.enum(['default', 'two-engines', 'crashes', 'failures', 'races']);

export type ProfileName = z.infer<typeof profileName>;

export const mutantName = z.enum(['request_takes_next_place', 'one_request_per_position', 'fresh-id', 'claim-any', 'answer-apart', 'unanswered-failure', 'answer_is_final', 'no-engine']);

export type MutantName = z.infer<typeof mutantName>;

type Guard = 'KeyFollowsCommitOrder' | 'RepeatReusesTheRow' | 'ClaimTakesOldestOfTarget' | 'ApplyAndAnswerAreOneStep' | 'FailureIsAnswered' | 'AnswerWrittenOnce' | 'EngineIsFair';

type Change = { readonly drop?: string; readonly schema?: readonly string[]; readonly parts?: Partial<Parts>; readonly freshId?: true; readonly apart?: true; readonly idle?: true };

type Mutant = { readonly guard: Guard; readonly breaks: PropertyName; readonly profile: ProfileName; readonly change: Change };

const claimAny: Claim = tx =>
  tx
    .selectFrom('person_request as request')
    .select(eb => ['request.id', 'request.kind', 'request.person_id as person', eb.fn.coalesce('request.task_id', 'request.routine_id').$castTo<string>().as('target'), 'request.payload'])
    .where('request.answer', 'is', null)
    .orderBy('request.at')
    .orderBy('request.id')
    .limit(1)
    .forUpdate('request')
    .skipLocked()
    .executeTakeFirst();

const leaveOpen: Refuse = () => Promise.reject(new Error('The mutant leaves a failed request open.'));

const blindRefuse: Refuse = async (db, id, reason, now) => {
  const { numUpdatedRows } = await db.updateTable('person_request').set({ answer: 'refused', answered_at: now, reason }).where('id', '=', id).executeTakeFirst();
  return numUpdatedRows === 1n;
};

export const mutants: Readonly<Record<MutantName, Mutant>> = {
  request_takes_next_place: {
    guard: 'KeyFollowsCommitOrder',
    breaks: 'RequestsApplyInOrder',
    profile: 'races',
    change: {
      drop: 'request_takes_next_place',
      schema: [
        'create sequence mutant_place',
        "create function mutant_place() returns trigger language plpgsql as $$ begin new.position := nextval('mutant_place'); return new; end $$",
        'create trigger mutant_takes_a_sequence_place before insert on person_request for each row execute function mutant_place()',
      ],
    },
  },
  one_request_per_position: { guard: 'KeyFollowsCommitOrder', breaks: 'OnePlacePerRequest', profile: 'races', change: { drop: 'one_request_per_position' } },
  'fresh-id': { guard: 'RepeatReusesTheRow', breaks: 'RequestAppliedOnce', profile: 'default', change: { freshId: true } },
  'claim-any': { guard: 'ClaimTakesOldestOfTarget', breaks: 'RequestsApplyInOrder', profile: 'two-engines', change: { parts: { claim: claimAny } } },
  'answer-apart': { guard: 'ApplyAndAnswerAreOneStep', breaks: 'RequestAppliedOnce', profile: 'crashes', change: { apart: true } },
  'unanswered-failure': { guard: 'FailureIsAnswered', breaks: 'EveryRequestAnswered', profile: 'failures', change: { parts: { refuse: leaveOpen } } },
  answer_is_final: { guard: 'AnswerWrittenOnce', breaks: 'AnswerIsFinal', profile: 'failures', change: { drop: 'answer_is_final', parts: { refuse: blindRefuse } } },
  'no-engine': { guard: 'EngineIsFair', breaks: 'EveryRequestAnswered', profile: 'default', change: { idle: true } },
};

type OuterMove = 'send' | 'repeat' | 'mismatch' | 'race' | 'lateRefusal';

type InnerMove = 'none' | 'send' | 'otherEngine' | 'crash';

type Fate = 'record' | 'refuse' | 'throw';

type Profile = {
  readonly engines: 1 | 2;
  readonly stepMs: number;
  readonly outer: Readonly<Record<OuterMove, number>>;
  readonly inner: Readonly<Record<InnerMove, number>>;
  readonly fates: Readonly<Record<Fate, number>>;
};

const passEveryMs = 250;

const timeoutMs = 60_000;

const everything = {
  engines: 2,
  stepMs: 200,
  outer: { send: 3, repeat: 1, mismatch: 0.3, race: 0.3, lateRefusal: 0.3 },
  inner: { none: 4, send: 1, otherEngine: 1, crash: 0.3 },
  fates: { record: 6, refuse: 2, throw: 1 },
} as const satisfies Profile;

export const profiles: Readonly<Record<ProfileName, Profile>> = {
  default: everything,
  'two-engines': { ...everything, outer: { send: 3, repeat: 0.5, mismatch: 0, race: 0, lateRefusal: 0 }, inner: { none: 2, send: 1.5, otherEngine: 3, crash: 0 }, fates: { record: 4, refuse: 1, throw: 0 } },
  crashes: { ...everything, outer: { send: 3, repeat: 0.5, mismatch: 0, race: 0, lateRefusal: 0 }, inner: { none: 2, send: 0.5, otherEngine: 0.5, crash: 1.5 }, fates: { record: 1, refuse: 0, throw: 0 } },
  failures: { ...everything, outer: { send: 3, repeat: 0.5, mismatch: 0, race: 0, lateRefusal: 2 }, inner: { none: 3, send: 0.5, otherEngine: 1, crash: 0 }, fates: { record: 2, refuse: 1, throw: 3 } },
  races: { ...everything, outer: { send: 1, repeat: 0.3, mismatch: 0, race: 3, lateRefusal: 0 }, inner: { none: 4, send: 0.5, otherEngine: 0.5, crash: 0 } },
};

export type Plan = { readonly profile: ProfileName; readonly seeds: readonly number[]; readonly steps: number; readonly mutant?: MutantName };

export type Entry = { readonly step: number; readonly at: number; readonly move: string; readonly detail: string };

export type Failure = { readonly step: number; readonly move: string; readonly broken: readonly Violation[] };

export type Summary = { readonly requests: number; readonly recorded: number; readonly refused: number; readonly open: number; readonly handlerRuns: number };

export type Run = {
  readonly plan: Plan;
  readonly seed: number;
  readonly steps: number;
  readonly failure: Failure | undefined;
  readonly tally: Readonly<Record<string, number>>;
  readonly summary: Summary;
  readonly engineLog: readonly string[];
  readonly trace: readonly Entry[];
  readonly digest: string;
};

type Random = () => number;

type Timer = { readonly at: number; readonly owner: number; readonly wake: () => void };

type VirtualClock = {
  readonly now: () => Date;
  readonly clockFor: (owner: number) => Clock;
  readonly start: (run: () => Promise<void>) => Promise<void>;
  readonly nextDue: () => number | undefined;
  readonly advance: (to: number) => void;
  readonly fire: () => Promise<void>;
  readonly idle: () => Promise<void>;
};

type Engine = { readonly db: Database; readonly loop: Loop; readonly stop: AbortController; readonly done: Promise<void>; crashed: boolean; closed: Promise<void> | undefined };

type Target = { readonly on: TargetKind; readonly id: string };

type World = {
  readonly db: Database;
  readonly url: string;
  readonly plan: Plan;
  readonly profile: Profile;
  readonly change: Change;
  readonly random: Random;
  readonly virtual: VirtualClock;
  readonly engines: (Engine | undefined)[];
  readonly person: string;
  readonly targets: readonly Target[];
  readonly sent: Asked[];
  readonly tally: Map<string, number>;
  readonly log: string[];
  readonly trace: Entry[];
  watched: Watch | undefined;
  failure: Failure | undefined;
  pendingCrash: number | undefined;
  quiet: boolean;
  depth: number;
  step: number;
};

const lanes = Math.min(8, availableParallelism());

const epoch = Date.parse('2026-01-01T00:00:00.000Z');

const traceTail = 40;

const realWaitMs = 5_000;

const kindsOn: Readonly<Record<TargetKind, readonly RequestKind[]>> = { task: ['stop', 'retry', 'approve'], routine: ['pause', 'resume', 'run_now'] };

function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function virtualClock(startAt: number): VirtualClock {
  let at = startAt;
  let active = 0;
  let timers: readonly Timer[] = [];
  let waiting: (() => void)[] = [];
  const settle = (): void => {
    if (active > 0) return;
    const woken = waiting;
    waiting = [];
    for (const resolve of woken) resolve();
  };
  const idle = (): Promise<void> =>
    active === 0
      ? Promise.resolve()
      : new Promise(resolve => {
          waiting.push(resolve);
        });
  const nextDue = (): number | undefined => timers.reduce<number | undefined>((soonest, timer) => (soonest === undefined || timer.at < soonest ? timer.at : soonest), undefined);
  const now = (): Date => new Date(at);
  const clockFor = (owner: number): Clock => ({
    now,
    sleep: (ms, stop) =>
      new Promise(resolve => {
        if (stop.aborted) {
          resolve();
          return;
        }
        const wake = (): void => {
          stop.removeEventListener('abort', wake);
          timers = timers.filter(timer => timer.wake !== wake);
          active += 1;
          resolve();
        };
        timers = [...timers, { at: at + Math.max(0, ms), owner, wake }];
        stop.addEventListener('abort', wake, { once: true });
        active -= 1;
        settle();
      }),
  });
  return {
    now,
    clockFor,
    start: run => {
      active += 1;
      return run().finally(() => {
        active -= 1;
        settle();
      });
    },
    nextDue,
    advance: to => {
      at = Math.max(at, to);
    },
    fire: async () => {
      const due = nextDue();
      if (due === undefined) return;
      at = Math.max(at, due);
      const inEngineOrder = timers.filter(timer => timer.at === due).sort((one, other) => one.owner - other.owner);
      for (const timer of inEngineOrder) {
        if (!timers.includes(timer)) continue;
        timer.wake();
        await idle();
      }
    },
    idle,
  };
}

const pick = <T>(random: Random, items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];

function weighted<T extends string>(random: Random, odds: Readonly<Record<T, number>>): T | undefined {
  const choices = Object.entries(odds) as [T, number][];
  const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [choice, weight] of choices) {
    roll -= weight;
    if (weight > 0 && roll < 0) return choice;
  }
  return undefined;
}

function uuidFrom(random: Random): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function count(world: World, outcome: string): void {
  world.tally.set(outcome, (world.tally.get(outcome) ?? 0) + 1);
}

const now = (world: World): Date => world.virtual.now();

async function checkStep(world: World, move: string, detail: string): Promise<void> {
  world.step += 1;
  world.trace.push({ step: world.step, at: now(world).getTime() - epoch, move, detail });
  if (world.watched === undefined || world.failure !== undefined) return;
  const broken = await world.watched.step();
  if (broken.length > 0) world.failure = { step: world.step, move, broken };
}

const askFor = (world: World, id: string, target: Target, kind: RequestKind): Asked => {
  const base = { id, person: world.person, at: now(world), target: target.id };
  switch (kind) {
    case 'stop':
    case 'pause':
    case 'resume':
    case 'run_now':
      return { ...base, kind, payload: {} };
    case 'retry':
      return { ...base, kind, payload: { note: world.random() < 0.5 ? null : note.parse('Keep the change small.') } };
    case 'approve':
      return { ...base, kind, payload: { review: '7' } };
    case 'send_back':
      return { ...base, kind, payload: { review: '7', note: note.parse('Try again.') } };
    case 'answer':
      return { ...base, kind, payload: { review: '7', answer: { kind: 'pick', block: 0, option: 'a' } } };
    case 'steer':
      return { ...base, kind, payload: { message: 'Also check the edge case.' } };
  }
};

function newAsk(world: World, target: Target | undefined = pick(world.random, world.targets)): Asked | undefined {
  if (target === undefined) return undefined;
  const kind = pick(world.random, kindsOn[target.on]);
  return kind === undefined ? undefined : askFor(world, uuidFrom(world.random), target, kind);
}

async function recordFate(world: World, row: string, logical: string): Promise<Fate> {
  const fate = weighted(world.random, world.profile.fates) ?? 'record';
  await sql`insert into sim_sent (row, request, fate) values (${row}, ${logical}, ${fate})`.execute(world.db);
  return fate;
}

async function send(world: World, db: Database, asked: Asked): Promise<string> {
  const fate = await recordFate(world, asked.id, asked.id);
  const sent = await request(db, asked);
  if ('refused' in sent) throw new Error(`a fresh request ${asked.id} was refused as id-taken`);
  world.sent.push(asked);
  count(world, `sent ${fate}`);
  return `sent ${asked.kind} on ${requestKinds[asked.kind].on} ${asked.target} as ${asked.id}, fated to ${fate}`;
}

async function repeat(world: World): Promise<string> {
  const earlier = pick(world.random, world.sent);
  if (earlier === undefined) return 'nothing sent yet';
  if (world.change.freshId !== true) {
    const again = await request(world.db, earlier);
    count(world, 'sent' in again ? 'repeat reused the row' : 'repeat refused');
    return `sent ${earlier.id} again: ${'sent' in again ? 'the same row' : 'refused'}`;
  }
  const fresh = uuidFrom(world.random);
  const fate = await sql<{ fate: Fate }>`select fate from sim_sent where row = ${earlier.id}`.execute(world.db);
  await sql`insert into sim_sent (row, request, fate) values (${fresh}, ${earlier.id}, ${fate.rows[0]?.fate ?? 'record'})`.execute(world.db);
  await request(world.db, { ...earlier, id: fresh });
  count(world, 'repeat made a new row');
  return `sent ${earlier.id} again as a new row ${fresh}`;
}

async function mismatch(world: World): Promise<string> {
  const earlier = pick(world.random, world.sent);
  if (earlier === undefined) return 'nothing sent yet';
  const other = kindsOn[requestKinds[earlier.kind].on].find(kind => kind !== earlier.kind) ?? earlier.kind;
  const target = world.targets.find(candidate => candidate.id === earlier.target && candidate.on === requestKinds[earlier.kind].on);
  if (target === undefined) return 'no target';
  const sent = await request(world.db, askFor(world, earlier.id, target, other));
  count(world, 'refused' in sent ? 'mismatch refused' : 'mismatch accepted');
  return `sent ${earlier.id} again as ${other}: ${'refused' in sent ? sent.refused : 'accepted'}`;
}

async function lateRefusal(world: World): Promise<string> {
  const { rows } = await sql<{ id: string }>`select id from person_request where answer is not null order by id`.execute(world.db);
  const chosen = pick(world.random, rows);
  if (chosen === undefined) return 'nothing answered yet';
  const refuse = world.change.parts?.refuse ?? refuseOpen;
  const wrote = await refuse(world.db, chosen.id, 'A stale engine refused this late.', now(world), timeoutMs).catch(() => false);
  count(world, wrote ? 'late refusal overwrote an answer' : 'late refusal changed nothing');
  return `a stale engine refused ${chosen.id}: ${wrote ? 'it overwrote the answer' : 'nothing changed'}`;
}

async function pidOf(db: Database): Promise<number> {
  const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error('Postgres gave no backend pid');
  return pid;
}

async function blockedOrSettled(db: Database, pid: number, settled: () => boolean): Promise<'blocked' | 'settled'> {
  const deadline = performance.now() + realWaitMs;
  while (performance.now() < deadline) {
    if (settled()) return 'settled';
    const { rows } = await sql<{ waiting: boolean }>`select wait_event_type = 'Lock' as waiting from pg_stat_activity where pid = ${pid}`.execute(db);
    if (rows[0]?.waiting === true) return 'blocked';
    await wait(5);
  }
  throw new Error(`the racing request neither finished nor waited on a lock within ${String(realWaitMs)} ms, so the race move gave up`);
}

async function race(world: World): Promise<string> {
  const target = pick(world.random, world.targets);
  const first = newAsk(world, target);
  const second = newAsk(world, target);
  if (target === undefined || first === undefined || second === undefined) return 'no target';
  const slow = connect(world.url, 1);
  const fast = connect(world.url, 1);
  try {
    const fastPid = await pidOf(fast);
    await recordFate(world, first.id, first.id);
    await recordFate(world, second.id, second.id);
    let settled = false;
    let pending: Promise<unknown> = Promise.resolve();
    const { state, passed } = await slow.transaction().execute(async tx => {
      await tx.insertInto('person_request').values({ id: first.id, person_id: first.person, at: first.at, kind: first.kind, payload: JSON.stringify(first.payload), ...(target.on === 'task' ? { task_id: target.id } : { routine_id: target.id }) }).execute();
      pending = request(fast, second).then(() => {
        settled = true;
      });
      return { state: await blockedOrSettled(world.db, fastPid, () => settled), passed: await otherPass(world, -1) };
    });
    await pending;
    world.sent.push(first, second);
    count(world, `race ${state}`);
    return `two requests raced for ${target.on} ${target.id}; the later one ${state === 'blocked' ? 'waited for the first to commit' : 'committed first'}; ${passed}`;
  } finally {
    await slow.destroy();
    await fast.destroy();
  }
}

async function otherPass(world: World, index: number): Promise<string> {
  const other = world.engines.findIndex((candidate, at) => at !== index && candidate !== undefined && !candidate.crashed);
  const peer = world.engines[other];
  if (peer === undefined) return 'no other engine is running';
  world.depth += 1;
  try {
    const lines = await peer.loop.pass(peer.db, { now: now(world), late: () => false, stop: neverStops });
    world.log.push(...lines.map(line => `engine ${String(other + 1)} ${peer.loop.name}: ${line}`));
    return `engine ${String(other + 1)} passed: ${lines.join('; ') || 'nothing to apply'}`;
  } catch (error) {
    const line = `engine ${String(other + 1)} ${peer.loop.name}: the pass failed. ${error instanceof Error ? error.message : String(error)}`;
    world.log.push(line);
    return line;
  } finally {
    world.depth -= 1;
  }
}

async function waitGone(db: Database, pid: number): Promise<void> {
  const deadline = performance.now() + realWaitMs;
  while (performance.now() < deadline) {
    const { rows } = await sql`select 1 from pg_stat_activity where pid = ${pid}`.execute(db);
    if (rows.length === 0) return;
    await wait(5);
  }
  throw new Error(`the crashed engine's backend ${String(pid)} was still there after ${String(realWaitMs)} ms, so the crash move gave up`);
}

class Crashed extends Error {}

function kill(world: World, engine: Engine): void {
  engine.crashed = true;
  engine.stop.abort();
  engine.closed = engine.db.destroy();
  count(world, 'crashed');
}

async function crashInside(world: World, index: number, tx: Transacting): Promise<never> {
  const engine = world.engines[index];
  if (engine === undefined) throw new Error(`engine ${String(index + 1)} is not running`);
  const pid = await pidOf(tx);
  await sql`select pg_terminate_backend(${pid})`.execute(world.db);
  await waitGone(world.db, pid);
  kill(world, engine);
  throw new Crashed(`engine ${String(index + 1)} crashed inside its transaction`);
}

async function innerMove(world: World, index: number, tx: Transacting, target: Target, move: InnerMove): Promise<string> {
  switch (move) {
    case 'none':
      return 'nothing happened while it applied';
    case 'send': {
      const asked = newAsk(world, target);
      return asked === undefined ? 'no request' : send(world, world.db, asked);
    }
    case 'otherEngine':
      count(world, 'passed during a handler');
      return otherPass(world, index);
    case 'crash':
      if (world.change.apart === true) {
        world.pendingCrash = index;
        return `engine ${String(index + 1)} will crash before it answers`;
      }
      return crashInside(world, index, tx);
  }
}

const fakeHandler =
  (world: World, index: number, on: TargetKind): Handler<RequestKind> =>
  async (tx, applying) => {
    await sql`insert into sim_handled (row, engine) values (${applying.action}, ${index})`.execute(tx);
    const found = await sql<{ fate: Fate }>`select fate from sim_sent where row = ${applying.action}`.execute(tx);
    const fate = found.rows[0]?.fate ?? 'record';
    if (world.depth === 0 && !world.quiet) {
      world.depth += 1;
      try {
        const moves = Math.floor(world.random() * 3);
        for (let made = 0; made < moves && world.failure === undefined; made += 1) {
          world.virtual.advance(now(world).getTime() + 1);
          const move = weighted(world.random, world.profile.inner) ?? 'none';
          const detail = await innerMove(world, index, tx, { on, id: applying.target }, move);
          await checkStep(world, `while engine ${String(index + 1)} applied ${applying.action}: ${move}`, detail);
          if (world.pendingCrash !== undefined) break;
        }
      } finally {
        world.depth -= 1;
      }
    }
    if (fate === 'throw') throw new Error('The seeded handler failed.');
    if (fate === 'refuse') return { refused: 'The seeded handler refused the request.' };
    await tx
      .insertInto('human_action')
      .values({ id: applying.action, at: applying.at, person_id: applying.person, kind: on === 'task' ? 'retry_task' : 'resume_routine', ...(on === 'task' ? { task_id: applying.target } : { routine_id: applying.target }) })
      .onConflict(conflict => conflict.column('id').doNothing())
      .execute();
    return 'recorded';
  };

function handlersFor(world: World, index: number): Handlers<RequestKind> {
  const onTask = fakeHandler(world, index, 'task');
  const onRoutine = fakeHandler(world, index, 'routine');
  return { stop: onTask, retry: onTask, approve: onTask, send_back: onTask, answer: onTask, steer: onTask, pause: onRoutine, resume: onRoutine, run_now: onRoutine };
}

const apartPass =
  (world: World, index: number, settings: RequestSettings): Loop['pass'] =>
  async db => {
    const lines: string[] = [];
    for (;;) {
      const at = settings.now();
      const applied = await inTransaction(db, async tx => {
        await limitTime(tx, settings.timeoutMs);
        const claimed = await claimOldest(tx);
        return claimed === undefined ? undefined : { claimed, applied: await applyClaimed(tx, settings.handlers, claimed, at) };
      });
      if (applied === undefined) return lines;
      const engine = world.engines[index];
      if (world.pendingCrash === index && engine !== undefined) {
        world.pendingCrash = undefined;
        kill(world, engine);
        throw new Crashed(`engine ${String(index + 1)} crashed after applying ${applied.claimed.id} and before answering it`);
      }
      await inTransaction(db, tx => writeAnswer(tx, applied.claimed.id, applied.applied, at));
      lines.push(`applied ${applied.claimed.kind} ${applied.claimed.id}, then answered it`);
    }
  };

function engineLoop(world: World, index: number): Loop {
  const settings: RequestSettings = { everyMs: passEveryMs, timeoutMs, handlers: handlersFor(world, index), now: () => now(world) };
  const loop = requests(settings, { ...coreParts, ...world.change.parts });
  if (world.change.idle === true) return { ...loop, pass: () => Promise.resolve([]) };
  return world.change.apart === true ? { ...loop, pass: apartPass(world, index, settings) } : loop;
}

async function startEngine(world: World, index: number): Promise<void> {
  const db = connect(world.url, 2);
  const stop = new AbortController();
  const loop = engineLoop(world, index);
  const done = world.virtual.start(() =>
    runLoop(loop, db, world.virtual.clockFor(index), stop.signal, line => {
      if (world.engines[index]?.crashed !== true) world.log.push(`engine ${String(index + 1)} ${line}`);
    }),
  );
  world.engines[index] = { db, loop, stop, done, crashed: false, closed: undefined };
  await world.virtual.idle();
}

async function stopEngine(world: World, index: number): Promise<void> {
  const engine = world.engines[index];
  if (engine === undefined) return;
  engine.stop.abort();
  await engine.done;
  await (engine.closed ?? engine.db.destroy());
  world.engines[index] = undefined;
}

async function restartCrashed(world: World): Promise<void> {
  for (const [index, engine] of world.engines.entries()) {
    if (engine?.crashed !== true) continue;
    await stopEngine(world, index);
    await startEngine(world, index);
  }
}

async function applyMutant(db: Database, name: MutantName): Promise<void> {
  const { drop, schema = [] } = mutants[name].change;
  if (drop !== undefined) await dropGuard(db, name, drop);
  for (const statement of schema) await sql.raw(statement).execute(db);
}

async function dropGuard(db: Database, name: MutantName, drop: string): Promise<void> {
  const { rows } = await sql<{ ddl: string }>`
    select format('alter table %s drop constraint %I', conrelid::regclass, conname) as ddl
    from pg_constraint where conname = ${drop} and connamespace = 'public'::regnamespace
    union all
    select format('drop index %s', x.indexrelid::regclass)
    from pg_index x
    where x.indexrelid = to_regclass(${drop})
      and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))
    union all
    select format('drop trigger %I on %s', tgname, tgrelid::regclass)
    from pg_trigger where tgname = ${drop} and not tgisinternal`.execute(db);
  const [only, ...more] = rows;
  if (only === undefined || more.length > 0) throw new Error(`mutant ${name} must name exactly one constraint, index, or trigger, and it names ${String(rows.length)}`);
  await sql.raw(only.ddl).execute(db);
}

async function setUp(db: Database): Promise<{ readonly person: string; readonly targets: readonly Target[] }> {
  for (const statement of worldStatements) await statement.execute(db);
  const person = await db.selectFrom('person').select('id').executeTakeFirstOrThrow();
  const tasks = await db.selectFrom('task').select('id').orderBy('id').execute();
  const routines = await db.selectFrom('routine').select('id').orderBy('id').execute();
  return {
    person: person.id,
    targets: [...tasks.map(({ id }): Target => ({ on: 'task', id })), ...routines.map(({ id }): Target => ({ on: 'routine', id }))],
  };
}

async function summarize(db: Database): Promise<Summary> {
  const rows = await db.selectFrom('person_request').select('answer').execute();
  const { runs } = await sql<{ runs: string }>`select count(*) as runs from sim_handled`.execute(db).then(result => result.rows[0] ?? { runs: '0' });
  return {
    requests: rows.length,
    recorded: rows.filter(row => row.answer === 'recorded').length,
    refused: rows.filter(row => row.answer === 'refused').length,
    open: rows.filter(row => row.answer === null).length,
    handlerRuns: Number(runs),
  };
}

async function personMove(world: World, move: OuterMove): Promise<string> {
  switch (move) {
    case 'send': {
      const asked = newAsk(world);
      return asked === undefined ? 'no target' : send(world, world.db, asked);
    }
    case 'repeat':
      return repeat(world);
    case 'mismatch':
      return mismatch(world);
    case 'race':
      return race(world);
    case 'lateRefusal':
      return lateRefusal(world);
  }
}

async function outerStep(world: World): Promise<void> {
  await restartCrashed(world);
  const due = world.virtual.nextDue();
  const clock = now(world).getTime();
  if (due !== undefined && due <= clock + world.profile.stepMs && (world.quiet || world.random() < 0.5)) {
    const from = world.log.length;
    await world.virtual.fire();
    await checkStep(world, 'engine', world.log.slice(from).join('; ') || 'nothing to apply');
    return;
  }
  world.virtual.advance(clock + 1 + Math.floor(world.random() * world.profile.stepMs));
  const move = world.quiet ? undefined : weighted(world.random, world.profile.outer);
  if (move === undefined) {
    await checkStep(world, 'idle', 'time passed');
    return;
  }
  await checkStep(world, move, await personMove(world, move));
}

async function runSeed(postgres: TestPostgres, plan: Plan, seed: number): Promise<Run> {
  const profile = profiles[plan.profile];
  const random = seeded(seed);
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  const virtual = virtualClock(epoch);
  const tally = new Map<string, number>();
  let world: World | undefined;
  try {
    if (plan.mutant !== undefined) await applyMutant(db, plan.mutant);
    const seededWorld = await setUp(db);
    const current: World = {
      db,
      url: scratch.url,
      plan,
      profile,
      change: plan.mutant === undefined ? {} : mutants[plan.mutant].change,
      random,
      virtual,
      engines: [],
      ...seededWorld,
      sent: [],
      tally,
      log: [],
      trace: [],
      watched: undefined,
      failure: undefined,
      pendingCrash: undefined,
      quiet: false,
      depth: 0,
      step: 0,
    };
    world = current;
    current.watched = await watch(db);
    for (let index = 0; index < profile.engines; index += 1) {
      if (index > 0) virtual.advance(now(current).getTime() + passEveryMs / 2 + 7);
      await startEngine(current, index);
    }
    while (current.step < plan.steps && current.failure === undefined) await outerStep(current);
    current.quiet = true;
    const quietUntil = now(current).getTime() + 20 * passEveryMs;
    while (current.failure === undefined && now(current).getTime() < quietUntil) await outerStep(current);
    if (current.failure === undefined) {
      const unsettled = await current.watched.settled();
      if (unsettled.length > 0) current.failure = { step: current.step, move: 'the quiet phase ended', broken: unsettled };
    }
    return {
      plan,
      seed,
      steps: current.step,
      failure: current.failure,
      tally: Object.fromEntries(tally),
      summary: await summarize(db),
      engineLog: current.log,
      trace: current.failure === undefined ? current.trace.slice(-traceTail) : current.trace,
      digest: createHash('sha256').update(JSON.stringify([current.trace, current.log, [...tally].sort()])).digest('hex').slice(0, 16),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${plan.profile} seed ${String(seed)}${plan.mutant === undefined ? '' : ` without ${plan.mutant}`} threw after step ${String(world?.step ?? 0)}: ${reason}`, { cause: error });
  } finally {
    if (world !== undefined) for (const index of world.engines.keys()) await stopEngine(world, index);
    await db.destroy();
    await scratch.drop();
  }
}

export async function simulate(postgres: TestPostgres, plans: readonly Plan[], onFailure?: (run: Run) => void): Promise<readonly Run[]> {
  const jobs = plans.flatMap(plan => plan.seeds.map(seed => ({ plan, seed })));
  const runs: Run[] = [];
  const errors: unknown[] = [];
  let next = 0;
  const lane = async (): Promise<void> => {
    while (errors.length === 0 && next < jobs.length) {
      const index = next;
      next += 1;
      const job = jobs[index];
      if (job === undefined) return;
      try {
        const run = await runSeed(postgres, job.plan, job.seed);
        runs[index] = run;
        if (run.failure !== undefined) onFailure?.(run);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, jobs.length) }, lane));
  if (errors.length > 0) throw errors[0];
  return runs;
}
