import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import { shapeOf } from '../../shared/workflow.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { withPostgres, type TestPostgres } from '../../tools/verify/postgres.ts';
import { modelShape, shapeDrift } from '../../tools/verify/model-shape.ts';
import { checkModel, type TlcRun, type TraceState } from '../../tools/verify/tlc.ts';
import { checkCatalog, type Catalog } from './catalog.ts';
import { lostTooOften } from './claim.ts';
import { provePlants, type PlantProof } from './invariants.ts';
import { badEnd, mutantName, parks, profileName, profiles, simulate, mutants as storeMutants, workflows, type MutantName, type ProfileName, type Run } from './simulate.ts';

type Shape = { readonly label: string; readonly holds: (run: TlcRun) => boolean };

type Mutant = {
  readonly guard: string;
  readonly without: string;
  readonly kind: 'INVARIANT' | 'PROPERTY';
  readonly property: string;
  readonly violation: string;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly shape?: Shape;
};

type TaskView = { readonly id: string; readonly step: string; readonly state: string; readonly runnable: boolean };

type AttemptView = { readonly worker: string; readonly task: string };

const folder = fileURLToPath(new URL('.', import.meta.url));

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

const lastRealState = (run: TlcRun): TraceState | undefined => run.trace.filter(state => state.action !== 'Stuttering').at(-1);

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

const invariant = (guard: string, without: string, property: string, shape?: Shape): Mutant => ({
  guard,
  without,
  kind: 'INVARIANT',
  property,
  violation: `Invariant ${property} is violated`,
  ...(shape === undefined ? {} : { shape }),
});

const action = (guard: string, without: string, property: string, extra: Pick<Mutant, 'overrides' | 'shape'> = {}): Mutant => ({
  guard,
  without,
  kind: 'PROPERTY',
  property,
  violation: `Action property ${property} is violated`,
  ...extra,
});

const unsettled = (guard: string, without: string, shape: Shape, extra: Pick<Mutant, 'overrides'> = {}): Mutant => ({
  guard,
  without,
  kind: 'PROPERTY',
  property: 'EveryTaskSettles',
  violation: 'Temporal properties were violated',
  shape,
  ...extra,
});

const onlyReaps = { MaxHumanActions: '0' };

