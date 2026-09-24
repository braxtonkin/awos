import { createHash, randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { setImmediate, setTimeout as wait } from 'node:timers/promises';
import { sql } from 'kysely';
import { z } from 'zod';
import { connect, refusal, type Database } from '../../shared/db/client.ts';
import type { TaskState } from '../../shared/db/types.ts';
import { runLoop, type Clock, type Loop } from '../../shared/loop.ts';
import { outcomes, review as reviewSchema, type Answer } from '../../shared/review.ts';
import { step, type Failure as StepFailure, type StepKind, type StepVerdict, type Workflow } from '../../shared/workflow.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { act, advance, noTurnToStop, approveFromOutside, note, type PersonAction, type Report } from './advance.ts';
import { claim, claimable, renew } from './claim.ts';
import { logLostApprovals, loseApprovals, watch, type PropertyName, type Violation } from './invariants.ts';
import { coreRunAs } from './run-as.ts';
import { reaper } from './reaper.ts';
import { workflowsByName } from './start.ts';

export const profileName = z.enum(['default', 'races', 'hangs', 'verdicts', 'people', 'reviews', 'needs-input', 'mixed', 'behavior', 'environment', 'crashes', 'db-pause', 'two-engines']);

export type ProfileName = z.infer<typeof profileName>;

export const mutantName = z.enum([
  'one_live_attempt_per_task',
  'finished_attempt_is_final',
  'live_attempt_matches_ready_task',
  'attempt_runs_as_a_person',
  'one_decision_per_review',
  'done_task_is_final',
  'task_repository_when_needed',
  'send_back_has_a_note',
  'one_target',
  'target_fits_kind',
]);

export type MutantName = z.infer<typeof mutantName>;

export const mutants: Readonly<Record<MutantName, readonly [PropertyName, ...PropertyName[]]>> = {
  one_live_attempt_per_task: ['OneLiveAttempt'],
  finished_attempt_is_final: ['LateWriteChangesNothing'],
  live_attempt_matches_ready_task: ['LiveAttemptMeansReady', 'LiveAttemptIsCurrent'],
  attempt_runs_as_a_person: ['AttemptRunsAsAPerson'],
  one_decision_per_review: ['ApproveNamesTheWaitingReview'],
  done_task_is_final: ['DoneIsFinal'],
  task_repository_when_needed: ['TaskHasItsRepository'],
  send_back_has_a_note: ['SendBackCarriesItsNote'],
  one_target: ['ActionHasOneTarget'],
  target_fits_kind: ['ActionTargetFitsItsKind'],
};

export const engineMutantName = z.enum(['no-reaper', 'early-reap', 'no-grace', 'no-fence']);

export type EngineMutantName = z.infer<typeof engineMutantName>;

type EngineMutant = { readonly profile: ProfileName; readonly breaks: readonly [PropertyName, ...PropertyName[]]; readonly loop: (loop: Loop) => Loop | undefined };

export const engineMutants: Readonly<Record<EngineMutantName, EngineMutant>> = {
  'no-reaper': { profile: 'crashes', breaks: ['EveryTaskSettles'], loop: () => undefined },
  'early-reap': { profile: 'crashes', breaks: ['ReleasedOnlyAfterItsLease'], loop: loop => ({ ...loop, pass: (db, pass) => loop.pass(db, { ...pass, now: new Date(pass.now.getTime() + loop.everyMs) }) }) },
  'no-grace': { profile: 'db-pause', breaks: ['ReleasedWithinOneInterval'], loop: ({ name, everyMs, pass }) => ({ name, everyMs, pass }) },
  'no-fence': { profile: 'db-pause', breaks: ['ReleasedWithinOneInterval'], loop: loop => ({ ...loop, pass: (db, { now }) => loop.pass(db, { now, late: () => false }) }) },
};

const failedToVerify = 'Verify found the behavior still wrong in 3 rounds. Read its evidence on this page, fix the ticket or the plan, then press Retry to run Verify again.';

const environmentDown = "Verify's environment failed 4 times in a row. Check that the repository's Verify environment starts, then press Retry to run Verify again.";

const verified = reviewSchema.extend({ behavior: z.enum(['fixed', 'still_wrong']).nullable() });

const agentStep = (name: string, reads: readonly string[], canEnd: boolean, needsRepository: boolean): StepKind =>
  step({
    name,
    reads,
    runBy: 'agent',
    prompt: `Simulated ${name}.`,
    startsEnvironment: false,
    needsRepository,
    canEnd,
    owes: [],
    output: reviewSchema,
    requires: ['text'],
    failures: { fail: { kind: 'fail' }, needs_input: { kind: 'ask' } },
    blocked: 'fail',
    done: () => 'pass',
  });

export const workflows: readonly [Workflow, ...Workflow[]] = [
  {
    name: 'code-change',
    steps: [
      agentStep('specify', [], false, true),
      agentStep('implement', ['specify'], true, true),
      step({
        name: 'verify',
        reads: ['specify', 'implement'],
        runBy: 'agent',
        prompt: 'Simulated verify.',
        startsEnvironment: true,
        needsRepository: true,
        canEnd: false,
        owes: [],
        output: verified,
        requires: ['text'],
        failures: {
          needs_input: { kind: 'ask' },
          behavior_fail: { kind: 'return', to: 'implement', counter: 'rounds', cap: 3, parks: failedToVerify },
          environment_fail: { kind: 'rerun', counter: 'reruns', cap: 3, parks: environmentDown },
        },
        blocked: 'environment_fail',
        done: ({ behavior }) => (behavior === 'fixed' ? 'pass' : behavior === 'still_wrong' ? 'behavior_fail' : 'environment_fail'),
      }),
      step({
        name: 'land',
        reads: ['implement', 'verify'],
        runBy: 'engine',
        needsRepository: true,
        canEnd: true,
        owes: [{ kind: 'pr.merge', irreversible: true }],
        output: reviewSchema,
        requires: ['text'],
        failures: {
          fail: { kind: 'fail' },
          needs_input: { kind: 'ask' },
          red_check: { kind: 'return', to: 'implement', counter: 'landRounds', cap: 3, parks: 'Checks failed in 3 rounds. Press Retry to run Land again.' },
          changes_requested: {
            kind: 'review',
            to: 'implement',
            counter: 'reviews',
            cap: 1,
            parks: 'A later review asked for changes. Press Retry to run Land again.',
            ignored: 'A later review asked for changes, and this routine ignores later reviews. AutoWorker lands once GitHub allows it.',
          },
          review_required: { kind: 'await', waits: 'The pull request needs an approval. AutoWorker goes on once GitHub reports one.' },
        },
        blocked: 'fail',
        done: () => 'pass',
      }),
    ],
  },
  { name: 'post', steps: [agentStep('post', [], true, false)] },
];

export const parks = { rounds: failedToVerify, reruns: environmentDown } as const;

const byName = workflowsByName(workflows);
const runsAs = coreRunAs(null);

type Effect = 'pass' | StepFailure['kind'];

const moves = [
  'claim',
  'renew',
  'finish',
  'hang',
  'wake',
  'crash',
  'burst',
  'late',
  'reassign',
  'stop',
  'retry',
  'approve',
  'sendBack',
  'answer',
  'stale',
  'outside',
  'doubleDecision',
  'doneWrite',
  'bareIntake',
  'noteless',
  'strayTarget',
  'race',
  'badName',
  'restart',
  'pause',
  'loseApproval',
] as const;

const faults: ReadonlySet<Move> = new Set<Move>(['hang', 'wake', 'crash', 'burst', 'late', 'reassign', 'doubleDecision', 'doneWrite', 'bareIntake', 'noteless', 'strayTarget', 'race', 'badName', 'restart', 'pause', 'loseApproval']);

const people: ReadonlySet<Move> = new Set<Move>(['stop', 'retry', 'approve', 'sendBack', 'answer', 'stale', 'outside']);

const assignees = ['jira-ada', 'jira-bo', 'jira-nobody', null] as const;

type Move = (typeof moves)[number];

type Profile = {
  readonly stepsPerTask: number;
  readonly workers: number;
  readonly nobodyEvery: number;
  readonly leaseMs: number;
  readonly reapEveryMs: number;
  readonly engines: number;
  readonly outage: { readonly realMs: number; readonly virtualMs: number };
  readonly stepMs: number;
  readonly burst: number;
  readonly odds: Readonly<Record<Move, number>>;
  readonly effects: Readonly<Record<Effect, number>>;
};

const quietFaults = { hang: 0, wake: 0, crash: 0, burst: 0, late: 0, reassign: 0, doubleDecision: 0, doneWrite: 0, bareIntake: 0, noteless: 0, strayTarget: 0, race: 0, badName: 0, restart: 0, pause: 0, loseApproval: 0 } as const;

const noPeople = { stop: 0, retry: 0, approve: 0, sendBack: 0, answer: 0, stale: 0, outside: 0 } as const;

const somePeople = { stop: 0.3, retry: 0.6, approve: 1.5, sendBack: 0.4, answer: 0.6, stale: 0.6, outside: 1 } as const;

const mostlyPass = { pass: 10, fail: 1, ask: 0.3, return: 0.6, rerun: 0.6, review: 0.3, await: 0.3 } as const;

const everyEffect = { pass: 5, fail: 2, ask: 1, return: 2, rerun: 2, review: 1, await: 1 } as const;

const t2Faults = { hang: 1, wake: 1, crash: 1, burst: 1, late: 2, reassign: 1, doubleDecision: 0.2, doneWrite: 0.2, bareIntake: 0.2, noteless: 0.2, strayTarget: 0.3, race: 0.5, badName: 0.2, restart: 0, pause: 0, loseApproval: 0.5 } as const;

const oneEngine = { engines: 1, outage: { realMs: 0, virtualMs: 0 } } as const;

const crashing = { ...quietFaults, hang: 1, wake: 1, crash: 3, late: 1, restart: 0.3 } as const;

const engineProfile = { stepsPerTask: 20, workers: 4, nobodyEvery: 0, leaseMs: 2_000, reapEveryMs: 1_000, stepMs: 400, burst: 5, effects: mostlyPass } as const;

const engineOdds = { claim: 6, renew: 3, finish: 3, ...crashing, ...noPeople, approve: 1, outside: 1 } as const;

const engineProfiles = {
  crashes: { ...engineProfile, ...oneEngine, odds: engineOdds },
  'db-pause': { ...engineProfile, engines: 1, outage: { realMs: 10_000, virtualMs: 10_000 }, odds: { ...engineOdds, pause: 0.5 } },
  'two-engines': { ...engineProfile, ...oneEngine, engines: 2, odds: engineOdds },
} as const;

export const profiles: Readonly<Record<ProfileName, Profile>> = {
  default: {
    stepsPerTask: 20,
    workers: 4,
    nobodyEvery: 4,
    leaseMs: 30_000,
    reapEveryMs: 15_000,
    ...oneEngine,
    stepMs: 6_000,
    burst: 5,
    odds: { claim: 6, renew: 6, finish: 4, ...t2Faults, ...somePeople },
    effects: mostlyPass,
  },
  races: {
    stepsPerTask: 20,
    workers: 4,
    nobodyEvery: 0,
    leaseMs: 30_000,
    reapEveryMs: 15_000,
    ...oneEngine,
    stepMs: 6_000,
    burst: 20,
    odds: { claim: 2, renew: 4, finish: 4, ...quietFaults, burst: 4, race: 2, ...noPeople, approve: 1, outside: 1 },
    effects: mostlyPass,
  },
  hangs: {
    stepsPerTask: 20,
    workers: 4,
    nobodyEvery: 0,
    leaseMs: 2_000,
    reapEveryMs: 1_000,
    ...oneEngine,
    stepMs: 400,
    burst: 5,
    odds: { claim: 6, renew: 3, finish: 3, ...quietFaults, hang: 3, crash: 1, late: 2, ...noPeople, approve: 1, outside: 1 },
    effects: mostlyPass,
  },
  verdicts: {
    stepsPerTask: 15,
    workers: 4,
    nobodyEvery: 0,
    leaseMs: 30_000,
    reapEveryMs: 15_000,
    ...oneEngine,
    stepMs: 6_000,
    burst: 5,
    odds: { claim: 6, renew: 4, finish: 6, ...quietFaults, ...noPeople, approve: 1.5, retry: 0.5, outside: 1, loseApproval: 1 },
    effects: everyEffect,
  },
  people: {
    stepsPerTask: 15,
    workers: 4,
    nobodyEvery: 6,
    leaseMs: 30_000,
    reapEveryMs: 15_000,
    ...oneEngine,
    stepMs: 6_000,
    burst: 5,
    odds: { claim: 6, renew: 4, finish: 5, ...quietFaults, stop: 1, retry: 2, approve: 3, sendBack: 2, answer: 2, stale: 2, outside: 1, doubleDecision: 0.5 },
    effects: { ...mostlyPass, ask: 2 },
  },
  reviews: {
    stepsPerTask: 15,
    workers: 4,
    nobodyEvery: 0,
    leaseMs: 30_000,
    reapEveryMs: 15_000,
    ...oneEngine,
    stepMs: 6_000,
    burst: 5,
    odds: { claim: 6, renew: 4, finish: 6, ...quietFaults, ...noPeople, approve: 3, retry: 0.5, outside: 1 },
    effects: { pass: 1, fail: 0, ask: 0, return: 0, rerun: 0, review: 1, await: 0 },
  },
  'needs-input': {
    stepsPerTask: 15,
    workers: 4,
    nobodyEvery: 0,
    leaseMs: 30_000,
    reapEveryMs: 15_000,
    ...oneEngine,
    stepMs: 6_000,
    burst: 5,
    odds: { claim: 6, renew: 4, finish: 5, ...quietFaults, ...noPeople, approve: 3, answer: 2, sendBack: 0.5, outside: 1 },
    effects: { pass: 4, fail: 0.5, ask: 6, return: 0.3, rerun: 0.3, review: 0.2, await: 0.2 },
  },
  mixed: {
    stepsPerTask: 15,
    workers: 4,
    nobodyEvery: 5,
    leaseMs: 30_000,
    reapEveryMs: 15_000,
    ...oneEngine,
    stepMs: 6_000,
    burst: 5,
    odds: { claim: 6, renew: 5, finish: 5, ...t2Faults, ...somePeople, approve: 2, sendBack: 1, answer: 1, stale: 1 },
    effects: everyEffect,
  },
  behavior: {
    stepsPerTask: 20,
    workers: 4,
    nobodyEvery: 0,
    leaseMs: 30_000,
    reapEveryMs: 15_000,
    ...oneEngine,
    stepMs: 6_000,
    burst: 5,
    odds: { claim: 6, renew: 4, finish: 6, ...quietFaults, ...noPeople, approve: 3 },
    effects: { pass: 1, fail: 0, ask: 0, return: 0, rerun: 0, review: 0, await: 0 },
  },
  environment: {
    stepsPerTask: 20,
    workers: 4,
    nobodyEvery: 0,
    leaseMs: 30_000,
    reapEveryMs: 15_000,
    ...oneEngine,
    stepMs: 6_000,
    burst: 5,
    odds: { claim: 6, renew: 4, finish: 6, ...quietFaults, ...noPeople, approve: 3 },
    effects: { pass: 1, fail: 0, ask: 0, return: 0, rerun: 0, review: 0, await: 0 },
  },
  ...engineProfiles,
};

const forcedAtChecks: Partial<Readonly<Record<ProfileName, StepVerdict>>> = { behavior: 'behavior_fail', environment: 'environment_fail' };

export const fingerprint = createHash('sha256').update(JSON.stringify({ moves, profiles, assignees, forcedAtChecks, workflows })).digest('hex').slice(0, 16);

export type Plan = {
  readonly profile: ProfileName;
  readonly seeds: readonly number[];
  readonly steps: number;
  readonly mutant?: MutantName;
  readonly engine?: EngineMutantName;
};

export type Entry = { readonly step: number; readonly at: number; readonly move: string; readonly detail: string };

export type Failure = { readonly step: number; readonly move: string; readonly broken: readonly Violation[] };

export type Burst = { readonly winners: number; readonly ms: number };

export type Release = { readonly attempt: string; readonly key: string; readonly delayMs: number };

export type Settled = { readonly key: string; readonly workflow: string; readonly step: string; readonly state: TaskState; readonly reason: string | null; readonly counts: unknown; readonly lastStep: string | null };

export type Run = {
  readonly plan: Plan;
  readonly seed: number;
  readonly steps: number;
  readonly failure: Failure | undefined;
  readonly bursts: readonly Burst[];
  readonly hung: number;
  readonly hungNotLost: readonly string[];
  readonly tally: Readonly<Record<string, number>>;
  readonly fired: Readonly<Record<string, number>>;
  readonly done: number;
  readonly tasks: readonly Settled[];
  readonly releases: readonly Release[];
  readonly passMs: readonly number[];
  readonly engineLog: readonly string[];
  readonly trace: readonly Entry[];
};

type Random = () => number;

type Worker = { readonly state: 'idle' } | { readonly state: 'busy' | 'hung'; readonly attempt: string };

type Held = { readonly index: number; readonly attempt: string };

type Timer = { readonly at: number; readonly wake: () => void };

type VirtualClock = {
  readonly clock: Clock;
  readonly start: (run: () => Promise<void>) => Promise<void>;
  readonly nextDue: () => number | undefined;
  readonly advance: (to: number) => void;
  readonly fire: () => Promise<void>;
  readonly idle: () => Promise<void>;
};

type Engine = { readonly stop: AbortController; readonly done: Promise<void> };

type Engines = {
  readonly virtual: VirtualClock;
  readonly loop: Loop | undefined;
  readonly dbs: readonly Database[];
  readonly running: (Engine | undefined)[];
  readonly log: string[];
  readonly passMs: number[];
};

type World = {
  readonly tasks: readonly string[];
  readonly workers: Worker[];
  readonly engines: Engines;
  lost: readonly string[];
  pausedOnce: boolean;
  readonly hung: Set<string>;
  readonly bursts: Burst[];
  readonly tally: Map<string, number>;
  readonly fired: Map<Move, number>;
  readonly people: readonly string[];
  readonly routines: readonly Seeded[];
  clock: number;
  nextKey: number;
};

type Seeded = { readonly routine: string; readonly workflow: Workflow; readonly repository: string | null };

type Turn = {
  readonly db: Database;
  readonly postgres: TestPostgres;
  readonly world: World;
  readonly profile: Profile;
  readonly plan: Plan;
  readonly random: Random;
  readonly quiet: boolean;
  readonly now: Date;
};

type Rule = { readonly allowed: (world: World, quiet: boolean) => boolean; readonly perform: (turn: Turn) => Promise<string> | string };

const lanes = Math.min(8, availableParallelism());

const epoch = Date.parse('2026-01-01T00:00:00.000Z');

const traceTail = 40;

const idle: Worker = { state: 'idle' };

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

function startEngine(engines: Engines, index: number): void {
  const { loop, virtual } = engines;
  const db = engines.dbs[index];
  if (loop === undefined || db === undefined) return;
  const stop = new AbortController();
  const done = virtual.start(() =>
    runLoop(loop, db, virtual.clock, stop.signal, line => {
      engines.log.push(`engine ${String(index + 1)} ${line}`);
    }),
  );
  engines.running[index] = { stop, done };
}

async function stopEngines(engines: Engines): Promise<void> {
  const running = engines.running.flatMap(engine => (engine === undefined ? [] : [engine]));
  for (const engine of running) engine.stop.abort();
  await Promise.all(running.map(engine => engine.done));
}

const pick = <T>(random: Random, items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];

function weighted<T>(random: Random, choices: readonly (readonly [T, number])[]): T | undefined {
  let roll = random() * choices.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [choice, weight] of choices) {
    if (weight > 0 && roll < weight) return choice;
    roll -= weight;
  }
  return undefined;
}

