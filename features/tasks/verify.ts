import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { sql } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import { shapeOf } from '../../shared/workflow.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { engineHandlesSigtermFrom, hangCeilingMs } from '../../tools/verify/engine.ts';
import { withPostgres, type TestPostgres } from '../../tools/verify/postgres.ts';
import { modelShape, shapeDrift } from '../../tools/verify/model-shape.ts';
import { defineModel, type Shape } from '../../tools/verify/models.ts';
import { lastRealState, type TlcRun, type TraceState } from '../../tools/verify/tlc.ts';
import { catalogProblems, type Audit } from '../../tools/verify/catalog.ts';
import { checkCatalog } from './catalog.ts';
import { claim, lostTooOften } from './claim.ts';
import { coreRunAs } from './run-as.ts';
import { pastSeedNames, pastSeeds, seedPast } from './seed.ts';
import { provePlants, type PlantProof } from './invariants.ts';
import { stepMutantName, type StepMutantName } from './sim-jobs.ts';
import {
  badEnd,
  engineMutantName,
  engineMutants,
  laterReviews,
  mutantName,
  parks,
  probeReaper,
  profileName,
  profiles,
  simulate,
  stepMutantProfile,
  stepMutants,
  mutants as storeMutants,
  unfiredFaults,
  workflows,
  type EngineMutantName,
  type MutantName,
  type Plan,
  type Probe,
  type ProfileName,
  type Run,
} from './simulate.ts';

type TaskView = { readonly id: string; readonly step: string; readonly state: string; readonly runnable: boolean };

type AttemptView = { readonly worker: string; readonly task: string };

const unrunnableIn = (state: TraceState): readonly string[] =>
  [...(/runnable = \(([^)]*)\)/.exec(state.text)?.[1] ?? '').matchAll(/(t\d+) :> FALSE/g)].map(([, id = '']) => id);