const mutants: readonly Mutant[] = [
  invariant('ClaimIsExclusive', 'a second worker can insert an attempt', 'OneLiveAttempt', twoWorkersClaimOneTask),
  invariant('ClaimNeedsReadyTask', 'a worker can claim a task that is not ready', 'LiveAttemptMeansReady'),
  invariant('ClaimNeedsAPerson', 'a claim runs a task nobody can run as', 'AttemptRunsAsAPerson', claimRunsTaskNobodyCanRunAs),
  unsettled('NoOneParksTask', 'a task nobody can run as stays ready', readyTaskNoClaimTakes),
  invariant('StopEndsAttempt', 'stopping a task leaves its attempt live', 'LiveAttemptMeansReady', stoppedTaskKeepsAttempt),
  invariant('RetryEndsAttempt', 'a retry leaves the old attempt live', 'LiveAttemptIsCurrent'),
  action('LateResultIsRefused', 'a late result still applies', 'LateWriteChangesNothing', { overrides: onlyReaps, shape: lateResultAfterReap }),
  action('LateResultIsRefused', 'a late result still applies', 'TaskChangesOnlyWithItsAttempt', { overrides: onlyReaps, shape: lateResultAfterReap }),
  invariant('RetryKeepsOutputs', 'a retry drops earlier outputs', 'OutputsSurvive'),
  action('RetryKeepsOutputs', 'a retry drops earlier outputs', 'OutputsOnlyGrow'),
  action('EnvironmentFailureStaysInVerify', 'an environment failure counts as a pass', 'StageAdvancesOnlyOnPass'),
  action('StopSparesDoneTasks', 'a person can stop a done task', 'DoneIsFinal'),
  action('BehaviorFailureReturnsToImplement', 'a behavior failure returns to specify', 'StageMovesOneStep'),
  action('BehaviorFailureLeavesVerify', 'a behavior failure reruns Verify', 'FailedRoundReturnsToImplement'),
  action('EndingSparesOtherTasks', 'a stop or retry ends every live attempt', 'AttemptEndsOnlyWithItsTask', { shape: personEndsALiveAttempt }),
  action('FailureParksTask', 'a failed stage stops the task', 'OnlyAPersonStops'),
  unsettled('RoundsAreCapped', 'verify rounds have no cap', loopsBetweenImplementAndVerify),
  invariant('RoundsAreCapped', 'verify rounds have no cap', 'RoundsCapped'),
  unsettled('EnvRerunsAreCapped', 'environment reruns have no cap', rerunsVerifyForever),
  invariant('EnvRerunsAreCapped', 'environment reruns have no cap', 'EnvRerunsCapped'),
  unsettled('LostAttemptsAreCapped', 'lost attempts have no cap', losesAttemptsForever),
  invariant('LostAttemptsAreCapped', 'lost attempts have no cap', 'LostAttemptsCapped'),
  unsettled('StageRetriesAreCapped', 'stage retries have no cap', rerunsFailedStageForever),
  invariant('StageRetriesAreCapped', 'stage retries have no cap', 'StageRetriesCapped'),
  invariant('InputWaitsAreCapped', 'needs input has no cap', 'InputWaitsCapped'),
  invariant('PassResetsStageRetries', 'a pass keeps the stage retries', 'PassLeavesNoStageRetries'),
  action('RetryResetsStageRetries', "a person's retry keeps the stage retries", 'RetryLeavesNoStageRetries'),
  unsettled('ReaperIsFair', 'the reaper has no fairness', hungWorkerHoldsItsTask),
  invariant('EndStageIsFinal', "passing a routine's end stage does not end the task", 'StopsAtItsEndStage'),
  action('GateBlocksUntilApproved', 'a gated stage passes straight to the next stage', 'GatePassesOnlyOnApprove'),
  action('ReturnClearsApprovals', 'a return to Implement keeps the approval of a gate it must pass again', 'GatePassesOnlyOnApprove'),
  invariant('ReturnClearsApprovals', 'a return to Implement keeps the approval of a gate it must pass again', 'ApprovalsMatchGatesPassed'),
  action('MergeChecksGates', 'Land merges without checking gates while a gate lets a task through', 'MergeNeedsEveryGate', { overrides: { GateBlocksUntilApproved: 'FALSE' } }),
  action('MergeWaitsForMergeable', 'Land merges past a red check on a pull request that left draft before its checks were green', 'MergeNeedsEveryGate', { overrides: { IgnoreLaterReviews: '{}' } }),
  action('MergeWaitsForMergeable', 'Land merges past a later review that its routine ignores', 'MergeNeedsEveryGate', { overrides: { ReadyBeforeGreen: '{}' } }),
  invariant('ReviewReturnIsCapped', 'every review that asks for changes returns the task to Implement', 'ReviewReturnsCapped'),
  invariant('RetryResumesStopped', 'Retry cannot resume a stopped task', 'StoppedTaskCanResume'),
  invariant('RetryKeepsReviews', "a person's retry forgets the review return", 'StoppedTaskCanResume'),
  unsettled('VerifyPassKeepsLandRounds', 'a Verify pass clears the Land rounds of a task with no gate', loopsFromLandToImplement, { overrides: { ReadyBeforeGreen: '{t1}' } }),
  unsettled('OutsideApprovalsAreFinite', 'outside approvals may never stop', approvesForever),
];

const readConfig = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');

const typeInvariant = 'TypeOK';

const bounds = ['Tasks', 'Workers', 'MaxRounds', 'MaxEnvReruns', 'MaxLost', 'MaxStageRetries', 'MaxInputWaits', 'MaxHumanActions', 'MaxReassignments'] as const;

