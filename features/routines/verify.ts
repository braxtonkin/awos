import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import { runLoop, type Clock } from '../../shared/loop.ts';
import type { Workflow } from '../../shared/workflow.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { defineModel, type Shape } from '../../tools/verify/models.ts';
import { withPostgres, type TestPostgres } from '../../tools/verify/postgres.ts';
import { lastRealState, type TlcRun, type TraceState } from '../../tools/verify/tlc.ts';
import { provePlants } from './invariants.ts';
import { scheduleSource } from './schedule-source.ts';
import { scheduler } from './scheduler.ts';
import { mutantName, mutants, post, profileName, profiles, simulate, type MutantName, type ProfileName, type Run } from './simulate.ts';
import { sourcesByKind } from './source.ts';

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

const flags = {
  profile: { type: 'string' },
  seeds: { type: 'string' },
  from: { type: 'string' },
  seed: { type: 'string' },
  steps: { type: 'string' },
  mutant: { type: 'string' },
  trace: { type: 'string' },
} as const;

const options = z.object({
  profile: z.union([profileName, z.literal('all')]).default('default'),
  seeds: z.coerce.number().int().positive().default(20),
  from: z.coerce.number().int().nonnegative().default(1),
  seed: z.coerce.number().int().nonnegative().optional(),
  steps: z.coerce.number().int().positive().default(300),
  mutant: z.union([mutantName, z.literal('all')]).optional(),
  trace: z.string().optional(),
});

type Options = z.infer<typeof options>;

