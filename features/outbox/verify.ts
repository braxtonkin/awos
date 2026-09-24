import type { Scenario } from '../../tools/verify/check.ts';
import { defineModel, type Shape } from '../../tools/verify/models.ts';
import type { TlcRun } from '../../tools/verify/tlc.ts';

type TaskView = { readonly id: string; readonly state: string };

type RowView = {
  readonly id: string;
  readonly task: TaskView;
  readonly index: number;
  readonly state: string;
  readonly tries: number;
  readonly leased: boolean;
  readonly effects: number;
};

type PerformerView = { readonly id: string; readonly row: string; readonly step: string; readonly live: boolean; readonly stalled: boolean };

type StateView = { readonly rows: readonly RowView[]; readonly performers: readonly PerformerView[] };

type TraceView = Pick<TlcRun, 'loopActions' | 'stutters'> & {
  readonly actions: readonly string[];
  readonly last: StateView;
  readonly beforeLast: StateView;
  readonly loop: readonly StateView[];
};

const variablesIn = (text: string): ReadonlyMap<string, string> =>
  new Map([...text.replace(/["\s]/g, '').matchAll(/\/\\(\w+)=([^/]*)/g)].map(([, name = '', value = '']): [string, string] => [name, value]));

const entriesIn = (value: string): ReadonlyMap<string, string> =>
  new Map([...value.matchAll(/(<<[^>]*>>|\w+):>(\[[^\]]*\]|\w+)/g)].map(([, key = '', entry = '']): [string, string] => [key, entry]));

const fieldsIn = (record: string): ReadonlyMap<string, string> =>
  new Map([...record.matchAll(/(\w+)\|->(<<[^>]*>>|\w+)/g)].map(([, name = '', field = '']): [string, string] => [name, field]));

function viewOf(text: string): StateView {
  const variables = variablesIn(text);
  const entries = (name: string): ReadonlyMap<string, string> => entriesIn(variables.get(name) ?? '');
  const tasks = entries('task');
  const effects = entries('effects');
  const rows = [...entries('row')].map(([id, record]): RowView => {
    const fields = fieldsIn(record);
    const [, task = '', index = ''] = /^<<(\w+),(\d+)>>$/.exec(id) ?? [];
    return {
      id,
      task: { id: task, state: tasks.get(task) ?? '' },
      index: Number.parseInt(index, 10),
      state: fields.get('state') ?? '',
      tries: Number.parseInt(fields.get('tries') ?? '', 10),
      leased: fields.get('leased') === 'TRUE',
      effects: Number.parseInt(effects.get(id) ?? '', 10),
    };
  });
  const performers = [...entries('perf')].map(([id, record]): PerformerView => {
    const fields = fieldsIn(record);
    return { id, row: fields.get('row') ?? '', step: fields.get('step') ?? '', live: fields.get('live') === 'TRUE', stalled: fields.get('stalled') === 'TRUE' };
  });
  return { rows, performers };
}

function traceViewOf(run: TlcRun): TraceView {
  const real = run.trace.filter(state => state.action !== 'Stuttering');
  return {
    actions: run.trace.map(state => state.action),
    last: viewOf(real.at(-1)?.text ?? ''),
    beforeLast: viewOf(real.at(-2)?.text ?? ''),
    loop: run.loop.map(state => viewOf(state.text)),
    loopActions: run.loopActions,
    stutters: run.stutters,
  };
}

const shape = (label: string, holds: (trace: TraceView) => boolean): Shape => ({ label, holds: run => holds(traceViewOf(run)) });

const performersOn = (view: StateView, row: RowView): readonly PerformerView[] => view.performers.filter(performer => performer.row === row.id);

const earlierRows = (view: StateView, row: RowView): readonly RowView[] => view.rows.filter(other => other.task.id === row.task.id && other.index < row.index);

const claimable = (view: StateView, row: RowView): boolean => row.state === 'owed' && !row.leased && earlierRows(view, row).every(earlier => earlier.state === 'done');

const postedTwice = (row: RowView): boolean => row.effects === 2;

const someRowThroughout = (views: readonly StateView[], holds: (row: RowView, view: StateView) => boolean): boolean =>
  (views[0]?.rows ?? []).some(({ id }) => views.every(view => view.rows.some(row => row.id === id && holds(row, view))));

const inOrder = (actions: readonly string[], wanted: readonly string[]): boolean =>
  actions.reduce((matched, action) => (action === wanted[matched] ? matched + 1 : matched), 0) === wanted.length;

const withoutCrashHangOrExpire = (actions: readonly string[]): boolean => !actions.some(action => ['Crash', 'Hang', 'Expire'].includes(action));

const nextStageClaimedOver =
  (rowState: string) =>
  ({ actions, last }: TraceView): boolean =>
    actions.at(-1) === 'ClaimNextStage' && last.rows.some(row => row.task.state === 'next' && row.state === rowState);

const twoPerformersPostOneComment = shape(
  'by two performers posting one comment',
  ({ actions, last }) =>
    withoutCrashHangOrExpire(actions) && actions.at(-1) === 'Call' && last.rows.some(row => postedTwice(row) && performersOn(last, row).length === 2),
);

const twoLiveClaimsOnOneRow = shape(
  'with two performers holding live claims on one row',
  ({ actions, last }) => !actions.includes('Expire') && last.rows.some(row => performersOn(last, row).filter(performer => performer.live).length === 2),
);

const crashBetweenPostAndMark = shape('by a crash between the post and the done mark', ({ actions, last }) => {
  const betweenCalls = actions.slice(actions.indexOf('Call') + 1, actions.lastIndexOf('Call'));
  return (
    !actions.includes('Hang') &&
    inOrder(betweenCalls, ['Crash', 'Expire', 'Claim']) &&
    !betweenCalls.includes('Mark') &&
    actions.at(-1) === 'Call' &&
    last.rows.some(postedTwice)
  );
});

const effectWhoseStateRolledBack = shape(
  'by an effect whose owing state rolled back',
  ({ actions, last }) => actions.at(-1) === 'Call' && last.rows.some(row => row.task.state === 'rolledBack' && row.effects > 0),
);

const nextStageClaimedForUnowedState = shape('by a next stage claimed for a state whose actions were never owed', nextStageClaimedOver('absent'));

const claimOutlivesItsPerformer = shape(
  'by a claim that outlives its performer and holds its row forever',
  ({ actions, stutters, last, loop }) =>
    !actions.includes('Expire') &&
    someRowThroughout(stutters ? [last] : loop, (row, view) => row.state === 'owed' && row.leased && performersOn(view, row).length === 0),
);

const laterRowPostedFirst = shape(
  'by a later row posted before an earlier one',
  ({ actions, last }) => actions.at(-1) === 'Call' && last.rows.some(row => row.effects > 0 && earlierRows(last, row).some(earlier => earlier.effects === 0)),
);

const stalledPerformerPostsAfterAnother = shape('by a stalled performer posting after another performer already did', ({ actions, beforeLast, last }) => {
  const callers = beforeLast.performers.filter(performer => performer.step === 'call');
  const poster = callers.length === 1 ? callers[0] : undefined;
  return (
    !actions.includes('Crash') &&
    inOrder(actions, ['Hang', 'Expire', 'Claim', 'Call', 'Wake', 'Call']) &&
    actions.at(-1) === 'Call' &&
    last.rows.some(postedTwice) &&
    poster?.live === false &&
    last.performers.some(performer => performer.id === poster.id && performer.step === 'mark')
  );
});

const failedCallLandsAfterRetry = shape(
  "by a failed call's request landing after the retry posted",
  ({ actions, last }) => withoutCrashHangOrExpire(actions) && inOrder(actions, ['Call', 'Claim']) && actions.at(-1) === 'Resolve' && last.rows.some(postedTwice),
);

const rowRetriedForever = shape('by a row retried forever', ({ actions, loop, loopActions }) => {
  const mostTries = Math.max(...loop.flatMap(view => view.rows.map(row => row.tries)));
  return (
    !actions.includes('Crash') &&
    ['Claim', 'Call', 'Resolve', 'Expire'].every(action => loopActions.includes(action)) &&
    someRowThroughout(loop, row => row.state === 'owed' && row.tries === mostTries)
  );
});

const nextStageClaimedOverFailedRow = shape(
  'by a next stage claimed over a row that failed before a retry',
  trace => trace.actions.includes('Retry') && nextStageClaimedOver('failed')(trace),
);

const nextStageClaimedOverUnparkedFailure = shape(
  'by a next stage claimed over a failed row whose task never waited',
  trace => !trace.actions.includes('Retry') && nextStageClaimedOver('failed')(trace),
);

const nextStageClaimedWhileOwing = shape('by a next stage claimed while its task owes an action', nextStageClaimedOver('owed'));

const rowMarkedDoneBeforeEffect = shape(
  'by a row marked done before its effect',
  ({ actions, last }) => actions.at(-1) === 'Claim' && last.rows.some(row => row.state === 'done' && row.effects === 0),
);

const performersStopTakingOwedRows = shape(
  'by performers that stop taking owed rows',
  ({ stutters, last }) =>
    stutters &&
    last.rows.some(row => row.state === 'owed' && row.task.state !== 'waiting') &&
    last.performers.some(performer => (performer.step === 'idle' ? last.rows.some(row => claimable(last, row)) : !performer.stalled)),
);

export const scenarios: readonly Scenario[] = [
  defineModel({
    name: 'outbox',
    module: new URL('Outbox.tla', import.meta.url),
    configs: {
      pr: { file: 'Outbox.cfg', floors: { Tasks: 2, Performers: 2, RowsPerTask: 2, MaxTries: 2, MaxCrashes: 2, MaxStalls: 1, MaxRetries: 1 } },
      nightly: { file: 'Outbox.nightly.cfg', floors: { Tasks: 2, Performers: 2, RowsPerTask: 3, MaxTries: 2, MaxCrashes: 3, MaxStalls: 2, MaxRetries: 1 } },
    },
    guards: [
      'EnqueueWithState',
      'ClaimIsExclusive',
      'MarkerCheckedBeforeWrite',
      'LeaseExpires',
      'InOrderPerTask',
      'ClaimWaitsForOwedActions',
      'DoneFollowsEffect',
      'EffectWithinLease',
      'FailedCallKeepsClaim',
      'RetriesAreCapped',
      'FailureParksTask',
      'RetryReowesFailedRows',
      'PerformerIsFair',
    ],
    properties: {
      EffectAtMostOnce: 'INVARIANTS',
      DoneMeansEffect: 'INVARIANTS',
      NoEffectWithoutOwingState: 'INVARIANTS',
      ActionsInOrderPerTask: 'INVARIANTS',
      NextStageWaitsForOwedActions: 'INVARIANTS',
      OneLivePerformerPerRow: 'INVARIANTS',
      EveryOwedActionSettles: 'PROPERTIES',
    },
    liveness: ['EveryOwedActionSettles'],
    mutants: [
      { guard: 'ClaimIsExclusive', property: 'EffectAtMostOnce', shape: twoPerformersPostOneComment },
      { guard: 'ClaimIsExclusive', property: 'OneLivePerformerPerRow', shape: twoLiveClaimsOnOneRow },
      { guard: 'MarkerCheckedBeforeWrite', property: 'EffectAtMostOnce', shape: crashBetweenPostAndMark },
      { guard: 'EnqueueWithState', property: 'NoEffectWithoutOwingState', shape: effectWhoseStateRolledBack },
      { guard: 'EnqueueWithState', property: 'NextStageWaitsForOwedActions', shape: nextStageClaimedForUnowedState },
      { guard: 'LeaseExpires', property: 'EveryOwedActionSettles', overrides: { MaxStalls: '0', MaxRetries: '0' }, shape: claimOutlivesItsPerformer },
      { guard: 'InOrderPerTask', property: 'ActionsInOrderPerTask', shape: laterRowPostedFirst },
      { guard: 'EffectWithinLease', property: 'EffectAtMostOnce', shape: stalledPerformerPostsAfterAnother },
      { guard: 'FailedCallKeepsClaim', property: 'EffectAtMostOnce', shape: failedCallLandsAfterRetry },
      { guard: 'RetriesAreCapped', property: 'EveryOwedActionSettles', overrides: { MaxCrashes: '0', MaxStalls: '0', MaxRetries: '0' }, shape: rowRetriedForever },
      { guard: 'FailureParksTask', property: 'NextStageWaitsForOwedActions', shape: nextStageClaimedOverUnparkedFailure },
      { guard: 'RetryReowesFailedRows', property: 'NextStageWaitsForOwedActions', shape: nextStageClaimedOverFailedRow },
      { guard: 'ClaimWaitsForOwedActions', property: 'NextStageWaitsForOwedActions', shape: nextStageClaimedWhileOwing },
      { guard: 'DoneFollowsEffect', property: 'DoneMeansEffect', shape: rowMarkedDoneBeforeEffect },
      { guard: 'PerformerIsFair', property: 'EveryOwedActionSettles', overrides: { MaxCrashes: '0', MaxStalls: '0', MaxRetries: '0' }, shape: performersStopTakingOwedRows },
    ],
  }),
];