type Bound = (typeof bounds)[number];

const floors: Readonly<Record<string, Readonly<Record<Bound, number>>>> = {
  'Tasks.cfg': { Tasks: 2, Workers: 2, MaxRounds: 2, MaxEnvReruns: 2, MaxLost: 2, MaxStageRetries: 1, MaxInputWaits: 1, MaxHumanActions: 2, MaxReassignments: 1 },
  'Tasks.nightly.cfg': { Tasks: 2, Workers: 2, MaxRounds: 3, MaxEnvReruns: 3, MaxLost: 3, MaxStageRetries: 2, MaxInputWaits: 2, MaxHumanActions: 3, MaxReassignments: 1 },
};

type Section = 'CONSTANTS' | 'INVARIANTS' | 'PROPERTIES';

type ConfigShape = {
  readonly constants: ReadonlyMap<string, string>;
  readonly listed: Readonly<Record<Mutant['kind'], ReadonlySet<string>>>;
  readonly problems: readonly string[];
};

const sections: readonly Section[] = ['CONSTANTS', 'INVARIANTS', 'PROPERTIES'];

const isSection = (line: string): line is Section => sections.some(section => section === line);

function parseConfig(config: string): ConfigShape {
  const constants = new Map<string, string>();
  const invariants = new Set<string>();
  const properties = new Set<string>();
  const problems: string[] = [];
  let section: Section | undefined;
  for (const line of config.split('\n').map(raw => raw.trimEnd())) {
    const assignment = /^ {4}(\w+) (?:=|<-) (\S.*)$/.exec(line);
    const listed = /^ {4}(\w+)$/.exec(line)?.[1];
    if (line === '' || line === 'SPECIFICATION Spec') continue;
    if (/\\\*|\(\*/.test(line)) problems.push(`comment in "${line}"`);
    else if (isSection(line)) section = line;
    else if (section === 'CONSTANTS' && assignment !== null) {
      const [, name = '', value = ''] = assignment;
      if (constants.has(name)) problems.push(`${name} is assigned twice`);
      constants.set(name, value.trim());
    } else if (section === 'INVARIANTS' && listed !== undefined) invariants.add(listed);
    else if (section === 'PROPERTIES' && listed !== undefined) properties.add(listed);
    else problems.push(`unexpected line "${line}"`);
  }
  return { constants, listed: { INVARIANT: invariants, PROPERTY: properties }, problems };
}

function boundOf(constants: ReadonlyMap<string, string>, bound: Bound): number | undefined {
  const value = constants.get(bound);
  if (value === undefined) return undefined;
  return value.startsWith('{') ? new Set(value.replace(/[{}\s]/g, '').split(',').filter(item => item !== '')).size : Number(value);
}

type ConfigReview = { readonly findings: readonly string[]; readonly summary: string };

function reviewConfig(file: string, config: string): ConfigReview {
  const { constants, listed, problems } = parseConfig(config);
  const floor = floors[file];
  const everyListed = [...listed.INVARIANT, ...listed.PROPERTY];
  const broken = new Set(mutants.map(mutant => mutant.property));
  const mutated = new Set(mutants.map(mutant => mutant.guard));
  const guards = [...constants].filter(([, value]) => value === 'TRUE').map(([name]) => name);
  const findings = [
    ...problems,
    ...(listed.INVARIANT.has(typeInvariant) ? [] : [`${typeInvariant} is not listed under INVARIANTS`]),
    ...mutants.filter(mutant => !listed[mutant.kind].has(mutant.property)).map(mutant => `${mutant.property} is not listed under ${mutant.kind === 'INVARIANT' ? 'INVARIANTS' : 'PROPERTIES'}`),
    ...everyListed.filter(property => property !== typeInvariant && !broken.has(property)).map(property => `${property} has no mutant`),
    ...guards.filter(guard => !mutated.has(guard)).map(guard => `guard ${guard} has no mutant`),
    ...(floor === undefined
      ? [`${file} has no floors`]
      : bounds.flatMap(bound => {
          const value = boundOf(constants, bound);
          return value !== undefined && value >= floor[bound] ? [] : [`${bound} is ${String(value)}, below its floor of ${String(floor[bound])}`];
        })),
  ];
  return { findings: [...new Set(findings)], summary: `${String(broken.size)} properties, ${String(guards.length)} guards` };
}

function checkConfig(file: string): Check {
  const { findings, summary } = reviewConfig(file, readConfig(file));
  const name = `${file} lists each property in its section with a mutant, every guard with a mutant, and bounds no lower than its floors`;
  return findings.length === 0 ? pass(name, summary) : fail(name, findings.join('; '));
}

type Plant = { readonly change: string; readonly harmful: boolean; readonly edit: (config: string) => string };

const plants: readonly Plant[] = [
  { change: 'a comment hides a smaller Tasks', harmful: true, edit: config => config.replace('    Tasks = {t1, t2}', '    Tasks = {t1} \\* {t1, t2}') },
  { change: 'a comment follows a guard', harmful: true, edit: config => config.replace('    ReaperIsFair = TRUE', '    ReaperIsFair = TRUE \\* fair') },
  { change: 'an invariant moves under PROPERTIES', harmful: true, edit: config => config.replace('    RoundsCapped\n', '').replace('PROPERTIES\n', 'PROPERTIES\n    RoundsCapped\n') },
  { change: 'Tasks is assigned twice', harmful: true, edit: config => config.replace('    Workers =', '    Tasks = {t1}\n    Workers =') },
  { change: 'Tasks repeats a member', harmful: true, edit: config => config.replace('{t1, t2}', '{t1, t1}') },
  { change: 'TypeOK is dropped', harmful: true, edit: config => config.replace('    TypeOK\n', '') },
  { change: 'a line ends in a tab', harmful: false, edit: config => config.replace('    TypeOK\n', '    TypeOK\t\n') },
  { change: 'a blank line holds spaces', harmful: false, edit: config => config.replace('\nINVARIANTS', '\n    \nINVARIANTS') },
  { change: 'lines end in CRLF', harmful: false, edit: config => config.replace(/\n/g, '\r\n') },
];

function checkPlants(file: string): Check {
  const config = readConfig(file);
  const misses = plants.flatMap(plant => {
    const planted = plant.edit(config);
    if (planted === config) return [`${plant.change} no longer changes ${file}`];
    const rejected = reviewConfig(file, planted).findings.length > 0;
    return rejected === plant.harmful ? [] : [`${plant.change} is ${rejected ? 'rejected' : 'accepted'}`];
  });
  const name = `the review of ${file} rejects each harmful plant and accepts each harmless one`;
  return misses.length === 0 ? pass(name, `${String(plants.length)} plants`) : fail(name, misses.join('; '));
}

function mutantConfig(config: string, mutant: Mutant): string {
  const [constants = '', properties] = config.split('\nINVARIANTS');
  if (properties === undefined || !constants.includes(`${mutant.guard} = TRUE`)) throw new Error(`Tasks.cfg must set ${mutant.guard} = TRUE before its INVARIANTS`);
  const overridden = Object.entries(mutant.overrides ?? {}).reduce((text, [name, value]) => text.replace(new RegExp(`^( +${name} = ).*$`, 'm'), `$1${value}`), constants);
  return `${overridden.replace(`${mutant.guard} = TRUE`, `${mutant.guard} = FALSE`)}\n${mutant.kind}\n    ${mutant.property}\n`;
}

const traceLine = (run: TlcRun): string => {
  const actions = run.trace.map(state => state.action);
  const shown = actions.length > 8 ? ['...', ...actions.slice(-8)] : actions;
  const ending = run.loop.length > 0 ? `, then loops back over the last ${String(run.loop.length)} states` : '';
  return `${shown.join(' -> ')}${ending}`;
};

function checkHolds(file: string): Check {
  const run = checkModel(folder, 'Tasks', readConfig(file));
  const name = `${file} holds every property`;
  return run.clean
    ? pass(name, `${String(run.distinctStates)} distinct states in ${run.seconds.toFixed(1)} s, no error has been found`)
    : fail(name, run.error ?? run.output.trim().split('\n').slice(-3).join(' | '));
}

function checkMutant(config: string, mutant: Mutant): Check {
  const run = checkModel(folder, 'Tasks', mutantConfig(config, mutant), mutant.property === 'EveryTaskSettles' ? 'auto' : '1');
  const name = `${mutant.property} fails when ${mutant.without}${mutant.shape === undefined ? '' : `, ${mutant.shape.label}`}`;
  const violated = run.error?.includes(mutant.violation) === true;
  const shaped = mutant.shape === undefined || mutant.shape.holds(run);
  const got = run.error ?? (run.clean ? 'no violation' : (run.output.trim().split('\n').at(-1) ?? 'no output'));
  return violated && shaped ? pass(name, traceLine(run)) : fail(name, `expected ${mutant.violation}${shaped ? '' : ' with that trace'}, got ${got}`);
}

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
  mutant: z.union([mutantName, z.literal('all')]).optional(),
  trace: z.string().optional(),
});

