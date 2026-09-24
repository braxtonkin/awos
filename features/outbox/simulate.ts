import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { performer, type ActionSpec, type Limits, type Lookup, type Outcome, type Owed, type Owe } from '../../shared/actions.ts';
import { connect, refusal, type Database } from '../../shared/db/client.ts';
import { neverStops, realClock, runLoop, type Clock } from '../../shared/loop.ts';
import { inTransaction } from '../../shared/transaction.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { enqueue } from './enqueue.ts';
import { check, worldOf, type PropertyName, type Violation } from './invariants.ts';
import { claimNext, expire, guarded, outbox, performClaimed, registryOf, type Claimed, type Guards, type Lease, type Performed, type Registry } from './perform.ts';

export const profileName = z.enum(['mixed', 'crashes', 'two-engines', 'always-fails']);

export type ProfileName = z.infer<typeof profileName>;

type Weights = {
  readonly claimTask: number;
  readonly owe: number;
  readonly claimRow: number;
  readonly advance: number;
  readonly crash: number;
  readonly hang: number;
  readonly wake: number;
  readonly resolve: number;
  readonly expire: number;
  readonly retry: number;
  readonly approve: number;
  readonly stop: number;
  readonly race: number;
  readonly tick: number;
};

type Profile = {
  readonly engines: number;
  readonly performersPerEngine: number;
  readonly tasks: number;
  readonly fail: number;
  readonly landsLater: number;
  readonly refuse: number;
  readonly rollback: number;
  readonly failing: boolean;
  readonly stepMs: number;
  readonly weights: Weights;
};

const lease: Lease = { leaseMs: 5_000, marginMs: 500, maxTries: 3 };

const maxRetries = 1;

const steps = ['s1', 's2', 's3'] as const;

const calm: Weights = { claimTask: 1.5, owe: 3, claimRow: 4, advance: 8, crash: 0.5, hang: 0.4, wake: 0.6, resolve: 1, expire: 1.5, retry: 1, approve: 1, stop: 0.03, race: 0, tick: 0.4 };

export const profiles: Readonly<Record<ProfileName, Profile>> = {
  mixed: { engines: 2, performersPerEngine: 1, tasks: 4, fail: 0.15, landsLater: 0.5, refuse: 0.03, rollback: 0.15, failing: false, stepMs: 400, weights: calm },
  crashes: {
    engines: 2,
    performersPerEngine: 1,
    tasks: 4,
    fail: 0.3,
    landsLater: 0.7,
    refuse: 0.02,
    rollback: 0.1,
    failing: false,
    stepMs: 400,
    weights: { ...calm, crash: 2, hang: 2, wake: 0.4, resolve: 1.5, expire: 2, tick: 0.8 },
  },
  'two-engines': {
    engines: 2,
    performersPerEngine: 2,
    tasks: 4,
    fail: 0.1,
    landsLater: 0.5,
    refuse: 0.02,
    rollback: 0.1,
    failing: false,
    stepMs: 300,
    weights: { ...calm, claimRow: 5, crash: 0.3, race: 2 },
  },
  'always-fails': { engines: 2, performersPerEngine: 1, tasks: 3, fail: 1, landsLater: 0, refuse: 0, rollback: 0.1, failing: true, stepMs: 400, weights: { ...calm, crash: 0.3, stop: 0 } },
};

export const mutantName = z.enum([
  'no-claim',
  'no-marker',
  'no-expiry',
  'out-of-order',
  'no-owed-count',
  'done-at-claim',
  'no-lease-check',
  'release-on-failure',
  'no-cap',
  'no-park',
  'no-drop-behind',
  'no-reowe',
  'enqueue-apart',
  'unfair',
]);

export type MutantName = z.infer<typeof mutantName>;

type Mutant = {
  readonly guard: string;
  readonly breaks: readonly [PropertyName, ...PropertyName[]];
  readonly profile: ProfileName;
  readonly off?: keyof Guards;
  readonly drops?: string;
};

