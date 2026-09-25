import type { Scenario } from '../../tools/verify/check.ts';
import { defineModel, type Shape } from '../../tools/verify/models.ts';
import { actionsOf, realStates, variablesIn, type TlcRun } from '../../tools/verify/tlc.ts';

type EngineView = { readonly id: string; readonly step: string; readonly target: string; readonly row: number };

type RowView = { readonly request: number; readonly answer: string };

type StateView = {
  readonly engines: readonly EngineView[];
  readonly rows: ReadonlyMap<string, readonly RowView[]>;
  readonly applied: ReadonlyMap<string, readonly number[]>;
};

type TraceView = Pick<TlcRun, 'stutters' | 'loopActions'> & {
  readonly actions: readonly string[];
  readonly states: readonly StateView[];
  readonly loop: readonly StateView[];
};

const fieldsIn = (record: string): ReadonlyMap<string, string> =>
  new Map([...record.matchAll(/(\w+)\|->(\w+)/g)].map(([, name = '', field = '']): [string, string] => [name, field]));

function viewOf(text: string): StateView {
  const variables = variablesIn(text);
  const value = (name: string): string => variables.get(name) ?? '';
  const engines = [...value('engine').matchAll(/(\w+):>\[([^\]]*)\]/g)].map(([, id = '', record = '']): EngineView => {
    const fields = fieldsIn(record);
    return { id, step: fields.get('step') ?? '', target: fields.get('target') ?? '', row: Number(fields.get('row')) };
  });
  const rows = new Map(
    [...value('rows').matchAll(/(\w+):><<(.*?)>>/g)].map(([, target = '', body = '']): [string, readonly RowView[]] => [
      target,
      [...body.matchAll(/\[([^\]]*)\]/g)].map(([, record = '']) => {
        const fields = fieldsIn(record);
        return { request: Number(fields.get('request')), answer: fields.get('answer') ?? '' };
      }),
    ]),
  );
  const applied = new Map(
    [...value('applied').matchAll(/(\w+):><<([\d,]*)>>/g)].map(([, target = '', body = '']): [string, readonly number[]] => [
      target,
      body.split(',').filter(entry => entry !== '').map(Number),
    ]),
  );
  return { engines, rows, applied };
}

const shape = (label: string, holds: (trace: TraceView) => boolean): Shape => ({
  label,
  holds: run =>
    holds({
      actions: actionsOf(run),
      states: realStates(run).map(state => viewOf(state.text)),
      loop: run.loop.map(state => viewOf(state.text)),
      loopActions: run.loopActions,
      stutters: run.stutters,
    }),
});

const inOrder = (actions: readonly string[], wanted: readonly string[]): boolean =>
  actions.reduce((matched, action) => (action === wanted[matched] ? matched + 1 : matched), 0) === wanted.length;

const without = (actions: readonly string[], ...absent: readonly string[]): boolean => !actions.some(action => absent.includes(action));

const allRows = (view: StateView | undefined): readonly RowView[] => [...(view?.rows.values() ?? [])].flat();

const appliedTwice = (view: StateView | undefined): boolean => [...(view?.applied.values() ?? [])].some(counts => counts.some(count => count > 1));

const openBelowAnswered = (view: StateView | undefined): boolean =>
  [...(view?.rows.values() ?? [])].some(rows =>
    rows.some((row, index) => row.answer === 'open' && rows.slice(index + 1).some(later => later.answer === 'recorded' || later.answer === 'refused')),
  );

const rowOf = (view: StateView, engine: EngineView): RowView | undefined => view.rows.get(engine.target)?.[engine.row - 1];

const lastTwo = (states: readonly StateView[]): readonly [StateView, StateView] | undefined => {
  const before = states.at(-2);
  const last = states.at(-1);
  return before === undefined || last === undefined ? undefined : [before, last];
};

const insertedBelow = (before: StateView | undefined, after: StateView): boolean =>
  [...after.rows].some(([target, rows]) =>
    rows.some((row, index) => {
      const earlier = before?.rows.get(target) ?? [];
      return row.answer !== 'absent' && earlier[index]?.answer === 'absent' && earlier.slice(index + 1).some(above => above.answer !== 'absent');
    }),
  );

const keyBelowAnotherRequest = shape('by a request sent later whose key sorts it below a request already sent', ({ actions, states }) =>
  without(actions, 'Repeat', 'Crash', 'Fail') &&
  states.some((after, index) => actions[index] === 'Send' && insertedBelow(states[index - 1], after)) &&
  openBelowAnswered(states.at(-1)),
);

const repeatAppliedAgain = shape('by a repeat that inserted a second row for the same request id', ({ actions, states }) =>
  without(actions, 'Crash', 'Fail') && actions.includes('Repeat') && actions.at(-1) === 'Apply' && appliedTwice(states.at(-1)),
);

