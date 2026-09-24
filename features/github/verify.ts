import type { Scenario } from '../../tools/verify/check.ts';
import { defineModel, type Shape } from '../../tools/verify/models.ts';
import { actionsOf, realStates, variablesIn, type TlcRun } from '../../tools/verify/tlc.ts';

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
  const real = realStates(run);
  return {
    actions: actionsOf(run),
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

export const scenarios: readonly Scenario[] = [
  defineModel({
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
  }),
];