type SimulationOptions = z.infer<typeof simulationOptions>;

const seedsOf = (options: SimulationOptions): readonly number[] =>
  options.seed === undefined ? Array.from({ length: options.seeds }, (_, index) => options.from + index) : [options.seed];

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

const replay = (run: Run): string =>
  `npm run verify -- tasks-sim ${run.plan.mutant === undefined ? `--profile ${run.plan.profile}` : `--mutant ${run.plan.mutant}`} --seed ${String(run.seed)} --steps ${String(run.plan.steps)}`;

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
        writeFileSync(join(folder, `${run.plan.profile}-${run.plan.mutant ?? 'every-guard'}-seed-${String(run.seed)}.json`), `${JSON.stringify(run, null, 2)}\n`);
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
    badVersionsPark(profile, runs),
    ...(profile === 'races' ? [everyBurstHasOneWinner(runs)] : []),
    ...(profile === 'hangs' ? [everyHungAttemptLost(runs)] : []),
    ...(profile === 'behavior' ? [checksParkAtTheirCap(runs, parks.rounds, 'every task that reached Verify waits after 3 rounds with the instruction for that wait, unless its attempts were lost first')] : []),
    ...(profile === 'environment' ? [checksParkAtTheirCap(runs, parks.reruns, 'every task that reached Verify parked at the rerun cap, unless its attempts were lost first, and no round was charged')] : []),
  ];
}

