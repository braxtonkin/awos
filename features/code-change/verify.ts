import { parseArgs } from 'node:util';
import { z } from 'zod';
import { builtByStep, shapeOf, type StepVerdict, type Unasked } from '../../shared/workflow.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { modelShape, shapeDrift } from '../../tools/verify/model-shape.ts';
import type { Change, Ran } from '../../shared/agent-step.ts';
import { agentSteps, reproduction } from './stage-output.ts';
import { defineModel, type Shape } from '../../tools/verify/models.ts';
import type { TlcRun } from '../../tools/verify/tlc.ts';
import { mutantName, mutants, runSeed, simulate, type MutantName, type Run } from './simulate.ts';
import { workflow } from './workflow.ts';

type Case = { readonly output: unknown; readonly verdicts: Readonly<Record<string, StepVerdict>> };

const text = { kind: 'text', title: null, body: 'What the step did.' } as const;

const choice = { kind: 'choice', title: null, question: 'Which way?', options: [{ id: 'a', label: 'This way' }], recommended: null } as const;

const review = (outcome: 'done' | 'needs_input' | 'blocked', blocks: readonly unknown[] = [text]) => ({ outcome, summary: 'A review.', blocks });

const cases: readonly (readonly [string, Case])[] = [
  ['a done review with a text block', { output: review('done'), verdicts: { specify: 'pass', implement: 'pass', verify: 'environment_fail', land: 'pass' } }],
  ['a done review that says the behavior is fixed', { output: { ...review('done'), behavior: 'fixed' }, verdicts: { specify: 'fail', implement: 'fail', verify: 'pass', land: 'fail' } }],
  ['a done review that says the behavior is still wrong', { output: { ...review('done'), behavior: 'still_wrong' }, verdicts: { verify: 'behavior_fail' } }],
  ['a done review that could not check the behavior', { output: { ...review('done'), behavior: null }, verdicts: { verify: 'environment_fail' } }],
  ['a done review with no text block', { output: { ...review('done', [choice]), behavior: 'fixed' }, verdicts: { verify: 'environment_fail' } }],
  ['a review that asks for input', { output: review('needs_input', [choice]), verdicts: { specify: 'needs_input', implement: 'needs_input', land: 'needs_input' } }],
  ['a review that asks for input about the behavior', { output: { ...review('needs_input', [choice]), behavior: null }, verdicts: { verify: 'needs_input' } }],
  ['a blocked review', { output: review('blocked'), verdicts: { specify: 'fail', implement: 'fail', land: 'fail' } }],
  ['a blocked review about the behavior', { output: { ...review('blocked'), behavior: null }, verdicts: { verify: 'environment_fail' } }],
  ['a message that is not a review', { output: 'I could not finish.', verdicts: { specify: 'fail', implement: 'fail', verify: 'environment_fail', land: 'fail' } }],
  ['no final message', { output: null, verdicts: { specify: 'fail', implement: 'fail', verify: 'environment_fail', land: 'fail' } }],
];

function judgeChecks(): readonly Check[] {
  return cases.map(([what, { output, verdicts }]) => {
    const name = `each step judges ${what} as its declaration says`;
    const wrong = Object.entries(verdicts).flatMap(([step, expected]) => {
      const kind = workflow.steps.find(candidate => candidate.name === step);
      const got = kind?.judge(output);
      return got === expected ? [] : [`${step} judged ${got ?? 'nothing, because it has no such step'}, not ${expected}`];
    });
    return wrong.length === 0 ? pass(name, Object.entries(verdicts).map(([step, verdict]) => `${step} ${verdict}`).join(', ')) : fail(name, wrong.join('; '));
  });
}

function shapeCheck(): Check {
  const name = 'the Code change declaration has the shape that features/tasks/Tasks.tla checks';
  const drift = shapeDrift(modelShape(new URL('../tasks/Tasks.tla', import.meta.url), new URL('../tasks/Tasks.cfg', import.meta.url)), shapeOf(workflow));
  return drift.length === 0 ? pass(name, workflow.steps.map(kind => kind.name).join(', ')) : fail(name, drift.join('; '));
}

function builtCheck(): Check {
  const name = 'every step of Code change was built by step()';
  const loose = workflow.steps.filter(kind => !builtByStep(kind)).map(kind => kind.name);
  return loose.length === 0 ? pass(name, `${String(workflow.steps.length)} steps`) : fail(name, `not built by step(): ${loose.join(', ')}`);
}

