import { availableParallelism } from 'node:os';
import { sql } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import { runLoop, type Clock, type Loop } from '../../shared/loop.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { openAttempt, t0, violations, world as setup, type PropertyName, type Violation } from './invariants.ts';
import { reconcile, startEnvironment, type Started } from './lifecycle.ts';
import { providersByName, type Environment, type Provider } from './provider.ts';

export const profileName = z.enum(['default', 'crashes']);

export type ProfileName = z.infer<typeof profileName>;

export const mutantName = z.enum(['one_environment_per_attempt', 'reconcile', 'provider_honours_deadline']);

export type MutantName = z.infer<typeof mutantName>;

export const mutants: Readonly<Record<MutantName, PropertyName>> = {
  one_environment_per_attempt: 'OneEnvironmentPerAttempt',
  reconcile: 'NoEnvironmentOutlivesItsAttempt',
  provider_honours_deadline: 'NoEnvironmentOutlivesItsAttempt',
};

export const settings = { everyMs: 1_000, startDeadlineMs: 2_000 } as const;

type CrashPoint = 'before-start' | 'after-start' | 'in-flight' | 'idle';

const moves = ['open', 'start', 'answer', 'pass', 'lose', 'stop', 'crash', 'restart'] as const;

type Move = (typeof moves)[number];

type Profile = { readonly odds: Readonly<Record<Move, number>>; readonly stepMs: number; readonly engines: number; readonly liveAttempts: number };

export const profiles: Readonly<Record<ProfileName, Profile>> = {
  default: { odds: { open: 2, start: 4, answer: 3, pass: 1, lose: 0.5, stop: 0.5, crash: 0.2, restart: 1 }, stepMs: 400, engines: 2, liveAttempts: 5 },
  crashes: { odds: { open: 2, start: 4, answer: 2, pass: 1, lose: 0.5, stop: 0.5, crash: 2, restart: 2 }, stepMs: 400, engines: 2, liveAttempts: 5 },
};

export type Plan = { readonly profile: ProfileName; readonly seeds: readonly number[]; readonly steps: number; readonly mutant?: MutantName };

export type Entry = { readonly step: number; readonly at: number; readonly move: string; readonly detail: string };

export type Failure = { readonly step: number; readonly move: string; readonly broken: readonly Violation[] };

export type Run = {
  readonly plan: Plan;
  readonly seed: number;
  readonly steps: number;
  readonly failure: Failure | undefined;
  readonly left: number;
  readonly unstopped: readonly string[];
  readonly starts: number;
  readonly crashes: Readonly<Record<CrashPoint, number>>;
  readonly trace: readonly Entry[];
};

type Random = () => number;

type Timer = { readonly at: number; readonly wake: () => void };

type VirtualClock = {
  readonly clock: Clock;
  readonly start: (run: () => Promise<void>) => Promise<void>;
  readonly nextDue: () => number | undefined;
  readonly advance: (to: number) => void;
  readonly fire: () => Promise<void>;
  readonly idle: () => Promise<void>;
};

type Pending = { readonly call: number; readonly engine: number; readonly attemptId: string; readonly calledAt: number; readonly settle: (result: Environment | Error) => void };

type Tally = { starts: number; stops: number; stoppedSinceStart: boolean };

type Fake = {
  readonly environments: Map<string, string>;
  readonly tallies: Map<string, Tally>;
  pending: readonly Pending[];
  caller: number;
  arrived: (() => void) | undefined;
};

type Call = { readonly id: number; readonly engine: number; readonly attemptId: string; readonly outcome: Promise<string>; done: boolean };

type Engine = { readonly id: number; readonly db: Database; readonly stop: AbortController; readonly done: Promise<void> };

type World = {
  readonly db: Database;
  readonly url: string;
  readonly plan: Plan;
  readonly profile: Profile;
  readonly random: Random;
  readonly virtual: VirtualClock;
  readonly fake: Fake;
  readonly slots: (Engine | undefined)[];
  readonly calls: Call[];
  readonly log: string[];
  readonly crashes: Record<CrashPoint, number>;
  engines: number;
  opened: number;
  clock: number;
};

const lanes = Math.min(8, availableParallelism());

const bound = settings.everyMs * 1.1 + settings.startDeadlineMs;

