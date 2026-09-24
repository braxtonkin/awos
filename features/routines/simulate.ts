import { createHash, randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { sql } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import { neverStops, runLoop, type Clock, type Loop } from '../../shared/loop.ts';
import { review } from '../../shared/review.ts';
import { step, type Workflow } from '../../shared/workflow.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { pause, resume, runNow } from './actions.ts';
import { ticketTable, watch, type PropertyName, type Violation, type Watch } from './invariants.ts';
import { scheduler, type SchedulerSettings } from './scheduler.ts';
import type { RoutineRun, Source, WorkItem } from '../../shared/routine-source.ts';
import { sourcesByKind } from './source.ts';

export const profileName = z.enum(['default', 'two-engines', 'downtime', 'pause', 'hangs', 'run-now', 'shared-key', 'assignee']);

export type ProfileName = z.infer<typeof profileName>;

export const mutantName = z.enum([
  'one_run_per_slot',
  'one_live_run_per_routine',
  'run_claims_an_active_routine',
  'slot-by-slot',
  'one_task_per_key',
  'task_keeps_its_routine',
  'endless-lease',
  'run_finishes_under_its_claim',
  'stale-assignee',
  'one_waiting_press_per_routine',
  'no-scheduler',
]);

export type MutantName = z.infer<typeof mutantName>;

type Guard =
  | 'SlotClaimIsExclusive'
  | 'PauseIsChecked'
  | 'CatchUpCollapses'
  | 'TaskKeyIsUnique'
  | 'RecordKeepsOwner'
  | 'RunLeaseExpires'
  | 'LateFinishIsRefused'
  | 'RunRefreshesAssignee'
  | 'RunNowIsKeyed'
  | 'SchedulerIsFair';

type Change =
  | { readonly drop: string }
  | { readonly schema: readonly string[] }
  | { readonly settings: (settings: SchedulerSettings, virtual: VirtualClock) => SchedulerSettings }
  | { readonly loop: (loop: Loop) => Loop };

type Mutant = { readonly guard: Guard; readonly breaks: PropertyName; readonly profile: ProfileName; readonly change: Change };

const lagging = (settings: SchedulerSettings, virtual: VirtualClock): SchedulerSettings => ({
  ...settings,
  now: async db => {
    const real = virtual.clock.now().getTime();
    const { newest } = await db.selectFrom('routine_run').select(eb => eb.fn.max('slot').as('newest')).executeTakeFirstOrThrow();
    return new Date(newest === null ? real : Math.min(real, newest.getTime() + routineEveryMs + 1));
  },
});

export const mutants: Readonly<Record<MutantName, Mutant>> = {
  one_run_per_slot: { guard: 'SlotClaimIsExclusive', breaks: 'OneRunPerSlot', profile: 'two-engines', change: { drop: 'one_run_per_slot' } },
  one_live_run_per_routine: { guard: 'SlotClaimIsExclusive', breaks: 'OneRunPerSlot', profile: 'hangs', change: { drop: 'one_live_run_per_routine' } },
  run_claims_an_active_routine: { guard: 'PauseIsChecked', breaks: 'PausedRoutineStartsNoRun', profile: 'pause', change: { drop: 'run_claims_an_active_routine' } },
  'slot-by-slot': { guard: 'CatchUpCollapses', breaks: 'MissedSlotsCollapse', profile: 'downtime', change: { settings: lagging } },
  one_task_per_key: {
    guard: 'TaskKeyIsUnique',
    breaks: 'OneTaskPerTicket',
    profile: 'shared-key',
    change: { schema: ['alter table task drop constraint one_task_per_key, add constraint one_task_per_key unique (key, routine_id)'] },
  },
  task_keeps_its_routine: { guard: 'RecordKeepsOwner', breaks: 'OneTaskPerTicket', profile: 'shared-key', change: { drop: 'task_keeps_its_routine' } },
  'endless-lease': { guard: 'RunLeaseExpires', breaks: 'DueSlotsRun', profile: 'hangs', change: { settings: settings => ({ ...settings, leaseMs: 10 * 365 * 24 * 3_600_000 }) } },
  run_finishes_under_its_claim: { guard: 'LateFinishIsRefused', breaks: 'OneRunPerSlot', profile: 'hangs', change: { drop: 'run_finishes_under_its_claim' } },
  'stale-assignee': {
    guard: 'RunRefreshesAssignee',
    breaks: 'AssigneeFollowsTicket',
    profile: 'assignee',
    change: {
      schema: [
        'create function keep_assignee() returns trigger language plpgsql as $$ begin new.assignee_account_id := old.assignee_account_id; return new; end $$',
        'create trigger mutant_keeps_the_first_assignee before update on task for each row execute function keep_assignee()',
      ],
    },
  },
  one_waiting_press_per_routine: { guard: 'RunNowIsKeyed', breaks: 'RunNowRunsOnce', profile: 'run-now', change: { drop: 'one_waiting_press_per_routine' } },
  'no-scheduler': { guard: 'SchedulerIsFair', breaks: 'DueSlotsRun', profile: 'default', change: { loop: loop => ({ ...loop, pass: () => Promise.resolve([]) }) } },
};

const outerMoves = ['pause', 'resume', 'press', 'reassign', 'downtime'] as const;

type OuterMove = (typeof outerMoves)[number];

const innerMoves = ['none', 'pause', 'press', 'reassign', 'lapse', 'crash', 'otherEngine', 'failSearch'] as const;

type InnerMove = (typeof innerMoves)[number];

type Profile = {
  readonly engines: 1 | 2;
  readonly sharedTickets: boolean;
  readonly downtimeSlots: number;
  readonly stepMs: number;
  readonly outer: Readonly<Record<OuterMove, number>>;
  readonly inner: Readonly<Record<InnerMove, number>>;
};

const routineEveryMs = 60_000;

const passEveryMs = 10_000;

const leaseMs = 30_000;

const quietOuter = { pause: 0, resume: 0, press: 0, reassign: 0, downtime: 0 } as const;

const calmInner = { none: 10, pause: 0, press: 0, reassign: 0, lapse: 0, crash: 0, otherEngine: 0, failSearch: 0 } as const;

const everything = {
  engines: 2,
  sharedTickets: true,
  downtimeSlots: 3,
  stepMs: 3_000,
  outer: { pause: 0.4, resume: 0.8, press: 1, reassign: 1, downtime: 0.05 },
  inner: { none: 6, pause: 0.3, press: 0.5, reassign: 0.5, lapse: 0.4, crash: 0.3, otherEngine: 1, failSearch: 0.3 },
} as const satisfies Profile;

export const profiles: Readonly<Record<ProfileName, Profile>> = {
  default: everything,
  'two-engines': { ...everything, outer: { ...quietOuter, press: 0.5, reassign: 0.5 }, inner: { ...calmInner, otherEngine: 3, press: 0.3 } },
  downtime: { ...everything, engines: 1, downtimeSlots: 5, outer: { ...quietOuter, downtime: 0.1, press: 0.3 }, inner: { ...calmInner, crash: 0.5, lapse: 0.3 } },
  pause: { ...everything, outer: { ...quietOuter, pause: 1, resume: 1, press: 1.5 }, inner: { ...calmInner, pause: 2, press: 1, otherEngine: 1 } },
  hangs: { ...everything, outer: { ...quietOuter, press: 1, reassign: 0.3 }, inner: { ...calmInner, lapse: 2, crash: 1, otherEngine: 2, press: 0.5 } },
  'run-now': { ...everything, outer: { ...quietOuter, press: 4 }, inner: { ...calmInner, press: 2, otherEngine: 1 } },
  'shared-key': { ...everything, outer: { ...quietOuter, reassign: 0.5, press: 0.5 }, inner: { ...calmInner, otherEngine: 2, reassign: 0.3 } },
  assignee: { ...everything, outer: { ...quietOuter, reassign: 3 }, inner: { ...calmInner, reassign: 2, otherEngine: 1 } },
};

export const post: Workflow = {
  name: 'post',
  steps: [
    step({
      name: 'post',
      reads: [],
      runBy: 'agent',
      prompt: 'Post the update.',
      startsEnvironment: false,
      needsRepository: false,
      canEnd: true,
      owes: [],
      output: review,
      requires: [],
      failures: { fail: { kind: 'fail' } },
      blocked: 'fail',
      done: () => 'pass',
    }),
  ],
};

export const fingerprint = createHash('sha256').update(JSON.stringify({ outerMoves, innerMoves, profiles, routineEveryMs, passEveryMs, leaseMs })).digest('hex').slice(0, 16);

export type Plan = { readonly profile: ProfileName; readonly seeds: readonly number[]; readonly steps: number; readonly mutant?: MutantName };

export type Entry = { readonly step: number; readonly at: number; readonly move: string; readonly detail: string };

export type Failure = { readonly step: number; readonly move: string; readonly broken: readonly Violation[] };

export type Summary = {
  readonly runs: number;
  readonly slots: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly catchUps: readonly number[];
  readonly lostCollapsed: number;
  readonly tasks: number;
  readonly overlaps: number;
  readonly presses: number;
  readonly pressRuns: number;
};

export type Run = {
  readonly plan: Plan;
  readonly seed: number;
  readonly steps: number;
  readonly failure: Failure | undefined;
  readonly tally: Readonly<Record<string, number>>;
  readonly summary: Summary;
  readonly engineLog: readonly string[];
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

type Engine = { readonly db: Database; readonly loop: Loop; readonly stop: AbortController; readonly done: Promise<void>; crashed: boolean };

type World = {
  readonly db: Database;
  readonly url: string;
  readonly plan: Plan;
  readonly profile: Profile;
  readonly random: Random;
  readonly virtual: VirtualClock;
  readonly engines: (Engine | undefined)[];
  readonly person: string;
  readonly routines: readonly string[];
  readonly tickets: readonly string[];
  readonly tally: Map<string, number>;
  readonly log: string[];
  readonly trace: Entry[];
  watched: Watch | undefined;
  failure: Failure | undefined;
  quiet: boolean;
  depth: number;
  step: number;
};

const lanes = Math.min(8, availableParallelism());

const epoch = Date.parse('2026-01-01T00:00:00.000Z');

const traceTail = 40;

const assignees = ['acc-ada', 'acc-bo', null] as const;

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

function count(world: World, outcome: string): void {
  world.tally.set(outcome, (world.tally.get(outcome) ?? 0) + 1);
}

const now = (world: World): Date => world.virtual.clock.now();

async function checkStep(world: World, move: string, detail: string): Promise<void> {
  const at = now(world).getTime();
  world.step += 1;
  world.trace.push({ step: world.step, at: at - epoch, move, detail });
  if (world.watched === undefined || world.failure !== undefined) return;
  const broken = await world.watched.step(new Date(at));
  if (broken.length > 0) world.failure = { step: world.step, move, broken };
}

async function personMove(world: World, move: 'pause' | 'resume' | 'press' | 'reassign'): Promise<string> {
  const at = now(world);
  if (move === 'reassign') {
    const key = pick(world.random, world.tickets);
    const assignee = pick(world.random, assignees) ?? null;
    if (key === undefined) return 'no ticket';
    await sql`update sim_ticket set assignee = ${assignee}, changed_at = ${at} where key = ${key}`.execute(world.db);
    count(world, 'reassigned');
    return `ticket ${key} now assigned to ${assignee ?? 'nobody'}`;
  }
  const routine = pick(world.random, world.routines);
  if (routine === undefined) return 'no routine';
  const outcome =
    move === 'pause' ? await pause(world.db, routine, world.person, at) : move === 'resume' ? await resume(world.db, routine, world.person, at) : await runNow(world.db, routine, world.person, at);
  const said = typeof outcome === 'string' ? outcome : `refused: ${outcome.refused}`;
  count(world, `${move} ${said}`);
  return `routine ${routine}: ${said}`;
}

async function leaseOf(db: Database, run: string): Promise<number> {
  const row = await db.selectFrom('routine_run').select('lease_until').where('id', '=', run).executeTakeFirst();
  return row?.lease_until?.getTime() ?? 0;
}

async function innerMove(world: World, index: number, run: RoutineRun, move: Exclude<InnerMove, 'failSearch'>): Promise<string> {
  const engine = world.engines[index];
  switch (move) {
    case 'none':
      return 'nothing happened while it searched';
    case 'pause':
    case 'press':
    case 'reassign':
      return personMove(world, move);
    case 'lapse': {
      const lease = await leaseOf(world.db, run.run);
      if (lease - now(world).getTime() > routineEveryMs * 10) return 'the lease is too long to outlast';
      world.virtual.advance(lease + 1);
      count(world, 'lapsed');
      return `run ${run.run} hung past its lease`;
    }
    case 'crash':
      if (engine === undefined || engine.crashed) return 'the engine already crashed';
      engine.crashed = true;
      engine.stop.abort();
      await engine.db.destroy();
      count(world, 'crashed');
      return `engine ${String(index + 1)} crashed during run ${run.run}`;
    case 'otherEngine': {
      const other = world.engines.findIndex((candidate, at) => at !== index && candidate !== undefined && !candidate.crashed);
      const peer = world.engines[other];
      if (peer === undefined) return 'no other engine is running';
      const lines = await peer.loop.pass(peer.db, { now: now(world), late: () => false, stop: neverStops });
      world.log.push(...lines.map(line => `engine ${String(other + 1)} ${peer.loop.name}: ${line}`));
      count(world, 'passed during another run');
      return `engine ${String(other + 1)} passed: ${lines.join('; ') || 'nothing due'}`;
    }
  }
}

function seededSource(world: World, index: number): Source {
  return {
    kind: 'tickets',
    find: async run => {
      await checkStep(world, 'claim', `engine ${String(index + 1)} claimed run ${run.run} of routine ${run.routine}`);
      let failed = false;
      if (world.depth === 0 && !world.quiet) {
        world.depth += 1;
        try {
          const moves = Math.floor(world.random() * 3);
          for (let made = 0; made < moves && world.failure === undefined; made += 1) {
            world.virtual.advance(now(world).getTime() + 1);
            const move = weighted(world.random, world.profile.inner) ?? 'none';
            if (move === 'failSearch') count(world, 'search failed');
            failed ||= move === 'failSearch';
            const detail = move === 'failSearch' ? 'the search will fail' : await innerMove(world, index, run, move);
            await checkStep(world, `while run ${run.run} searched: ${move}`, detail);
          }
        } finally {
          world.depth -= 1;
        }
      }
      if (failed) throw new Error('the seeded search timed out');
      const { rows } = await sql<WorkItem>`select key, key as title, assignee from sim_ticket where ${run.routine}::bigint = any (routines) order by key`.execute(world.db);
      return rows;
    },
  };
}

function engineLoop(world: World, index: number): Loop {
  const base: SchedulerSettings = {
    everyMs: passEveryMs,
    leaseMs,
    sources: sourcesByKind([seededSource(world, index)]),
    workflows: new Map([[post.name, post]]),
    now: () => Promise.resolve(now(world)),
  };
  const change = world.plan.mutant === undefined ? undefined : mutants[world.plan.mutant].change;
  const settings = change !== undefined && 'settings' in change ? change.settings(base, world.virtual) : base;
  const loop = scheduler(settings);
  return change !== undefined && 'loop' in change ? change.loop(loop) : loop;
}

async function startEngine(world: World, index: number): Promise<void> {
  const db = connect(world.url, 2);
  const stop = new AbortController();
  const loop = engineLoop(world, index);
  const done = world.virtual.start(() =>
    runLoop(loop, db, world.virtual.clock, stop.signal, line => {
      world.log.push(`engine ${String(index + 1)} ${line}`);
    }),
  );
  world.engines[index] = { db, loop, stop, done, crashed: false };
  await world.virtual.idle();
}

async function stopEngine(world: World, index: number): Promise<void> {
  const engine = world.engines[index];
  if (engine === undefined) return;
  engine.stop.abort();
  await engine.done;
  if (!engine.crashed) await engine.db.destroy();
  world.engines[index] = undefined;
}

async function restartCrashed(world: World): Promise<void> {
  for (const [index, engine] of world.engines.entries()) {
    if (engine?.crashed !== true) continue;
    await stopEngine(world, index);
    await startEngine(world, index);
  }
}

async function startStaggered(world: World, engines: number): Promise<void> {
  for (let index = 0; index < engines; index += 1) {
    if (index > 0) world.virtual.advance(now(world).getTime() + passEveryMs / 2 + 7);
    await startEngine(world, index);
  }
}

async function downtime(world: World): Promise<string> {
  for (const index of world.engines.keys()) await stopEngine(world, index);
  world.virtual.advance(now(world).getTime() + world.profile.downtimeSlots * routineEveryMs);
  await startStaggered(world, world.profile.engines);
  count(world, 'downtime');
  return `every engine stopped for ${String(world.profile.downtimeSlots)} slots and started again`;
}

async function applyMutant(db: Database, name: MutantName): Promise<void> {
  const { change } = mutants[name];
  if ('schema' in change) {
    for (const statement of change.schema) await sql.raw(statement).execute(db);
    return;
  }
  if (!('drop' in change)) return;
  const { rows } = await sql<{ ddl: string }>`
    select format('alter table %s drop constraint %I', conrelid::regclass, conname) as ddl
    from pg_constraint where conname = ${change.drop} and connamespace = 'public'::regnamespace
    union all
    select format('drop index %s', x.indexrelid::regclass)
    from pg_index x
    where x.indexrelid = to_regclass(${change.drop})
      and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))
    union all
    select format('drop trigger %I on %s', tgname, tgrelid::regclass)
    from pg_trigger where tgname = ${change.drop} and not tgisinternal`.execute(db);
  const [only, ...more] = rows;
  if (only === undefined || more.length > 0) throw new Error(`mutant ${name} must name exactly one constraint, index, or trigger, and it names ${String(rows.length)}`);
  await sql.raw(only.ddl).execute(db);
}

async function setUp(db: Database, profile: Profile, random: Random): Promise<{ readonly person: string; readonly routines: readonly string[]; readonly tickets: readonly string[] }> {
  const at = new Date(epoch);
  await ticketTable.execute(db);
  const person = await db.insertInto('person').values({ email: 'ada@example.com', name: 'Ada', jira_account_id: 'acc-ada' }).returning('id').executeTakeFirstOrThrow();
  const routines: string[] = [];
  for (const name of ['First', 'Second']) {
    const routine = await db.insertInto('routine').values({ creator_id: person.id }).returning('id').executeTakeFirstOrThrow();
    const action = randomUUID();
    await db.insertInto('human_action').values({ id: action, at, person_id: person.id, kind: 'edit_routine', routine_id: routine.id }).execute();
    await db
      .insertInto('routine_version')
      .values({
        routine_id: routine.id,
        version: 1,
        name,
        goal: 'Record a task for each ticket.',
        every: `${String(routineEveryMs / 1000)} seconds`,
        action_id: action,
        workflow: post.name,
        source: JSON.stringify({ kind: 'tickets' }),
        needs_repository: false,
      })
      .execute();
    routines.push(routine.id);
  }
  const tickets = ['T-1', 'T-2', 'T-3', 'T-4'];
  for (const [index, key] of tickets.entries()) {
    const seenBy = profile.sharedTickets && random() < 0.6 ? routines : [routines[index % routines.length] ?? ''];
    await sql`insert into sim_ticket values (${key}, ${pick(random, assignees) ?? null}, ${at}, ${`{${seenBy.join(',')}}`}::bigint[])`.execute(db);
  }
  return { person: person.id, routines, tickets };
}

async function summarize(db: Database): Promise<Summary> {
  const runs = await db.selectFrom('routine_run').select(['outcome', 'covers', 'reason', 'slot', 'lease_until', 'finished_at']).execute();
  const outcomes: Record<string, number> = {};
  for (const run of runs) outcomes[run.outcome ?? 'unfinished'] = (outcomes[run.outcome ?? 'unfinished'] ?? 0) + 1;
  const tasks = await db.selectFrom('task').select(eb => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
  const overlaps = await db.selectFrom('routine_overlap').select(eb => eb.fn.countAll<string>().as('count')).executeTakeFirstOrThrow();
  const presses = await db.selectFrom('human_action').select(eb => eb.fn.countAll<string>().as('count')).where('kind', '=', 'run_now').executeTakeFirstOrThrow();
  return {
    runs: runs.length,
    slots: new Set(runs.filter(run => run.slot !== null).map(run => run.slot?.toISOString())).size,
    outcomes,
    catchUps: runs.filter(run => run.covers > 1).map(run => run.covers),
    lostCollapsed: runs.filter(run => run.outcome === 'lost').length,
    tasks: Number(tasks.count),
    overlaps: Number(overlaps.count),
    presses: Number(presses.count),
    pressRuns: runs.filter(run => run.reason === 'run_now' && run.outcome !== null).length,
  };
}

async function outerStep(world: World): Promise<void> {
  await restartCrashed(world);
  const due = world.virtual.nextDue();
  const clock = now(world).getTime();
  if (due !== undefined && due <= clock + world.profile.stepMs && (world.quiet || world.random() < 0.6)) {
    const from = world.log.length;
    await world.virtual.fire();
    await checkStep(world, 'engine', world.log.slice(from).join('; ') || 'nothing due');
    return;
  }
  world.virtual.advance(clock + 1 + Math.floor(world.random() * world.profile.stepMs));
  const move = world.quiet ? undefined : weighted(world.random, world.profile.outer);
  if (move === undefined) {
    await checkStep(world, 'idle', 'time passed');
    return;
  }
  const detail = move === 'downtime' ? await downtime(world) : await personMove(world, move);
  await checkStep(world, move, detail);
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
    const seededWorld = await setUp(db, profile, random);
    const current: World = {
      db,
      url: scratch.url,
      plan,
      profile,
      random,
      virtual,
      engines: [],
      ...seededWorld,
      tally,
      log: [],
      trace: [],
      watched: undefined,
      failure: undefined,
      quiet: false,
      depth: 0,
      step: 0,
    };
    world = current;
    current.watched = await watch(db, new Date(epoch), passEveryMs);
    await startStaggered(current, profile.engines);
    while (current.step < plan.steps && current.failure === undefined) await outerStep(current);
    current.quiet = true;
    const quietUntil = now(current).getTime() + leaseMs + 2 * routineEveryMs + passEveryMs;
    while (current.failure === undefined && now(current).getTime() < quietUntil) await outerStep(current);
    if (current.failure === undefined) {
      const unsettled = await current.watched.settled(now(current));
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