const idleWorkers = (world: World): readonly number[] => world.workers.flatMap((worker, index) => (worker.state === 'idle' ? [index] : []));

const held = (world: World, states: readonly ('busy' | 'hung')[]): readonly Held[] =>
  world.workers.flatMap((worker, index) => (worker.state !== 'idle' && states.includes(worker.state) ? [{ index, attempt: worker.attempt }] : []));

function count(world: World, outcome: string, times = 1): void {
  world.tally.set(outcome, (world.tally.get(outcome) ?? 0) + times);
}

const simulatedBlocks = [
  { kind: 'text', title: 'Result', body: 'The simulated step wrote its result.' },
  { kind: 'choice', title: null, question: 'Which way?', options: [{ id: 'a', label: 'This way' }, { id: 'b', label: 'That way' }], recommended: 'a' },
  { kind: 'checklist', title: null, items: [{ id: 'one', label: 'First' }, { id: 'two', label: 'Second' }] },
  { kind: 'draft', title: 'Message', body: 'A simulated draft.' },
] as const;

const simulatedReviews = outcomes.flatMap(outcome => [
  { outcome, summary: `Simulated ${outcome}.`, blocks: simulatedBlocks },
  { outcome, summary: `Simulated ${outcome} with no text block.`, blocks: simulatedBlocks.slice(1) },
]);

