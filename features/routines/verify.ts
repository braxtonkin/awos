import type { Scenario } from '../../tools/verify/check.ts';
import { defineModel, type Shape } from '../../tools/verify/models.ts';
import type { TlcRun, TraceState } from '../../tools/verify/tlc.ts';

type Hold = { readonly engine: string; readonly routine: string; readonly slot: string; readonly lapsed: boolean };

type RoutineVariable = 'paused' | 'newest' | 'runNow' | 'asked';

const leased = ['newest', 'runNow'] as const satisfies readonly RoutineVariable[];

const variable = (state: TraceState, name: RoutineVariable | 'engine' | 'task' | 'finder'): string =>
  new RegExp(String.raw`^/\\ ${name} = (.*(?:\n .*)*)`, 'm').exec(state.text)?.[1] ?? '';

const holdsIn = (state: TraceState): readonly Hold[] =>
  [...variable(state, 'engine').matchAll(/(e\d+) :> \[routine \|-> (r\d+), slot \|-> "(\w+)", lapsed \|-> (TRUE|FALSE)\]/g)].map(
    ([, engine = '', routine = '', slot = '', lapsed = '']) => ({ engine, routine, slot, lapsed: lapsed === 'TRUE' }),
  );

const currentIn = (state: TraceState): readonly Hold[] => holdsIn(state).filter(hold => !hold.lapsed);

const rowsOf = (text: string): ReadonlyMap<string, string> => new Map([...text.matchAll(/(r\d+) :> "?(\w+)"?/g)].map(([, routine = '', value = '']) => [routine, value]));

const rowsIn = (state: TraceState, name: RoutineVariable): ReadonlyMap<string, string> => rowsOf(variable(state, name));

const tasksIn = (state: TraceState): ReadonlyMap<string, ReadonlyMap<string, string>> =>
  new Map([...variable(state, 'task').matchAll(/(k\d+) :> \(([^)]*)\)/g)].map(([, key = '', rows = '']) => [key, rowsOf(rows)]));

const findersIn = (state: TraceState): ReadonlyMap<string, string> =>
  new Map([...variable(state, 'finder').matchAll(/(k\d+) :> \{([^}]*)\}/g)].map(([, key = '', finder = '']) => [key, finder.trim()]));

const ownersOf = (rows: ReadonlyMap<string, string>): readonly string[] => [...rows].filter(([, task]) => task !== 'none').map(([routine]) => routine);

const unpausedIn = (state: TraceState): readonly string[] => [...rowsIn(state, 'paused')].filter(([, paused]) => paused === 'FALSE').map(([routine]) => routine);

const hasOrphanedRun = (state: TraceState): boolean => {
  const holds = currentIn(state);
  const unpaused = unpausedIn(state);
  return leased.some(slot => {
    const rows = rowsIn(state, slot);
    return unpaused.some(routine => rows.get(routine) === 'live' && !holds.some(hold => hold.routine === routine && hold.slot === slot));
  });
};

const hasDueSlot = (state: TraceState): boolean => {
  const newest = rowsIn(state, 'newest');
  const runNow = rowsIn(state, 'runNow');
  const asked = rowsIn(state, 'asked');
  return unpausedIn(state).some(routine => newest.get(routine) !== 'done' || runNow.get(routine) !== 'none' || Number(asked.get(routine)) > 0);
};

const lastRealState = (run: TlcRun): TraceState | undefined => run.trace.filter(state => state.action !== 'Stuttering').at(-1);

const startedIn = (run: TlcRun): readonly Hold[] => {
  const [before, last] = run.trace.slice(-2);
  if (before === undefined || last?.action !== 'Claim') return [];
  const busy = holdsIn(before).map(hold => hold.engine);
  return holdsIn(last).filter(hold => !busy.includes(hold.engine));
};

const twoEnginesRunOneSlot: Shape = {
  label: 'with two engines running one slot',
  holds: run => {
    const last = run.trace.at(-1);
    const runs = last === undefined ? [] : currentIn(last).map(hold => `${hold.routine} ${hold.slot}`);
    return new Set(runs).size < runs.length;
  },
};

const lapsedRunFinishesTakenSlot: Shape = {
  label: 'by a run that finished after its lease lapsed and another engine took the slot',
  holds: run => {
    const last = run.trace.at(-1);
    if (last?.action !== 'Finish' || !run.trace.some(state => state.action === 'Lapse')) return false;
    return currentIn(last).some(hold => leased.some(slot => slot === hold.slot && rowsIn(last, slot).get(hold.routine) !== 'live'));
  },
};

const claimOnPausedRoutine: Shape = {
  label: 'by a claim on a paused routine',
  holds: run => {
    const last = run.trace.at(-1);
    return last !== undefined && startedIn(run).some(hold => rowsIn(last, 'paused').get(hold.routine) === 'TRUE');
  },
};