const run = (command: string, exitCode: number, wrap = true): Ran => ({ command: wrap ? `/bin/bash -lc '${command}'` : command, cwd: '/workspace', exitCode, output: `ran ${command}` });

const script = run(reproduction.show, 0);

const settleCases: readonly (readonly [string, readonly Ran[], 'fixed' | 'still_wrong' | null])[] = [
  ['a failing base run then a passing change run, each wrapped by the shell', [script, run(reproduction.before, 1), run(reproduction.after, 0)], 'fixed'],
  ['the same runs written without the shell wrapper', [script, run(reproduction.before, 1, false), run(reproduction.after, 0, false)], 'fixed'],
  ['a change run that still fails', [script, run(reproduction.before, 1), run(reproduction.after, 1)], 'still_wrong'],
  ['a base run that passes, so nothing was reproduced', [script, run(reproduction.before, 0), run(reproduction.after, 0)], null],
  ['a change run that hides its exit with || true', [script, run(reproduction.before, 1), run(`${reproduction.after} || true`, 0)], null],
  ['the change run before the base run', [script, run(reproduction.after, 0), run(reproduction.before, 1)], null],
  ['no script shown before the runs', [run(reproduction.before, 1), run(reproduction.after, 0), script], null],
];

function settleChecks(): readonly Check[] {
  return settleCases.map(([what, commands, expected]) => {
    const name = `Verify's behavior comes from its stored runs: ${what}`;
    const settled = agentSteps.settle({ step: 'verify', output: { outcome: 'done', summary: 'Ran both.', blocks: [], behavior: 'fixed' }, commands, change: { pushed: 'a'.repeat(40), carried: null } });
    const behavior = typeof settled.output === 'object' && settled.output !== null && 'behavior' in settled.output ? settled.output.behavior : 'missing';
    return behavior === expected ? pass(name, `behavior ${String(expected)}, evidence ${settled.evidence === null ? 'none' : 'stored'}`) : fail(name, `behavior ${String(behavior)}, not ${String(expected)}`);
  });
}

const doneImplement = { outcome: 'done', summary: 'Implemented the ticket.', blocks: [{ kind: 'text', title: null, body: 'Added the function.' }] };

const implementCases: readonly (readonly [string, Change, Unasked | null])[] = [
  ['an attempt that pushed a commit', { pushed: 'a'.repeat(40), carried: null }, null],
  ["an attempt that pushed nothing but started from a lost attempt's push", { pushed: null, carried: 'b'.repeat(40) }, null],
  ['an attempt that pushed nothing and carried nothing, so the agent made no change', { pushed: null, carried: null }, 'fail'],
];

function implementChecks(): readonly Check[] {
  return implementCases.map(([what, change, expected]) => {
    const name = `Implement's verdict comes from its change: ${what}`;
    const settled = agentSteps.settle({ step: 'implement', output: doneImplement, commands: [], change });
    const said = JSON.stringify(settled.output);
    const explained = expected === null || said.includes('made no change');
    return settled.observed === expected && explained ? pass(name, `observed ${String(settled.observed)}`) : fail(name, `observed ${String(settled.observed)}, not ${String(expected)}; output ${said.slice(0, 200)}`);
  });
}

function promptCheck(): Check {
  const name = "Verify's core prompt names each command the engine matches exactly";
  const found = workflow.steps.find(kind => kind.name === 'verify');
  const prompt = found?.runBy === 'agent' ? found.prompt : '';
  const missing = [reproduction.show, reproduction.before, reproduction.after].filter(command => !prompt.includes(`\`${command}\``));
  return missing.length === 0 ? pass(name, 'all 3') : fail(name, `missing ${missing.join(', ')}`);
}

const settings = { Checks: 2, Ignorable: 1, QueueSettings: 2, ReviewSettings: 2, DraftSettings: 2 } as const;

type StateView = {
  readonly repo: { readonly draft: string };
  readonly check: ReadonlyMap<string, string>;
  readonly draft: boolean;
  readonly conflict: boolean;
  readonly reviews: number;
  readonly lastReview: string;
  readonly queue: string;
  readonly mergedAt: number | undefined;
  readonly task: string;
  readonly landFails: number;
  readonly seen: number;
  readonly row: string;
  readonly inflight: number | undefined;
  readonly judged: readonly number[];
};