const simulatedOutputs: readonly unknown[] = [
  ...simulatedReviews,
  ...simulatedReviews.flatMap(review => [null, 'fixed', 'still_wrong', 'unsure'].map(behavior => ({ ...review, behavior }))),
  { outcome: 'done', summary: 'A review with a stray field.', blocks: simulatedBlocks, extra: true },
  'The agent ended without a review.',
  null,
];

const passingOutput = simulatedReviews[0];

function reportFor(random: Random, kind: StepKind, verdict: StepVerdict): Report {
  const output = pick(
    random,
    simulatedOutputs.filter(candidate => kind.judge(candidate) === verdict),
  );
  if (output !== undefined) return { output, observed: null };
  if (verdict === 'pass' || verdict === 'needs_input') throw new Error(`No simulated output makes ${kind.name} judge ${verdict}.`);
  return { output: pick(random, simulatedOutputs) ?? null, observed: verdict };
}

async function unguardedLateWrite(db: Database, attempt: string, now: Date): Promise<'applied' | 'refused'> {
  try {
    await db.updateTable('attempt').set({ finished_at: now, verdict: 'pass', output: JSON.stringify(passingOutput) }).where('id', '=', attempt).execute();
    return 'applied';
  } catch (error) {
    const found = refusal(error);
    if (found?.kind === 'final' && found.name === 'finished_attempt_is_final') return 'refused';
    throw error;
  }
}

async function refused(write: () => Promise<unknown>, guard: string): Promise<'applied' | 'refused'> {
  try {
    await write();
    return 'applied';
  } catch (error) {
    const found = refusal(error);
    if (found !== undefined && 'name' in found && found.name === guard) return 'refused';
    throw error;
  }
}

async function outsideApproves(db: Database, task: string): Promise<'moved' | 'found nothing' | 'refused by review_wait_names_its_review'> {
  try {
    return (await approveFromOutside(db, task)) ? 'moved' : 'found nothing';
  } catch (error) {
    const found = refusal(error);
    if (found !== undefined && 'name' in found && found.name === 'review_wait_names_its_review') return 'refused by review_wait_names_its_review';
    throw error;
  }
}

async function attemptInfo(db: Database, attempt: string): Promise<{ readonly workflow: string; readonly step: string } | undefined> {
  return db
    .selectFrom('attempt')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .select(['task.workflow', 'attempt.step'])
    .where('attempt.id', '=', attempt)
    .where('attempt.finished_at', 'is', null)
    .executeTakeFirst();
}