const traceTail = 40;

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
  let now = startAt;
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
  const clock: Clock = {
    now: () => new Date(now),
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
        timers = [...timers, { at: now + Math.max(0, ms), wake }];
        stop.addEventListener('abort', wake, { once: true });
        active -= 1;
        settle();
      }),
  };
  return {
    clock,
    start: run => {
      active += 1;
      return run().finally(() => {
        active -= 1;
        settle();
      });
    },
    nextDue,
    advance: to => {
      now = Math.max(now, to);
    },
    fire: async () => {
      const due = nextDue();
      if (due === undefined) return;
      now = Math.max(now, due);
      for (const timer of timers.filter(candidate => candidate.at === due)) timer.wake();
      await idle();
    },
    idle,
  };
}

const pick = <T>(random: Random, items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];

function weighted<T>(random: Random, choices: readonly (readonly [T, number])[]): T | undefined {
  const total = choices.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [choice, weight] of choices) {
    if (weight <= 0) continue;
    roll -= weight;
    if (roll < 0) return choice;
  }
  return undefined;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function tallyOf(fake: Fake, attemptId: string): Tally {
  const found = fake.tallies.get(attemptId);
  if (found !== undefined) return found;
  const made: Tally = { starts: 0, stops: 0, stoppedSinceStart: true };
  fake.tallies.set(attemptId, made);
  return made;
}

function fakeFor(fake: Fake, engine: number, now: () => number): Provider {
  return {
    name: 'fake',
    start: ({ attemptId }) =>
      new Promise((resolve, reject) => {
        fake.pending = [
          ...fake.pending,
          { call: fake.caller, engine, attemptId, calledAt: now(), settle: result => {
              if (result instanceof Error) reject(result);
              else resolve(result);
            },
          },
        ];
        fake.arrived?.();
      }),
    stop: attemptId => {
      fake.environments.delete(attemptId);
      const tally = tallyOf(fake, attemptId);
      tally.stops += 1;
      tally.stoppedSinceStart = true;
      return Promise.resolve();
    },
  };
}

function answer(fake: Fake, pending: Pending, now: number, deadlineHonoured: boolean): 'made' | 'refused' {
  fake.pending = fake.pending.filter(entry => entry !== pending);
  if (deadlineHonoured && now > pending.calledAt + settings.startDeadlineMs) {
    pending.settle(new Error(`the start deadline of ${String(settings.startDeadlineMs)} ms passed before the environment was ready`));
    return 'refused';
  }
  const url = `http://attempt-${pending.attemptId}.environments.test`;
  fake.environments.set(pending.attemptId, url);
  const tally = tallyOf(fake, pending.attemptId);
  tally.starts += 1;
  tally.stoppedSinceStart = false;
  pending.settle({ kind: 'address', url });
  return 'made';
}

const honoursDeadline = (world: World): boolean => world.plan.mutant !== 'provider_honours_deadline';

function drop(fake: Fake, pending: Pending): void {
  fake.pending = fake.pending.filter(entry => entry !== pending);
  pending.settle(new Error('the engine died before it called start'));
}

async function settleCall(world: World, call: number): Promise<string> {
  const found = world.calls.find(entry => entry.id === call);
  return found === undefined ? 'no call' : found.outcome;
}

function startEngine(world: World, slot: number): Engine {
  world.engines += 1;
  const id = world.engines;
  const db = connect(world.url, 2);
  const stop = new AbortController();
  const loop: Loop | undefined =
    world.plan.mutant === 'reconcile' ? undefined : reconcile({ providers: providersByName([fakeFor(world.fake, id, () => world.virtual.clock.now().getTime())]), ...settings });
  const done =
    loop === undefined
      ? Promise.resolve()
      : world.virtual.start(() =>
          runLoop(loop, db, world.virtual.clock, stop.signal, line => {
            world.log.push(`engine ${String(id)} ${line}`);
          }),
        );
  const engine: Engine = { id, db, stop, done };
  world.slots[slot] = engine;
  return engine;
}

async function crashEngine(world: World, slot: number, engine: Engine): Promise<string> {
  const own = world.fake.pending.filter(pending => pending.engine === engine.id);
  const point: CrashPoint = own.length === 0 ? 'idle' : (pick(world.random, ['before-start', 'after-start', 'in-flight'] as const) ?? 'in-flight');
  engine.stop.abort();
  await engine.done;
  await engine.db.destroy();
  world.slots[slot] = undefined;
  world.crashes[point] += 1;
  const now = world.virtual.clock.now().getTime();
  for (const pending of own) {
    if (point === 'before-start') drop(world.fake, pending);
    if (point === 'after-start') answer(world.fake, pending, now, honoursDeadline(world));
    if (point !== 'in-flight') await settleCall(world, pending.call);
  }
  return `engine ${String(engine.id)} died ${point === 'idle' ? 'with no start in flight' : `${point} for ${own.map(pending => `attempt ${pending.attemptId}`).join(', ')}`}`;
}