const runForMissedSlot: Shape = {
  label: 'by a run for a missed slot',
  holds: run => run.trace.some(state => state.action === 'Tick') && startedIn(run).some(hold => hold.slot === 'earlier'),
};

const routineTakesOverTicket: Shape = {
  label: "by a routine taking over another routine's ticket",
  holds: run => {
    const last = run.trace.at(-1);
    if (last?.action !== 'Finish') return false;
    const finders = findersIn(last);
    return [...tasksIn(last)].some(([key, rows]) => {
      const owners = ownersOf(rows);
      return owners.length === 1 && finders.get(key) !== owners[0];
    });
  },
};

const bothRoutinesRecordOneTicket: Shape = {
  label: 'by both routines recording the same ticket',
  holds: run => {
    const last = run.trace.at(-1);
    return last?.action === 'Finish' && [...tasksIn(last).values()].some(rows => ownersOf(rows).length > 1);
  },
};

const crashedRunHoldsItsSlot: Shape = {
  label: 'by a crashed run holding its slot forever',
  holds: run => {
    const last = lastRealState(run);
    const ending = run.stutters ? (last === undefined ? [] : [last]) : run.loop;
    return run.trace.some(state => state.action === 'Crash') && ending.length > 0 && ending.every(hasOrphanedRun);
  },
};

const outdatedTaskStaysOutdated: Shape = {
  label: 'by a run that found an outdated task and left it outdated',
  holds: run => {
    const last = run.trace.at(-1);
    return last?.action === 'Finish' && [...tasksIn(last).values()].some(rows => [...rows.values()].includes('outdated'));
  },
};

const twoPressesBeforeARun: Shape = {
  label: 'by two presses before a run starts',
  holds: run => run.trace.slice(-2).map(state => state.action).join(' ') === 'Press Press',
};

const schedulerStopsWithDueSlot: Shape = {
  label: 'by a scheduler that stops with a due slot unrun',
  holds: run => {
    const last = lastRealState(run);
    return run.stutters && last !== undefined && hasDueSlot(last) && !hasOrphanedRun(last);
  },
};

export const scenarios: readonly Scenario[] = [
  defineModel({
    name: 'schedule',
    module: new URL('Schedule.tla', import.meta.url),
    configs: {
      pr: { file: 'Schedule.cfg', floors: { Routines: 2, Engines: 2, Keys: 2, Slots: 4, MaxCrashes: 1, MaxHumanActions: 2 } },
      nightly: { file: 'Schedule.nightly.cfg', floors: { Routines: 2, Engines: 2, Keys: 2, Slots: 6, MaxCrashes: 2, MaxHumanActions: 3 } },
    },
    guards: [
      'SlotClaimIsExclusive',
      'PauseIsChecked',
      'CatchUpCollapses',
      'TaskKeyIsUnique',
      'RecordKeepsOwner',
      'RunLeaseExpires',
      'LateFinishIsRefused',
      'RunRefreshesAssignee',
      'RunNowIsKeyed',
      'SchedulerIsFair',
    ],
    properties: {
      OneRunPerSlot: 'INVARIANTS',
      RunNowRunsOnce: 'INVARIANTS',
      OneTaskPerTicket: 'INVARIANTS',
      AssigneeFollowsTicket: 'INVARIANTS',
      PausedRoutineStartsNoRun: 'PROPERTIES',
      MissedSlotsCollapse: 'PROPERTIES',
      DueSlotsRun: 'PROPERTIES',
    },
    liveness: ['DueSlotsRun'],
    mutants: [
      { guard: 'SlotClaimIsExclusive', property: 'OneRunPerSlot', shape: twoEnginesRunOneSlot },
      { guard: 'LateFinishIsRefused', property: 'OneRunPerSlot', shape: lapsedRunFinishesTakenSlot },
      { guard: 'PauseIsChecked', property: 'PausedRoutineStartsNoRun', shape: claimOnPausedRoutine },
      { guard: 'CatchUpCollapses', property: 'MissedSlotsCollapse', shape: runForMissedSlot },
      { guard: 'TaskKeyIsUnique', property: 'OneTaskPerTicket', shape: bothRoutinesRecordOneTicket },
      { guard: 'RecordKeepsOwner', property: 'OneTaskPerTicket', shape: routineTakesOverTicket },
      { guard: 'RunLeaseExpires', property: 'DueSlotsRun', shape: crashedRunHoldsItsSlot },
      { guard: 'RunRefreshesAssignee', property: 'AssigneeFollowsTicket', shape: outdatedTaskStaysOutdated },
      { guard: 'RunNowIsKeyed', property: 'RunNowRunsOnce', shape: twoPressesBeforeARun },
      { guard: 'SchedulerIsFair', property: 'DueSlotsRun', shape: schedulerStopsWithDueSlot },
    ],
  }),
];