function verdictFor(turn: Turn, kind: StepKind): { readonly verdict: StepVerdict; readonly effect: Effect } | undefined {
  const forced = forcedAtChecks[turn.plan.profile];
  const declared: readonly (readonly [StepVerdict, Effect])[] = [
    ['pass', 'pass'],
    ...Object.entries(kind.failures).map(([verdict, failure]) => [verdict as StepVerdict, failure.kind] as const),
  ];
  const forcing = declared.find(([verdict]) => verdict === forced);
  if (forcing !== undefined) return { verdict: forcing[0], effect: forcing[1] };
  const chosen = weighted(turn.random, declared.map(([verdict, effect]) => [verdict, turn.profile.effects[effect]] as const));
  return chosen === undefined ? undefined : { verdict: chosen, effect: declared.find(([verdict]) => verdict === chosen)?.[1] ?? 'pass' };
}

async function tasksWhere(db: Database, filter: 'stoppable' | 'retryable' | 'review' | 'outside' | 'done'): Promise<readonly { readonly id: string; readonly review: string | null }[]> {
  const base = db.selectFrom('task').select(['task.id', 'task.review_attempt as review']).orderBy('task.id');
  switch (filter) {
    case 'stoppable':
      return base.where('task.state', 'in', ['ready', 'waiting']).execute();
    case 'retryable':
      return base.where(eb => eb.or([eb('task.state', 'in', ['ready', 'stopped']), eb.and([eb('task.state', '=', 'waiting'), eb('task.waiting_on', '<>', 'approval')])])).execute();
    case 'review':
      return base.where('task.waiting_on', 'in', ['approval', 'answer']).execute();
    case 'outside':
      return base.where('task.waiting_on', '=', 'outside_approval').execute();
    case 'done':
      return base.where('task.state', '=', 'done').execute();
  }
}

async function personActs(turn: Turn, pool: 'stoppable' | 'retryable' | 'review', action: (task: { readonly id: string; readonly review: string | null }) => PersonAction | undefined, label: string): Promise<string> {
  const { db, world, random, now } = turn;
  const task = pick(random, await tasksWhere(db, pool));
  const person = pick(random, world.people);
  if (task === undefined || person === undefined) return `no task to ${label}`;
  const chosen = action(task);
  if (chosen === undefined) return `task ${task.id}: nothing to ${label}`;
  const outcome = await act(db, byName, task.id, { id: randomUUID(), person, at: now }, chosen, noTurnToStop);
  const said = 'refused' in outcome ? `refused ${outcome.refused}` : 'recorded';
  count(world, `${label} ${said}`);
  return `task ${task.id}: ${label} ${said}`;
}

const aNote = (random: Random): ReturnType<typeof note.parse> => note.parse(random() < 0.5 ? 'Use the smaller plan.' : 'The ticket says to keep the old API.');