const describeStarted = (started: Started): string => {
  switch (started.kind) {
    case 'started':
      return `started ${started.environment.kind}`;
    case 'unknown-provider':
      return `unknown provider ${started.provider}`;
    case 'attempt-ended':
      return 'the attempt had ended';
    case 'failed':
      return `failed: ${started.reason}`;
  }
};

async function liveAttempts(db: Database): Promise<readonly string[]> {
  const rows = await db.selectFrom('attempt').select('id').where('finished_at', 'is', null).orderBy('id').execute();
  return rows.map(row => row.id);
}

async function allAttempts(db: Database): Promise<readonly string[]> {
  const rows = await db.selectFrom('attempt').select('id').orderBy('id').execute();
  return rows.map(row => row.id);
}

async function beginStart(world: World, engine: Engine, attemptId: string): Promise<string> {
  const call = world.calls.length + 1;
  world.fake.caller = call;
  const arrived = new Promise<'waiting'>(resolve => {
    world.fake.arrived = () => {
      resolve('waiting');
    };
  });
  const providers = providersByName([fakeFor(world.fake, engine.id, () => world.virtual.clock.now().getTime())]);
  const entry: Call = {
    id: call,
    engine: engine.id,
    attemptId,
    done: false,
    outcome: startEnvironment(engine.db, providers, attemptId, { now: () => world.virtual.clock.now(), startDeadlineMs: settings.startDeadlineMs })
      .then(describeStarted, (error: unknown) => `died: ${reason(error)}`)
      .then(detail => {
        entry.done = true;
        return detail;
      }),
  };
  world.calls.push(entry);
  const first = await Promise.race([entry.outcome, arrived]);
  world.fake.arrived = undefined;
  return `engine ${String(engine.id)} ${first === 'waiting' ? 'called start and waits' : first} for attempt ${attemptId}`;
}

async function endAttempt(world: World, verdict: 'pass' | 'lost' | 'stopped'): Promise<string> {
  const attempt = pick(world.random, await liveAttempts(world.db));
  if (attempt === undefined) return 'no live attempt';
  const output = verdict === 'pass' ? JSON.stringify({ outcome: 'done', summary: 'Simulated.', blocks: [] }) : null;
  await world.db
    .updateTable('attempt')
    .set({ finished_at: world.virtual.clock.now(), verdict, output })
    .where('id', '=', attempt)
    .where('finished_at', 'is', null)
    .execute();
  return `attempt ${attempt} ended ${verdict}`;
}

const running = (world: World): readonly (readonly [number, Engine])[] => world.slots.flatMap((engine, slot) => (engine === undefined ? [] : [[slot, engine] as const]));

type Rule = { readonly allowed: (world: World, quiet: boolean) => Promise<boolean> | boolean; readonly perform: (world: World) => Promise<string> };

const rules: Readonly<Record<Move, Rule>> = {
  open: {
    allowed: async (world, quiet) => !quiet && (await liveAttempts(world.db)).length < world.profile.liveAttempts,
    perform: async world => {
      world.opened += 1;
      const key = `SIM-${String(world.opened)}`;
      for (const statement of openAttempt(key, world.virtual.clock.now())) await statement.execute(world.db);
      return `opened a Verify attempt for ${key}`;
    },
  },
  start: {
    allowed: (world, quiet) => !quiet && running(world).length > 0,
    perform: async world => {
      const [, engine] = pick(world.random, running(world)) ?? [];
      const live = await liveAttempts(world.db);
      const attempt = pick(world.random, world.random() < 0.9 && live.length > 0 ? live : await allAttempts(world.db));
      if (engine === undefined || attempt === undefined) return 'no attempt to start';
      return beginStart(world, engine, attempt);
    },
  },
  answer: {
    allowed: world => world.fake.pending.length > 0,
    perform: async world => {
      const pending = pick(world.random, world.fake.pending);
      if (pending === undefined) return 'no start in flight';
      const made = answer(world.fake, pending, world.virtual.clock.now().getTime(), honoursDeadline(world));
      const detail = await settleCall(world, pending.call);
      return `the provider ${made === 'made' ? 'made' : 'refused'} the environment for attempt ${pending.attemptId}, and engine ${String(pending.engine)} ${detail}`;
    },
  },
  pass: { allowed: async world => (await liveAttempts(world.db)).length > 0, perform: world => endAttempt(world, 'pass') },
  lose: { allowed: async world => (await liveAttempts(world.db)).length > 0, perform: world => endAttempt(world, 'lost') },
  stop: { allowed: async world => (await liveAttempts(world.db)).length > 0, perform: world => endAttempt(world, 'stopped') },
  crash: {
    allowed: (world, quiet) => !quiet && running(world).length >= 2,
    perform: async world => {
      const [slot, engine] = pick(world.random, running(world)) ?? [];
      return slot === undefined || engine === undefined ? 'no engine to crash' : crashEngine(world, slot, engine);
    },
  },
  restart: {
    allowed: world => running(world).length < world.profile.engines,
    perform: async world => {
      const slot = world.slots.findIndex(engine => engine === undefined);
      const engine = startEngine(world, slot === -1 ? world.slots.length : slot);
      await world.virtual.idle();
      return `engine ${String(engine.id)} started`;
    },
  },
};