export const mutants: Readonly<Record<MutantName, Mutant>> = {
  'no-claim': { guard: 'ClaimIsExclusive', breaks: ['EffectAtMostOnce', 'OneLivePerformerPerRow'], profile: 'mixed', off: 'ClaimIsExclusive' },
  'no-marker': { guard: 'MarkerCheckedBeforeWrite', breaks: ['EffectAtMostOnce'], profile: 'crashes', off: 'MarkerCheckedBeforeWrite' },
  'no-expiry': { guard: 'LeaseExpires', breaks: ['EveryOwedActionSettles'], profile: 'crashes', off: 'LeaseExpires' },
  'out-of-order': { guard: 'InOrderPerTask', breaks: ['ActionsInOrderPerTask'], profile: 'mixed', off: 'InOrderPerTask' },
  'no-owed-count': { guard: 'ClaimWaitsForOwedActions', breaks: ['NextStageWaitsForOwedActions'], profile: 'mixed', drops: 'task_counts_its_owed_actions' },
  'done-at-claim': { guard: 'DoneFollowsEffect', breaks: ['DoneMeansEffect'], profile: 'mixed', off: 'DoneFollowsEffect' },
  'no-lease-check': { guard: 'EffectWithinLease', breaks: ['EffectAtMostOnce'], profile: 'crashes', off: 'EffectWithinLease' },
  'release-on-failure': { guard: 'FailedCallKeepsClaim', breaks: ['EffectAtMostOnce'], profile: 'crashes', off: 'FailedCallKeepsClaim' },
  'no-cap': { guard: 'RetriesAreCapped', breaks: ['EveryOwedActionSettles'], profile: 'always-fails', off: 'RetriesAreCapped' },
  'no-park': { guard: 'FailureParksTask', breaks: ['EveryOwedActionSettles'], profile: 'always-fails', drops: 'failed_row_parks_its_task' },
  'no-drop-behind': { guard: 'DoneTaskDropsRowsBehindFailure', breaks: ['EveryOwedActionSettles'], profile: 'crashes', drops: 'done_task_drops_rows_behind_a_failure' },
  'no-reowe': { guard: 'RetryReowesFailedRows', breaks: ['EveryOwedActionSettles'], profile: 'always-fails', off: 'RetryReowesFailedRows' },
  'enqueue-apart': { guard: 'EnqueueWithState', breaks: ['NoEffectWithoutOwingState'], profile: 'mixed' },
  unfair: { guard: 'PerformerIsFair', breaks: ['EveryOwedActionSettles'], profile: 'mixed' },
};

export const noMutantYet: Readonly<Record<string, readonly string[]>> = {
  'enqueue draws each key from 18 random bytes, so no simulated move can repeat one': ['idempotency_key_is_unique', 'marker_cannot_be_guessed'],
  'enqueue numbers rows while it holds the task row, so no simulated move can give two rows one place': ['one_row_per_place_in_its_task'],
  'each statement that claims, settles, or releases a row writes these columns together, so dropping one check changes no simulated state': [
    'claim_holds_a_lease',
    'only_owed_rows_are_claimed',
    'settled_row_says_when',
    'performed_row_keeps_its_result',
    'failed_row_keeps_its_error',
  ],
  'it speeds finding the unsettled rows of a task and refuses nothing': ['unsettled_rows_by_task'],
  'enqueue takes the task and the identity from rows that exist, so no simulated move names a missing one': ['row_of_task', 'row_acts_as_a_person'],
};

export type Plan = { readonly profile: ProfileName; readonly seeds: readonly number[]; readonly steps: number; readonly mutant?: MutantName };

export type Failure = { readonly step: number; readonly move: string; readonly broken: readonly Violation[] };

export type Entry = { readonly step: number; readonly at: number; readonly move: string };

export type Run = {
  readonly plan: Plan;
  readonly seed: number;
  readonly steps: number;
  readonly failure: Failure | undefined;
  readonly tally: Readonly<Record<string, number>>;
  readonly done: number;
  readonly duplicates: number;
  readonly failedRows: readonly FailedRow[];
  readonly reowed: number;
  readonly trace: readonly Entry[];
};

export type FailedRow = { readonly row: string; readonly tries: number; readonly taskState: string; readonly noteHasError: boolean };

type Random = () => number;

type GateAt = 'find' | 'call' | 'landed';

type Gate = { readonly at: GateAt; readonly release: () => void };

type Busy = { readonly claimed: Claimed; readonly simClaim: string; readonly run: Promise<Performed> };

type Slot = { readonly id: string; readonly engine: number; stalled: boolean; gate: Gate | undefined; arrived: () => void; busy: Busy | undefined };

type Pending = { readonly marker: string; readonly keyed: boolean; readonly deadline: number };

type Target = {
  readonly db: Database;
  readonly now: () => number;
  readonly random: Random;
  readonly profile: Pick<Profile, 'fail' | 'landsLater' | 'refuse' | 'failing'>;
  readonly pending: Pending[];
};

type Sim = Target & {
  readonly db: Database;
  readonly engines: readonly Database[];
  readonly profile: Profile;
  readonly guards: Guards;
  readonly mutant: MutantName | undefined;
  readonly random: Random;
  readonly clock: Clock;
  readonly slots: readonly Slot[];
  readonly pending: Pending[];
  readonly retried: Map<string, number>;
  readonly failedBefore: Set<string>;
  readonly tally: Map<string, number>;
  time: number;
  step: number;
  readonly steps: number;
  reowed: number;
};