const rules: Readonly<Record<Move, Rule>> = {
  claim: {
    allowed: world => idleWorkers(world).length > 0,
    perform: async ({ db, world, profile, random, quiet, now }) => {
      const worker = pick(random, idleWorkers(world));
      const task = pick(random, quiet ? await claimable(db, byName) : world.tasks);
      if (worker === undefined || task === undefined) return 'nothing to claim';
      const outcome = await claim(db, task, now, profile.leaseMs, await runsAs(db, task), null);
      if ('refused' in outcome) {
        const refusedWith = 'parked' in outcome ? `${outcome.refused}, ${outcome.parked ? 'parked' : 'not parked'}` : outcome.refused;
        count(world, `claim refused ${refusedWith}`);
        return `task ${task}: ${refusedWith}`;
      }
      count(world, 'claim won');
      world.workers[worker] = { state: 'busy', attempt: outcome.attempt };
      return `task ${task}: attempt ${outcome.attempt}`;
    },
  },
  renew: {
    allowed: world => held(world, ['busy']).length > 0,
    perform: async ({ db, world, profile, random, now }) => {
      const worker = pick(random, held(world, ['busy']));
      if (worker === undefined) return 'no busy worker';
      const outcome = await renew(db, worker.attempt, now, profile.leaseMs);
      count(world, `renew ${outcome}`);
      if (outcome === 'lost') world.workers[worker.index] = idle;
      return `attempt ${worker.attempt}: ${outcome}`;
    },
  },
  finish: {
    allowed: world => held(world, ['busy']).length > 0,
    perform: async turn => {
      const { db, world, random, now } = turn;
      const worker = pick(random, held(world, ['busy']));
      if (worker === undefined) return 'no busy worker';
      world.workers[worker.index] = idle;
      const info = await attemptInfo(db, worker.attempt);
      if (info === undefined) {
        count(world, 'finish lost');
        return `attempt ${worker.attempt}: lost before it finished`;
      }
      const workflow = byName.get(info.workflow);
      const kind = workflow?.steps.find(step => step.name === info.step);
      const chosen = kind === undefined ? undefined : verdictFor(turn, kind);
      if (kind === undefined || chosen === undefined) return `attempt ${worker.attempt}: no verdict to give`;
      const report = reportFor(random, kind, chosen.verdict);
      const outcome = await advance(db, byName, worker.attempt, report, now);
      const how = report.observed === null ? 'judged' : 'observed';
      const said = 'finished' in outcome ? `already finished ${outcome.finished ?? 'with no verdict'}` : `${outcome.state} at ${outcome.step}`;
      count(world, `finish ${chosen.verdict} ${how} ${'finished' in outcome ? 'lost' : outcome.state}`);
      return `attempt ${worker.attempt} at ${info.step}: ${how} ${chosen.verdict}, ${said}`;
    },
  },
  hang: {
    allowed: (world, quiet) => !quiet && held(world, ['busy']).length > 0,
    perform: ({ world, random }) => {
      const worker = pick(random, held(world, ['busy']));
      if (worker === undefined) return 'no busy worker';
      world.workers[worker.index] = { state: 'hung', attempt: worker.attempt };
      world.hung.add(worker.attempt);
      count(world, 'hang');
      return `attempt ${worker.attempt}`;
    },
  },
  wake: {
    allowed: (world, quiet) => !quiet && held(world, ['hung']).length > 0,
    perform: ({ world, random }) => {
      const worker = pick(random, held(world, ['hung']));
      if (worker === undefined) return 'no hung worker';
      world.workers[worker.index] = { state: 'busy', attempt: worker.attempt };
      world.hung.delete(worker.attempt);
      count(world, 'wake');
      return `attempt ${worker.attempt}`;
    },
  },
  crash: {
    allowed: (world, quiet) => !quiet && held(world, ['busy', 'hung']).length > 0,
    perform: ({ world, random }) => {
      const worker = pick(random, held(world, ['busy', 'hung']));
      if (worker === undefined) return 'no worker holds an attempt';
      world.workers[worker.index] = idle;
      count(world, 'crash');
      return `attempt ${worker.attempt} is left to its lease`;
    },
  },
  burst: {
    allowed: (_world, quiet) => !quiet,
    perform: async ({ db, world, profile, random, now }) => {
      const task = pick(random, await claimable(db, byName));
      if (task === undefined) return 'nothing claimable';
      const runAs = await runsAs(db, task);
      const started = performance.now();
      const outcomes = await Promise.all(Array.from({ length: profile.burst }, () => claim(db, task, now, profile.leaseMs, runAs, null)));
      const won = outcomes.flatMap(outcome => ('attempt' in outcome ? [outcome.attempt] : []));
      world.bursts.push({ winners: won.length, ms: performance.now() - started });
      count(world, 'burst');
      const taker = pick(random, idleWorkers(world));
      const [winner] = won;
      if (taker !== undefined && winner !== undefined && won.length === 1) world.workers[taker] = { state: 'busy', attempt: winner };
      return `task ${task}: ${String(won.length)} of ${String(profile.burst)} claims won`;
    },
  },
  late: {
    allowed: (world, quiet) => !quiet && world.lost.length > 0,
    perform: async ({ db, world, profile, random, now }) => {
      const attempt = pick(random, world.lost);
      if (attempt === undefined) return 'no lost attempt';
      if (random() < 0.5) {
        const outcome = random() < 0.5 ? await renew(db, attempt, now, profile.leaseMs) : 'finished' in (await advance(db, byName, attempt, { output: passingOutput, observed: null }, now)) ? 'lost' : 'applied';
        count(world, `guarded late write ${outcome}`);
        return `guarded late write on attempt ${attempt}: ${outcome}`;
      }
      const outcome = await unguardedLateWrite(db, attempt, now);
      count(world, `unguarded late write ${outcome}`);
      return `unguarded late write on attempt ${attempt}: ${outcome}`;
    },
  },
  reassign: {
    allowed: (_world, quiet) => !quiet,
    perform: async ({ db, world, random }) => {
      const task = pick(random, world.tasks);
      const assignee = pick(random, assignees) ?? null;
      if (task === undefined) return 'no task';
      await db.updateTable('task').set({ assignee_account_id: assignee }).where('id', '=', task).execute();
      count(world, 'reassign');
      return `task ${task}: assignee ${assignee ?? 'none'}`;
    },
  },
  stop: {
    allowed: (_world, quiet) => !quiet,
    perform: turn => personActs(turn, 'stoppable', () => ({ kind: 'stop' }), 'stop'),
  },
  retry: {
    allowed: (_world, quiet) => !quiet,
    perform: turn => personActs(turn, 'retryable', () => ({ kind: 'retry', note: turn.random() < 0.5 ? null : aNote(turn.random) }), 'retry'),
  },
  approve: {
    allowed: (_world, quiet) => !quiet,
    perform: turn => personActs(turn, 'review', task => (task.review === null ? undefined : { kind: 'approve', review: task.review }), 'approve'),
  },
  sendBack: {
    allowed: (_world, quiet) => !quiet,
    perform: turn => personActs(turn, 'review', task => (task.review === null ? undefined : { kind: 'send_back', review: task.review, note: aNote(turn.random) }), 'send back'),
  },
  answer: {
    allowed: (_world, quiet) => !quiet,
    perform: turn =>
      personActs(
        turn,
        'review',
        task => {
          if (task.review === null) return undefined;
          const answers: readonly Answer[] = [
            { kind: 'pick', block: 1, option: turn.random() < 0.5 ? 'a' : 'b' },
            { kind: 'untick', block: 2, items: ['two'] },
            { kind: 'edit', block: 3, body: 'An edited draft.' },
            { kind: 'pick', block: 0, option: 'a' },
          ];
          const answer = pick(turn.random, answers);
          return answer === undefined ? undefined : { kind: 'answer', review: task.review, answer };
        },
        'answer',
      ),
  },
  stale: {
    allowed: (_world, quiet) => !quiet,
    perform: async turn => {
      const { db, world, random, now } = turn;
      const olds = await db
        .selectFrom('attempt')
        .innerJoin('task', 'task.id', 'attempt.task_id')
        .select(['attempt.id', 'attempt.task_id', 'task.waiting_on'])
        .where('attempt.finished_at', 'is not', null)
        .where(eb => eb.or([eb('task.review_attempt', 'is', null), eb('task.review_attempt', '<>', eb.ref('attempt.id'))]))
        .where(eb => eb.not(eb.exists(eb.selectFrom('human_action').select('human_action.id').whereRef('human_action.attempt_id', '=', 'attempt.id'))))
        .orderBy('attempt.id')
        .execute();
      const behindANewerReview = olds.filter(candidate => candidate.waiting_on === 'approval' || candidate.waiting_on === 'answer');
      const old = pick(random, behindANewerReview.length > 0 && random() < 0.8 ? behindANewerReview : olds);
      const person = pick(random, world.people);
      if (old === undefined || person === undefined) return 'no stale review to approve';
      const outcome = await act(db, byName, old.task_id, { id: randomUUID(), person, at: now }, { kind: 'approve', review: old.id }, noTurnToStop);
      const said = 'refused' in outcome ? `refused ${outcome.refused}` : 'recorded';
      count(world, `stale approve ${said}`);
      return `task ${old.task_id}: approve of old attempt ${old.id} ${said}`;
    },
  },
  outside: {
    allowed: (_world, quiet) => !quiet,
    perform: async ({ db, world, random }) => {
      const stray = random() < 0.3;
      const task = stray ? pick(random, world.tasks) : pick(random, await tasksWhere(db, 'outside'))?.id;
      if (task === undefined) return 'no task awaits an outside approval';
      const outcome = await outsideApproves(db, task);
      const aimed = stray ? 'outside approval at any task' : 'outside approval';
      count(world, `${aimed} ${outcome}`);
      return `task ${task}: ${aimed} ${outcome}`;
    },
  },
  doubleDecision: {
    allowed: (_world, quiet) => !quiet,
    perform: async ({ db, world, random, now }) => {
      const decided = pick(
        random,
        await db.selectFrom('human_action').select(['human_action.task_id', 'human_action.attempt_id', 'human_action.person_id']).where('human_action.kind', 'in', ['approve', 'send_back']).orderBy('human_action.at').execute(),
      );
      if (decided?.task_id == null || decided.attempt_id === null) return 'no decided review';
      const { task_id: task, attempt_id: attempt, person_id: person } = decided;
      const outcome = await refused(
        () => db.insertInto('human_action').values({ id: randomUUID(), at: now, person_id: person, kind: 'approve', task_id: task, attempt_id: attempt }).execute(),
        'one_decision_per_review',
      );
      count(world, `second decision ${outcome}`);
      return `review ${attempt} of task ${task}: a second decision was ${outcome}`;
    },
  },
  doneWrite: {
    allowed: (_world, quiet) => !quiet,
    perform: async ({ db, world, random }) => {
      const task = pick(random, await tasksWhere(db, 'done'));
      if (task === undefined) return 'no done task';
      const outcome = await refused(() => db.updateTable('task').set({ retries: 1 }).where('id', '=', task.id).execute(), 'done_task_is_final');
      count(world, `write to a done task ${outcome}`);
      return `task ${task.id}: a write to the done task was ${outcome}`;
    },
  },
  bareIntake: {
    allowed: (_world, quiet) => !quiet,
    perform: async ({ db, world, random, now }) => {
      const seeded = pick(
        random,
        world.routines.filter(entry => entry.repository !== null),
      );
      if (seeded === undefined) return 'no routine needs a repository';
      world.nextKey += 1;
      const outcome = await refused(
        () =>
          db
            .insertInto('task')
            .values({
              routine_id: seeded.routine,
              found_version: 1,
              repository_id: null,
              key: `BARE-${String(world.nextKey)}`,
              title: 'A ticket intake found with no repository',
              found_at: now,
              workflow: seeded.workflow.name,
              needs_repository: true,
              step: seeded.workflow.steps[0].name,
            })
            .execute(),
        'task_repository_when_needed',
      );
      count(world, `task with no repository ${outcome}`);
      return `routine ${seeded.routine}: a task with no repository was ${outcome}`;
    },
  },
  noteless: {
    allowed: (_world, quiet) => !quiet,
    perform: async ({ db, world, random, now }) => {
      const task = pick(random, await tasksWhere(db, 'review'));
      const person = pick(random, world.people);
      if (task?.review == null || person === undefined) return 'no review to send back';
      const review = task.review;
      const outcome = await refused(
        () => db.insertInto('human_action').values({ id: randomUUID(), at: now, person_id: person, kind: 'send_back', task_id: task.id, attempt_id: review, detail: JSON.stringify({}) }).execute(),
        'send_back_has_a_note',
      );
      count(world, `send back with no note ${outcome}`);
      return `task ${task.id}: a send back with no note was ${outcome}`;
    },
  },
  race: {
    allowed: (world, quiet) => !quiet && held(world, ['busy']).length > 0,
    perform: async turn => {
      const { db, world, profile, random, now } = turn;
      const worker = pick(random, held(world, ['busy']));
      const person = pick(random, world.people);
      if (worker === undefined || person === undefined) return 'no busy worker';
      world.workers[worker.index] = idle;
      const live = await db
        .selectFrom('attempt')
        .innerJoin('task', 'task.id', 'attempt.task_id')
        .select(['attempt.task_id', 'task.workflow', 'attempt.step'])
        .where('attempt.id', '=', worker.attempt)
        .where('attempt.finished_at', 'is', null)
        .executeTakeFirst();
      const kind = live === undefined ? undefined : byName.get(live.workflow)?.steps.find(candidate => candidate.name === live.step);
      const chosen = kind === undefined ? undefined : verdictFor(turn, kind);
      if (live === undefined || kind === undefined || chosen === undefined) return `attempt ${worker.attempt}: lost before the race`;
      const action: PersonAction = random() < 0.5 ? { kind: 'stop' } : { kind: 'retry', note: null };
      const report = reportFor(random, kind, chosen.verdict);
      const settle = async <T,>(work: Promise<T>): Promise<T | { readonly guard: string }> => {
        try {
          return await work;
        } catch (error) {
          const found = refusal(error);
          if (turn.plan.mutant === undefined || found === undefined) throw error;
          return { guard: 'name' in found ? found.name : `${found.table}.${found.column}` };
        }
      };
      const [finished, acted, ...claims] = await Promise.all([
        settle(advance(db, byName, worker.attempt, report, now)),
        settle(act(db, byName, live.task_id, { id: randomUUID(), person, at: now }, action, noTurnToStop)),
        settle(claim(db, live.task_id, now, profile.leaseMs, await runsAs(db, live.task_id), null)),
        settle(claim(db, live.task_id, now, profile.leaseMs, await runsAs(db, live.task_id), null)),
      ]);
      const won = claims.flatMap(outcome => ('attempt' in outcome ? [outcome.attempt] : []));
      const taker = pick(random, idleWorkers(world));
      const [winner] = won;
      if (taker !== undefined && winner !== undefined && won.length === 1) world.workers[taker] = { state: 'busy', attempt: winner };
      const finishing =
        'guard' in finished ? `finish refused by ${finished.guard}` : 'finished' in finished ? `finish found it ${finished.finished ?? 'unfinished'}` : `finish left it ${finished.state}`;
      const acting = 'guard' in acted ? `${action.kind} refused by ${acted.guard}` : 'refused' in acted ? `${action.kind} refused ${acted.refused}` : `${action.kind} recorded`;
      count(world, `race: ${finishing}, ${acting}, ${String(won.length)} claims won`);
      return `task ${live.task_id}: ${finishing}, ${acting}, ${String(won.length)} of 2 claims won`;
    },
  },
  badName: {
    allowed: (_world, quiet) => !quiet,
    perform: async ({ db, world, random }) => {
      const task = pick(random, world.tasks);
      const seeded = pick(random, world.routines);
      if (task === undefined || seeded === undefined) return 'no task';
      const writes = [
        { domain: 'skill_name_is_a_slug', what: 'a skill named Bad_Name', write: () => db.insertInto('routine_step').values({ routine_id: seeded.routine, version: 1, step: 'extra', skills: ['Bad_Name'] }).execute() },
        { domain: 'step_name_is_a_slug', what: 'a step named Not a step', write: () => db.updateTable('task').set({ step: 'Not a step' }).where('id', '=', task).execute() },
        { domain: 'workflow_name_is_a_slug', what: 'a workflow named Code Change', write: () => db.updateTable('task').set({ workflow: 'Code Change' }).where('id', '=', task).execute() },
        { domain: 'instruction_is_a_sentence', what: 'a waiting reason that is not a sentence', write: () => db.updateTable('task').set({ waiting_reason: 'press retry' }).where('id', '=', task).execute() },
      ] as const;
      const bad = pick(random, writes);
      if (bad === undefined) return 'no bad name';
      const outcome = await refused(bad.write, bad.domain);
      if (outcome === 'applied') throw new Error(`Postgres accepted ${bad.what}, which the domain check ${bad.domain} must refuse.`);
      count(world, `bad name ${outcome}`);
      return `${bad.what} was ${outcome}`;
    },
  },
  restart: {
    allowed: (world, quiet) => !quiet && world.engines.running.some(engine => engine !== undefined),
    perform: async ({ db, world, random }) => {
      const index = Math.floor(random() * world.engines.running.length);
      const engine = world.engines.running[index];
      if (engine === undefined) return 'no engine runs';
      const from = world.engines.log.length;
      engine.stop.abort();
      await engine.done;
      startEngine(world.engines, index);
      await world.engines.virtual.idle();
      count(world, 'engine restart');
      return `engine ${String(index + 1)} stopped and started again: ${await noteReleases(db, world, from)}`;
    },
  },
  pause: {
    allowed: (world, quiet) => !quiet && !world.pausedOnce,
    perform: async ({ db, postgres, world, profile }) => {
      const { virtual, log } = world.engines;
      const due = virtual.nextDue();
      if (due === undefined) return 'no engine pass to hold up';
      world.pausedOnce = true;
      const from = log.length;
      const release = await postgres.pause();
      try {
        const held = virtual.fire();
        await setImmediate();
        virtual.advance(due + profile.outage.virtualMs);
        await wait(profile.outage.realMs);
        await release();
        await held;
      } finally {
        await release();
      }
      const now = (): number => virtual.clock.now().getTime();
      for (let next = virtual.nextDue(); next !== undefined && next <= now(); next = virtual.nextDue()) await virtual.fire();
      count(world, 'postgres paused');
      return `Postgres paused for ${String(profile.outage.realMs)} ms while the engine's pass at ${String(due - epoch)} ms waited, and ${String(profile.outage.virtualMs)} simulated ms passed: ${await noteReleases(db, world, from)}`;
    },
  },
  loseApproval: {
    allowed: (_world, quiet) => !quiet,
    perform: async ({ db, world, random }) => {
      const task = pick(random, await approvalsToLose(db));
      if (task === undefined) return 'no ready task at an irreversible step holds an approval';
      await loseApprovals(db, task);
      count(world, 'approval lost');
      return `task ${task}: its approvals went missing`;
    },
  },
  strayTarget: {
    allowed: (_world, quiet) => !quiet,
    perform: async ({ db, world, random, now }) => {
      const seeded = pick(
        random,
        world.routines.filter(entry => entry.repository !== null),
      );
      const person = pick(random, world.people);
      if (seeded?.repository == null || person === undefined) return 'no routine with a repository';
      const { routine, repository } = seeded;
      const strays = [
        { guard: 'one_target', what: 'a routine edit that also names a connector', values: { kind: 'edit_routine', routine_id: routine, connector: 'github' } },
        { guard: 'one_target', what: 'a routine edit that also names a repository', values: { kind: 'edit_routine', routine_id: routine, repository_id: repository } },
        { guard: 'target_fits_kind', what: 'a credential replacement aimed at a repository', values: { kind: 'replace_credential', repository_id: repository } },
        { guard: 'target_fits_kind', what: 'a repository added to a connector', values: { kind: 'add_repository', connector: 'codex' } },
      ] as const;
      const stray = pick(random, strays);
      if (stray === undefined) return 'no stray target';
      const outcome = await refused(() => db.insertInto('human_action').values({ id: randomUUID(), at: now, person_id: person, ...stray.values }).execute(), stray.guard);
      count(world, `stray target ${outcome}`);
      return `${stray.what} was ${outcome}`;
    },
  },
};