async function perform(world: World, quiet: boolean): Promise<{ readonly move: string; readonly detail: string }> {
  const choices: (readonly [Move, number])[] = [];
  for (const move of moves) choices.push([move, (await rules[move].allowed(world, quiet)) ? world.profile.odds[move] : 0]);
  const move = weighted(world.random, choices);
  if (move === undefined) return { move: 'wait', detail: 'no move is allowed, so time passes' };
  return { move, detail: await rules[move].perform(world) };
}

async function enginePass(world: World): Promise<string> {
  const from = world.log.length;
  await world.virtual.fire();
  const lines = world.log.slice(from);
  return lines.length === 0 ? 'a pass found nothing to stop' : lines.join('; ');
}

async function fakeTruth(world: World, now: number): Promise<readonly Violation[]> {
  const held = [...world.fake.environments.keys()];
  if (held.length === 0) return [];
  const rows = await world.db
    .selectFrom('attempt')
    .select(['id', 'finished_at'])
    .where('id', 'in', held)
    .where('finished_at', '<', new Date(now - bound))
    .execute();
  return rows.map(row => ({ property: 'NoEnvironmentOutlivesItsAttempt', row: { attempt_id: row.id, finished_at: row.finished_at, held_by: 'the fake provider' } }));
}

async function settled(world: World): Promise<boolean> {
  if ((await liveAttempts(world.db)).length > 0 || world.fake.pending.length > 0 || world.fake.environments.size > 0) return false;
  if (world.calls.some(call => !call.done && world.slots.some(engine => engine?.id === call.engine))) return false;
  const open = await world.db.selectFrom('verify_environment').select('id').where('stopped_at', 'is', null).executeTakeFirst();
  return open === undefined;
}

async function dropGuard(db: Database, name: MutantName): Promise<void> {
  if (name === 'one_environment_per_attempt') await sql`alter table verify_environment drop constraint one_environment_per_attempt`.execute(db);
}

async function runSeed(postgres: TestPostgres, plan: Plan, seed: number): Promise<Run> {
  const profile = profiles[plan.profile];
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  const trace: Entry[] = [];
  const world: World = {
    db,
    url: scratch.url,
    plan,
    profile,
    random: seeded(seed),
    virtual: virtualClock(t0),
    fake: { environments: new Map(), tallies: new Map(), pending: [], caller: 0, arrived: undefined },
    slots: [],
    calls: [],
    log: [],
    crashes: { 'before-start': 0, 'after-start': 0, 'in-flight': 0, idle: 0 },
    engines: 0,
    opened: 0,
    clock: t0,
  };
  const ended = (steps: number, failure: Failure | undefined): Run => {
    const unstopped = [...world.fake.tallies].filter(([, tally]) => tally.starts > 0 && !tally.stoppedSinceStart).map(([attempt]) => attempt);
    const starts = [...world.fake.tallies.values()].reduce((sum, tally) => sum + tally.starts, 0);
    return { plan, seed, steps, failure, left: world.fake.environments.size, unstopped, starts, crashes: { ...world.crashes }, trace: failure === undefined ? trace.slice(-traceTail) : trace };
  };
  try {
    if (plan.mutant !== undefined) await dropGuard(db, plan.mutant);
    for (const statement of setup) await statement.execute(db);
    await db.updateTable('repository').set({ verify_provider: 'fake' }).execute();
    for (let slot = 0; slot < profile.engines; slot += 1) startEngine(world, slot);
    await world.virtual.idle();
    const quietCap = 400;
    let step = 0;
    while (step < plan.steps + quietCap) {
      step += 1;
      const quiet = step > plan.steps;
      if (quiet && (await settled(world))) break;
      const due = world.virtual.nextDue();
      const engineDue = due !== undefined && due <= world.clock;
      if (!engineDue) world.virtual.advance(world.clock);
      const made = engineDue ? { move: 'loop', detail: await enginePass(world) } : await perform(world, quiet);
      const at = world.virtual.clock.now().getTime();
      trace.push({ step, at: at - t0, ...made });
      const broken = [...(await violations(db, { now: new Date(at), ...settings })), ...(await fakeTruth(world, at))];
      if (broken.length > 0) return ended(step, { step, move: made.move, broken });
      world.clock = Math.max(world.clock, at) + (engineDue ? 0 : 1 + Math.floor(world.random() * profile.stepMs));
    }
    return ended(step, (await settled(world)) ? undefined : { step, move: 'the quiet phase ended', broken: [] });
  } catch (error) {
    throw new Error(`${plan.profile} seed ${String(seed)}${plan.mutant === undefined ? '' : ` without ${plan.mutant}`} threw after step ${String(trace.at(-1)?.step ?? 0)}: ${reason(error)}`, { cause: error });
  } finally {
    for (const engine of world.slots) engine?.stop.abort();
    await Promise.all(world.slots.flatMap(engine => (engine === undefined ? [] : [engine.done])));
    for (const pending of world.fake.pending) drop(world.fake, pending);
    await Promise.all(world.calls.map(call => call.outcome));
    await Promise.all(world.slots.flatMap(engine => (engine === undefined ? [] : [engine.db.destroy()])));
    await db.destroy();
    await scratch.drop();
  }
}

