import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { checkModel, type TlcRun, type TraceState } from '../../tools/verify/tlc.ts';

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

type TaskView = { readonly id: string; readonly stage: string; readonly state: string };

type AttemptView = { readonly worker: string; readonly task: string };

const folder = fileURLToPath(new URL('.', import.meta.url));

const tasksIn = (state: TraceState): readonly TaskView[] =>
  [...state.text.matchAll(/(t\d+) :>\s*\[\s*stage \|-> "(\w+)",\s*state \|-> "(\w+)"/g)].map(([, id = '', stage = '', status = '']) => ({ id, stage, state: status }));

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
  holds: run => loopedTask(run, views => views.every(view => view.state === 'ready') && ['implement', 'verify'].every(stage => views.some(view => view.stage === stage))),
};

const rerunsVerifyForever: Shape = {
  label: 'by verify rerunning forever',
  holds: run => loopedTask(run, views => views.every(view => view.state === 'ready' && view.stage === 'verify')),
};

const losesAttemptsForever: Shape = {
  label: 'by a task that loses every attempt',
  holds: run => run.loopActions.includes('Reap') && loopedTask(run, views => views.every(view => view.state === 'ready')),
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

const unsettled = (guard: string, without: string, shape: Shape): Mutant => ({
  guard,
  without,
  kind: 'PROPERTY',
  property: 'EveryTaskSettles',
  violation: 'Temporal properties were violated',
  shape,
});

const onlyReaps = { MaxHumanActions: '0' };

const mutants: readonly Mutant[] = [
  invariant('ClaimIsExclusive', 'a second worker can insert an attempt', 'OneLiveAttempt', twoWorkersClaimOneTask),
  invariant('ClaimNeedsReadyTask', 'a worker can claim a task that is not ready', 'LiveAttemptMeansReady'),
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
  unsettled('ReaperIsFair', 'the reaper has no fairness', hungWorkerHoldsItsTask),
];

const readConfig = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');

const typeInvariant = 'TypeOK';

const bounds = ['Tasks', 'Workers', 'MaxRounds', 'MaxEnvReruns', 'MaxLost', 'MaxHumanActions'] as const;

type Bound = (typeof bounds)[number];

const floors: Readonly<Record<string, Readonly<Record<Bound, number>>>> = {
  'Tasks.cfg': { Tasks: 2, Workers: 2, MaxRounds: 2, MaxEnvReruns: 2, MaxLost: 2, MaxHumanActions: 2 },
  'Tasks.nightly.cfg': { Tasks: 2, Workers: 2, MaxRounds: 3, MaxEnvReruns: 3, MaxLost: 3, MaxHumanActions: 3 },
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
    const assignment = /^ {4}(\w+) = (\S.*)$/.exec(line);
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

export const scenarios: readonly Scenario[] = [
  {
    name: 'tasks-model',
    summary: 'model-checks task claims, leases, and stages in TLC, and proves each property fails without its guard',
    run: args => {
      if (args.includes('nightly')) return Promise.resolve([checkConfig('Tasks.nightly.cfg'), checkPlants('Tasks.nightly.cfg'), checkHolds('Tasks.nightly.cfg')]);
      const config = readConfig('Tasks.cfg');
      return Promise.resolve([checkConfig('Tasks.cfg'), checkPlants('Tasks.cfg'), checkHolds('Tasks.cfg'), ...mutants.map(mutant => checkMutant(config, mutant))]);
    },
  },
];