const tasksIn = (state: TraceState): readonly TaskView[] =>
  [...state.text.matchAll(/(t\d+) :>\s*\[\s*step \|-> "(\w+)",\s*state \|-> "(\w+)"/g)].map(([, id = '', step = '', status = '']) => ({
    id,
    step,
    state: status,
    runnable: !unrunnableIn(state).includes(id),
  }));

const attemptsIn = (state: TraceState): readonly AttemptView[] =>
  [...state.text.matchAll(/(w\d+) :> (t\d+)\b/g)].map(([, worker = '', task = '']) => ({ worker, task }));

const hungIn = (state: TraceState): readonly string[] => [...state.text.matchAll(/(w\d+) :> "hung"/g)].map(([, worker = '']) => worker);

const failedIn = (state: TraceState): readonly string[] => [...state.text.matchAll(/(w\d+) :> "failed"/g)].map(([, worker = '']) => worker);

const loopedTask = (run: TlcRun, looping: (views: readonly TaskView[]) => boolean): boolean =>
  run.loop.length > 0 && [...new Set(run.loop.flatMap(tasksIn).map(view => view.id))].some(id => looping(run.loop.flatMap(tasksIn).filter(view => view.id === id)));

const twoWorkersClaimOneTask: Shape = {
  label: 'with a trace of two workers claiming one task',
  holds: run => {
    const last = lastRealState(run);
    const tasks = last === undefined ? [] : attemptsIn(last).map(attempt => attempt.task);
    return new Set(tasks).size < tasks.length && run.trace.slice(-2).every(state => state.action === 'Claim');
  },
};

const lateResultAfterReap: Shape = {
  label: "by a reaped attempt's late result",
  holds: run => run.trace.some(state => state.action === 'Reap') && run.trace.at(-1)?.action === 'LateResult',
};

const loopsBetweenImplementAndVerify: Shape = {
  label: 'by a loop between implement and verify',
  holds: run => loopedTask(run, views => views.every(view => view.state === 'ready') && ['implement', 'verify'].every(step => views.some(view => view.step === step))),
};

const loopsFromLandToImplement: Shape = {
  label: 'by a loop from land back to implement',
  holds: run => loopedTask(run, views => views.every(view => view.state === 'ready') && ['implement', 'verify', 'land'].every(step => views.some(view => view.step === step))),
};

const readyTaskNoClaimTakes: Shape = {
  label: 'by a ready task that no claim can take',
  holds: run => {
    const last = lastRealState(run);
    const ending = run.stutters ? (last === undefined ? [] : [last]) : run.loop;
    const stuck = (id: string): boolean => ending.every(state => tasksIn(state).some(view => view.id === id && view.state === 'ready' && !view.runnable));
    return ending.length > 0 && tasksIn(ending[0] ?? { action: '', text: '' }).some(view => stuck(view.id));
  },
};

const claimRunsTaskNobodyCanRunAs: Shape = {
  label: 'by a claim that runs a task nobody can run as',
  holds: run => run.trace.at(-1)?.action === 'Claim' && run.trace.some(state => state.action === 'Reassign'),
};

const approvesForever: Shape = {
  label: 'by outside approvals that never stop',
  holds: run => run.loopActions.includes('OutsideApproval'),
};

const rerunsVerifyForever: Shape = {
  label: 'by verify rerunning forever',
  holds: run => loopedTask(run, views => views.every(view => view.state === 'ready' && view.step === 'verify')),
};

const losesAttemptsForever: Shape = {
  label: 'by a task that loses every attempt',
  holds: run => run.loopActions.includes('Reap') && loopedTask(run, views => views.every(view => view.state === 'ready')),
};

const rerunsFailedStageForever: Shape = {
  label: 'by a failed stage rerunning forever',
  holds: run => run.loopActions.includes('Finish') && loopedTask(run, views => new Set(views.map(view => view.step)).size === 1 && views.every(view => view.state === 'ready' && view.step !== 'verify')),
};

const stoppedTaskKeepsAttempt: Shape = {
  label: 'by a stopped task that keeps its live attempt',
  holds: run => {
    const last = lastRealState(run);
    if (last === undefined) return false;
    const stopped = tasksIn(last).filter(view => view.state === 'stopped').map(view => view.id);
    return attemptsIn(last).some(attempt => stopped.includes(attempt.task));
  },
};

const personEndsALiveAttempt: Shape = {
  label: 'by a stop or retry that ends a live attempt',
  holds: run => {
    const last = run.trace.at(-1);
    const before = run.trace.at(-2);
    return (last?.action === 'Stop' || last?.action === 'Retry') && before !== undefined && attemptsIn(before).length > 0;
  },
};

const holdsThroughout = (states: readonly TraceState[], held: AttemptView): boolean =>
  states.every(state => attemptsIn(state).some(attempt => attempt.worker === held.worker && attempt.task === held.task));

const hungWorkerHoldsItsTask: Shape = {
  label: 'by a hung worker holding its task forever',
  holds: run => {
    const last = lastRealState(run);
    const ending = run.stutters ? (last === undefined ? [] : [last]) : run.loop;
    const first = ending[0];
    return first !== undefined && attemptsIn(first).some(held => holdsThroughout(ending, held) && ending.some(state => hungIn(state).includes(held.worker)));
  },
};

const guards = [
  'ClaimIsExclusive',
  'ClaimNeedsReadyTask',
  'ClaimNeedsAPerson',
  'NoOneParksTask',
  'LateResultIsRefused',
  'RoundsAreCapped',
  'EnvRerunsAreCapped',
  'LostAttemptsAreCapped',
  'StageRetriesAreCapped',
  'InputWaitsAreCapped',
  'PassResetsStageRetries',
  'RetryResetsStageRetries',
  'BehaviorFailureReturnsToImplement',
  'BehaviorFailureLeavesVerify',
  'EnvironmentFailureStaysInVerify',
  'FailureParksTask',
  'RetryKeepsOutputs',
  'RetryEndsAttempt',
  'StopEndsAttempt',
  'StopSparesDoneTasks',
  'EndingSparesOtherTasks',
  'ReaperIsFair',
  'EndStageIsFinal',
  'GateBlocksUntilApproved',
  'ReturnClearsApprovals',
  'MergeChecksGates',
  'MergeWaitsForMergeable',
  'ReviewReturnIsCapped',
  'RetryResumesStopped',
  'RetryKeepsReviews',
  'VerifyPassKeepsLandRounds',
  'OutsideApprovalsAreFinite',
  'LaterReviewParks',
  'OutsideApprovalNeedsAWait',
  'RetryKeepsApprovals',
  'LostApprovalStaysLost',
  'LapsedLeaseCannotRenew',
  'RefusedLaunchIsNotLost',
  'FailedLaunchRelaunches',
  'RetryWaitsAtGate',
  'RetryReturnsWhenRoundsRunOut',
] as const;

const renewsLapsedLeaseForever: Shape = {
  label: 'by a worker whose lease lapses and renews forever',
  holds: run => run.loopActions.includes('Hang') && run.loopActions.includes('Wake') && !run.loopActions.includes('Reap'),
};

const failedLaunchHoldsItsTask: Shape = {
  label: 'by a worker whose launch failed holding its task forever',
  holds: run => {
    const last = lastRealState(run);
    const ending = run.stutters ? (last === undefined ? [] : [last]) : run.loop;
    const first = ending[0];
    return first !== undefined && attemptsIn(first).some(held => holdsThroughout(ending, held) && ending.every(state => failedIn(state).includes(held.worker)));
  },
};

const properties = {
  OneLiveAttempt: 'INVARIANTS',
  LiveAttemptMeansReady: 'INVARIANTS',
  LiveAttemptIsCurrent: 'INVARIANTS',
  AttemptRunsAsAPerson: 'INVARIANTS',
  OutputsSurvive: 'INVARIANTS',
  RoundsCapped: 'INVARIANTS',
  EnvRerunsCapped: 'INVARIANTS',
  LostAttemptsCapped: 'INVARIANTS',
  StageRetriesCapped: 'INVARIANTS',
  InputWaitsCapped: 'INVARIANTS',
  PassLeavesNoStageRetries: 'INVARIANTS',
  StopsAtItsEndStage: 'INVARIANTS',
  ApprovalsMatchGatesPassed: 'INVARIANTS',
  ReviewReturnsCapped: 'INVARIANTS',
  StoppedTaskCanResume: 'INVARIANTS',
  LateWriteChangesNothing: 'PROPERTIES',
  TaskChangesOnlyWithItsAttempt: 'PROPERTIES',
  AttemptEndsOnlyWithItsTask: 'PROPERTIES',
  FailedRoundReturnsToImplement: 'PROPERTIES',
  OutputsOnlyGrow: 'PROPERTIES',
  StageAdvancesOnlyOnPass: 'PROPERTIES',
  DoneIsFinal: 'PROPERTIES',
  StageMovesOneStep: 'PROPERTIES',
  OnlyAPersonStops: 'PROPERTIES',
  RetryLeavesNoStageRetries: 'PROPERTIES',
  RetryStartsWhereTheFailureRoutes: 'PROPERTIES',
  GatePassesOnlyOnApprove: 'PROPERTIES',
  MergeNeedsEveryGate: 'PROPERTIES',
  ReviewsOnlyGrow: 'PROPERTIES',
  LaterReviewWaitsForAPerson: 'PROPERTIES',
  EndStagePassIsDone: 'PROPERTIES',
  ReleasedOnlyAfterItsLease: 'PROPERTIES',
  LapsedLeaseNeverRenews: 'PROPERTIES',
  GateStopResumesAtGate: 'PROPERTIES',
  EveryTaskSettles: 'PROPERTIES',
} as const;

type Guard = (typeof guards)[number];

type Property = keyof typeof properties;

type Setting = 'MaxHumanActions' | 'IgnoreLaterReviews' | 'ReadyBeforeGreen' | 'GateSteps';

type Extra = { readonly shape?: Shape; readonly overrides?: Readonly<Partial<Record<Setting, string>>> };

const breaks = (guard: Guard, without: string, property: Property, extra: Extra = {}) => ({ guard, without, property, ...extra });

const unsettled = (guard: Guard, without: string, shape: Shape) => breaks(guard, without, 'EveryTaskSettles', { shape });

const onlyReaps = { MaxHumanActions: '0' };

const tasksModel = defineModel({
  name: 'tasks',
  module: new URL('Tasks.tla', import.meta.url),
  configs: {
    pr: {
      file: 'Tasks.cfg',
      floors: { Tasks: 2, Workers: 2, MaxRounds: 2, MaxEnvReruns: 2, MaxLost: 2, MaxStageRetries: 1, MaxInputWaits: 1, MaxHumanActions: 2, MaxReassignments: 1, MaxLaunchFaults: 1 },
    },
    nightly: {
      file: 'Tasks.nightly.cfg',
      floors: { Tasks: 2, Workers: 2, MaxRounds: 3, MaxEnvReruns: 3, MaxLost: 3, MaxStageRetries: 2, MaxInputWaits: 2, MaxHumanActions: 3, MaxReassignments: 1, MaxLaunchFaults: 1 },
    },
  },
  guards,
  properties,
  liveness: ['EveryTaskSettles'],
  settings: ['IgnoreLaterReviews', 'ReadyBeforeGreen', 'GateSteps'],
  mutants: [
    breaks('ClaimIsExclusive', 'a second worker can insert an attempt', 'OneLiveAttempt', { shape: twoWorkersClaimOneTask }),
    breaks('ClaimNeedsReadyTask', 'a worker can claim a task that is not ready', 'LiveAttemptMeansReady'),
    breaks('ClaimNeedsAPerson', 'a claim runs a task nobody can run as', 'AttemptRunsAsAPerson', { shape: claimRunsTaskNobodyCanRunAs }),
    unsettled('NoOneParksTask', 'a task nobody can run as stays ready', readyTaskNoClaimTakes),
    breaks('StopEndsAttempt', 'stopping a task leaves its attempt live', 'LiveAttemptMeansReady', { shape: stoppedTaskKeepsAttempt }),
    breaks('RetryEndsAttempt', 'a retry leaves the old attempt live', 'LiveAttemptIsCurrent'),
    breaks('LateResultIsRefused', 'a late result still applies', 'LateWriteChangesNothing', { overrides: onlyReaps, shape: lateResultAfterReap }),
    breaks('LateResultIsRefused', 'a late result still applies', 'TaskChangesOnlyWithItsAttempt', { overrides: onlyReaps, shape: lateResultAfterReap }),
    breaks('RetryKeepsOutputs', 'a retry drops earlier outputs', 'OutputsSurvive'),
    breaks('RetryKeepsOutputs', 'a retry drops earlier outputs', 'OutputsOnlyGrow'),
    breaks('EnvironmentFailureStaysInVerify', 'an environment failure counts as a pass', 'StageAdvancesOnlyOnPass'),
    breaks('StopSparesDoneTasks', 'a person can stop a done task', 'DoneIsFinal'),
    breaks('BehaviorFailureReturnsToImplement', 'a behavior failure returns to specify', 'StageMovesOneStep'),
    breaks('BehaviorFailureLeavesVerify', 'a behavior failure reruns Verify', 'FailedRoundReturnsToImplement'),
    breaks('EndingSparesOtherTasks', 'a stop or retry ends every live attempt', 'AttemptEndsOnlyWithItsTask', { shape: personEndsALiveAttempt }),
    breaks('FailureParksTask', 'a failed stage stops the task', 'OnlyAPersonStops'),
    unsettled('RoundsAreCapped', 'verify rounds have no cap', loopsBetweenImplementAndVerify),
    breaks('RoundsAreCapped', 'verify rounds have no cap', 'RoundsCapped'),
    unsettled('EnvRerunsAreCapped', 'environment reruns have no cap', rerunsVerifyForever),
    breaks('EnvRerunsAreCapped', 'environment reruns have no cap', 'EnvRerunsCapped'),
    unsettled('LostAttemptsAreCapped', 'lost attempts have no cap', losesAttemptsForever),
    breaks('LostAttemptsAreCapped', 'lost attempts have no cap', 'LostAttemptsCapped'),
    unsettled('StageRetriesAreCapped', 'stage retries have no cap', rerunsFailedStageForever),
    breaks('StageRetriesAreCapped', 'stage retries have no cap', 'StageRetriesCapped'),
    breaks('InputWaitsAreCapped', 'needs input has no cap', 'InputWaitsCapped'),
    breaks('PassResetsStageRetries', 'a pass keeps the stage retries', 'PassLeavesNoStageRetries'),
    breaks('RetryResetsStageRetries', "a person's retry keeps the stage retries", 'RetryLeavesNoStageRetries'),
    unsettled('ReaperIsFair', 'the reaper has no fairness', hungWorkerHoldsItsTask),
    breaks('LapsedLeaseCannotRenew', 'a worker renews a lease that has lapsed', 'LapsedLeaseNeverRenews'),
    unsettled('LapsedLeaseCannotRenew', 'a worker renews a lease that has lapsed', renewsLapsedLeaseForever),
    breaks('RefusedLaunchIsNotLost', 'a refused launch counts as a lost attempt', 'ReleasedOnlyAfterItsLease'),
    unsettled('FailedLaunchRelaunches', 'a launch that failed is never tried again', failedLaunchHoldsItsTask),
    breaks('EndStageIsFinal', "passing a routine's end stage does not end the task", 'StopsAtItsEndStage'),
    breaks('GateBlocksUntilApproved', 'a gated stage passes straight to the next stage', 'GatePassesOnlyOnApprove'),
    breaks('ReturnClearsApprovals', 'a return to Implement keeps the approval of a gate it must pass again', 'GatePassesOnlyOnApprove'),
    breaks('ReturnClearsApprovals', 'a return to Implement keeps the approval of a gate it must pass again', 'ApprovalsMatchGatesPassed'),
    breaks('LostApprovalStaysLost', 'a return to Implement restores the approval of an earlier gate that went missing at Land', 'ApprovalsMatchGatesPassed'),
    breaks('MergeChecksGates', "Land merges a task that a fault left without a gate's approval", 'MergeNeedsEveryGate'),
    breaks('MergeWaitsForMergeable', 'Land merges past a red check on a pull request that left draft before its checks were green', 'MergeNeedsEveryGate', {
      overrides: { IgnoreLaterReviews: '{}' },
    }),
    breaks('MergeWaitsForMergeable', 'Land merges past a later review that its routine ignores', 'MergeNeedsEveryGate', {
      overrides: { ReadyBeforeGreen: '{}', GateSteps: '{"specify"}' },
    }),
    breaks('ReviewReturnIsCapped', 'every review that asks for changes returns the task to Implement', 'ReviewReturnsCapped'),
    breaks('RetryResumesStopped', 'Retry cannot resume a stopped task', 'StoppedTaskCanResume'),
    breaks('RetryKeepsReviews', "a person's retry forgets the review return", 'ReviewsOnlyGrow'),
    breaks('RetryKeepsApprovals', "a person's retry forgets the task's approvals", 'StoppedTaskCanResume'),
    breaks('RetryWaitsAtGate', 'Retry after a Stop at a gate reruns the gated step', 'GateStopResumesAtGate'),
    breaks('RetryReturnsWhenRoundsRunOut', 'Retry after the rounds run out reruns the step that failed', 'RetryStartsWhereTheFailureRoutes'),
    unsettled('VerifyPassKeepsLandRounds', 'a Verify pass clears the Land rounds of a task with no gate', loopsFromLandToImplement),
    unsettled('OutsideApprovalsAreFinite', 'outside approvals may never stop', approvesForever),
    breaks('OutsideApprovalNeedsAWait', 'an outside approval resumes a task that is not awaiting one', 'TaskChangesOnlyWithItsAttempt'),
    breaks('LaterReviewParks', 'a later review of a routine that does not ignore them waits for an outside approval', 'LaterReviewWaitsForAPerson'),
    breaks('EndStageIsFinal', "passing a routine's end stage does not end the task", 'EndStagePassIsDone'),
  ],
});

const simulationFlags = {
  profile: { type: 'string' },
  seeds: { type: 'string' },
  from: { type: 'string' },
  seed: { type: 'string' },
  steps: { type: 'string' },
  mutant: { type: 'string' },
  trace: { type: 'string' },
} as const;

const simulationOptions = z.object({
  profile: z.union([profileName, z.literal('all')]).default('default'),
  seeds: z.coerce.number().int().positive().default(20),
  from: z.coerce.number().int().nonnegative().default(1),
  seed: z.coerce.number().int().nonnegative().optional(),
  steps: z.coerce.number().int().positive().default(300),
  mutant: z.union([mutantName, engineMutantName, stepMutantName, z.literal('all')]).optional(),
  trace: z.string().optional(),
});

type SimulationOptions = z.infer<typeof simulationOptions>;

const seedsOf = (options: SimulationOptions): readonly number[] =>
  options.seed === undefined ? Array.from({ length: options.seeds }, (_, index) => options.from + index) : [options.seed];

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const withoutGuard = (plan: Plan): MutantName | EngineMutantName | StepMutantName | undefined => plan.mutant ?? plan.engine ?? plan.step;

const replay = (run: Run): string => {
  const mutant = withoutGuard(run.plan);
  return `npm run verify -- tasks-sim ${mutant === undefined ? `--profile ${run.plan.profile}` : `--mutant ${mutant}`} --seed ${String(run.seed)} --steps ${String(run.plan.steps)}`;
};

function violation(run: Run): string {
  if (run.failure === undefined) return `seed ${String(run.seed)} broke nothing`;
  const { step, move, broken } = run.failure;
  const names = [...new Set(broken.map(found => found.property))].join(', ');
  const rows = broken.slice(0, 3).map(found => `${found.property} ${JSON.stringify(found.row)}`);
  return `${names} violated at seed ${String(run.seed)}, step ${String(step)}, after ${move}: ${rows.join('; ')}; replay: ${replay(run)}`;
}

const traceWriter = (folder: string | undefined): ((run: Run) => void) | undefined =>
  folder === undefined
    ? undefined
    : run => {
        mkdirSync(folder, { recursive: true });
        writeFileSync(join(folder, `${run.plan.profile}-${withoutGuard(run.plan) ?? 'every-guard'}-seed-${String(run.seed)}.json`), `${JSON.stringify(run, null, 2)}\n`);
      };

function everyBurstHasOneWinner(runs: readonly Run[]): Check {
  const bursts = runs.flatMap(run => run.bursts);
  const name = 'races: every burst had exactly 1 winner';
  const winners = [...new Set(bursts.map(burst => burst.winners))].sort((a, b) => a - b);
  return bursts.length > 0 && winners.join() === '1'
    ? pass(name, `${String(bursts.length)} bursts of ${String(profiles.races.burst)} claims, median settle ${median(bursts.map(burst => burst.ms)).toFixed(1)} ms`)
    : fail(name, `${String(bursts.length)} bursts, winners seen: ${winners.join(', ')}`);
}

function everySeedFinishesATask(profile: ProfileName, runs: readonly Run[]): Check {
  const name = `${profile}: every seed took at least one task to done`;
  const done = runs.map(run => run.done);
  const idle = runs.filter(run => run.done === 0).map(run => run.seed);
  return idle.length === 0
    ? pass(name, `${String(Math.min(...done))} to ${String(Math.max(...done))} tasks done per seed, median ${String(median(done))}`)
    : fail(name, `${String(idle.length)} seeds took no task to done: ${idle.slice(0, 10).join(', ')}${idle.length > 10 ? ', ...' : ''}`);
}

function everyHungAttemptLost(runs: readonly Run[]): Check {
  const hung = runs.reduce((sum, run) => sum + run.hung, 0);
  const notLost = runs.flatMap(run => run.hungNotLost);
  const name = 'hangs: every hung attempt ended lost';
  return hung > 0 && notLost.length === 0
    ? pass(name, `${String(hung)} hung attempts, all lost`)
    : fail(name, `${String(hung)} hung attempts, not lost: ${notLost.slice(0, 5).join(', ')}`);
}

async function profileChecks(postgres: TestPostgres, profile: ProfileName, options: SimulationOptions): Promise<readonly Check[]> {
  const started = performance.now();
  const runs = await simulate(postgres, [{ profile, seeds: seedsOf(options), steps: options.steps }], traceWriter(options.trace));
  const seconds = (performance.now() - started) / 1000;
  const failed = runs.filter(run => run.failure !== undefined);
  const steps = runs.reduce((sum, run) => sum + run.steps, 0);
  const bursts = runs.flatMap(run => run.bursts);
  const hung = runs.reduce((sum, run) => sum + run.hung, 0);
  const tally = new Map<string, number>();
  for (const [outcome, times] of runs.flatMap(run => Object.entries(run.tally))) tally.set(outcome, (tally.get(outcome) ?? 0) + times);
  const detail = [
    `${String(options.steps)} steps each plus a quiet phase, ${String(steps)} steps in ${seconds.toFixed(1)} s, ${(steps / seconds).toFixed(0)} steps per second`,
    `Postgres ready in ${(postgres.readyInMs / 1000).toFixed(1)} s`,
    `${String(bursts.length)} bursts, median settle ${median(bursts.map(burst => burst.ms)).toFixed(1)} ms`,
    `${String(hung)} hung attempts`,
    [...tally].sort(([a], [b]) => a.localeCompare(b)).map(([outcome, times]) => `${outcome} ${String(times)}`).join(', '),
  ].join('; ');
  const name = `${profile}: ${String(runs.length)} seeds, ${String(failed.length)} violations`;
  const [first] = failed;
  return [
    first === undefined ? pass(name, detail) : fail(name, violation(first)),
    everySeedFinishesATask(profile, runs),
    everyWeightedFaultFired(profile, runs),
    badVersionsPark(profile, runs),
    ...(profile === 'races' ? [everyBurstHasOneWinner(runs)] : []),
    ...(profile === 'hangs' ? [everyHungAttemptLost(runs)] : []),
    ...(profile === 'reviews' ? [laterReviewsReached(runs)] : []),
    ...(profile === 'people' ? [gateStopsRetried(runs)] : []),
    ...(engineProfiles.has(profile) ? [releasesWithinOneInterval(profile, runs), everyReleaseLoggedOnce(profile, runs)] : []),
    ...(profile === 'db-pause' ? [outagesLoggedAndResumed(runs)] : []),
    ...(profile === 'jobs' ? [jobFaultsReached(runs)] : []),
    ...(profile === 'behavior' ? [checksParkAtTheirCap(runs, parks.rounds, 'every task that reached Verify waits after 3 rounds with the instruction for that wait, unless its attempts were lost first')] : []),
    ...(profile === 'environment' ? [checksParkAtTheirCap(runs, parks.reruns, 'every task that reached Verify parked at the rerun cap, unless its attempts were lost first, and no round was charged')] : []),
  ];
}

function laterReviewsReached(runs: readonly Run[]): Check {
  const name = 'reviews: a review past the cap asked for changes at Land, so LaterReviewWaitsForAPerson had a case to check';
  const reached = laterReviews(runs);
  return reached > 0 ? pass(name, `${String(reached)} later reviews across ${String(runs.length)} seeds`) : fail(name, `none across ${String(runs.length)} seeds`);
}

function gateStopsRetried(runs: readonly Run[]): Check {
  const name = 'people: a person retried a task stopped at a gate, so GateStopResumesAtGate had a case to check';
  const reached = runs.reduce((sum, run) => sum + (run.tally['retry at a gate'] ?? 0), 0);
  return reached > 0 ? pass(name, `${String(reached)} retries at a gate across ${String(runs.length)} seeds`) : fail(name, `none across ${String(runs.length)} seeds`);
}

function everyWeightedFaultFired(profile: ProfileName, runs: readonly Run[]): Check {
  const name = `${profile}: every fault the profile weights above 0 fired at least once`;
  const unfired = unfiredFaults(profile, runs);
  return unfired.length === 0 ? pass(name, `across ${String(runs.length)} seeds`) : fail(name, `never fired: ${unfired.join(', ')}`);
}

function badVersionsPark(profile: ProfileName, runs: readonly Run[]): Check {
  const name = `${profile}: no task whose routine ends at ${badEnd}, where Code change cannot end, reached done, and such tasks parked with the instruction to stop them`;
  const bad = runs.flatMap(run => run.tasks.filter(task => task.lastStep === badEnd).map(task => ({ seed: run.seed, ...task })));
  const done = bad.filter(task => task.state === 'done');
  const parked = bad.filter(task => task.state === 'waiting' && task.reason?.toLowerCase().includes(`ends at ${badEnd}`) === true);
  return done.length === 0 && parked.length > 0
    ? pass(name, `${String(parked.length)} of ${String(bad.length)} such tasks parked with that instruction, and none reached done`)
    : fail(name, done.length > 0 ? done.slice(0, 3).map(task => `seed ${String(task.seed)} task ${task.key} reached done`).join('; ') : `none of ${String(bad.length)} such tasks parked`);
}

function checksParkAtTheirCap(runs: readonly Run[], reason: string, name: string): Check {
  const settled = runs.flatMap(run => run.tasks.map(task => ({ seed: run.seed, ...task })));
  const atVerify = settled.filter(task => task.workflow === 'code-change' && task.step === 'verify');
  const wrong = atVerify.filter(task => task.state !== 'waiting' || (task.reason !== reason && task.reason !== lostTooOften));
  const lostThere = atVerify.filter(task => task.reason === lostTooOften).length;
  const beyond = settled.filter(task => task.workflow === 'code-change' && task.step === 'land');
  const rounds = reason === parks.reruns ? settled.filter(task => typeof task.counts === 'object' && task.counts !== null && 'rounds' in task.counts) : [];
  const problems = [
    ...wrong.slice(0, 3).map(task => `seed ${String(task.seed)} task ${task.key} is ${task.state} at verify: ${task.reason ?? 'no instruction'}`),
    ...beyond.slice(0, 3).map(task => `seed ${String(task.seed)} task ${task.key} reached land`),
    ...rounds.slice(0, 3).map(task => `seed ${String(task.seed)} task ${task.key} was charged a round`),
  ];
  return atVerify.length > 0 && problems.length === 0
    ? pass(name, `${String(atVerify.length - lostThere)} tasks waited at verify with: ${reason} ${String(lostThere)} more parked there first because their attempts were lost.`)
    : fail(name, problems.length === 0 ? 'no task reached verify' : problems.join('; '));
}

const engineProfiles: ReadonlySet<ProfileName> = new Set<ProfileName>(['crashes', 'db-pause', 'two-engines']);

const releasedLine = /: released attempt (\d+) of task /;

const releasedLines = (run: Run): readonly string[] => run.engineLog.filter(line => releasedLine.test(line));

function releasesWithinOneInterval(profile: ProfileName, runs: readonly Run[]): Check {
  const budget = profiles[profile].reapEveryMs * 1.1;
  const name = `${profile}: every release landed within one interval plus 10%, ${String(budget)} ms after its lease expired`;
  const releases = runs.flatMap(run => run.releases.map(release => ({ run, ...release })));
  const slowest = releases.reduce<(typeof releases)[number] | undefined>((worst, release) => (worst === undefined || release.delayMs > worst.delayMs ? release : worst), undefined);
  const [firstLine] = runs.flatMap(releasedLines);
  if (slowest === undefined || firstLine === undefined) return fail(name, 'the engine released no attempt');
  const detail = `${String(releases.length)} releases, slowest ${slowest.delayMs.toFixed(0)} ms, attempt ${slowest.attempt} of task ${slowest.key} at seed ${String(slowest.run.seed)} (replay: ${replay(slowest.run)}); first logged line: ${firstLine}`;
  return slowest.delayMs <= budget ? pass(name, detail) : fail(name, detail);
}

function everyReleaseLoggedOnce(profile: ProfileName, runs: readonly Run[]): Check {
  const name = `${profile}: the engines logged exactly one released line for each lost attempt, and none for any other`;
  const problems = runs.flatMap(run => {
    const logged = new Map<string, number>();
    for (const line of releasedLines(run)) {
      const attempt = releasedLine.exec(line)?.[1] ?? '';
      logged.set(attempt, (logged.get(attempt) ?? 0) + 1);
    }
    const lost = new Set(run.releases.map(release => release.attempt));
    return [
      ...[...lost].filter(attempt => logged.get(attempt) !== 1).map(attempt => `seed ${String(run.seed)} attempt ${attempt} was logged ${String(logged.get(attempt) ?? 0)} times`),
      ...[...logged.keys()].filter(attempt => !lost.has(attempt)).map(attempt => `seed ${String(run.seed)} logged attempt ${attempt}, which is not lost`),
    ];
  });
  const lines = runs.reduce((sum, run) => sum + releasedLines(run).length, 0);
  const engines = new Set(runs.flatMap(run => releasedLines(run).map(line => line.split(' reaper:')[0])));
  return problems.length === 0 && lines > 0
    ? pass(name, `${String(lines)} released lines from ${[...engines].sort().join(' and ')} across ${String(runs.length)} seeds`)
    : fail(name, problems.length === 0 ? 'no released line' : problems.slice(0, 5).join('; '));
}

function jobFaultsReached(runs: readonly Run[]): Check {
  const name = 'jobs: attempts continued from a lost push, late pushes reached the store and were refused, and replies that fail the parse ended their attempts';
  const tallied = (prefix: string): number => runs.reduce((sum, run) => sum + Object.entries(run.tally).reduce((within, [outcome, times]) => within + (outcome.startsWith(prefix) ? times : 0), 0), 0);
  const reached = {
    continued: runs.reduce((sum, run) => sum + run.continued, 0),
    refused: tallied('late push refused'),
    applied: tallied('late push applied'),
    unparsed: tallied('reply that fails the parse finished'),
  };
  const detail = `${String(reached.continued)} attempts started from a lost attempt's push, ${String(reached.refused)} late pushes refused and ${String(reached.applied)} applied, ${String(reached.unparsed)} replies that fail the parse ended their attempts`;
  return reached.continued > 0 && reached.refused > 0 && reached.applied === 0 && reached.unparsed > 0 ? pass(name, detail) : fail(name, detail);
}

function outagesLoggedAndResumed(runs: readonly Run[]): Check {
  const name = 'db-pause: each pause was logged as a failed pass, the engine resumed with fresh leases and kept running, and it released the backlog afterward';
  const paused = runs.filter(run => (run.tally['postgres paused'] ?? 0) > 0);
  const problems: string[] = [];
  let releasedAfter = 0;
  let longest = '';
  for (const run of paused) {
    const failedAt = run.engineLog.findIndex(line => line.includes(' failed after '));
    const resumedAt = run.engineLog.findIndex((line, index) => index > failedAt && line.includes(': gave '));
    if (failedAt < 0 || resumedAt < 0) problems.push(`seed ${String(run.seed)} logged ${failedAt < 0 ? 'no failed pass' : 'no resume after its failed pass'}`);
    else {
      releasedAfter += run.engineLog.slice(resumedAt).filter(line => releasedLine.test(line)).length;
      longest = longest === '' ? `${run.engineLog[failedAt] ?? ''} Then: ${run.engineLog[resumedAt] ?? ''}` : longest;
    }
  }
  return paused.length > 0 && problems.length === 0 && releasedAfter > 0
    ? pass(name, `${String(paused.length)} of ${String(runs.length)} seeds paused Postgres, ${String(releasedAfter)} releases after the resume. For example: ${longest}`)
    : fail(name, problems.length > 0 ? problems.slice(0, 5).join('; ') : `${String(paused.length)} seeds paused, ${String(releasedAfter)} releases after a resume`);
}

async function mutantRuns(postgres: TestPostgres, properties: readonly string[], name: string, plan: Plan, options: SimulationOptions): Promise<Check> {
  const runs = await simulate(postgres, [plan], traceWriter(options.trace));
  const first = runs.find(run => run.failure !== undefined);
  if (first === undefined) return fail(name, `no violation in ${String(runs.length)} seeds of ${String(plan.steps)} steps`);
  return first.failure?.broken.some(found => properties.includes(found.property)) === true ? pass(name, violation(first)) : fail(name, `expected ${properties.join(' or ')}, got ${violation(first)}`);
}

function mutantCheck(postgres: TestPostgres, mutant: MutantName, options: SimulationOptions): Promise<Check> {
  const properties: readonly string[] = storeMutants[mutant];
  return mutantRuns(postgres, properties, `${properties.join(' or ')} fails without ${mutant}`, { profile: 'default', seeds: seedsOf(options), steps: options.steps, mutant }, options);
}

function engineMutantCheck(postgres: TestPostgres, mutant: EngineMutantName, options: SimulationOptions): Promise<Check> {
  const { profile, breaks, steps = options.steps } = engineMutants[mutant];
  return mutantRuns(postgres, breaks, `${breaks.join(' or ')} fails under the ${mutant} engine in the ${profile} profile`, { profile, seeds: seedsOf(options), steps, engine: mutant }, options);
}

function stepMutantCheck(postgres: TestPostgres, mutant: StepMutantName, options: SimulationOptions): Promise<Check> {
  const { breaks } = stepMutants[mutant];
  return mutantRuns(postgres, breaks, `${breaks.join(' or ')} fails under the ${mutant} step mutant in the ${stepMutantProfile} profile`, { profile: stepMutantProfile, seeds: seedsOf(options), steps: options.steps, step: mutant }, options);
}

function catalogCheck(catalog: Audit): Check {
  const name = 'every named constraint, index, and trigger on the tables tasks owns, apart from those named for a feature that keeps its own catalog, has a mutant or a reason in noMutantYet';
  const problems = catalogProblems(catalog);
  const mutated = Object.keys(storeMutants).length;
  const guards = catalog.guards.length;
  return problems.length === 0 ? pass(name, `${String(guards)} guards: ${String(mutated)} with a mutant, ${String(guards - mutated)} with a reason`) : fail(name, problems.join('; '));
}

function simulatorShapeCheck(): Check {
  const name = "the simulator's copy of Code change has the shape that Tasks.tla checks";
  const [copy] = workflows;
  const drift = shapeDrift(modelShape(new URL('Tasks.tla', import.meta.url), new URL('Tasks.cfg', import.meta.url)), shapeOf(copy));
  return drift.length === 0 ? pass(name, copy.steps.map(kind => kind.name).join(', ')) : fail(name, drift.join('; '));
}

function plantsCheck(proofs: readonly PlantProof[]): Check {
  const name = "each property's plant trips that property's check";
  const misses = proofs.flatMap(({ property, plant, atStart, reported }) => {
    if (atStart.length > 0) return [`${property} plant ${String(plant)}: its setup already breaks ${atStart.join(', ')}`];
    return reported.includes(property) ? [] : [`${property} plant ${String(plant)} reported ${reported.length === 0 ? 'nothing' : reported.join(', ')}`];
  });
  return misses.length === 0 ? pass(name, `${String(proofs.length)} of ${String(proofs.length)} plants caught`) : fail(name, misses.join('; '));
}

async function simulationChecks(postgres: TestPostgres, options: SimulationOptions): Promise<readonly Check[]> {
  const checks: Check[] = [];
  if (options.mutant === 'all') {
    checks.push(simulatorShapeCheck(), catalogCheck(await checkCatalog(postgres)), plantsCheck(await provePlants(postgres, workflows)));
    for (const mutant of mutantName.options) checks.push(await mutantCheck(postgres, mutant, options));
    for (const mutant of engineMutantName.options) checks.push(await engineMutantCheck(postgres, mutant, options));
    for (const mutant of stepMutantName.options) checks.push(await stepMutantCheck(postgres, mutant, options));
  } else if (options.mutant !== undefined) {
    const store = mutantName.safeParse(options.mutant);
    const step = stepMutantName.safeParse(options.mutant);
    if (store.success) checks.push(await mutantCheck(postgres, store.data, options));
    else if (step.success) checks.push(await stepMutantCheck(postgres, step.data, options));
    else checks.push(await engineMutantCheck(postgres, engineMutantName.parse(options.mutant), options));
  } else {
    for (const profile of options.profile === 'all' ? profileName.options : [options.profile]) checks.push(...(await profileChecks(postgres, profile, options)));
  }
  return checks;
}

const engineMain = fileURLToPath(new URL('../../services/engine/main.ts', import.meta.url));

const engineStartedAt = new Date('2026-01-01T00:00:00.000Z');

async function saveRoutine(db: Database, person: string, repository: string, workflow: string): Promise<string> {
  const routine = await db.insertInto('routine').values({ creator_id: person }).returning('id').executeTakeFirstOrThrow();
  const action = randomUUID();
  await db.insertInto('human_action').values({ id: action, at: engineStartedAt, person_id: person, kind: 'edit_routine', routine_id: routine.id }).execute();
  await db
    .insertInto('routine_version')
    .values({
      routine_id: routine.id,
      version: 1,
      name: 'Engine start',
      goal: 'Start the engine.',
      repository_id: repository,
      action_id: action,
      workflow,
      source: JSON.stringify({ kind: 'jira-search' }),
      needs_repository: true,
    })
    .execute();
  return routine.id;
}

const quickEngine = { REAPER_EVERY_MS: '200', LEASE_MS: '1000' } as const;

const startLine = 'The engine runs';

function startEngine(env: NodeJS.ProcessEnv): { readonly status: number | null; readonly said: string } {
  const started = spawnSync(process.execPath, [engineMain], { env, encoding: 'utf8', timeout: hangCeilingMs });
  const hung = started.error === undefined ? '' : ` The verify tool stopped the engine after ${String(hangCeilingMs / 1000)} s: ${started.error.message}`;
  return { status: started.status, said: `${started.stdout}${started.stderr}`.trim() + hung };
}

type RunningEngine = {
  readonly said: () => string;
  readonly errors: () => string;
  readonly running: () => boolean;
  readonly waitFor: (text: string) => Promise<boolean>;
  readonly terminate: () => Promise<number | null>;
  readonly kill: () => Promise<number | null>;
};

function runEngine(url: string, settings: Readonly<Record<string, string>>): RunningEngine {
  const child = spawn(process.execPath, [engineMain], { env: { ...process.env, ...settings, DATABASE_URL: url }, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  let errors = '';
  let code: number | null | undefined;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    said += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    errors += chunk;
  });
  const exited = new Promise<number | null>(resolve => {
    child.on('exit', status => {
      code = status;
      resolve(status);
    });
  });
  const waitFor = async (text: string): Promise<boolean> => {
    const deadline = performance.now() + hangCeilingMs;
    while (!said.includes(text) && code === undefined && performance.now() < deadline) await wait(20);
    if (!said.includes(text) && code === undefined) errors += `\nThe verify tool stopped waiting for "${text}" after ${String(hangCeilingMs / 1000)} s, and the engine still ran.`;
    return said.includes(text);
  };
  return {
    said: () => said.trim(),
    errors: () => errors.trim(),
    running: () => code === undefined,
    waitFor,
    terminate: async () => {
      await waitFor(engineHandlesSigtermFrom);
      child.kill('SIGTERM');
      return Promise.race([exited, wait(hangCeilingMs).then(() => 'hung' as const)]).then(status => {
        if (status === 'hung') {
          child.kill('SIGKILL');
          throw new Error(`the engine did not exit within ${String(hangCeilingMs / 1000)} s of SIGTERM. It said: ${said}`);
        }
        return status;
      });
    },
    kill: () => {
      child.kill('SIGKILL');
      return exited;
    },
  };
}

async function until(ms: number, done: () => Promise<boolean>): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await done()) return true;
    await wait(50);
  }
  return done();
}

