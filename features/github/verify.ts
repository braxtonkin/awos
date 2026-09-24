import { parseArgs } from 'node:util';
import { z } from 'zod';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { defineModel, type Shape } from '../../tools/verify/models.ts';
import type { TlcRun } from '../../tools/verify/tlc.ts';
import { githubClient } from './client.ts';
import { liveScenario } from './live.ts';
import { mutantName, mutants, simulate, type MutantName, type Run } from './simulate.ts';

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

const landModel = defineModel({
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

const simulationFlags = { seeds: { type: 'string' }, seed: { type: 'string' }, steps: { type: 'string' }, mutant: { type: 'string' } } as const;

const whole = z.coerce.number().int().positive();

const simulationOptions = z.object({
  seeds: whole.default(200),
  seed: whole.optional(),
  steps: whole.default(1000),
  mutant: z.union([mutantName, z.literal('all')]).optional(),
});

type SimulationOptions = z.infer<typeof simulationOptions>;

const mutantSeeds = 20;

const seedList = (options: SimulationOptions, count: number): readonly number[] =>
  options.seed === undefined ? Array.from({ length: count }, (_, index) => index + 1) : [options.seed];

const replayOf = (run: Run): string =>
  `npm run verify -- github-sim --seed ${String(run.seed)} --steps ${String(run.plan.steps)}${run.plan.mutant === undefined ? '' : ` --mutant ${run.plan.mutant}`}`;

const failureOf = (run: Run): string =>
  run.failure === undefined
    ? ''
    : `seed ${String(run.seed)} broke ${[...new Set(run.failure.broken.map(found => found.property))].join(', ')} at step ${String(run.failure.step)} after "${run.failure.move}": ${run.failure.broken[0]?.detail ?? ''}; replay with ${replayOf(run)}`;

const allValues = ['waiting-for-checks', 'red', 'green-draft', 'review-required', 'changes-requested', 'behind', 'conflicting', 'ready', 'queued', 'ejected', 'merged'];

async function cleanSeeds(options: SimulationOptions): Promise<readonly Check[]> {
  const started = performance.now();
  const runs = await simulate([{ seeds: seedList(options, options.seeds), steps: options.steps }]);
  const seconds = (performance.now() - started) / 1000;
  const failed = runs.filter(run => run.failure !== undefined);
  const idle = runs.filter(run => run.settled === 0);
  const seen = new Set(runs.flatMap(run => [...run.values]));
  const unseen = allValues.filter(value => !seen.has(value));
  const sum = (count: (run: Run) => number): number => runs.reduce((total, run) => total + count(run), 0);
  const name = `${String(runs.length)} seeds, ${String(failed.length)} violations`;
  return [
    failed.length === 0
      ? pass(name, `${String(options.steps)} steps a seed in ${seconds.toFixed(1)} s: ${String(sum(run => run.reads))} merge-state reads, ${String(sum(run => run.merged))} merges, ${String(sum(run => run.settled))} tasks settled, ${String(sum(run => run.lostReplies))} lost replies`)
      : fail(name, failed.slice(0, 3).map(failureOf).join('; ')),
    idle.length === 0
      ? pass('every seed settled a task: merged, awaiting a review, or parked after its retries', `fewest settled in a seed: ${String(Math.min(...runs.map(run => run.settled)))}`)
      : fail('every seed settled a task: merged, awaiting a review, or parked after its retries', `seeds ${idle.map(run => String(run.seed)).join(', ')} settled nothing`),
    unseen.length === 0 || options.seed !== undefined
      ? pass('the reads reached every merge-state value', [...seen].join(', '))
      : fail('the reads reached every merge-state value', `never read: ${unseen.join(', ')}`),
  ];
}

async function mutantCheck(mutant: MutantName, options: SimulationOptions): Promise<Check> {
  const expected = mutants[mutant].breaks;
  const runs = await simulate([{ seeds: seedList(options, Math.min(options.seeds, mutantSeeds)), steps: options.steps, mutant }]);
  const breaking = runs.filter(run => run.failure?.broken.some(found => found.property === expected) === true);
  const name = `${expected} fails under the ${mutant} mutant`;
  const first = breaking[0];
  return first === undefined ? fail(name, `no seed of ${String(runs.length)} broke it`) : pass(name, `${String(breaking.length)} of ${String(runs.length)} seeds; first: ${failureOf(first)}`);
}

const withoutNumber: typeof fetch = () =>
  Promise.resolve(
    new Response(JSON.stringify({ node_id: 'PR_1', html_url: 'https://github.com/sim/repo/pull/1', state: 'open', draft: true, merged_at: null, body: '', head: { ref: 'a', sha: 'a'.repeat(40) }, base: { ref: 'main' } }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }),
  );

async function parseCheck(): Promise<Check> {
  const client = githubClient({ token: 'planted', baseUrl: 'https://github.invalid', pageSize: 100, fetch: withoutNumber });
  const opened = await client.openDraft('sim/repo', { head: 'a', base: 'main', title: 'Planted', body: '' }, new AbortController().signal);
  const name = 'the client refuses a planted pull request answer without number';
  return !('ok' in opened) && opened.message.includes('number') ? pass(name, opened.message.replace(/\s+/g, ' ')) : fail(name, JSON.stringify(opened));
}

async function simulationChecks(options: SimulationOptions): Promise<readonly Check[]> {
  if (options.mutant === 'all') {
    const checks: Check[] = [await parseCheck()];
    for (const mutant of mutantName.options) checks.push(await mutantCheck(mutant, options));
    return checks;
  }
  if (options.mutant !== undefined) return [await mutantCheck(options.mutant, options)];
  return [...(await cleanSeeds(options)), await parseCheck()];
}

export const scenarios: readonly Scenario[] = [
  landModel,
  {
    name: 'github-sim',
    summary:
      'reads merge states and performs pull request actions through the real client against a seeded fake GitHub with pushes, late checks, reviews from ignored and other reviewers, conflicts, queue ejections, and lost replies, and checks every Land property after each step; --mutant all proves each guard the connector holds can fail',
    run: args => {
      const parsed = simulationOptions.safeParse(parseArgs({ args: [...args], options: simulationFlags, strict: true, allowPositionals: false }).values);
      if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
      return simulationChecks(parsed.data);
    },
  },
  liveScenario,
];