const owesIrreversible = (workflow: string, step: string): boolean =>
  byName.get(workflow)?.steps.find(kind => kind.name === step)?.owes.some(owed => owed.irreversible) === true;

async function approvalsToLose(db: Database): Promise<readonly string[]> {
  const ready = await db
    .selectFrom('task')
    .select(['task.id', 'task.workflow', 'task.step'])
    .where('task.state', '=', 'ready')
    .where(sql<boolean>`cardinality(task.approved) > 0`)
    .where(eb => eb.not(eb.exists(eb.selectFrom('attempt').select('attempt.id').whereRef('attempt.task_id', '=', 'task.id').where('attempt.finished_at', 'is', null))))
    .orderBy('task.id')
    .execute();
  return ready.filter(task => owesIrreversible(task.workflow, task.step)).map(task => task.id);
}

async function noteReleases(db: Database, world: World, from: number): Promise<string> {
  const said = world.engines.log.slice(from);
  const released = said.filter(line => line.includes(': released attempt '));
  count(world, 'released by the engine', released.length);
  count(world, 'parked by the engine', released.filter(line => line.includes(', and parked the task')).length);
  const lost = await db.selectFrom('attempt').select('id').where('verdict', '=', 'lost').orderBy('id').execute();
  world.lost = lost.map(row => row.id);
  const ended = new Set(world.lost);
  world.workers.forEach((worker, index) => {
    if (worker.state !== 'idle' && ended.has(worker.attempt)) world.workers[index] = idle;
  });
  return said.length === 0 ? 'the engine had nothing to say' : said.join('; ');
}