const passesIn = (said: string): number => Number(/reaper: stopped after (\d+) passes, 0 of them failed/.exec(said)?.[1] ?? '-1');

type LiteralStep = { readonly workflow: string; readonly position: number; readonly name: string; readonly run_by: string; readonly requires: readonly string[]; readonly failures: object };

const ends = { fail: { kind: 'fail', to: null }, needs_input: { kind: 'ask', to: null } };

const declaredSteps: readonly LiteralStep[] = [
  { workflow: 'code-change', position: 1, name: 'specify', run_by: 'agent', requires: ['text'], failures: ends },
  { workflow: 'code-change', position: 2, name: 'implement', run_by: 'agent', requires: ['text'], failures: ends },
  {
    workflow: 'code-change',
    position: 3,
    name: 'verify',
    run_by: 'agent',
    requires: ['text'],
    failures: { needs_input: { kind: 'ask', to: null }, behavior_fail: { kind: 'return', to: 'implement' }, environment_fail: { kind: 'rerun', to: 'verify' } },
  },
  {
    workflow: 'code-change',
    position: 4,
    name: 'land',
    run_by: 'engine',
    requires: ['text'],
    failures: { ...ends, red_check: { kind: 'return', to: 'implement' }, changes_requested: { kind: 'review', to: 'implement' }, review_required: { kind: 'await', to: null } },
  },
];