type TraceView = Pick<TlcRun, 'loopActions' | 'stutters'> & {
  readonly actions: readonly string[];
  readonly states: readonly StateView[];
  readonly last: StateView;
  readonly beforeLast: StateView;
  readonly loop: readonly StateView[];
};

const variablesIn = (text: string): ReadonlyMap<string, string> =>
  new Map([...text.replace(/["\s]/g, '').matchAll(/\/\\(\w+)=([^/]*)/g)].map(([, name = '', value = '']): [string, string] => [name, value]));

const entriesIn = (value: string): ReadonlyMap<string, string> =>
  new Map([...value.matchAll(/(\w+):>(\w+)/g)].map(([, key = '', entry = '']): [string, string] => [key, entry]));

const fieldsIn = (record: string): ReadonlyMap<string, string> =>
  new Map([...record.matchAll(/(\w+)\|->(\w+)/g)].map(([, name = '', field = '']): [string, string] => [name, field]));

const headIn = (value: string): number | undefined => (value === 'NoHead' ? undefined : Number.parseInt(value, 10));

const headsIn = (set: string): readonly number[] => [...set.matchAll(/(\d+)/g)].map(([, head = '']) => Number.parseInt(head, 10));

function viewOf(text: string): StateView {
  const variables = variablesIn(text);
  const variable = (name: string): string => variables.get(name) ?? '';
  const count = (name: string): number => Number.parseInt(variable(name), 10);
  return {
    repo: { draft: fieldsIn(variable('repo')).get('draft') ?? '' },
    check: entriesIn(variable('check')),
    draft: variable('draft') === 'TRUE',
    conflict: variable('conflict') === 'TRUE',
    reviews: count('reviews'),
    lastReview: variable('lastReview'),
    queue: variable('queue'),
    mergedAt: headIn(variable('mergedAt')),
    task: variable('task'),
    landFails: count('landFails'),
    seen: count('seen'),
    row: variable('row'),
    inflight: headIn(variable('inflight')),
    judged: headsIn(variable('judged')),
  };
}

function traceViewOf(run: TlcRun): TraceView {
  const real = run.trace.filter(state => state.action !== 'Stuttering');
  return {
    actions: run.trace.map(state => state.action),
    states: run.trace.map(state => viewOf(state.text)),
    last: viewOf(real.at(-1)?.text ?? ''),
    beforeLast: viewOf(real.at(-2)?.text ?? ''),
    loop: run.loop.map(state => viewOf(state.text)),
    loopActions: run.loopActions,
    stutters: run.stutters,
  };
}

const shape = (label: string, holds: (trace: TraceView) => boolean): Shape => ({ label, holds: run => holds(traceViewOf(run)) });

const landActions: ReadonlySet<string> = new Set(['Complete', 'FailAttempt', 'SendBack', 'MarkReady', 'AnswerReview', 'AwaitApproval', 'OweMerge', 'Resume']);

const mergeActions: ReadonlySet<string> = new Set(['Perform', 'Arrive', 'QueueMerges']);

const sendBackActions: ReadonlySet<string> = new Set(['SendBack', 'AnswerReview']);

const countedCheck = 'c1';

const endsIn = (actions: readonly string[], wanted: ReadonlySet<string>): boolean => wanted.has(actions.at(-1) ?? '');

const inOrder = (actions: readonly string[], wanted: readonly string[]): boolean =>
  actions.reduce((matched, action) => (action === wanted[matched] ? matched + 1 : matched), 0) === wanted.length;

const followsLastOweMerge = (actions: readonly string[], action: string): boolean => {
  const owed = actions.lastIndexOf('OweMerge');
  return owed >= 0 && actions.slice(owed + 1).includes(action);
};

const holdsForever = ({ stutters, last, loop }: TraceView, holds: (view: StateView) => boolean): boolean => {
  const forever = stutters ? [last] : loop;
  return forever.length > 0 && forever.every(holds);
};

const mergedPastJudged = ({ mergedAt, judged }: StateView): boolean => mergedAt !== undefined && judged.every(head => head < mergedAt);

const mergesSentBackTask = ({ actions, beforeLast }: TraceView): boolean => endsIn(actions, mergeActions) && beforeLast.task === 'implement';

const landMovesOn = ({ actions, last }: TraceView): boolean => endsIn(actions, landActions) && last.task !== 'implement';

const mergeOfHeadPushedAfterRead = shape(
  'by a merge of a head pushed after the state was read',
  ({ actions, last }) => followsLastOweMerge(actions, 'OutsidePush') && endsIn(actions, mergeActions) && mergedPastJudged(last),
);

const mergeAfterReviewSentBack = shape('by a merge performed after a review sent the task back', trace => {
  const read = trace.states[trace.actions.lastIndexOf('AnswerReview') - 1];
  return inOrder(trace.actions, ['OweMerge', 'AnswerReview']) && read !== undefined && read.row !== 'none' && mergesSentBackTask(trace);
});

const mergeAfterRedCheckSentBack = shape(
  'by a merge performed after a check turned red and sent the task back',
  trace =>
    inOrder(trace.actions, ['OweMerge', 'Rerun', 'Finish', 'SendBack']) && trace.states.every(state => state.queue !== 'queued') && mergesSentBackTask(trace),
);

const queueMergesAfterSendBack = shape('by the queue merging after Land sent the task back', trace => {
  const sentBack = trace.actions.findLastIndex(action => sendBackActions.has(action));
  return (
    sentBack >= 0 &&
    trace.states.slice(0, sentBack).some(state => state.queue === 'queued') &&
    trace.actions.at(-1) === 'QueueMerges' &&
    mergesSentBackTask(trace)
  );
});

const failedCallLandsAfterSendBack = shape("by a failed call's request landing after Land sent the task back", trace => {
  const { actions, states } = trace;
  const released = states.findIndex((state, index) => actions[index] === 'Perform' && state.inflight !== undefined && state.row === 'owed');
  return released >= 0 && actions.slice(released + 1).some(action => sendBackActions.has(action)) && actions.at(-1) === 'Arrive' && mergesSentBackTask(trace);
});

const mergeAfterStop = shape(
  'by a merge performed after a person stopped the task',
  ({ actions, beforeLast, last }) =>
    followsLastOweMerge(actions, 'Stop') && actions.at(-1) === 'Perform' && beforeLast.task === 'stopped' && last.mergedAt !== undefined,
);

const readyWhileCheckNotGreen = shape(
  'by a draft marked ready while its counted check is not green',
  ({ actions, beforeLast }) =>
    actions.at(-1) === 'MarkReady' && beforeLast.draft && beforeLast.repo.draft === 'whenGreen' && beforeLast.check.get(countedCheck) !== 'green',
);

const landMovesPastRedCheck = shape(
  'by Land moving past a red check',
  trace =>
    landMovesOn(trace) &&
    trace.actions.at(-1) !== 'SendBack' &&
    trace.beforeLast.check.get(countedCheck) === 'red' &&
    trace.beforeLast.repo.draft === 'whenGreen',
);

const landMovesPastConflict = shape('by Land moving past a conflict', trace => landMovesOn(trace) && trace.beforeLast.conflict);

const rejoinsQueueAfterEjection = shape(
  'by Land joining the queue again in the attempt the queue ejected',
  ({ actions, beforeLast, last }) =>
    actions.slice(0, -1).includes('QueueEjects') && actions.at(-1) === 'OweMerge' && beforeLast.queue === 'ejected' && last.landFails === beforeLast.landFails,
);

const refusedMergeOwedForever = shape(
  'by a merge GitHub keeps refusing while Land keeps owing it',
  trace =>
    holdsForever(trace, view => view.task === 'land') &&
    ['OweMerge', 'Perform'].every(action => trace.loopActions.includes(action)) &&
    !trace.loopActions.includes('FailAttempt'),
);

const changesUnansweredWhileAwaiting = shape(
  'by a changes request left unanswered while the task awaits approval',
  trace => holdsForever(trace, view => view.task === 'awaiting' && view.lastReview === 'changes' && view.reviews > view.seen),
);

const landNeverPolls = shape(
  'by a task left in Land while Land never polls',
  trace => holdsForever(trace, view => view.task === 'land') && !trace.loopActions.some(action => landActions.has(action)),
);

const directMerge = { QueueSettings: '{FALSE}', ReviewSettings: '{FALSE}', DraftSettings: '{"whenGreen"}' } as const;

const queueMerge = { QueueSettings: '{TRUE}', ReviewSettings: '{FALSE}', DraftSettings: '{"whenGreen"}' } as const;

const noReviewers = { MaxReviews: '0' } as const;

const landModel: Scenario = defineModel({
  name: 'land',
  module: new URL('Land.tla', import.meta.url),
  configs: {
    pr: { file: 'Land.cfg', floors: { ...settings, LaterReviewSettings: 1, MaxPushes: 2, MaxReviews: 2, MaxReruns: 1, MaxEjections: 1, MaxCallFailures: 1 } },
    nightly: { file: 'Land.nightly.cfg', floors: { ...settings, LaterReviewSettings: 2, MaxPushes: 3, MaxReviews: 2, MaxReruns: 1, MaxEjections: 2, MaxCallFailures: 1 } },
  },
  guards: [
    'ActionCarriesHead',
    'ReadyWaitsForGreen',
    'RedCheckSendsBack',
    'ConflictSendsBack',
    'EjectionEndsAttempt',
    'LandPollIsFair',
    'LandWaitsForMergeRow',
    'LandWaitsWhileQueued',
    'FailedMergeKeepsClaim',
    'MergeClaimChecksTask',
    'RefusalFailsAttempt',
    'AnyReviewResumesLand',
  ],
  properties: {
    MergedHeadWasMergeable: 'INVARIANTS',
    PerformedMergeWasAllowed: 'PROPERTIES',
    ReadyOnlyWhenChecksGreen: 'PROPERTIES',
    RedCheckReturnsToImplement: 'PROPERTIES',
    ConflictReturnsToImplement: 'PROPERTIES',
    EjectionFailsLand: 'PROPERTIES',
    LandSettles: 'PROPERTIES',
  },
  liveness: ['LandSettles'],
  mutants: [
    { guard: 'ActionCarriesHead', property: 'MergedHeadWasMergeable', overrides: { ...directMerge, ...noReviewers }, shape: mergeOfHeadPushedAfterRead },
    { guard: 'LandWaitsForMergeRow', property: 'PerformedMergeWasAllowed', overrides: directMerge, shape: mergeAfterReviewSentBack },
    { guard: 'LandWaitsForMergeRow', property: 'PerformedMergeWasAllowed', overrides: { ...directMerge, ...noReviewers }, shape: mergeAfterRedCheckSentBack },
    { guard: 'LandWaitsWhileQueued', property: 'PerformedMergeWasAllowed', overrides: { ...queueMerge, ...noReviewers }, shape: queueMergesAfterSendBack },
    { guard: 'FailedMergeKeepsClaim', property: 'PerformedMergeWasAllowed', overrides: directMerge, shape: failedCallLandsAfterSendBack },
    { guard: 'MergeClaimChecksTask', property: 'PerformedMergeWasAllowed', overrides: { ...directMerge, ...noReviewers }, shape: mergeAfterStop },
    { guard: 'ReadyWaitsForGreen', property: 'ReadyOnlyWhenChecksGreen', overrides: directMerge, shape: readyWhileCheckNotGreen },
    { guard: 'RedCheckSendsBack', property: 'RedCheckReturnsToImplement', overrides: directMerge, shape: landMovesPastRedCheck },
    { guard: 'ConflictSendsBack', property: 'ConflictReturnsToImplement', overrides: { QueueSettings: '{FALSE}', ReviewSettings: '{FALSE}' }, shape: landMovesPastConflict },
    { guard: 'EjectionEndsAttempt', property: 'EjectionFailsLand', overrides: { ...queueMerge, ...noReviewers }, shape: rejoinsQueueAfterEjection },
    { guard: 'RefusalFailsAttempt', property: 'LandSettles', overrides: { ...directMerge, ...noReviewers }, shape: refusedMergeOwedForever },
    { guard: 'AnyReviewResumesLand', property: 'LandSettles', overrides: { QueueSettings: '{FALSE}', ReviewSettings: '{TRUE}', DraftSettings: '{"whenGreen"}' }, shape: changesUnansweredWhileAwaiting },
    { guard: 'LandPollIsFair', property: 'LandSettles', overrides: { ...directMerge, ...noReviewers }, shape: landNeverPolls },
  ],
});

const simulationFlags = {
  seeds: { type: 'string' },
  from: { type: 'string' },
  seed: { type: 'string' },
  steps: { type: 'string' },
  tasks: { type: 'string' },
  mutant: { type: 'string' },
} as const;

const simulationOptions = z.object({
  seeds: z.coerce.number().int().positive().default(40),
  from: z.coerce.number().int().nonnegative().default(1),
  seed: z.coerce.number().int().nonnegative().optional(),
  steps: z.coerce.number().int().positive().default(150),
  tasks: z.coerce.number().int().positive().default(6),
  mutant: z.union([mutantName, z.literal('all')]).optional(),
});

type SimulationOptions = z.infer<typeof simulationOptions>;

function parseSimulationOptions(args: readonly string[]): SimulationOptions {
  const parsed = simulationOptions.safeParse(parseArgs({ args: [...args], options: simulationFlags, strict: true, allowPositionals: false }).values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

const seedsOf = (options: SimulationOptions): readonly number[] =>
  options.seed === undefined ? Array.from({ length: options.seeds }, (_, index) => options.from + index) : [options.seed];

const replay = (run: Run, options: SimulationOptions): string =>
  `npm run verify -- land-sim${run.mutant === undefined ? '' : ` --mutant ${run.mutant}`} --seed ${String(run.seed)} --steps ${String(options.steps)} --tasks ${String(options.tasks)}`;

function violation(run: Run, options: SimulationOptions): string {
  if (run.failure === undefined) return `seed ${String(run.seed)} broke nothing`;
  const { step, move, broken } = run.failure;
  const found = broken.slice(0, 3).map(entry => `${entry.property}: ${entry.detail}`);
  return `seed ${String(run.seed)}, step ${String(step)}, after ${move}: ${found.join('; ')}; replay: ${replay(run, options)}; last moves: ${run.trace.slice(-6).join(' | ')}`;
}

const merged = (runs: readonly Run[]): Readonly<Record<string, number>> =>
  runs.reduce<Record<string, number>>((total, run) => {
    for (const [key, count] of Object.entries(run.settled)) total[key] = (total[key] ?? 0) + count;
    return total;
  }, {});

async function guardedCheck(options: SimulationOptions): Promise<Check> {
  const started = performance.now();
  const runs = await simulate({ seeds: seedsOf(options), steps: options.steps, tasks: options.tasks });
  const seconds = (performance.now() - started) / 1000;
  const failed = runs.find(run => run.failure !== undefined);
  const name = `every guard on: ${String(runs.length)} seeds, ${String(runs.filter(run => run.failure !== undefined).length)} violations`;
  const settled = Object.entries(merged(runs))
    .map(([state, count]) => `${String(count)} ${state}`)
    .join(', ');
  return failed === undefined ? pass(name, `${String(options.steps)} steps each plus a quiet phase, in ${seconds.toFixed(1)} s; tasks ended ${settled}`) : fail(name, violation(failed, options));
}

async function mutantCheck(mutant: MutantName, options: SimulationOptions): Promise<Check> {
  const breaks = mutants[mutant];
  const plan = { seeds: seedsOf(options), steps: options.steps, tasks: options.tasks, mutant };
  const name = `without ${mutant}: ${breaks} violated`;
  for (const seed of plan.seeds) {
    const run = await runSeed(plan, seed);
    if (run.failure?.broken.some(found => found.property === breaks) === true) return pass(name, violation(run, options));
  }
  return fail(name, `no seed of ${String(plan.seeds.length)} broke ${breaks}`);
}

async function simulationChecks(args: readonly string[]): Promise<readonly Check[]> {
  const options = parseSimulationOptions(args);
  const chosen = options.mutant === undefined ? [] : options.mutant === 'all' ? mutantName.options : [options.mutant];
  return [await guardedCheck(options), ...(await Promise.all(chosen.map(mutant => mutantCheck(mutant, options))))];
}

const parked = (lane: string): Check => fail(`${lane} is parked`, 'PARKED: gate 1. The sandbox GitHub token is read-only, so AutoWorker cannot open, mark ready, or merge a pull request until the owner regrants it.');

export const scenarios: readonly Scenario[] = [
  {
    name: 'code-change',
    summary: "checks the Code change declaration against the task model's shape and runs each step's judge on reviews of every outcome",
    run: () => Promise.resolve([shapeCheck(), builtCheck(), ...judgeChecks(), ...settleChecks(), ...implementChecks(), promptCheck()]),
  },
  landModel,
  {
    name: 'land-sim',
    summary: "runs Land's real decision table and pass against a seeded fake of GitHub and the outbox, and checks each property of Land.tla by name; --mutant turns one guard off",
    run: simulationChecks,
  },
  {
    name: 'land-live',
    summary: 'seeds a task at Land with a pull request from a probe branch, and prints each state Land read and each action it owed, up to merged',
    run: () => Promise.resolve([parked('land-live')]),
  },
];
