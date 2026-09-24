import type { Scenario } from '../../tools/verify/check.ts';
import { defineModel, type Shape } from '../../tools/verify/models.ts';
import type { TlcRun, TraceState } from '../../tools/verify/tlc.ts';
import { liveScenarios } from './live.ts';
import { simScenarios } from './sim-scenarios.ts';

const numbersIn = (state: TraceState | undefined, variable: string): readonly number[] => {
  const listed = new RegExp(`\\b${variable} = [<{]+([^>}]*)`).exec(state?.text ?? '')?.[1];
  if (listed === undefined) throw new Error(`the trace state has no ${variable}`);
  return listed
    .split(',')
    .filter(item => item.trim() !== '')
    .map(Number);
};

const actionsOf = (run: TlcRun): readonly string[] => run.trace.map(state => state.action);

const endSteps: ReadonlySet<string> = new Set(['Finish', 'Stop', 'Reap']);

const storesPastAGap: Shape = {
  label: 'by storing a number past a gap',
  holds: run => {
    const stored = numbersIn(run.trace.at(-1), 'timesStored');
    return actionsOf(run).at(-1) === 'Store' && stored.some((count, index) => count > 0 && stored.slice(0, index).includes(0));
  },
};

const crashBetweenAckAndCommit: Shape = {
  label: 'by a crash between the acknowledgement and the commit',
  holds: run => actionsOf(run).at(-1) === 'CrashBeforeCommit',
};

const prunedFragmentStoredAgain: Shape = {
  label: 'by storing a pruned fragment again',
  holds: run => {
    const storedBefore = numbersIn(run.trace.at(-2), 'timesStored');
    const rowsBefore = numbersIn(run.trace.at(-2), 'rows');
    return numbersIn(run.trace.at(-1), 'timesStored').some((count, index) => count === 2 && storedBefore[index] === 1 && !rowsBefore.includes(index + 1));
  },
};

const storedAfterTheEnd: Shape = {
  label: 'by a post stored after the attempt ended',
  holds: run => {
    const actions = actionsOf(run);
    return actions.at(-1) === 'Store' && actions.slice(0, -1).some(action => endSteps.has(action));
  },
};

const reapRightAfterRestart: Shape = {
  label: 'by a reap right after an engine restart',
  holds: run => actionsOf(run).slice(-2).join(' ') === 'Restart Reap',
};

const withoutNetworkFaults = { MaxNetworkFaults: '0' };

const withoutCommands = { MaxCommands: '0' };

export const scenarios: readonly Scenario[] = [
  defineModel({
    name: 'bridge',
    module: new URL('Bridge.tla', import.meta.url),
    configs: {
      pr: { file: 'Bridge.cfg', floors: { MaxEvents: 3, MaxCommands: 2, MaxEngineCrashes: 2, MaxNetworkFaults: 2 } },
      nightly: { file: 'Bridge.nightly.cfg', floors: { MaxEvents: 4, MaxCommands: 2, MaxEngineCrashes: 3, MaxNetworkFaults: 2 } },
    },
    guards: [
      'GapIsRefused',
      'DuplicateIsDropped',
      'AckFollowsCommit',
      'BridgeResendsUnacked',
      'CommandsAreNumbered',
      'PruneKeepsHighWater',
      'LostAttemptIsFenced',
      'RestartGraceForLeases',
      'FinishWaitsForLastLine',
      'EngineIsFair',
    ],
    properties: {
      NoEventStoredTwice: 'INVARIANTS',
      EventsStoredInOrder: 'INVARIANTS',
      AckedMeansStored: 'INVARIANTS',
      EveryEventStored: 'PROPERTIES',
      CommandAppliedOnce: 'INVARIANTS',
      CommandsAppliedInOrder: 'PROPERTIES',
      EveryCommandApplied: 'PROPERTIES',
      FinishedStepKeepsItsText: 'INVARIANTS',
      LostAttemptChangesNothing: 'PROPERTIES',
      ReconnectedBridgeKeepsItsAttempt: 'INVARIANTS',
    },
    liveness: ['EveryEventStored', 'EveryCommandApplied'],
    mutants: [
      { guard: 'GapIsRefused', property: 'EventsStoredInOrder', shape: storesPastAGap },
      { guard: 'DuplicateIsDropped', property: 'NoEventStoredTwice', overrides: withoutNetworkFaults, shape: prunedFragmentStoredAgain },
      { guard: 'DuplicateIsDropped', property: 'EveryEventStored' },
      { guard: 'AckFollowsCommit', property: 'AckedMeansStored', shape: crashBetweenAckAndCommit },
      { guard: 'BridgeResendsUnacked', property: 'EveryEventStored' },
      { guard: 'CommandsAreNumbered', property: 'CommandAppliedOnce' },
      { guard: 'CommandsAreNumbered', property: 'CommandsAppliedInOrder' },
      { guard: 'PruneKeepsHighWater', property: 'NoEventStoredTwice', shape: prunedFragmentStoredAgain },
      { guard: 'PruneKeepsHighWater', property: 'FinishedStepKeepsItsText' },
      { guard: 'LostAttemptIsFenced', property: 'LostAttemptChangesNothing' },
      { guard: 'LostAttemptIsFenced', property: 'LostAttemptChangesNothing', overrides: withoutCommands, shape: storedAfterTheEnd },
      { guard: 'RestartGraceForLeases', property: 'ReconnectedBridgeKeepsItsAttempt', shape: reapRightAfterRestart },
      { guard: 'FinishWaitsForLastLine', property: 'EveryEventStored' },
      { guard: 'EngineIsFair', property: 'EveryEventStored' },
      { guard: 'EngineIsFair', property: 'EveryCommandApplied' },
    ],
  }),
  ...simScenarios,
  ...liveScenarios,
];