const retiredSteps: readonly LiteralStep[] = ['gather', 'draft', 'post'].map((name, index) => ({ workflow: 'retired-flow', position: index + 1, name, run_by: 'agent', requires: ['text'], failures: ends }));

const publishedRows = (db: Database): Promise<readonly unknown[]> => db.selectFrom('published_workflow_step').selectAll().orderBy('workflow').orderBy('position').execute();

const publishedProviders = async (db: Database): Promise<readonly string[]> => (await db.selectFrom('published_provider').select('name').orderBy('name').execute()).map(row => row.name);

const publishedDrift = (rows: readonly unknown[], providers: readonly string[]): string | null =>
  isDeepStrictEqual(rows, declaredSteps) && isDeepStrictEqual(providers, ['tests-only'])
    ? null
    : `published ${JSON.stringify(rows)} and the providers ${providers.join(', ') || 'none'}, where code-change declares ${JSON.stringify(declaredSteps)} and the engine is given tests-only`;

const rowVersions = async (db: Database): Promise<readonly string[]> => {
  const { rows } = await sql<{ version: string }>`
    select format('%s/%s@%s', workflow, position, xmin) as version from published_workflow_step
    union all
    select format('%s@%s', name, xmin) from published_provider
    order by 1`.execute(db);
  return rows.map(row => row.version);
};