const epoch = Date.parse('2026-01-01T00:00:00.000Z');

const lanes = Math.min(16, availableParallelism());

const traceTail = 40;

function seeded(seed: number): Random {
  let state = (seed * 2654435761) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: Random, items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];

function weighted<T>(random: Random, choices: readonly (readonly [T, number])[]): T | undefined {
  let roll = random() * choices.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [choice, weight] of choices) {
    roll -= weight;
    if (roll < 0) return choice;
  }
  return choices.at(-1)?.[0];
}

const count = (sim: Sim, outcome: string): void => {
  sim.tally.set(outcome, (sim.tally.get(outcome) ?? 0) + 1);
};

const noop = (): void => undefined;

const simPayload = z.object({ owing: z.uuid(), text: z.string().min(1) });

const simResult = z.object({ marker: z.string().min(1) });

const keyedKind: ActionSpec<'sim.keyed', z.infer<typeof simPayload>, z.infer<typeof simResult>> = { kind: 'sim.keyed', payload: simPayload, result: simResult };

const unkeyedKind: ActionSpec<'sim.unkeyed', z.infer<typeof simPayload>, z.infer<typeof simResult>> = { kind: 'sim.unkeyed', payload: simPayload, result: simResult };

async function land(sim: Target, marker: string, keyed: boolean): Promise<void> {
  const at = new Date(sim.now());
  if (keyed) await sql`insert into sim_effect (marker, at) select ${marker}, ${at} where not exists (select 1 from sim_effect where marker = ${marker})`.execute(sim.db);
  else await sql`insert into sim_effect (marker, at) values (${marker}, ${at})`.execute(sim.db);
}

async function landed(sim: Target, marker: string): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`select exists (select 1 from sim_effect where marker = ${marker}) as found`.execute(sim.db);
  return rows[0]?.found === true;
}

function gateAt(slot: Slot | undefined, at: GateAt): Promise<void> {
  if (slot === undefined) return Promise.resolve();
  return new Promise(resolve => {
    slot.gate = { at, release: resolve };
    slot.arrived();
  });
}

function fakeCall(sim: Target, slot: Slot | undefined, keyed: boolean, faults: boolean) {
  return async (owed: Owed<unknown>, limits: Limits): Promise<Outcome<z.infer<typeof simResult>>> => {
    await gateAt(slot, 'call');
    if (sim.now() >= limits.deadline.getTime()) return { failed: 'The call passed its deadline before it was sent.' };
    if (sim.profile.failing || (faults && sim.random() < sim.profile.fail)) {
      if (faults && sim.random() < sim.profile.landsLater) sim.pending.push({ marker: owed.marker, keyed, deadline: limits.deadline.getTime() });
      return { failed: 'The target answered 503 Service Unavailable.' };
    }
    if (keyed && faults && sim.random() < sim.profile.refuse) return { refused: { reason: 'The target refused the change it was asked for.', head: null } };
    await land(sim, owed.marker, keyed);
    await gateAt(slot, 'landed');
    return { done: { marker: owed.marker } };
  };
}

function fakeFind(sim: Target, slot: Slot | undefined) {
  return async (owed: Owed<unknown>): Promise<Lookup<z.infer<typeof simResult>>> => {
    await gateAt(slot, 'find');
    return (await landed(sim, owed.marker)) ? { found: { marker: owed.marker } } : { absent: true };
  };
}

export const registryFor = (sim: Target, slot: Slot | undefined, faults: boolean): Registry =>
  registryOf({
    keyed: performer(keyedKind, { catches: 'duplicates', call: fakeCall(sim, slot, true, faults) }),
    unkeyed: performer(unkeyedKind, { catches: 'nothing', find: fakeFind(sim, slot), call: fakeCall(sim, slot, false, faults) }),
  });

const arrival = (slot: Slot): Promise<'gate'> =>
  new Promise(resolve => {
    slot.arrived = () => {
      resolve('gate');
    };
  });

async function release(sim: Sim, slot: Slot, busy: Busy): Promise<void> {
  await sql`update sim_claim set released_at = ${new Date(sim.time)} where id = ${busy.simClaim} and released_at is null`.execute(sim.db);
  slot.busy = undefined;
  slot.gate = undefined;
  slot.stalled = false;
}

async function driveUntilGate(sim: Sim, slot: Slot, busy: Busy, reached: Promise<'gate'>): Promise<string> {
  const outcome = await Promise.race([reached, busy.run]);
  if (outcome === 'gate') return `${slot.id} waits at ${slot.gate?.at ?? 'no gate'}`;
  count(sim, outcome);
  await release(sim, slot, busy);
  return `${slot.id} ${outcome} row ${busy.claimed.row}`;
}

