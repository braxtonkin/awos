import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { withPostgres, type TestPostgres } from '../../tools/verify/postgres.ts';
import { checkModel, type TlcRun, type TraceState } from '../../tools/verify/tlc.ts';
import { provePlants, type PlantProof } from './invariants.ts';
import { checkCatalog, mutantName, profileName, profiles, simulate, mutants as storeMutants, type Catalog, type MutantName, type ProfileName, type Run } from './simulate.ts';

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

const rerunsFailedStageForever: Shape = {
  label: 'by a failed stage rerunning forever',
  holds: run => run.loopActions.includes('Finish') && loopedTask(run, views => new Set(views.map(view => view.stage)).size === 1 && views.every(view => view.state === 'ready' && view.stage !== 'verify')),
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
  unsettled('StageRetriesAreCapped', 'stage retries have no cap', rerunsFailedStageForever),
  invariant('StageRetriesAreCapped', 'stage retries have no cap', 'StageRetriesCapped'),
  invariant('PassResetsStageRetries', 'a pass keeps the stage retries', 'PassLeavesNoStageRetries'),
  action('RetryResetsStageRetries', "a person's retry keeps the stage retries", 'RetryLeavesNoStageRetries'),
  unsettled('ReaperIsFair', 'the reaper has no fairness', hungWorkerHoldsItsTask),
];

const readConfig = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');

const typeInvariant = 'TypeOK';

const bounds = ['Tasks', 'Workers', 'MaxRounds', 'MaxEnvReruns', 'MaxLost', 'MaxStageRetries', 'MaxHumanActions'] as const;

type Bound = (typeof bounds)[number];

const floors: Readonly<Record<string, Readonly<Record<Bound, number>>>> = {
  'Tasks.cfg': { Tasks: 2, Workers: 2, MaxRounds: 2, MaxEnvReruns: 2, MaxLost: 2, MaxStageRetries: 1, MaxHumanActions: 2 },
  'Tasks.nightly.cfg': { Tasks: 2, Workers: 2, MaxRounds: 3, MaxEnvReruns: 3, MaxLost: 3, MaxStageRetries: 2, MaxHumanActions: 3 },
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
    ...(profile === 'races' ? [everyBurstHasOneWinner(runs)] : []),
    ...(profile === 'hangs' ? [everyHungAttemptLost(runs)] : []),
  ];
}

async function mutantCheck(postgres: TestPostgres, mutant: MutantName, options: SimulationOptions): Promise<Check> {
  const property = storeMutants[mutant];
  const name = `${property} fails without ${mutant}`;
  const runs = await simulate(postgres, [{ profile: 'default', seeds: seedsOf(options), steps: options.steps, mutant }], traceWriter(options.trace));
  const first = runs.find(run => run.failure !== undefined);
  if (first === undefined) return fail(name, `no violation in ${String(runs.length)} seeds of ${String(options.steps)} steps`);
  return first.failure?.broken.some(found => found.property === property) === true ? pass(name, violation(first)) : fail(name, `expected ${property}, got ${violation(first)}`);
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
    checks.push(catalogCheck(await checkCatalog(postgres)), plantsCheck(await provePlants(postgres)));
    for (const mutant of mutantName.options) checks.push(await mutantCheck(postgres, mutant, options));
  } else if (options.mutant !== undefined) {
    checks.push(await mutantCheck(postgres, options.mutant, options));
  } else {
    for (const profile of options.profile === 'all' ? profileName.options : [options.profile]) checks.push(...(await profileChecks(postgres, profile, options)));
  }
  return checks;
}

function parseSimulationOptions(args: readonly string[]): SimulationOptions {
  const parsed = simulationOptions.safeParse(parseArgs({ args: [...args], options: simulationFlags, strict: true, allowPositionals: false }).values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
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
  {
    name: 'tasks-sim',
    summary: 'runs seeded workers that claim, renew, pass, hang, crash, and race against real Postgres, and checks every property after each step',
    run: args => {
      const options = parseSimulationOptions(args);
      return withPostgres(postgres => simulationChecks(postgres, options));
    },
  },
];