const insertSteps = (db: Database, steps: readonly LiteralStep[]): Promise<unknown> =>
  db
    .insertInto('published_workflow_step')
    .values(steps.map(step => ({ ...step, requires: [...step.requires], failures: JSON.stringify(step.failures) })))
    .execute();

async function publishCrashCheck(postgres: TestPostgres): Promise<Check> {
  const name = 'an engine killed inside its publish transaction leaves the old published rows whole, and the next start replaces them with the new set';
  const scratch = await postgres.scratch();
  const db = connect(scratch.stableUrl, 3);
  try {
    await insertSteps(db, [...declaredSteps, ...retiredSteps]);
    const before = await publishedRows(db);
    const writing = async (): Promise<boolean> =>
      Number(
        (
          await sql<{ writing: string }>`
            select count(*) as writing from pg_stat_activity
            where datname = current_database() and pid <> pg_backend_pid() and backend_xid is not null and wait_event_type = 'Lock'`.execute(db)
        ).rows[0]?.writing ?? '0',
      ) > 0;
    const openWrites = async (): Promise<boolean> =>
      Number(
        (
          await sql<{ open: string }>`select count(*) as open from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and backend_xid is not null`.execute(db)
        ).rows[0]?.open ?? '0',
      ) === 0;
    let release = (): void => undefined;
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    const blocking = db.connection().execute(async connection => {
      await sql`begin`.execute(connection);
      await sql`select name from published_workflow_step where workflow = 'retired-flow' and position = 3 for update`.execute(connection);
      await released;
      await sql`commit`.execute(connection);
    });
    const doomed = runEngine(scratch.stableUrl, quickEngine);
    const caught = await until(10_000, writing);
    await doomed.kill();
    release();
    await blocking;
    const settled = await until(10_000, openWrites);
    const afterKill = await publishedRows(db);
    const restarted = runEngine(scratch.stableUrl, quickEngine);
    const restartedUp = await restarted.waitFor(startLine);
    const restartedStatus = await restarted.terminate();
    const replaced = publishedDrift(await publishedRows(db), await publishedProviders(db));
    return caught && settled && isDeepStrictEqual(afterKill, before) && restartedUp && restartedStatus === 0 && replaced === null
      ? pass(name, `the engine had deleted part of retired-flow and waited on its last step when it was killed; afterwards all ${String(afterKill.length)} old rows stood, and the restart published the ${String(declaredSteps.length)} steps of code-change alone`)
      : fail(
          name,
          `caught mid-write ${String(caught)}, settled ${String(settled)}, old rows whole ${String(isDeepStrictEqual(afterKill, before))} (${JSON.stringify(afterKill)}), restarted ${String(restartedUp)} with exit ${String(restartedStatus)}, ${replaced ?? 'new set published'}: ${doomed.said()} ${doomed.errors()} ${restarted.said()} ${restarted.errors()}`,
        );
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

async function engineStartChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.stableUrl, 1);
  try {
    const person = await db.insertInto('person').values({ email: 'ada@example.com', name: 'Ada' }).returning('id').executeTakeFirstOrThrow();
    const saving = randomUUID();
    const repository = await db
      .with('saved', query => query.insertInto('human_action').values({ id: saving, at: engineStartedAt, person_id: person.id, kind: 'add_repository', repository_id: 1 }).returning('id'))
      .insertInto('repository')
      .columns(['github', 'branch', 'saved_by'])
      .expression(eb => eb.selectFrom('saved').select([eb.val('example/sandbox').as('github'), eb.val('main').as('branch'), 'saved.id']))
      .returning('id')
      .executeTakeFirstOrThrow();
    await saveRoutine(db, person.id, repository.id, 'code-change');
    const known = runEngine(scratch.stableUrl, quickEngine);
    const started = await known.waitFor(startLine);
    const knownStatus = await known.terminate();
    const line = known.said().split('\n').find(said => said.startsWith(startLine)) ?? '';
    const named = ['the workflows code-change', 'reaper every 200 ms'].every(part => line.includes(part));
    const published = publishedDrift(await publishedRows(db), await publishedProviders(db));
    const firstVersions = await rowVersions(db);
    const again = runEngine(scratch.stableUrl, quickEngine);
    const againStarted = await again.waitFor(startLine);
    const againStatus = await again.terminate();
    const secondVersions = await rowVersions(db);
    await db.deleteFrom('published_workflow_step').where('position', '=', 2).execute();
    const planted = publishedDrift(await publishedRows(db), await publishedProviders(db));
    await db.deleteFrom('published_workflow_step').execute();
    await db.deleteFrom('published_provider').execute();
    const stranger = await saveRoutine(db, person.id, repository.id, 'no-such-flow');
    const unknown = startEngine({ ...process.env, DATABASE_URL: scratch.stableUrl });
    const afterRefusal = [...(await publishedRows(db)), ...(await publishedProviders(db))];
    const knownName = 'the engine starts when every routine uses a workflow it was given, and exits 0 on SIGTERM';
    const publishedName = 'the engine publishes each step of code-change in order with its runner, required blocks, and failure targets, and tests-only as its Verify provider, and the check fails once a planted delete drops one step';
    const twiceName = 'a second start with the same code changes no published row';
    const unknownName = 'the engine refuses to start, names the routine whose workflow it was not given, and publishes nothing';
    return [
      started && named && knownStatus === 0
        ? pass(knownName, known.said().replaceAll('\n', ' '))
        : fail(knownName, `started ${String(started)}, named code-change and the reaper ${String(named)}, exit ${String(knownStatus)}: ${known.said()} ${known.errors()}`),
      published === null && planted !== null
        ? pass(publishedName, `${JSON.stringify(declaredSteps)}; with implement deleted the check reports: ${planted}`)
        : fail(publishedName, published ?? 'the check passed with implement deleted from the published rows'),
      againStarted && againStatus === 0 && firstVersions.length > 0 && isDeepStrictEqual(firstVersions, secondVersions)
        ? pass(twiceName, `${String(secondVersions.length)} rows kept their row versions: ${secondVersions.join(', ')}`)
        : fail(twiceName, `started ${String(againStarted)}, exit ${String(againStatus)}, row versions ${firstVersions.join(', ')} then ${secondVersions.join(', ')}: ${again.said()} ${again.errors()}`),
      unknown.status === 1 && unknown.said.includes(`Routine ${stranger} version 1 uses the workflow no-such-flow, which this engine was not given.`) && afterRefusal.length === 0
        ? pass(unknownName, unknown.said.replaceAll('\n', ' '))
        : fail(unknownName, `exit ${String(unknown.status)}, ${String(afterRefusal.length)} published rows: ${unknown.said}`),
    ];
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

function noUrlCheck(): Check {
  const name = 'the engine refuses to start without DATABASE_URL, and the zod error names it';
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'DATABASE_URL'));
  const started = startEngine(env);
  return started.status === 1 && started.said.includes('DATABASE_URL') ? pass(name, started.said.replaceAll('\n', ' ')) : fail(name, `exit ${String(started.status)}: ${started.said}`);
}