function engineOf(sim: Sim, slot: Slot): Database {
  const engine = sim.engines[slot.engine];
  if (engine === undefined) throw new Error(`The simulator has no engine ${String(slot.engine)}.`);
  return engine;
}

async function startClaimed(sim: Sim, slot: Slot, claimed: Claimed): Promise<string> {
  const { rows } = await sql<{ id: string }>`insert into sim_claim (row_id, performer, claimed_at, lease_until)
    values (${claimed.row}, ${slot.id}, ${new Date(sim.time)}, ${claimed.leaseUntil}) returning id`.execute(sim.db);
  const simClaim = rows[0]?.id;
  if (simClaim === undefined) throw new Error('The simulator could not record a claim.');
  const own = registryFor(sim, slot, true).get(claimed.kind);
  if (own === undefined) throw new Error(`The simulator claimed ${claimed.kind}, which it does not perform.`);
  count(sim, 'claimed');
  const reached = arrival(slot);
  const busy: Busy = { claimed, simClaim, run: performClaimed(engineOf(sim, slot), sim.guards, own, claimed, sim.clock, lease) };
  slot.busy = busy;
  return driveUntilGate(sim, slot, busy, reached);
}

async function claimRow(sim: Sim, slot: Slot): Promise<string> {
  const { claimed, dropped } = await claimNext(engineOf(sim, slot), sim.guards, registryFor(sim, undefined, false), new Date(sim.time), lease);
  for (let row = 0; row < dropped; row += 1) count(sim, 'dropped');
  if (claimed === undefined) return `${slot.id} claimed no row and dropped ${String(dropped)}`;
  return startClaimed(sim, slot, claimed);
}

async function race(sim: Sim, first: Slot, second: Slot): Promise<string> {
  const registry = registryFor(sim, undefined, false);
  const claims = await Promise.all([first, second].map(slot => claimNext(engineOf(sim, slot), sim.guards, registry, new Date(sim.time), lease)));
  const lines: string[] = [];
  for (const [index, slot] of [first, second].entries()) {
    const claimed = claims[index]?.claimed;
    if (claimed !== undefined) lines.push(await startClaimed(sim, slot, claimed));
  }
  return `race: ${lines.length === 0 ? 'no row' : lines.join('; ')}`;
}

async function advance(sim: Sim, slot: Slot, busy: Busy): Promise<string> {
  const gate = slot.gate;
  if (gate === undefined) throw new Error(`${slot.id} is busy without a gate.`);
  slot.gate = undefined;
  const reached = arrival(slot);
  gate.release();
  return driveUntilGate(sim, slot, busy, reached);
}

async function crash(sim: Sim, slot: Slot, busy: Busy): Promise<string> {
  const at = slot.gate?.at ?? 'no gate';
  await release(sim, slot, busy);
  count(sim, `crash at ${at}`);
  return `${slot.id} crashed at ${at} holding row ${busy.claimed.row}`;
}

async function resolvePending(sim: Sim, pending: Pending): Promise<string> {
  sim.pending.splice(sim.pending.indexOf(pending), 1);
  const lands = sim.random() < 0.5;
  if (lands) await land(sim, pending.marker, pending.keyed);
  count(sim, lands ? 'late request landed' : 'late request lost');
  return `a failed call's request ${lands ? 'landed' : 'was lost'}`;
}

async function resolveOverdue(sim: Sim): Promise<void> {
  for (const pending of sim.pending.filter(entry => entry.deadline <= sim.time)) await resolvePending(sim, pending);
}

async function runExpire(sim: Sim, db: Database): Promise<string> {
  await resolveOverdue(sim);
  const lapsed = await expire(db, sim.guards, new Date(sim.time), lease);
  for (const entry of lapsed) {
    count(sim, entry.state === 'failed' ? 'failed at cap' : 'lapsed');
    if (entry.tries === 1 && sim.failedBefore.has(entry.row)) sim.reowed += 1;
    if (entry.state === 'failed') sim.failedBefore.add(entry.row);
  }
  return `expire: ${String(lapsed.length)} lapsed`;
}

type TaskRow = {
  readonly id: string;
  readonly step: string;
  readonly state: string;
  readonly waiting_on: string | null;
  readonly review_attempt: string | null;
  readonly live: boolean;
};

async function tasksOf(sim: Sim): Promise<readonly TaskRow[]> {
  const { rows } = await sql<TaskRow>`select t.id, t.step, t.state, t.waiting_on, t.review_attempt,
      exists (select 1 from attempt a where a.task_id = t.id and a.finished_at is null) as live
    from task t order by t.id`.execute(sim.db);
  return rows;
}