export async function simulate(postgres: TestPostgres, plans: readonly Plan[]): Promise<readonly Run[]> {
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
        runs[index] = await runSeed(postgres, job.plan, job.seed);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, jobs.length) }, lane));
  if (errors.length > 0) throw errors[0];
  return runs;
}

export type Probe = { readonly ended: number; readonly stopped: number; readonly passMs: number; readonly slowestDelayMs: number; readonly everyMs: number };

export async function probeReconcile(postgres: TestPostgres, ending: number): Promise<Probe> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  const engineDb = connect(scratch.url, 2);
  const virtual = virtualClock(t0);
  const stop = new AbortController();
  const stopped = new Set<string>();
  const instant: Provider = {
    name: 'fake',
    start: ({ attemptId }) => Promise.resolve({ kind: 'address', url: `http://attempt-${attemptId}.environments.test` }),
    stop: attemptId => {
      stopped.add(attemptId);
      return Promise.resolve();
    },
  };
  const providers = providersByName([instant]);
  let done: Promise<void> = Promise.resolve();
  try {
    for (const statement of setup) await statement.execute(db);
    await db.updateTable('repository').set({ verify_provider: 'fake' }).execute();
    for (let index = 1; index <= ending; index += 1) {
      for (const statement of openAttempt(`PROBE-${String(index)}`, virtual.clock.now())) await statement.execute(db);
    }
    for (const attempt of await allAttempts(db)) {
      const started = await startEnvironment(db, providers, attempt, { now: () => virtual.clock.now(), startDeadlineMs: settings.startDeadlineMs });
      if (started.kind !== 'started') throw new Error(`the probe could not start an environment for attempt ${attempt}: ${describeStarted(started)}`);
    }
    const loop = reconcile({ providers, ...settings });
    done = virtual.start(() => runLoop(loop, engineDb, virtual.clock, stop.signal, () => undefined));
    await virtual.idle();
    virtual.advance(t0 + settings.everyMs / 3);
    await db.updateTable('attempt').set({ finished_at: virtual.clock.now(), verdict: 'lost' }).where('finished_at', 'is', null).execute();
    const started = performance.now();
    await virtual.fire();
    const passMs = performance.now() - started;
    const delays = await db
      .selectFrom('verify_environment as environment')
      .innerJoin('attempt', 'attempt.id', 'environment.attempt_id')
      .select(sql<number>`(extract(epoch from environment.stopped_at - attempt.finished_at) * 1000)::float8`.as('delay'))
      .where('environment.stopped_at', 'is not', null)
      .execute();
    return { ended: ending, stopped: Math.min(stopped.size, delays.length), passMs, slowestDelayMs: Math.max(0, ...delays.map(row => row.delay)), everyMs: settings.everyMs };
  } finally {
    stop.abort();
    await done;
    await engineDb.destroy();
    await db.destroy();
    await scratch.drop();
  }
}