const alwaysRun = ['reaper', 'scheduler', 'environments', 'outbox'] as const;

const skipReasons = {
  checks: 'has no CREDENTIAL_KEY, so it opens and checks no credentials',
  sweep: 'has no JOB_IMAGE, so it launches no Jobs and sweeps none',
} as const;

function unnamedLoops(said: string): readonly string[] {
  const line = said.split('\n').find(entry => entry.startsWith(startLine)) ?? '';
  const named = new Set([...line.matchAll(/(\w+) every \d+ ms/g)].map(([, loop = '']) => loop));
  return [
    ...alwaysRun.filter(loop => !named.has(loop)),
    ...Object.entries(skipReasons)
      .filter(([loop, reason]) => !named.has(loop) && !said.includes(reason))
      .map(([loop]) => loop),
  ];
}

const credentialKey = { CREDENTIAL_KEY: randomBytes(32).toString('base64'), CREDENTIAL_KEY_VERSION: '1' };

async function loopNamesCheck(postgres: TestPostgres): Promise<Check> {
  const name = 'an engine with a credential key names each of its loops in its startup line, or says why it skips one, and a keyless start line fails the same check';
  const scratch = await postgres.scratch();
  try {
    const keyed = runEngine(scratch.stableUrl, { ...quickEngine, ...credentialKey });
    const keyedUp = await keyed.waitFor(startLine);
    const keyedStatus = await keyed.terminate();
    const keyless = runEngine(scratch.stableUrl, quickEngine);
    const keylessUp = await keyless.waitFor(startLine);
    const keylessStatus = await keyless.terminate();
    const missing = unnamedLoops(keyed.said());
    const control = unnamedLoops(keyless.said().replace(skipReasons.checks, ''));
    return keyedUp && keyedStatus === 0 && missing.length === 0 && keylessUp && keylessStatus === 0 && control.join() === 'checks'
      ? pass(name, `${keyed.said().replaceAll('\n', ' ')} | without the key and its reason, the check finds ${control.join(', ')} unnamed`)
      : fail(name, `keyed start ${String(keyedUp)}, exit ${String(keyedStatus)}, unnamed ${missing.join(', ') || 'none'}; keyless start ${String(keylessUp)}, exit ${String(keylessStatus)}, unnamed ${control.join(', ') || 'none'}: ${keyed.said()} ${keyed.errors()}`);
  } finally {
    await scratch.drop();
  }
}