function badVersionsPark(profile: ProfileName, runs: readonly Run[]): Check {
  const name = `${profile}: no task whose routine ends at ${badEnd}, where Code change cannot end, reached done, and such tasks parked with the instruction to stop them`;
  const bad = runs.flatMap(run => run.tasks.filter(task => task.lastStep === badEnd).map(task => ({ seed: run.seed, ...task })));
  const done = bad.filter(task => task.state === 'done');
  const parked = bad.filter(task => task.state === 'waiting' && task.reason?.includes(`ends at ${badEnd}`) === true);
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

async function mutantCheck(postgres: TestPostgres, mutant: MutantName, options: SimulationOptions): Promise<Check> {
  const properties: readonly string[] = storeMutants[mutant];
  const name = `${properties.join(' or ')} fails without ${mutant}`;
  const runs = await simulate(postgres, [{ profile: 'default', seeds: seedsOf(options), steps: options.steps, mutant }], traceWriter(options.trace));
  const first = runs.find(run => run.failure !== undefined);
  if (first === undefined) return fail(name, `no violation in ${String(runs.length)} seeds of ${String(options.steps)} steps`);
  return first.failure?.broken.some(found => properties.includes(found.property)) === true ? pass(name, violation(first)) : fail(name, `expected ${properties.join(' or ')}, got ${violation(first)}`);
}

function catalogCheck(catalog: Catalog): Check {
  const name = 'every named constraint, index, and trigger has a mutant or a reason in noMutantYet';
  const problems = [
    ...catalog.unlisted.map(guard => `${guard} is in neither list`),
    ...catalog.absent.map(guard => `${guard} is listed, but the schema has no such guard`),
    ...catalog.listedTwice.map(guard => `${guard} is listed twice`),
  ];
  const mutated = Object.keys(storeMutants).length;
  return problems.length === 0
    ? pass(name, `${String(catalog.guards)} guards: ${String(mutated)} with a mutant, ${String(catalog.guards - mutated)} with a reason`)
    : fail(name, problems.join('; '));
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
  } else if (options.mutant !== undefined) {
    checks.push(await mutantCheck(postgres, options.mutant, options));
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
      schedule: '0 0 * * *',
      repository_id: repository,
      action_id: action,
      workflow,
      source: JSON.stringify({ kind: 'jira-search' }),
      needs_repository: true,
    })
    .execute();
  return routine.id;
}