async function claimTask(sim: Sim, task: TaskRow): Promise<string> {
  try {
    await sql`insert into attempt (task_id, routine_id, routine_version, step, epoch, run_as_id, started_at, lease_until)
      select t.id, t.routine_id, 1, t.step, t.epoch, 1, ${new Date(sim.time)}, ${new Date(sim.time + 86_400_000)} from task t where t.id = ${task.id}`.execute(sim.db);
    count(sim, 'next stage claimed');
    return `claimed the next stage of task ${task.id}`;
  } catch (error) {
    const found = refusal(error);
    if (found?.kind === 'foreign_key' && found.name === 'live_attempt_matches_ready_task') {
      count(sim, 'next stage refused');
      return `the claim of task ${task.id} was refused`;
    }
    throw error;
  }
}

class RolledBack extends Error {}

const nextOf = (step: string): string | undefined => steps[steps.indexOf(step as (typeof steps)[number]) + 1];

async function moveTask(db: Database, sim: Sim, task: TaskRow, token: string): Promise<void> {
  const next = nextOf(task.step);
  const gated = next !== undefined && sim.random() < 0.25;
  const standing =
    next === undefined
      ? sql`state = 'done'`
      : gated
        ? sql`step = ${next}, state = 'waiting', waiting_on = 'approval', waiting_reason = 'Approve the step before it.',
              review_attempt = (select max(a.id) from attempt a where a.task_id = task.id)`
        : sql`step = ${next}, state = 'ready'`;
  await sql`update task set ${standing} where id = ${task.id}`.execute(db);
  await sql`insert into sim_owing (token, task_id) values (${token}, ${task.id})`.execute(db);
  if (sim.random() < sim.profile.rollback) throw new RolledBack();
}

async function finishAttempt(db: Database, sim: Sim, task: TaskRow): Promise<void> {
  await db
    .updateTable('attempt')
    .set({ finished_at: new Date(sim.time), verdict: 'pass', output: JSON.stringify({ outcome: 'done', summary: 'Simulated.', blocks: [] }) })
    .where('attempt.task_id', '=', task.id)
    .where('attempt.finished_at', 'is', null)
    .execute();
}

function owedActions(sim: Sim, token: string): readonly Owe[] {
  const rows = 1 + Math.floor(sim.random() * 2);
  return Array.from({ length: rows }, (_, index) => ({
    kind: sim.random() < 0.5 ? keyedKind.kind : unkeyedKind.kind,
    payload: simPayload.parse({ owing: token, text: `Row ${String(index + 1)} of a verdict.` }),
  }));
}

async function oweActions(sim: Sim, task: TaskRow): Promise<string> {
  const token = randomUUID();
  const actions = owedActions(sim, token);
  const owing = { task: task.id, actsAs: '1', now: new Date(sim.time) };
  const [db = sim.db] = sim.engines;
  try {
    if (sim.mutant === 'enqueue-apart') {
      await finishAttempt(db, sim, task);
      await inTransaction(db, tx => enqueue(tx, owing, actions));
      await db.transaction().execute(tx => moveTask(tx, sim, task, token));
    } else {
      await inTransaction(db, async tx => {
        await finishAttempt(tx, sim, task);
        await moveTask(tx, sim, task, token);
        await enqueue(tx, owing, actions);
      });
    }
    count(sim, 'owed');
    return `task ${task.id} owed ${String(actions.length)} rows`;
  } catch (error) {
    if (!(error instanceof RolledBack)) throw error;
    count(sim, 'rolled back');
    return `task ${task.id}'s verdict rolled back`;
  }
}

async function retry(sim: Sim, task: TaskRow): Promise<string> {
  sim.retried.set(task.id, (sim.retried.get(task.id) ?? 0) + 1);
  await sim.db.transaction().execute(async tx => {
    await tx.insertInto('human_action').values({ id: randomUUID(), at: new Date(sim.time), person_id: '1', kind: 'retry_task', task_id: task.id }).execute();
    await sql`update task set state = 'ready', waiting_on = null, waiting_reason = null, lost = 0, epoch = epoch + 1
      where id = ${task.id} and state = 'waiting' and waiting_on = 'retry'`.execute(tx);
  });
  count(sim, 'retried');
  return `a person pressed Retry on task ${task.id}`;
}

async function approve(sim: Sim, task: TaskRow, review: string): Promise<string> {
  await sim.db.transaction().execute(async tx => {
    await tx.insertInto('human_action').values({ id: randomUUID(), at: new Date(sim.time), person_id: '1', kind: 'approve', task_id: task.id, attempt_id: review }).execute();
    await sql`update task set state = 'ready', waiting_on = null, waiting_reason = null, review_attempt = null, epoch = epoch + 1
      where id = ${task.id} and state = 'waiting' and waiting_on = 'approval'`.execute(tx);
  });
  count(sim, 'approved');
  return `a person approved task ${task.id}`;
}