async function engineStep({ db, world }: Turn): Promise<string> {
  const from = world.engines.log.length;
  const started = performance.now();
  await world.engines.virtual.fire();
  world.engines.passMs.push(performance.now() - started);
  return noteReleases(db, world, from);
}

async function perform(turn: Turn): Promise<{ readonly move: string; readonly detail: string }> {
  const quietly = (move: Move): boolean => !turn.quiet || (!faults.has(move) && !people.has(move));
  const move = weighted(
    turn.random,
    moves.map(candidate => [candidate, quietly(candidate) && rules[candidate].allowed(turn.world, turn.quiet) ? turn.profile.odds[candidate] : 0] as const),
  );
  if (move === undefined) return { move: 'idle', detail: 'no move is allowed' };
  const tallied = (): number => [...turn.world.tally.values()].reduce((sum, times) => sum + times, 0);
  const before = tallied();
  const detail = await rules[move].perform(turn);
  if (tallied() > before) turn.world.fired.set(move, (turn.world.fired.get(move) ?? 0) + 1);
  return { move, detail };
}

export const laterReviews = (runs: readonly Run[]): number => runs.reduce((sum, run) => sum + (run.tally['finish changes_requested observed waiting'] ?? 0), 0);

export const unfiredFaults =(profile: ProfileName, runs: readonly Run[]): readonly string[] =>
  [...faults].filter(fault => profiles[profile].odds[fault] > 0 && runs.every(run => (run.fired[fault] ?? 0) === 0));

async function dropGuard(db: Database, name: MutantName): Promise<void> {
  const { rows } = await sql<{ ddl: string }>`
    select format('alter table %s drop constraint %I', conrelid::regclass, conname) as ddl
    from pg_constraint where conname = ${name} and connamespace = 'public'::regnamespace
    union all
    select format('drop index %s', x.indexrelid::regclass)
    from pg_index x
    where x.indexrelid = to_regclass(${name})
      and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))
    union all
    select format('drop trigger %I on %s', tgname, tgrelid::regclass)
    from pg_trigger where tgname = ${name} and not tgisinternal`.execute(db);
  const [only, ...more] = rows;
  if (only === undefined || more.length > 0) throw new Error(`mutant ${name} must name exactly one constraint, index, or trigger, and it names ${String(rows.length)}`);
  await sql.raw(only.ddl).execute(db);
}

type RoutinePlan = { readonly workflow: Workflow; readonly runAsTeam: boolean; readonly gates: readonly string[]; readonly lastStep: string | null; readonly ignoreLaterReviews: boolean };

const [codeChange, post] = workflows;

export const badEnd = 'verify';

const routinePlans: readonly RoutinePlan[] = [
  { workflow: codeChange, runAsTeam: true, gates: ['specify'], lastStep: null, ignoreLaterReviews: false },
  { workflow: codeChange, runAsTeam: false, gates: [], lastStep: 'implement', ignoreLaterReviews: false },
  { workflow: codeChange, runAsTeam: false, gates: ['implement'], lastStep: null, ignoreLaterReviews: true },
  { workflow: codeChange, runAsTeam: true, gates: [], lastStep: badEnd, ignoreLaterReviews: false },
  ...(post === undefined ? [] : [{ workflow: post, runAsTeam: true, gates: [], lastStep: null, ignoreLaterReviews: false }]),
];

async function setUp(db: Database, profile: Profile, steps: number, engines: Engines): Promise<World> {
  const at = new Date(epoch);
  const ada = await db.insertInto('person').values({ email: 'ada@example.com', name: 'Ada', jira_account_id: 'jira-ada' }).returning('id').executeTakeFirstOrThrow();
  const bo = await db.insertInto('person').values({ email: 'bo@example.com', name: 'Bo', jira_account_id: 'jira-bo' }).returning('id').executeTakeFirstOrThrow();
  const team = await db.insertInto('person').values({ email: 'release-team@example.com', name: 'Release team', kind: 'shared' }).returning('id').executeTakeFirstOrThrow();
  const saving = '00000000-0000-4000-8000-000000000100';
  const repository = await db
    .with('saved', query => query.insertInto('human_action').values({ id: saving, at, person_id: ada.id, kind: 'add_repository', repository_id: 1 }).returning('id'))
    .insertInto('repository')
    .columns(['github', 'branch', 'saved_by'])
    .expression(eb => eb.selectFrom('saved').select([eb.val('example/sandbox').as('github'), eb.val('main').as('branch'), 'saved.id']))
    .returning('id')
    .executeTakeFirstOrThrow();
  const routines: Seeded[] = [];
  for (const [index, planned] of routinePlans.entries()) {
    const routine = await db.insertInto('routine').values({ creator_id: ada.id, run_as_id: planned.runAsTeam ? team.id : null }).returning('id').executeTakeFirstOrThrow();
    const action = `00000000-0000-4000-8000-00000000000${String(index + 1)}`;
    const needsRepository = planned.workflow.steps.some(kind => kind.needsRepository);
    await db.insertInto('human_action').values({ id: action, at, person_id: ada.id, kind: 'edit_routine', routine_id: routine.id }).execute();
    await db
      .insertInto('routine_version')
      .values({
        routine_id: routine.id,
        version: 1,
        name: `Simulated ${planned.workflow.name}`,
        goal: 'Take each labeled ticket as far as the routine says.',
        repository_id: needsRepository ? repository.id : null,
        action_id: action,
        workflow: planned.workflow.name,
        source: JSON.stringify({ kind: 'jira-search', query: 'labels = sim' }),
        needs_repository: needsRepository,
        gates: [...planned.gates],
        last_step: planned.lastStep,
        ignore_later_reviews: planned.ignoreLaterReviews,
      })
      .execute();
    await db
      .insertInto('routine_step')
      .values(planned.workflow.steps.map(kind => ({ routine_id: routine.id, version: 1, step: kind.name, instructions: `Keep ${kind.name} small.`, skills: ['simulated-skill'] })))
      .execute();
    routines.push({ routine: routine.id, workflow: planned.workflow, repository: needsRepository ? repository.id : null });
  }
  const tasks = await db
    .insertInto('task')
    .values(
      Array.from({ length: Math.max(routines.length * 2, Math.ceil(steps / profile.stepsPerTask)) }, (_, index) => {
        const seeded = routines[index % routines.length] ?? routines[0];
        if (seeded === undefined) throw new Error('the simulator seeds at least one routine');
        const nobody = profile.nobodyEvery > 0 && index % profile.nobodyEvery === profile.nobodyEvery - 1;
        return {
          routine_id: seeded.routine,
          found_version: 1,
          repository_id: seeded.repository,
          key: `SIM-${String(index + 1)}`,
          title: `Ticket ${String(index + 1)}`,
          found_at: at,
          assignee_account_id: nobody ? 'jira-nobody' : 'jira-bo',
          workflow: seeded.workflow.name,
          needs_repository: seeded.repository !== null,
          step: seeded.workflow.steps[0].name,
        };
      }),
    )
    .returning('id')
    .execute();
  return {
    tasks: tasks.map(task => task.id),
    workers: Array.from({ length: profile.workers }, () => idle),
    engines,
    lost: [],
    pausedOnce: false,
    hung: new Set(),
    bursts: [],
    tally: new Map(),
    fired: new Map(),
    people: [ada.id, bo.id],
    routines,
    clock: epoch,
    nextKey: 0,
  };
}