function startEngine(url: string): { readonly status: number | null; readonly said: string } {
  const started = spawnSync(process.execPath, [engineMain], { env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });
  return { status: started.status, said: `${started.stdout}${started.stderr}`.trim() };
}

async function engineStartChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
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
    const known = startEngine(scratch.url);
    const stranger = await saveRoutine(db, person.id, repository.id, 'no-such-flow');
    const unknown = startEngine(scratch.url);
    const knownName = 'the engine starts when every routine uses a workflow it was given';
    const unknownName = 'the engine refuses to start and names the routine whose workflow it was not given';
    return [
      known.status === 0 && known.said === 'The engine runs the workflows code-change.' ? pass(knownName, known.said) : fail(knownName, `exit ${String(known.status)}: ${known.said}`),
      unknown.status === 1 && unknown.said.includes(`Routine ${stranger} version 1 uses the workflow no-such-flow, which this engine was not given.`)
        ? pass(unknownName, unknown.said.replaceAll('\n', ' '))
        : fail(unknownName, `exit ${String(unknown.status)}: ${unknown.said}`),
    ];
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

function parseSimulationOptions(args: readonly string[]): SimulationOptions {
  const parsed = simulationOptions.safeParse(parseArgs({ args: [...args], options: simulationFlags, strict: true, allowPositionals: false }).values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

export const scenarios: readonly Scenario[] = [
  {
    name: 'tasks-model',
    summary: 'model-checks task claims, leases, and workflow steps in TLC, and proves each property fails without its guard',
    run: args => {
      if (args.includes('nightly')) return Promise.resolve([checkConfig('Tasks.nightly.cfg'), checkPlants('Tasks.nightly.cfg'), checkHolds('Tasks.nightly.cfg')]);
      const config = readConfig('Tasks.cfg');
      return Promise.resolve([checkConfig('Tasks.cfg'), checkPlants('Tasks.cfg'), checkHolds('Tasks.cfg'), ...mutants.map(mutant => checkMutant(config, mutant))]);
    },
  },
  {
    name: 'tasks-sim',
    summary: 'runs seeded workers that claim, renew, pass, hang, crash, and race against real Postgres, and checks every property after each step',
    run: args => {
      const options = parseSimulationOptions(args);
      return withPostgres(postgres => simulationChecks(postgres, options));
    },
  },
  {
    name: 'engine-start',
    summary: "starts the engine's entry point against Postgres, and proves it refuses to start while a routine uses a workflow it was not given",
    run: () => withPostgres(engineStartChecks),
  },
];