async function stop(sim: Sim, task: TaskRow): Promise<string> {
  const id = randomUUID();
  await sim.db.transaction().execute(async tx => {
    await tx.insertInto('human_action').values({ id, at: new Date(sim.time), person_id: '1', kind: 'stop_task', task_id: task.id }).execute();
    await tx.updateTable('attempt').set({ finished_at: new Date(sim.time), verdict: 'stopped' }).where('attempt.task_id', '=', task.id).where('attempt.finished_at', 'is', null).execute();
    await sql`update task set state = 'stopped', stopped_by = ${id}, waiting_on = null, waiting_reason = null, review_attempt = null where id = ${task.id}`.execute(tx);
  });
  count(sim, 'stopped');
  return `a person stopped task ${task.id}`;
}

type Move = readonly [string, () => Promise<string>];

function movesFor(sim: Sim, tasks: readonly TaskRow[]): readonly (readonly [Move, number])[] {
  const { weights } = sim.profile;
  const moves: (readonly [Move, number])[] = [];
  const add = (weight: number, name: string, run: () => Promise<string>): void => {
    if (weight > 0) moves.push([[name, run], weight]);
  };
  const idle = sim.slots.filter(slot => slot.busy === undefined);
  const fair = sim.mutant !== 'unfair' || sim.step <= sim.steps / 2;
  for (const task of tasks) {
    if (task.state === 'ready' && !task.live) add(weights.claimTask, `claim-task ${task.id}`, () => claimTask(sim, task));
    if (task.live) add(weights.owe, `owe ${task.id}`, () => oweActions(sim, task));
    if (task.state === 'waiting' && task.waiting_on === 'retry' && (sim.retried.get(task.id) ?? 0) < maxRetries) add(weights.retry, `retry ${task.id}`, () => retry(sim, task));
    const review = task.review_attempt;
    if (task.state === 'waiting' && task.waiting_on === 'approval' && review !== null) add(weights.approve, `approve ${task.id}`, () => approve(sim, task, review));
    if (task.state !== 'done' && task.state !== 'stopped') add(weights.stop, `stop ${task.id}`, () => stop(sim, task));
  }
  for (const slot of sim.slots) {
    const { busy } = slot;
    if (busy === undefined) {
      if (fair) add(weights.claimRow, `claim-row ${slot.id}`, () => claimRow(sim, slot));
      continue;
    }
    if (!slot.stalled) add(weights.advance, `advance ${slot.id}`, () => advance(sim, slot, busy));
    add(weights.crash, `crash ${slot.id}`, () => crash(sim, slot, busy));
    if (slot.gate?.at === 'call' && !slot.stalled) {
      add(weights.hang, `hang ${slot.id}`, () => {
        slot.stalled = true;
        count(sim, 'hung');
        return Promise.resolve(`${slot.id} stalled before its call`);
      });
    }
    if (slot.stalled) {
      add(weights.wake, `wake ${slot.id}`, () => {
        slot.stalled = false;
        return Promise.resolve(`${slot.id} woke`);
      });
    }
  }
  sim.engines.forEach((engine, index) => {
    add(weights.expire / sim.engines.length, `expire ${String(index)}`, () => runExpire(sim, engine));
  });
  const [waiting] = sim.pending;
  if (waiting !== undefined) add(weights.resolve, 'resolve', () => resolvePending(sim, pick(sim.random, sim.pending) ?? waiting));
  const [first, second] = [idle.find(slot => slot.engine === 0), idle.find(slot => slot.engine === 1)];
  if (fair && first !== undefined && second !== undefined) add(weights.race, 'race', () => race(sim, first, second));
  add(weights.tick, 'tick', () => {
    sim.time += lease.leaseMs / 2;
    return Promise.resolve('the clock jumped half a lease');
  });
  return moves;
}

async function finishBusy(sim: Sim): Promise<void> {
  for (const slot of sim.slots) {
    slot.stalled = false;
    for (let turn = 0; turn < 10 && slot.busy !== undefined; turn += 1) await advance(sim, slot, slot.busy);
  }
  for (const pending of [...sim.pending]) await resolvePending(sim, pending);
}

async function drain(sim: Sim): Promise<void> {
  await finishBusy(sim);
  if (sim.mutant === 'unfair') return;
  const [db = sim.db] = sim.engines;
  const loop = outbox({ everyMs: 1_000, clock: sim.clock, registry: registryFor(sim, undefined, false), ...lease }, sim.guards);
  for (let pass = 0; pass < 12; pass += 1) {
    for (const task of await tasksOf(sim)) {
      if (task.state === 'waiting' && task.waiting_on === 'retry' && (sim.retried.get(task.id) ?? 0) < maxRetries) await retry(sim, task);
    }
    sim.time += lease.leaseMs + lease.marginMs;
    let rounds = 0;
    await runExpire(sim, db);
    await loop.pass(db, { now: new Date(sim.time), late: () => (rounds += 1) > 200, stop: neverStops });
  }
}