function parseOptions(args: readonly string[]): Options {
  const parsed = options.safeParse(parseArgs({ args: [...args], options: flags, strict: true, allowPositionals: false }).values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

const seedsOf = (given: Options): readonly number[] => (given.seed === undefined ? Array.from({ length: given.seeds }, (_, index) => given.from + index) : [given.seed]);

const replay = (run: Run): string =>
  `npm run verify -- routines-sim --profile ${run.plan.profile}${run.plan.mutant === undefined ? '' : ` --mutant ${run.plan.mutant}`} --seed ${String(run.seed)} --steps ${String(run.plan.steps)}`;

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

const total = (runs: readonly Run[], outcome: string): number => runs.reduce((sum, run) => sum + (run.tally[outcome] ?? 0), 0);

const sum = (runs: readonly Run[], value: (run: Run) => number): number => runs.reduce((all, run) => all + value(run), 0);

const expect = (name: string, holds: boolean, detail: string): Check => (holds ? pass(name, detail) : fail(name, detail));

function profileSpecific(profile: ProfileName, runs: readonly Run[]): readonly Check[] {
  const outcome = (name: string): number => sum(runs, run => run.summary.outcomes[name] ?? 0);
  switch (profile) {
    case 'default':
      return [expect('default: every seed recorded tasks', runs.every(run => run.summary.tasks > 0), `${String(sum(runs, run => run.summary.tasks))} tasks, ${String(sum(runs, run => run.summary.runs))} runs`)];
    case 'two-engines':
      return [
        expect(
          'two-engines: every slot has exactly one run',
          sum(runs, run => run.summary.slots) > 0 && total(runs, 'passed during another run') > 0,
          `${String(sum(runs, run => run.summary.slots))} slots run once each with no OneRunPerSlot violation, and the second engine passed ${String(total(runs, 'passed during another run'))} times while a run was in flight`,
        ),
      ];
    case 'downtime': {
      const catchUps = runs.flatMap(run => run.summary.catchUps);
      const widest = Math.max(0, ...catchUps);
      return [
        expect(
          `downtime: one catch-up run covers the ${String(profiles.downtime.downtimeSlots)} missed slots, and expired runs of collapsed slots close as lost`,
          widest >= profiles.downtime.downtimeSlots && total(runs, 'downtime') > 0 && outcome('lost') > 0,
          `${String(total(runs, 'downtime'))} downtimes, ${String(catchUps.length)} catch-up runs covering up to ${String(widest)} slots, ${String(outcome('lost'))} runs closed as lost`,
        ),
      ];
    }
    case 'pause': {
      const refused = total(runs, 'press refused: Resume to run.');
      return [
        expect(
          'pause: a run in flight when its routine paused records nothing, Run now on a paused routine is refused with "Resume to run.", and runs resume after the routine resumes',
          outcome('paused') > 0 && refused > 0 && total(runs, 'resume resumed') > 0 && outcome('done') > 0,
          `${String(outcome('paused'))} runs recorded nothing after a pause, ${String(refused)} presses refused, ${String(total(runs, 'resume resumed'))} resumes, ${String(outcome('done'))} runs done`,
        ),
      ];
    }
    case 'hangs':
      return [
        expect(
          'hangs: runs whose lease lapsed recorded nothing, and their slots ran again or closed as lost',
          total(runs, 'lapsed') > 0 && runs.some(run => run.engineLog.some(line => line.includes('recorded nothing, because'))),
          `${String(total(runs, 'lapsed'))} lapsed leases, ${String(sum(runs, run => run.engineLog.filter(line => line.includes('recorded nothing, because')).length))} refused records, ${String(outcome('lost'))} runs lost`,
        ),
      ];
    case 'run-now':
      return [
        expect(
          'run-now: a second press before the run starts claims nothing more',
          total(runs, 'press already-waiting') > 0 && sum(runs, run => run.summary.pressRuns) > 0,
          `${String(total(runs, 'press pressed'))} presses waited, ${String(total(runs, 'press already-waiting'))} more pressed while one waited, ${String(sum(runs, run => run.summary.pressRuns))} Run now runs finished`,
        ),
      ];
    case 'shared-key':
      return [
        expect(
          'shared-key: one task per shared ticket, owned by the routine that found it first, and both routines record the overlap',
          sum(runs, run => run.summary.overlaps) > 0,
          `${String(sum(runs, run => run.summary.overlaps))} overlaps recorded, ${String(sum(runs, run => run.summary.tasks))} tasks`,
        ),
      ];
    case 'assignee':
      return [
        expect(
          "assignee: each task's assignee follows its ticket after its routine's next run",
          total(runs, 'reassigned') > 0 && sum(runs, run => run.summary.tasks) > 0,
          `${String(total(runs, 'reassigned'))} reassignments with no AssigneeFollowsTicket violation`,
        ),
      ];
  }
}

async function profileChecks(postgres: TestPostgres, profile: ProfileName, given: Options): Promise<readonly Check[]> {
  const started = performance.now();
  const runs = await simulate(postgres, [{ profile, seeds: seedsOf(given), steps: given.steps }], traceWriter(given.trace));
  const seconds = (performance.now() - started) / 1000;
  const failed = runs.filter(run => run.failure !== undefined);
  const [first] = failed;
  const steps = sum(runs, run => run.steps);
  const name = `${profile}: ${String(runs.length)} seeds, ${String(failed.length)} violations`;
  const detail = `${String(given.steps)} steps each plus a quiet phase, ${String(steps)} steps in ${seconds.toFixed(1)} s, ${String(sum(runs, run => run.summary.runs))} runs, ${String(sum(runs, run => run.summary.tasks))} tasks`;
  return [first === undefined ? pass(name, detail) : fail(name, violation(first)), ...profileSpecific(profile, runs)];
}

async function mutantCheck(postgres: TestPostgres, name: MutantName, given: Options): Promise<Check> {
  const mutant = mutants[name];
  const profile = given.profile === 'all' || given.profile === 'default' ? mutant.profile : given.profile;
  const runs = await simulate(postgres, [{ profile, seeds: seedsOf(given), steps: given.steps, mutant: name }], traceWriter(given.trace));
  const caught = runs.find(run => run.failure?.broken.some(found => found.property === mutant.breaks) === true);
  const label = `without ${name} (${mutant.guard}), ${mutant.breaks} is violated`;
  if (caught !== undefined) return pass(label, violation(caught));
  const other = runs.find(run => run.failure !== undefined);
  return fail(label, `${String(runs.length)} ${profile} seeds, none broke ${mutant.breaks}${other === undefined ? '' : `; first other failure: ${violation(other)}`}`);
}

async function plantChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  return (await provePlants(postgres)).map(proof => {
    const name = `plant ${String(proof.plant)} of ${proof.property} is reported`;
    return proof.atStart.length === 0 && proof.reported.includes(proof.property)
      ? pass(name, `reported ${proof.reported.join(', ')}`)
      : fail(name, `before the plant: ${proof.atStart.join(', ') || 'nothing'}; after: ${proof.reported.join(', ') || 'nothing'}`);
  });
}

async function simulationChecks(postgres: TestPostgres, given: Options): Promise<readonly Check[]> {
  if (given.mutant !== undefined) {
    const names = given.mutant === 'all' ? mutantName.options : [given.mutant];
    const checks: Check[] = [];
    for (const name of names) checks.push(await mutantCheck(postgres, name, given));
    return checks;
  }
  const chosen = given.profile === 'all' ? profileName.options : [given.profile];
  const checks: Check[] = [...(await plantChecks(postgres))];
  for (const profile of chosen) checks.push(...(await profileChecks(postgres, profile, given)));
  return checks;
}

const engineMain = fileURLToPath(new URL('../../services/engine/main.ts', import.meta.url));

type World = { readonly person: string; readonly repository: string };

async function seedWorld(db: Database): Promise<World> {
  const person = await db.insertInto('person').values({ email: 'ada@example.com', name: 'Ada' }).returning('id').executeTakeFirstOrThrow();
  const repository = await db.transaction().execute(async tx => {
    const saved = randomUUID();
    const row = await tx.insertInto('repository').values({ github: 'example/sandbox', branch: 'main', saved_by: saved }).returning('id').executeTakeFirstOrThrow();
    await tx.insertInto('human_action').values({ id: saved, at: new Date(), person_id: person.id, kind: 'add_repository', repository_id: row.id }).execute();
    return row.id;
  });
  return { person: person.id, repository };
}

async function seedRoutine(db: Database, world: World, name: string, source: string, workflow: Workflow | 'code-change'): Promise<string> {
  const routine = await db.insertInto('routine').values({ creator_id: world.person }).returning('id').executeTakeFirstOrThrow();
  const action = randomUUID();
  await db.insertInto('human_action').values({ id: action, at: new Date(), person_id: world.person, kind: 'edit_routine', routine_id: routine.id }).execute();
  await db
    .insertInto('routine_version')
    .values({
      routine_id: routine.id,
      version: 1,
      name,
      goal: 'Record one task per run.',
      every: '1 minute',
      repository_id: workflow === 'code-change' ? world.repository : null,
      action_id: action,
      workflow: workflow === 'code-change' ? workflow : workflow.name,
      source: JSON.stringify({ kind: source }),
      needs_repository: workflow === 'code-change',
    })
    .execute();
  return routine.id;
}

async function engineChecks(postgres: TestPostgres, minutes: number): Promise<readonly Check[]> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  try {
    const world = await seedWorld(db);
    const scheduled = await seedRoutine(db, world, 'Scheduled', 'schedule', 'code-change');
    const failing = await seedRoutine(db, world, 'Failing', 'jira-search', 'code-change');
    const child = spawn(process.execPath, [engineMain], { env: { ...process.env, DATABASE_URL: scratch.stableUrl, SCHEDULER_EVERY_MS: '5000' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let said = '';
    const hear = (chunk: string): void => {
      said += chunk;
    };
    child.stdout.setEncoding('utf8').on('data', hear);
    child.stderr.setEncoding('utf8').on('data', hear);
    const exited = new Promise<number | null>(resolve => child.on('exit', resolve));
    await wait(minutes * 60_000);
    const stopping = performance.now();
    child.kill('SIGTERM');
    const status = await Promise.race([exited, wait(60_000).then(() => 'hung' as const)]);
    const stoppedMs = performance.now() - stopping;
    if (status === 'hung') child.kill('SIGKILL');
    const tasks = await db.selectFrom('task').select(['key', 'routine_id']).orderBy('id').execute();
    const runs = await db.selectFrom('routine_run').select(['id', 'routine_id', 'outcome', 'note']).orderBy('id').execute();
    const keyed = tasks.filter(task => task.routine_id === scheduled && task.key.startsWith(`${scheduled}/`));
    const failures = runs.filter(run => run.routine_id === failing);
    const heard = said.trim().split('\n').filter(line => line.includes('scheduler') || line.includes('engine')).slice(-4).join(' | ');
    return [
      expect(
        `the routine on the schedule source records a task keyed <routine>/<occurrence> for each run over ${String(minutes)} minutes`,
        keyed.length >= minutes && keyed.length === tasks.length,
        `${String(keyed.length)} tasks: ${tasks.map(task => task.key).join(', ')}`,
      ),
      expect(
        'each run of the routine whose source fails records the failure with a note',
        failures.length >= minutes && failures.every(run => run.outcome === 'failed' && (run.note ?? '').length > 0),
        failures.map(run => `run ${run.id} ${run.outcome ?? 'unfinished'}: ${run.note ?? ''}`).join('; '),
      ),
      expect('the engine exits 0 within one interval of SIGTERM', status === 0 && stoppedMs < 60_000, `exit ${String(status)} after ${stoppedMs.toFixed(0)} ms; ${heard}`),
    ];
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

type SteppedClock = Clock & { readonly advance: (ms: number) => void };

function steppedClock(start: number): SteppedClock {
  let now = start;
  return {
    now: () => new Date(now),
    sleep: () => Promise.resolve(),
    advance: ms => {
      now += ms;
    },
  };
}

const perfEveryMs = 10_000;

const perfScheduler = (clock: Clock) =>
  scheduler({ everyMs: perfEveryMs, leaseMs: 60_000, sources: sourcesByKind([scheduleSource]), workflows: new Map([[post.name, post]]), now: () => Promise.resolve(clock.now()) });

async function timedPass(postgres: TestPostgres, routines: number): Promise<number> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  try {
    const world = await seedWorld(db);
    for (let made = 0; made < routines; made += 1) await seedRoutine(db, world, `Routine ${String(made)}`, 'schedule', post);
    const clock = steppedClock(Date.parse('2026-01-01T00:00:05.000Z'));
    const started = performance.now();
    await perfScheduler(clock).pass(db, { now: clock.now(), late: () => false });
    return performance.now() - started;
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

async function claimDelay(postgres: TestPostgres): Promise<{ readonly runs: number; readonly slowestMs: number; readonly passes: number }> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  try {
    await seedRoutine(db, await seedWorld(db), 'Looped', 'schedule', post);
    const clock = steppedClock(Date.parse('2026-01-01T00:00:03.000Z'));
    const stop = new AbortController();
    const loop = perfScheduler(clock);
    let passes = 0;
    const stepping = {
      ...loop,
      pass: async (given: Database, pass: Parameters<typeof loop.pass>[1]) => {
        const lines = await loop.pass(given, pass);
        passes += 1;
        clock.advance(perfEveryMs);
        if (passes >= 30) stop.abort();
        return lines;
      },
    };
    await runLoop(stepping, db, clock, stop.signal, () => undefined);
    const { rows } = await sql<{ runs: number; slowest: number }>`select count(*)::int as runs, max(extract(epoch from claimed_at - slot) * 1000)::float8 as slowest from routine_run`.execute(db);
    return { runs: rows[0]?.runs ?? 0, slowestMs: rows[0]?.slowest ?? Number.POSITIVE_INFINITY, passes };
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

async function perfChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  const hundreds: number[] = [];
  const singles: number[] = [];
  for (let round = 0; round < 5; round += 1) {
    hundreds.push(await timedPass(postgres, 100));
    singles.push(await timedPass(postgres, 1));
  }
  const delay = await claimDelay(postgres);
  const show = (list: readonly number[]): string => list.map(ms => `${ms.toFixed(1)} ms`).join(', ');
  return [
    expect('one scheduler pass over 100 routines takes at most 1 s', Math.max(...hundreds) <= 1000, `100 routines: ${show(hundreds)}; 1 routine: ${show(singles)}`),
    expect(
      'each slot is claimed within one loop interval plus 10% of its start',
      delay.runs >= 5 && delay.slowestMs <= perfEveryMs * 1.1,
      `${String(delay.runs)} slots over ${String(delay.passes)} passes, slowest claim ${delay.slowestMs.toFixed(0)} ms after its slot began, against an interval of ${String(perfEveryMs)} ms`,
    ),
  ];
}

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
  {
    name: 'routines-sim',
    summary: 'runs seeded engines that claim routine slots, search, record tasks, crash, hang, and race pauses and Run now against real Postgres, and checks every Schedule.tla property after each step',
    run: args => {
      const given = parseOptions(args);
      return withPostgres(postgres => simulationChecks(postgres, given));
    },
    nightly: day => profileName.options.map(profile => ['--profile', profile, '--seeds', '200', '--steps', '300', '--from', String(day * 1000), '--trace', 'traces/routines-sim']),
  },
  {
    name: 'routines-engine',
    summary: 'runs the real engine for 3 minutes with one routine on the schedule source and one whose source fails, each on a one-minute interval, then stops it with SIGTERM',
    run: () => withPostgres(postgres => engineChecks(postgres, 3)),
  },
  {
    name: 'routines-perf',
    summary: 'times 5 scheduler passes over 100 routines interleaved with 5 over one routine, and the delay from each slot starting to its claim under the real loop',
    run: () => withPostgres(perfChecks),
  },
];
