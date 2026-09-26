import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { catalogProblems } from '../../tools/verify/catalog.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { defineModel, type Shape } from '../../tools/verify/models.ts';
import { withPostgres, type TestPostgres } from '../../tools/verify/postgres.ts';
import { checkCatalog } from './catalog.ts';
import { provePlants } from './invariants.ts';
import { mutantName, mutants, profileName, simulate, type MutantName, type ProfileName, type Run } from './simulate.ts';
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
  profile: z.union([profileName, z.literal('all')]).default('all'),
  seeds: z.coerce.number().int().positive().default(20),
  from: z.coerce.number().int().nonnegative().default(1),
  seed: z.coerce.number().int().nonnegative().optional(),
  steps: z.coerce.number().int().positive().default(200),
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
  `npm run verify -- requests-sim --profile ${run.plan.profile}${run.plan.mutant === undefined ? '' : ` --mutant ${run.plan.mutant}`} --seed ${String(run.seed)} --steps ${String(run.plan.steps)}`;

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

const failedApplies = (runs: readonly Run[]): number => sum(runs, run => run.engineLog.filter(line => line.includes('AutoWorker could not apply the request')).length);

function profileSpecific(profile: ProfileName, runs: readonly Run[]): readonly Check[] {
  const recorded = sum(runs, run => run.summary.recorded);
  const refused = sum(runs, run => run.summary.refused);
  switch (profile) {
    case 'default':
      return [
        expect(
          'default: every seed recorded requests, a repeat reused its row, and a repeat with other details was refused',
          runs.every(run => run.summary.recorded > 0) && total(runs, 'repeat reused the row') > 0 && total(runs, 'mismatch refused') > 0 && total(runs, 'mismatch accepted') === 0,
          `${String(recorded)} recorded, ${String(refused)} refused, ${String(total(runs, 'repeat reused the row'))} repeats reused their row, ${String(total(runs, 'mismatch refused'))} mismatched repeats refused, ${String(total(runs, 'mismatch accepted'))} accepted`,
        ),
      ];
    case 'two-engines':
      return [
        expect(
          "two-engines: the second engine passed while the first held a request, and no request was applied twice or out of order",
          total(runs, 'passed during a handler') > 0 && recorded > 0,
          `${String(total(runs, 'passed during a handler'))} passes during another engine's handler, ${String(recorded)} recorded, ${String(sum(runs, run => run.summary.handlerRuns))} handler runs kept`,
        ),
      ];
    case 'crashes':
      return [
        expect(
          'crashes: engines crashed inside a request, and each request was applied once after a restart',
          total(runs, 'crashed') > 0 && runs.every(run => run.summary.open === 0),
          `${String(total(runs, 'crashed'))} crashes, ${String(recorded)} recorded, ${String(sum(runs, run => run.summary.open))} left open`,
        ),
      ];
    case 'failures':
      return [
        expect(
          'failures: a request whose handler threw was refused, and a stale refusal changed no answer',
          failedApplies(runs) > 0 && total(runs, 'late refusal changed nothing') > 0 && total(runs, 'late refusal overwrote an answer') === 0,
          `${String(failedApplies(runs))} failed applies refused, ${String(total(runs, 'late refusal changed nothing'))} stale refusals changed nothing`,
        ),
      ];
    case 'races':
      return [
        expect(
          'races: a request inserted while another held its place waited for it to commit, then took the next place',
          total(runs, 'race blocked') > 0 && total(runs, 'race settled') === 0,
          `${String(total(runs, 'race blocked'))} races waited, ${String(total(runs, 'race settled'))} committed ahead`,
        ),
      ];
  }
}

async function replayCheck(postgres: TestPostgres, profile: ProfileName, given: Options, runs: readonly Run[]): Promise<Check> {
  const [first] = runs;
  if (first === undefined) return fail(`${profile}: a seed replays exactly`, 'no seed ran');
  const [again] = await simulate(postgres, [{ profile, seeds: [first.seed], steps: given.steps }]);
  const name = `${profile}: seed ${String(first.seed)} replays exactly, with the same moves, engine lines, and tallies`;
  return again?.digest === first.digest ? pass(name, `digest ${first.digest} both times`) : fail(name, `digest ${first.digest}, then ${again?.digest ?? 'no run'}`);
}

async function profileChecks(postgres: TestPostgres, profile: ProfileName, given: Options): Promise<readonly Check[]> {
  const started = performance.now();
  const runs = await simulate(postgres, [{ profile, seeds: seedsOf(given), steps: given.steps }], traceWriter(given.trace));
  const seconds = (performance.now() - started) / 1000;
  const failed = runs.filter(run => run.failure !== undefined);
  const [first] = failed;
  const name = `${profile}: ${String(runs.length)} seeds, ${String(failed.length)} violations`;
  const detail = `${String(given.steps)} steps each plus a quiet phase, ${String(sum(runs, run => run.steps))} steps in ${seconds.toFixed(1)} s, ${String(sum(runs, run => run.summary.requests))} requests`;
  return [first === undefined ? pass(name, detail) : fail(name, violation(first)), ...profileSpecific(profile, runs), await replayCheck(postgres, profile, given, runs)];
}

async function mutantCheck(postgres: TestPostgres, name: MutantName, given: Options): Promise<Check> {
  const mutant = mutants[name];
  const profile = given.profile === 'all' ? mutant.profile : given.profile;
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

async function catalogCheck(postgres: TestPostgres): Promise<Check> {
  const audit = await checkCatalog(postgres);
  const problems = catalogProblems(audit);
  const name = 'every named constraint, index, and trigger on person_request has a mutant or a reason in noMutantYet';
  return problems.length === 0 ? pass(name, audit.guards.join(', ')) : fail(name, problems.join('; '));
}

async function simulationChecks(postgres: TestPostgres, given: Options): Promise<readonly Check[]> {
  if (given.mutant !== undefined) {
    const names = given.mutant === 'all' ? mutantName.options : [given.mutant];
    const checks: Check[] = given.mutant === 'all' ? [await catalogCheck(postgres)] : [];
    for (const name of names) checks.push(await mutantCheck(postgres, name, given));
    return checks;
  }
  const chosen = given.profile === 'all' ? profileName.options : [given.profile];
  const checks: Check[] = [...(await plantChecks(postgres))];
  for (const profile of chosen) checks.push(...(await profileChecks(postgres, profile, given)));
  return checks;
}

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
  {
    name: 'requests-sim',
    summary:
      'runs seeded engines that apply person requests, crash inside them, race inserts for a place in line, repeat and mismatch ids, and refuse late, against real Postgres, and checks every Requests.tla property after each step',
    run: args => {
      const given = parseOptions(args);
      return withPostgres(postgres => simulationChecks(postgres, given));
    },
    nightly: day => profileName.options.map(profile => ['--profile', profile, '--seeds', '100', '--steps', '300', '--from', String(day * 1000), '--trace', 'traces/requests-sim']),
  },
];