async function dropGuard(db: Database, name: string): Promise<void> {
  await sql`drop trigger ${sql.id(name)} on outbox`.execute(db);
}

async function failedRows(db: Database): Promise<readonly FailedRow[]> {
  const { rows } = await sql<{ row: string; tries: number; task_state: string; note_has_error: boolean }>`
    select o.id as row, o.tries, t.state as task_state, coalesce(strpos(t.waiting_reason, o.last_error) > 0, false) as note_has_error
    from outbox o join task t on t.id = o.task_id where o.state = 'failed' order by o.id`.execute(db);
  return rows.map(row => ({ row: row.row, tries: row.tries, taskState: row.task_state, noteHasError: row.note_has_error }));
}

async function scalar(db: Database, query: RawBuilder<{ value: string }>): Promise<number> {
  const { rows } = await query.execute(db);
  return Number(rows[0]?.value ?? 0);
}

async function runSeed(postgres: TestPostgres, plan: Plan, seed: number): Promise<Run> {
  const mutant = plan.mutant === undefined ? undefined : mutants[plan.mutant];
  const profile = profiles[plan.profile];
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  const engines = Array.from({ length: profile.engines }, () => connect(scratch.url, 3));
  const trace: Entry[] = [];
  const sim: Sim = {
    db,
    engines,
    profile,
    guards: mutant?.off === undefined ? guarded : { ...guarded, [mutant.off]: false },
    mutant: plan.mutant,
    random: seeded(seed),
    now: () => sim.time,
    clock: { now: () => new Date(sim.time), sleep: () => Promise.resolve() },
    slots: Array.from({ length: profile.engines * profile.performersPerEngine }, (_, index) => ({
      id: `p${String(index + 1)}`,
      engine: index % profile.engines,
      stalled: false,
      gate: undefined,
      arrived: noop,
      busy: undefined,
    })),
    pending: [],
    retried: new Map(),
    failedBefore: new Set(),
    tally: new Map(),
    time: epoch,
    step: 0,
    steps: plan.steps,
    reowed: 0,
  };
  try {
    for (const statement of worldOf(profile.tasks)) await statement.execute(db);
    if (mutant?.drops !== undefined) await dropGuard(db, mutant.drops);
    const ended = async (failure: Failure | undefined): Promise<Run> => ({
      plan,
      seed,
      steps: sim.step,
      failure,
      tally: Object.fromEntries(sim.tally),
      done: await scalar(db, sql<{ value: string }>`select count(*) as value from task where state = 'done'`),
      duplicates: await scalar(db, sql<{ value: string }>`select count(*) as value from (select marker from sim_effect group by marker having count(*) > 1) d`),
      failedRows: await failedRows(db),
      reowed: sim.reowed,
      trace: failure === undefined ? trace.slice(-traceTail) : trace,
    });
    while (sim.step < plan.steps) {
      sim.step += 1;
      await resolveOverdue(sim);
      const chosen = weighted(sim.random, movesFor(sim, await tasksOf(sim)));
      const [name, run] = chosen ?? ['idle', () => Promise.resolve('nothing to do')];
      const detail = await run();
      trace.push({ step: sim.step, at: sim.time - epoch, move: `${name}: ${detail}` });
      const broken = await check(db, 'each-step');
      if (broken.length > 0) return await ended({ step: sim.step, move: name, broken });
      sim.time += 1 + Math.floor(sim.random() * profile.stepMs);
    }
    await drain(sim);
    trace.push({ step: sim.step, at: sim.time - epoch, move: 'quiet phase' });
    const broken = [...(await check(db, 'each-step')), ...(await check(db, 'after-quiet-phase'))];
    return await ended(broken.length > 0 ? { step: sim.step, move: 'the quiet phase ended', broken } : undefined);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${plan.profile} seed ${String(seed)}${plan.mutant === undefined ? '' : ` without ${plan.mutant}`} threw after step ${String(sim.step)}: ${reason}`, { cause: error });
  } finally {
    await Promise.all(engines.map(engine => engine.destroy()));
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

export type Catalog = { readonly guards: number; readonly unlisted: readonly string[]; readonly absent: readonly string[] };

export async function checkCatalog(postgres: TestPostgres): Promise<Catalog> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    const { rows } = await sql<{ name: string }>`
      select c.conname as name
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.conrelid = 'outbox'::regclass
        and not (c.contype = 'p' and c.conname = 'outbox_pkey')
        and not (c.contype = 'n' and c.conname = 'outbox_' || a.attname || '_not_null')
      union all
      select i.relname from pg_index x join pg_class i on i.oid = x.indexrelid
      where x.indrelid = 'outbox'::regclass
        and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))
      union all
      select g.tgname from pg_trigger g where g.tgrelid = 'outbox'::regclass and not g.tgisinternal`.execute(db);
    const guards = new Set(rows.map(row => row.name));
    const listed = [...Object.values(mutants).flatMap(mutant => (mutant.drops === undefined ? [] : [mutant.drops])), ...Object.values(noMutantYet).flat()];
    return {
      guards: guards.size,
      unlisted: [...guards].filter(name => !listed.includes(name)).sort(),
      absent: listed.filter(name => !guards.has(name)).sort(),
    };
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

const instantTarget = (db: Database): Target => ({ db, now: () => Date.now(), random: seeded(1), profile: { fail: 0, landsLater: 0, refuse: 0, failing: false }, pending: [] });

export async function probeRollback(postgres: TestPostgres): Promise<{ readonly rows: number; readonly effects: number }> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  try {
    for (const statement of worldOf(1)) await statement.execute(db);
    const now = new Date(epoch);
    const owed = [{ kind: unkeyedKind.kind, payload: simPayload.parse({ owing: randomUUID(), text: 'Owed in a transaction that rolls back.' }) }];
    await inTransaction(db, async tx => {
      await enqueue(tx, { task: '1', actsAs: '1', now }, owed);
      throw new RolledBack();
    }).catch((error: unknown) => {
      if (!(error instanceof RolledBack)) throw error;
    });
    const clock = realClock;
    await outbox({ everyMs: 1_000, clock, registry: registryFor(instantTarget(db), undefined, false), ...lease }).pass(db, { now: clock.now(), late: () => false, stop: neverStops });
    return {
      rows: await scalar(db, sql<{ value: string }>`select count(*) as value from outbox`),
      effects: await scalar(db, sql<{ value: string }>`select count(*) as value from sim_effect`),
    };
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

export type Throughput = { readonly rows: number; readonly perSecond: number; readonly medianMs: number };

const medianOf = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function oweAndWait(db: Database, tasks: number, rowsPerTask: number): Promise<Throughput> {
  const committed = new Map<string, number>();
  for (let task = 1; task <= tasks; task += 1) {
    const owed = Array.from({ length: rowsPerTask }, () => ({ kind: unkeyedKind.kind, payload: simPayload.parse({ owing: randomUUID(), text: 'Timed.' }) }));
    const ids = await inTransaction(db, tx => enqueue(tx, { task: String(task), actsAs: '1', now: new Date() }, owed));
    const at = Date.now();
    for (const id of ids) committed.set(id, at);
  }
  const deadline = Date.now() + 120_000;
  while ((await scalar(db, sql<{ value: string }>`select count(*) as value from outbox where state = 'owed'`)) > 0) {
    if (Date.now() > deadline) throw new Error('The outbox did not perform the probe rows within 2 minutes.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const { rows } = await sql<{ id: string; at: Date }>`select o.id, e.at from outbox o join sim_effect e on e.marker = o.idempotency_key
    where o.id in (${sql.join([...committed.keys()])})`.execute(db);
  const effects = rows.map(row => row.at.getTime());
  const spanMs = Math.max(1, Math.max(...effects) - Math.min(...effects));
  return { rows: rows.length, perSecond: rows.length <= 1 ? Number.POSITIVE_INFINITY : (rows.length * 1000) / spanMs, medianMs: medianOf(rows.map(row => row.at.getTime() - (committed.get(row.id) ?? 0))) };
}

export async function probeThroughput(postgres: TestPostgres, everyMs: number): Promise<readonly (Throughput & { readonly kind: 'batch' | 'single' })[]> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 4);
  const stop = new AbortController();
  try {
    for (const statement of worldOf(50)) await statement.execute(db);
    const clock = realClock;
    const loop = outbox({ everyMs, clock, registry: registryFor(instantTarget(db), undefined, false), ...lease });
    const running = runLoop(loop, db, clock, stop.signal, noop);
    const probes: (Throughput & { readonly kind: 'batch' | 'single' })[] = [];
    for (let round = 0; round < 3; round += 1) {
      probes.push({ kind: 'batch', ...(await oweAndWait(db, 50, 10)) }, { kind: 'single', ...(await oweAndWait(db, 1, 1)) });
    }
    stop.abort();
    await running;
    return probes;
  } finally {
    stop.abort();
    await db.destroy();
    await scratch.drop();
  }
}