async function tasksIn(db: Database, state: TaskState): Promise<number> {
  const { tasks } = await db
    .selectFrom('task')
    .select(eb => eb.fn.countAll<string>().as('tasks'))
    .where('state', '=', state)
    .executeTakeFirstOrThrow();
  return Number(tasks);
}

async function hungNotLost(db: Database, hung: ReadonlySet<string>): Promise<readonly string[]> {
  if (hung.size === 0) return [];
  const rows = await db.selectFrom('attempt').select('id').where('id', 'in', [...hung]).where('verdict', 'is distinct from', 'lost').orderBy('id').execute();
  return rows.map(row => row.id);
}

async function settledTasks(db: Database): Promise<readonly Settled[]> {
  const rows = await db
    .selectFrom('task')
    .innerJoin('routine_version as version', join => join.onRef('version.routine_id', '=', 'task.routine_id').onRef('version.version', '=', 'task.found_version'))
    .select(['task.key', 'task.workflow', 'task.step', 'task.state', 'task.waiting_reason', 'task.counts', 'version.last_step'])
    .orderBy('task.id')
    .execute();
  return rows.map(row => ({ key: row.key, workflow: row.workflow, step: row.step, state: row.state, reason: row.waiting_reason, counts: row.counts, lastStep: row.last_step }));
}

const engineLoop = (profile: Profile, mutant: EngineMutantName | undefined): Loop | undefined => {
  const loop = reaper({ everyMs: profile.reapEveryMs, leaseMs: profile.leaseMs });
  return mutant === undefined ? loop : engineMutants[mutant].loop(loop);
};

async function releases(db: Database): Promise<readonly Release[]> {
  const rows = await db
    .selectFrom('attempt')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .select(['attempt.id', 'task.key', sql<number>`(extract(epoch from attempt.finished_at - attempt.lease_until) * 1000)::float8`.as('delay')])
    .where('attempt.verdict', '=', 'lost')
    .orderBy('attempt.id')
    .execute();
  return rows.map(row => ({ attempt: row.id, key: row.key, delayMs: row.delay }));
}

async function runSeed(postgres: TestPostgres, plan: Plan, seed: number): Promise<Run> {
  const profile = profiles[plan.profile];
  const random = seeded(seed);
  const trace: Entry[] = [];
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, profile.burst + 2);
  const engines: Engines = {
    virtual: virtualClock(epoch),
    loop: engineLoop(profile, plan.engine),
    dbs: Array.from({ length: profile.engines }, () => connect(scratch.url, 2)),
    running: [],
    log: [],
    passMs: [],
  };
  try {
    if (plan.mutant !== undefined) await dropGuard(db, plan.mutant);
    const world = await setUp(db, profile, plan.steps, engines);
    engines.dbs.forEach((_db, index) => {
      startEngine(engines, index);
    });
    await engines.virtual.idle();
    await logLostApprovals(db);
    const watched = await watch(db, workflows, profile.reapEveryMs, new Date(epoch));
    const ended = async (steps: number, failure: Failure | undefined): Promise<Run> => ({
      plan,
      seed,
      steps,
      failure,
      bursts: world.bursts,
      hung: world.hung.size,
      hungNotLost: failure === undefined ? await hungNotLost(db, world.hung) : [],
      tally: Object.fromEntries(world.tally),
      fired: Object.fromEntries(world.fired),
      done: await tasksIn(db, 'done'),
      tasks: await settledTasks(db),
      releases: await releases(db),
      passMs: engines.passMs,
      engineLog: engines.log,
      trace: failure === undefined ? trace.slice(-traceTail) : trace,
    });
    if (watched.atStart.length > 0) return await ended(0, { step: 0, move: 'setup', broken: watched.atStart });
    const quietCap = world.tasks.length * 40 + 100;
    let step = 0;
    while (step < plan.steps + quietCap) {
      step += 1;
      const quiet = step > plan.steps;
      if (quiet && (await tasksIn(db, 'ready')) === 0) break;
      const due = engines.virtual.nextDue();
      const engineDue = due !== undefined && due <= world.clock;
      if (!engineDue) engines.virtual.advance(world.clock);
      const turn: Turn = { db, postgres, world, profile, plan, random, quiet, now: new Date(world.clock) };
      const said = engines.log.length;
      const made = engineDue ? { move: 'engine', detail: await engineStep(turn) } : await perform(turn);
      const at = engines.virtual.clock.now().getTime();
      trace.push({ step, at: at - epoch, ...made });
      const broken = await watched.step(new Date(at), engines.log.slice(said).some(line => line.includes(': gave ')));
      if (broken.length > 0) return await ended(step, { step, move: made.move, broken });
      world.clock = Math.max(world.clock, at) + (engineDue ? 0 : 1 + Math.floor(random() * profile.stepMs));
    }
    const unsettled = await watched.settled();
    return await ended(step, unsettled.length > 0 ? { step, move: 'the quiet phase ended', broken: unsettled } : undefined);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const without = plan.mutant ?? plan.engine;
    const where = `${plan.profile} seed ${String(seed)}${without === undefined ? '' : ` without ${without}`}`;
    throw new Error(`${where} threw after step ${String(trace.at(-1)?.step ?? 0)}: ${reason}`, { cause: error });
  } finally {
    await stopEngines(engines);
    await Promise.all(engines.dbs.map(engineDb => engineDb.destroy()));
    await db.destroy();
    await scratch.drop();
  }
}

export type Probe = { readonly expired: number; readonly released: number; readonly passMs: number; readonly slowestDelayMs: number; readonly everyMs: number };

export async function probeReaper(postgres: TestPostgres, expiring: number): Promise<Probe> {
  const profile = profiles.crashes;
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  const engines: Engines = { virtual: virtualClock(epoch), loop: engineLoop(profile, undefined), dbs: [connect(scratch.url, 2)], running: [], log: [], passMs: [] };
  try {
    const world = await setUp(db, profile, expiring * profile.stepsPerTask, engines);
    for (const task of world.tasks.slice(0, expiring)) {
      const outcome = await claim(db, task, new Date(epoch), profile.leaseMs, await runsAs(db, task), null);
      if ('refused' in outcome) throw new Error(`the probe could not claim task ${task}: ${outcome.refused}`);
    }
    startEngine(engines, 0);
    await engines.virtual.idle();
    let released = 0;
    while (released < expiring && engines.virtual.clock.now().getTime() < epoch + profile.leaseMs * 4) {
      const started = performance.now();
      await engines.virtual.fire();
      const passMs = performance.now() - started;
      const found = await releases(db);
      if (found.length > released) {
        return { expired: expiring, released: found.length, passMs, slowestDelayMs: Math.max(...found.map(entry => entry.delayMs)), everyMs: profile.reapEveryMs };
      }
      released = found.length;
    }
    throw new Error(`the engine released none of ${String(expiring)} expired attempts within ${String(profile.leaseMs * 4)} simulated ms`);
  } finally {
    await stopEngines(engines);
    await Promise.all(engines.dbs.map(engineDb => engineDb.destroy()));
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