async function idleCheck(postgres: TestPostgres): Promise<Check> {
  const name = 'the engine runs at least 3 reaper intervals on an empty database with no error, then exits 0 on SIGTERM';
  const scratch = await postgres.scratch();
  try {
    const engine = runEngine(scratch.stableUrl, quickEngine);
    const started = await engine.waitFor(startLine);
    if (started) await wait(900);
    const status = await engine.terminate();
    const passes = passesIn(engine.said());
    return started && status === 0 && passes >= 3 && engine.errors() === ''
      ? pass(name, engine.said().replaceAll('\n', ' '))
      : fail(name, `started ${String(started)}, exit ${String(status)} after ${String(passes)} clean passes: ${engine.said()} ${engine.errors()}`);
  } finally {
    await scratch.drop();
  }
}

async function sigtermChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.stableUrl, 3);
  try {
    const person = await db.insertInto('person').values({ email: 'ada@example.com', name: 'Ada' }).returning('id').executeTakeFirstOrThrow();
    const repository = await db
      .with('saved', query => query.insertInto('human_action').values({ id: randomUUID(), at: engineStartedAt, person_id: person.id, kind: 'add_repository', repository_id: 1 }).returning('id'))
      .insertInto('repository')
      .columns(['github', 'branch', 'saved_by'])
      .expression(eb => eb.selectFrom('saved').select([eb.val('example/sandbox').as('github'), eb.val('main').as('branch'), 'saved.id']))
      .returning('id')
      .executeTakeFirstOrThrow();
    const routine = await saveRoutine(db, person.id, repository.id, 'code-change');
    await db.updateTable('routine').set({ run_as_id: person.id }).where('id', '=', routine).execute();
    const tasks = await db
      .insertInto('task')
      .values(
        Array.from({ length: 12 }, (_, index) => ({
          routine_id: routine,
          found_version: 1,
          repository_id: repository.id,
          key: `STOP-${String(index + 1)}`,
          title: 'A task whose attempt dies',
          found_at: engineStartedAt,
          workflow: 'code-change',
          needs_repository: true,
          step: 'specify',
        })),
      )
      .returning('id')
      .execute();
    const claimedAt = new Date();
    const attempts: string[] = [];
    for (const [index, task] of tasks.entries()) {
      const claimed = await claim(db, task.id, claimedAt, index < 8 ? 1_000 : 3_600_000, await coreRunAs(null)(db, task.id), null);
      if (!('attempt' in claimed)) throw new Error(`the lane could not claim task ${task.id}: ${claimed.refused}`);
      attempts.push(claimed.attempt);
    }
    const [held] = attempts;
    const first = attempts.slice(0, 8);
    const backlog = attempts.slice(8);
    if (held === undefined) throw new Error('the lane claimed no attempt');
    const lost = async (ids: readonly string[]): Promise<number> =>
      Number((await db.selectFrom('attempt').select(eb => eb.fn.countAll<string>().as('lost')).where('id', 'in', ids).where('verdict', '=', 'lost').executeTakeFirstOrThrow()).lost);
    const blocked = async (): Promise<boolean> =>
      Number(
        (
          await sql<{ waiting: string }>`select count(*) as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`.execute(db)
        ).rows[0]?.waiting ?? '0',
      ) > 0;
    const engine = runEngine(scratch.stableUrl, { REAPER_EVERY_MS: '2000', LEASE_MS: '1000' });
    const resumed = await engine.waitFor('reaper: gave ');
    let unlock = (): void => undefined;
    const unlocked = new Promise<void>(resolve => {
      unlock = resolve;
    });
    const locking = db.connection().execute(async connection => {
      await sql`begin`.execute(connection);
      await sql`select id from attempt where id = ${held} for update`.execute(connection);
      await unlocked;
      await sql`commit`.execute(connection);
    });
    const midPass = resumed && (await until(hangCeilingMs, blocked));
    const stopping = engine.terminate();
    await wait(500);
    const heldOn = engine.running();
    unlock();
    await locking;
    const firstStatus = await stopping;
    const firstSaid = engine.said();
    const releasedFirst = await lost(first);
    const halves = await db
      .selectFrom('task')
      .select(['task.key', 'task.lost', eb => eb.selectFrom('attempt').select(inner => inner.fn.countAll<string>().as('n')).whereRef('attempt.task_id', '=', 'task.id').where('attempt.verdict', '=', 'lost').as('lostAttempts')])
      .orderBy('task.id')
      .execute();
    const halfReleased = halves.filter(row => row.lost !== Number(row.lostAttempts ?? '0'));
    const releasedByFirst = await lost(backlog);
    await db.updateTable('attempt').set({ lease_until: new Date(Date.now() - 1_000) }).where('id', 'in', backlog).execute();
    await wait(1_000);
    const releasedWhileDown = await lost(backlog);
    const restarted = runEngine(scratch.stableUrl, { REAPER_EVERY_MS: '250', LEASE_MS: '1000' });
    const restartedUp = await restarted.waitFor(startLine);
    const finished = restartedUp && (await until(hangCeilingMs, async () => (await lost(backlog)) === backlog.length));
    const secondStatus = await restarted.terminate();
    const stopName = 'the engine got SIGTERM in the middle of a reaper pass, finished that pass, and exited 0';
    const halfName = 'no attempt was left half-released: every task counts exactly its lost attempts';
    const backlogName = 'the restarted engine released the backlog, then exited 0 on SIGTERM';
    return [
      midPass && heldOn && firstStatus === 0 && releasedFirst === first.length
        ? pass(stopName, `the pass waited on a locked attempt when SIGTERM arrived, the engine was still running 500 ms later, then released ${String(releasedFirst)} of ${String(first.length)} expired attempts in that pass and exited 0: ${firstSaid.replaceAll('\n', ' ')}`)
        : fail(stopName, `blocked mid-pass ${String(midPass)}, still running after SIGTERM ${String(heldOn)}, exit ${String(firstStatus)}, released ${String(releasedFirst)} of ${String(first.length)}: ${firstSaid} ${engine.errors()}`),
      halfReleased.length === 0 ? pass(halfName, `${String(halves.length)} tasks checked`) : fail(halfName, JSON.stringify(halfReleased)),
      releasedByFirst === 0 && releasedWhileDown === 0 && finished && secondStatus === 0
        ? pass(
            backlogName,
            `the first engine released 0 of ${String(backlog.length)} backlog attempts, whose leases lapsed only after it exited, 0 were released while no engine ran, then the restarted engine released all of them: ${restarted.said().replaceAll('\n', ' ')}`,
          )
        : fail(
            backlogName,
            `the first engine released ${String(releasedByFirst)} and ${String(releasedWhileDown)} were released while no engine ran, where both must be 0; the restarted engine started ${String(restartedUp)}, released ${String(await lost(backlog))} of ${String(backlog.length)}, exit ${String(secondStatus)}: ${restarted.said()} ${restarted.errors()}`,
          ),
    ];
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

async function restartCheck(postgres: TestPostgres): Promise<Check> {
  const name = 'after Postgres restarts between two reaper passes, the engine resumes with fresh leases before it releases anything';
  const scratch = await postgres.scratch();
  const engine = runEngine(scratch.stableUrl, { REAPER_EVERY_MS: '6000', LEASE_MS: '1000' });
  const started = await engine.waitFor('reaper: gave ');
  const restartedAt = engine.said().length;
  if (started) await postgres.restart();
  const noticed = started && (await engine.waitFor('Postgres restarted at '));
  const resumed = noticed && (await until(hangCeilingMs, () => Promise.resolve(engine.said().slice(engine.said().indexOf('Postgres restarted at ')).includes('reaper: gave '))));
  const status = await engine.terminate();
  await scratch.drop();
  const said = engine.said().slice(restartedAt).replaceAll('\n', ' ');
  return resumed && status === 0 ? pass(name, said) : fail(name, `noticed ${String(noticed)}, resumed ${String(resumed)}, exit ${String(status)}: ${said} ${engine.errors()}`);
}

async function reaperPerfChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  const probes: Probe[] = [];
  for (let round = 0; round < 5; round += 1) probes.push(await probeReaper(postgres, 100), await probeReaper(postgres, 1));
  const hundreds = probes.filter(probe => probe.expired === 100);
  const singles = probes.filter(probe => probe.expired === 1);
  const passName = 'one reaper pass over 100 expired attempts takes at most 1 s';
  const delayName = 'every probed release landed within one interval plus 10% of its lease expiring';
  const slowestPass = Math.max(...hundreds.map(probe => probe.passMs));
  const late = probes.filter(probe => probe.released !== probe.expired || probe.slowestDelayMs > probe.everyMs * 1.1);
  const passes = (list: typeof probes): string => list.map(probe => `${probe.passMs.toFixed(1)} ms`).join(', ');
  return [
    slowestPass <= 1000 && hundreds.every(probe => probe.released === 100)
      ? pass(passName, `100 at once: ${passes(hundreds)}; 1 alone: ${passes(singles)}`)
      : fail(passName, `100 at once: ${passes(hundreds)}, released ${hundreds.map(probe => String(probe.released)).join(', ')}`),
    late.length === 0
      ? pass(delayName, `slowest detection delay ${String(Math.max(...probes.map(probe => probe.slowestDelayMs)))} ms against an interval of ${String(profiles.crashes.reapEveryMs)} ms`)
      : fail(delayName, JSON.stringify(late)),
  ];
}