const laterTakenPastLockedOldest = shape('by an engine that skips the oldest request another engine holds and applies the next one first', ({ actions, states }) => {
  const pair = lastTwo(states);
  if (pair === undefined || actions.at(-1) !== 'Apply') return false;
  const [before, last] = pair;
  return before.engines.some(later =>
    before.engines.some(
      oldest =>
        later.step === 'locked' &&
        oldest.step === 'locked' &&
        later.target === oldest.target &&
        oldest.row < later.row &&
        last.engines.some(engine => engine.id === later.id && engine.step === 'idle') &&
        last.engines.some(engine => engine.id === oldest.id && engine.step === 'locked'),
    ),
  );
});

const crashBetweenApplyAndAnswer = shape('by one engine that crashes between applying a request and answering it, then applies it again', ({ actions, states }) =>
  without(actions, 'Repeat', 'Fail', 'Answer') && inOrder(actions, ['Apply', 'Crash', 'Apply']) && actions.at(-1) === 'Apply' && appliedTwice(states.at(-1)),
);

const secondEngineBeforeTheAnswer = shape('by a second engine that applies a request the first applied and has not yet answered', ({ actions, states }) => {
  const pair = lastTwo(states);
  if (pair === undefined || !without(actions, 'Repeat', 'Fail', 'Crash') || actions.at(-1) !== 'Apply') return false;
  const [before, last] = pair;
  return (
    appliedTwice(last) &&
    before.engines.some(first =>
      before.engines.some(second => first.step === 'applied' && second.step === 'locked' && first.target === second.target && first.row === second.row),
    )
  );
});

const failedRequestRetriedForever = shape('by a request whose apply fails on every try and is never answered', ({ loop, loopActions }) =>
  loopActions.includes('Fail') &&
  [...(loop[0]?.rows ?? new Map<string, readonly RowView[]>())].some(([target, rows]) =>
    rows.some((row, index) => row.answer === 'open' && loop.every(view => view.rows.get(target)?.[index]?.answer === 'open')),
  ),
);

const refusalOverwritesAnswer = shape("by an engine whose apply failed writing its refusal over another engine's answer", ({ actions, states }) => {
  const pair = lastTwo(states);
  if (pair === undefined || !without(actions, 'Crash', 'Repeat') || actions.at(-1) !== 'Refuse') return false;
  const [before, last] = pair;
  return before.engines.some(engine => {
    const held = rowOf(before, engine);
    return engine.step === 'failed' && held?.answer === 'recorded' && rowOf(last, engine)?.answer === 'refused';
  });
});

const enginesStopTakingRequests = shape(
  'by engines that stop taking an open request',
  ({ stutters, states, loop, loopActions }) =>
    without(loopActions, 'Claim', 'Apply', 'Answer', 'Refuse') && (stutters ? states.slice(-1) : loop).every(view => allRows(view).some(row => row.answer === 'open')),
);

export const scenarios: readonly Scenario[] = [
  defineModel({
    name: 'requests',
    module: new URL('Requests.tla', import.meta.url),
    configs: {
      pr: { file: 'Requests.cfg', floors: { Targets: 2, Engines: 2, RequestsPerTarget: 3, MaxRepeats: 1, MaxCrashes: 1 } },
      nightly: { file: 'Requests.nightly.cfg', floors: { Targets: 2, Engines: 3, RequestsPerTarget: 3, MaxRepeats: 1, MaxCrashes: 1 } },
    },
    guards: [
      'KeyFollowsCommitOrder',
      'RepeatReusesTheRow',
      'ClaimTakesOldestOfTarget',
      'ApplyAndAnswerAreOneStep',
      'FailureIsAnswered',
      'AnswerWrittenOnce',
      'EngineIsFair',
    ],
    properties: {
      RequestAppliedOnce: 'INVARIANTS',
      RequestsApplyInOrder: 'INVARIANTS',
      AnswerIsFinal: 'PROPERTIES',
      EveryRequestAnswered: 'PROPERTIES',
    },
    liveness: ['EveryRequestAnswered'],
    mutants: [
      { guard: 'KeyFollowsCommitOrder', property: 'RequestsApplyInOrder', shape: keyBelowAnotherRequest },
      { guard: 'RepeatReusesTheRow', property: 'RequestAppliedOnce', shape: repeatAppliedAgain },
      { guard: 'ClaimTakesOldestOfTarget', property: 'RequestsApplyInOrder', shape: laterTakenPastLockedOldest },
      { guard: 'ApplyAndAnswerAreOneStep', property: 'RequestAppliedOnce', overrides: { Engines: '{e1}' }, shape: crashBetweenApplyAndAnswer },
      { guard: 'ApplyAndAnswerAreOneStep', property: 'RequestAppliedOnce', shape: secondEngineBeforeTheAnswer },
      { guard: 'FailureIsAnswered', property: 'EveryRequestAnswered', overrides: { MaxRepeats: '0', MaxCrashes: '0' }, shape: failedRequestRetriedForever },
      { guard: 'AnswerWrittenOnce', property: 'AnswerIsFinal', shape: refusalOverwritesAnswer },
      { guard: 'EngineIsFair', property: 'EveryRequestAnswered', overrides: { MaxRepeats: '0', MaxCrashes: '0' }, shape: enginesStopTakingRequests },
    ],
  }),
];