const seedOptions = { database: { type: 'string' }, routine: { type: 'string' }, key: { type: 'string' } } as const;

async function seedChecks(args: readonly string[]): Promise<readonly Check[]> {
  const { values, positionals } = parseArgs({ args: [...args], options: seedOptions, allowPositionals: true, strict: true });
  const seed = pastSeedNames.find(name => name === positionals[0]);
  const { database, routine, key } = values;
  if (seed === undefined || database === undefined || routine === undefined || key === undefined || positionals.length !== 1) {
    return [fail('tasks-seed named', `name one past seed, ${pastSeedNames.join(' or ')}, then --database <url> --routine <name> --key <task key>`)];
  }
  const db = connect(database, 2);
  try {
    const planted = await seedPast(db, seed, routine, key, new Date());
    const { ends } = pastSeeds[seed];
    const reached = planted.state === ends.state && (ends.state === 'done' || (planted.waitingOn === ends.waitingOn && planted.reason === ends.reason));
    const name = `${seed} is seeded as ${planted.key}, ${ends.state === 'done' ? ends.state : `waiting on ${ends.waitingOn}`}`;
    const detail = `${planted.state} at ${planted.step}, its last attempt finished at ${planted.finishedAt.toISOString()}${planted.reason === null ? '' : `; waiting on ${planted.waitingOn ?? 'nothing'}: ${planted.reason}`}`;
    return [reached ? pass(name, detail) : fail(name, detail)];
  } finally {
    await db.destroy();
  }
}

function parseSimulationOptions(args: readonly string[]): SimulationOptions {
  const parsed = simulationOptions.safeParse(parseArgs({ args: [...args], options: simulationFlags, strict: true, allowPositionals: false }).values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

export const scenarios: readonly Scenario[] = [
  tasksModel,
  {
    name: 'tasks-sim',
    summary: 'runs seeded workers that claim, renew, pass, hang, crash, and race against real Postgres, and checks every property after each step',
    run: args => {
      const options = parseSimulationOptions(args);
      return withPostgres(postgres => simulationChecks(postgres, options));
    },
    nightly: day => profileName.options.filter(profile => !engineProfiles.has(profile)).map(profile => ['--profile', profile, '--seeds', '1000', '--steps', '1000', '--from', String(day * 1000), '--trace', 'traces/tasks-sim']),
  },
  {
    name: 'engine-start',
    summary:
      "starts the engine's entry point against Postgres: it publishes its workflows' steps and its Verify providers once and atomically, refuses a routine's unknown workflow and a missing DATABASE_URL, idles on an empty database, and on SIGTERM finishes its reaper pass and exits 0",
    run: () =>
      withPostgres(async postgres => [...(await engineStartChecks(postgres)), await publishCrashCheck(postgres), await loopNamesCheck(postgres), noUrlCheck(), await idleCheck(postgres), ...(await sigtermChecks(postgres)), await restartCheck(postgres)]),
  },
  {
    name: 'tasks-seed',
    summary: "writes a past seed's story, done, expired, failed-after-conflict, or failed-after-red-check, as task --key of the routine --routine in the database at --database, through the tasks feature's claim, advance, and handOff with earlier times, and checks it ends in the state the seed declares",
    run: seedChecks,
  },
  {
    name: 'reaper-perf',
    summary: 'expires 100 attempts at once 5 times, interleaved with 5 single expired attempts, and times the reaper pass and each detection delay',
    run: () => withPostgres(reaperPerfChecks),
  },
];
