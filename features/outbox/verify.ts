import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { defineModel, type Shape } from '../../tools/verify/models.ts';
import { withPostgres, type TestPostgres } from '../../tools/verify/postgres.ts';
import type { TlcRun } from '../../tools/verify/tlc.ts';
import { provePlants } from './invariants.ts';
import {
  checkCatalog,
  mutantName,
  mutants,
  probeDeadline,
  probeReviewThroughFailure,
  probeRollback,
  probeThroughput,
  profileName,
  simulate,
  type MutantName,
  type Plan,
  type ProfileName,
  type Run,
  type Throughput,
} from './simulate.ts';

type TaskView = { readonly id: string; readonly state: string; readonly review: string };

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
  const reviews = entries('review');
  const effects = entries('effects');
  const rows = [...entries('row')].map(([id, record]): RowView => {
    const fields = fieldsIn(record);
    const [, task = '', index = ''] = /^<<(\w+),(\d+)>>$/.exec(id) ?? [];
    return {
      id,
      task: { id: task, state: tasks.get(task) ?? '', review: reviews.get(task) ?? '' },
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

const reviewLostToAFailedRow = shape(
  'by a failed row that parks its task over the review a person has not decided',
  ({ actions, last }) => !actions.includes('Approve') && actions.at(-1) === 'Expire' && last.rows.some(row => row.state === 'failed' && row.task.state === 'waiting' && row.task.review === 'open'),
);

const performerOnAnotherClockPostsAgain = shape(
  'by a performer whose lease another engine judged over by its own clock posting after the next claim',
  ({ actions, last }) =>
    !actions.includes('Crash') && !actions.includes('Hang') && inOrder(actions, ['Claim', 'Expire', 'Claim']) && actions.at(-1) === 'Call' && last.rows.some(row => postedTwice(row) && performersOn(last, row).length === 2),
);

const requestSettlesAfterItsLease = shape(
  "by a failed call's request landing after its lease ran out and another performer posted",
  ({ actions, last }) => !actions.includes('Crash') && !actions.includes('Hang') && inOrder(actions, ['Call', 'Expire', 'Claim', 'Call']) && actions.at(-1) === 'Resolve' && last.rows.some(postedTwice),
);

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
  profile: z.union([profileName, z.literal('all')]).default('mixed'),
  seeds: z.coerce.number().int().positive().default(20),
  from: z.coerce.number().int().nonnegative().default(1),
  seed: z.coerce.number().int().nonnegative().optional(),
  steps: z.coerce.number().int().positive().default(300),
  mutant: z.union([mutantName, z.literal('all')]).optional(),
  trace: z.string().optional(),
});

type SimulationOptions = z.infer<typeof simulationOptions>;

function parseSimulationOptions(args: readonly string[]): SimulationOptions {
  const parsed = simulationOptions.safeParse(parseArgs({ args: [...args], options: simulationFlags, strict: true, allowPositionals: false }).values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

const seedsOf = (options: SimulationOptions): readonly number[] =>
  options.seed === undefined ? Array.from({ length: options.seeds }, (_, index) => options.from + index) : [options.seed];

const replay = (run: Run): string =>
  `npm run verify -- outbox-sim ${run.plan.mutant === undefined ? `--profile ${run.plan.profile}` : `--mutant ${run.plan.mutant}`} --seed ${String(run.seed)} --steps ${String(run.plan.steps)}`;

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

const sum = (runs: readonly Run[], of: (run: Run) => number): number => runs.reduce((total, run) => total + of(run), 0);

function tallyOf(runs: readonly Run[]): string {
  const tally = new Map<string, number>();
  for (const [outcome, times] of runs.flatMap(run => Object.entries(run.tally))) tally.set(outcome, (tally.get(outcome) ?? 0) + times);
  return [...tally]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([outcome, times]) => `${outcome} ${String(times)}`)
    .join(', ');
}

function alwaysFailsChecks(runs: readonly Run[]): readonly Check[] {
  const failed = runs.flatMap(run => run.failedRows.map(row => ({ seed: run.seed, ...row })));
  const wrong = failed.filter(row => row.tries !== 3 || row.taskState !== 'waiting' || !row.noteHasError);
  const capName = "always-fails: each failed row counted 3 lapsed leases, and its task waits with the row's last error in its note";
  const reowed = sum(runs, run => run.reowed);
  const reoweName = 'always-fails: Retry owed the failed rows again with their tries reset';
  const described = wrong
    .slice(0, 3)
    .map(row => `seed ${String(row.seed)} row ${row.row}: ${String(row.tries)} tries, task ${row.taskState}, note ${row.noteHasError ? 'has' : 'lacks'} the error`)
    .join('; ');
  return [
    failed.length > 0 && wrong.length === 0 ? pass(capName, `${String(failed.length)} failed rows across ${String(runs.length)} seeds`) : fail(capName, failed.length === 0 ? 'no row failed' : described),
    reowed > 0 ? pass(reoweName, `${String(reowed)} rows lapsed at try 1 again after a Retry`) : fail(reoweName, 'no failed row was tried again after a Retry'),
  ];
}

function doneChecks(profile: ProfileName, runs: readonly Run[]): Check {
  const name = `${profile}: every seed took a task to done`;
  const done = runs.map(run => run.done);
  const idle = runs.filter(run => run.done === 0).map(run => run.seed);
  return idle.length === 0 ? pass(name, `${String(Math.min(...done))} to ${String(Math.max(...done))} tasks done per seed`) : fail(name, `seeds with no task done: ${idle.slice(0, 10).join(', ')}`);
}

const finishingProfiles: ReadonlySet<ProfileName> = new Set<ProfileName>(['mixed', 'two-engines', 'skewed']);

async function profileChecks(postgres: TestPostgres, profile: ProfileName, options: SimulationOptions): Promise<readonly Check[]> {
  const started = performance.now();
  const runs = await simulate(postgres, [{ profile, seeds: seedsOf(options), steps: options.steps }], traceWriter(options.trace));
  const seconds = (performance.now() - started) / 1000;
  const failed = runs.filter(run => run.failure !== undefined);
  const duplicates = sum(runs, run => run.duplicates);
  const [first] = failed;
  const name = `${profile}: ${String(runs.length)} seeds, ${String(failed.length)} violations`;
  const detail = `${String(options.steps)} steps each plus a quiet phase, in ${seconds.toFixed(1)} s; ${tallyOf(runs)}`;
  const duplicateName = `${profile}: duplicate effects ${String(duplicates)}`;
  return [
    first === undefined ? pass(name, detail) : fail(name, violation(first)),
    duplicates === 0 ? pass(duplicateName, 'no marker took effect twice on either target') : fail(duplicateName, 'a marker took effect twice'),
    ...(profile === 'always-fails' ? alwaysFailsChecks(runs) : []),
    ...(finishingProfiles.has(profile) ? [doneChecks(profile, runs)] : []),
  ];
}

async function mutantCheck(postgres: TestPostgres, mutant: MutantName, options: SimulationOptions): Promise<Check> {
  const { guard, breaks, profile } = mutants[mutant];
  const plan: Plan = { profile, seeds: seedsOf(options), steps: options.steps, mutant };
  const runs = await simulate(postgres, [plan], traceWriter(options.trace));
  const caught = runs.find(run => run.failure?.broken.some(found => breaks.includes(found.property)) === true);
  const name = `without ${guard} (${mutant}): ${breaks.join(' or ')} violated`;
  return caught === undefined ? fail(name, `no seed of ${String(runs.length)} broke ${breaks.join(' or ')}`) : pass(name, violation(caught));
}

async function plantChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  const proofs = await provePlants(postgres);
  return proofs.map(proof => {
    const name = `plant ${String(proof.plant)} of ${proof.property} is reported`;
    return proof.atStart.length === 0 && proof.reported.includes(proof.property)
      ? pass(name, `reported ${proof.reported.join(', ')}`)
      : fail(name, `before the plant ${proof.atStart.join(', ') || 'nothing'}, after it ${proof.reported.join(', ') || 'nothing'}`);
  });
}

async function catalogCheck(postgres: TestPostgres): Promise<Check> {
  const catalog = await checkCatalog(postgres);
  const name = 'every named constraint, index, and trigger on outbox has a mutant or a reason it has none';
  return catalog.unlisted.length === 0 && catalog.absent.length === 0
    ? pass(name, `${String(catalog.guards)} named guards`)
    : fail(name, `unlisted: ${catalog.unlisted.join(', ') || 'none'}; listed but absent: ${catalog.absent.join(', ') || 'none'}`);
}

async function rollbackCheck(postgres: TestPostgres): Promise<Check> {
  const { rows, effects } = await probeRollback(postgres);
  const name = 'an enqueue in a transaction that rolls back leaves no row and no effect';
  return rows === 0 && effects === 0 ? pass(name, 'no row, and the pass after it performed nothing') : fail(name, `${String(rows)} rows, ${String(effects)} effects`);
}

async function reviewCheck(postgres: TestPostgres): Promise<Check> {
  const problems = await probeReviewThroughFailure(postgres);
  const name = 'a Jira comment that fails while specify waits for approval keeps the review, Retry reruns nothing, and Approve posts the comment once';
  return problems.length === 0 ? pass(name, 'the review and its note outlived the failure, and specify ran once') : fail(name, problems.join('; '));
}

const shortLease = { leaseMs: 1_000, marginMs: 400, maxTries: 3 };

async function deadlineCheck(postgres: TestPostgres): Promise<Check> {
  const waitMs = 4_000;
  const { settledMs, claimed, error } = await probeDeadline(postgres, shortLease, waitMs);
  const name = `a performer that never answers and ignores its signal lets the pass go by the ${String(shortLease.leaseMs - shortLease.marginMs)} ms deadline, and its row keeps the claim and the error`;
  if (settledMs === undefined) return fail(name, `the pass still waited on the call ${String(waitMs)} ms later`);
  return settledMs <= shortLease.leaseMs && claimed && error !== null
    ? pass(name, `the pass ended after ${settledMs.toFixed(0)} ms with the error: ${error}`)
    : fail(name, `the pass ended after ${settledMs.toFixed(0)} ms, the row is ${claimed ? 'still' : 'no longer'} claimed, and its error is ${error ?? 'empty'}`);
}

async function simulationChecks(postgres: TestPostgres, options: SimulationOptions): Promise<readonly Check[]> {
  if (options.mutant === 'all') {
    const checks: Check[] = [...(await plantChecks(postgres)), await catalogCheck(postgres)];
    for (const mutant of mutantName.options) checks.push(await mutantCheck(postgres, mutant, options));
    return checks;
  }
  if (options.mutant !== undefined) return [await mutantCheck(postgres, options.mutant, options)];
  const chosen = options.profile === 'all' ? profileName.options : [options.profile];
  const checks: Check[] = [await rollbackCheck(postgres), await reviewCheck(postgres), await deadlineCheck(postgres)];
  for (const profile of chosen) checks.push(...(await profileChecks(postgres, profile, options)));
  return checks;
}

const perfEveryMs = 1_000;

const listed = (values: readonly number[], unit: string): string => values.map(value => `${value.toFixed(0)} ${unit}`).join(', ');

async function perfChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  const probes = await probeThroughput(postgres, perfEveryMs);
  const batches = probes.filter(probe => probe.kind === 'batch');
  const singles = probes.filter(probe => probe.kind === 'single');
  const slowest = Math.min(...batches.map(probe => probe.perSecond));
  const medians = singles.map(probe => probe.medianMs);
  const median = [...medians].sort((a, b) => a - b)[Math.floor(medians.length / 2)] ?? Number.POSITIVE_INFINITY;
  const rateName = 'one engine performs at least 50 rows per second';
  const latencyName = `the median time from the owing commit to a single row's effect is at most ${String(perfEveryMs + 100)} ms`;
  const rates = (list: readonly Throughput[]): string => listed(list.map(probe => probe.perSecond), 'rows/s');
  return [
    slowest >= 50 ? pass(rateName, `500 rows across 50 tasks, 3 times: ${rates(batches)}; batch medians ${listed(batches.map(probe => probe.medianMs), 'ms')}`) : fail(rateName, rates(batches)),
    median <= perfEveryMs + 100 ? pass(latencyName, `single rows: ${listed(medians, 'ms')}`) : fail(latencyName, `single rows: ${listed(medians, 'ms')}`),
  ];
}

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
      'FailureKeepsReview',
      'RetryReowesFailedRows',
      'LeasesOnOneClock',
      'TargetSettlesWithinMargin',
      'PerformerIsFair',
    ],
    properties: {
      EffectAtMostOnce: 'INVARIANTS',
      DoneMeansEffect: 'INVARIANTS',
      NoEffectWithoutOwingState: 'INVARIANTS',
      ActionsInOrderPerTask: 'INVARIANTS',
      NextStageWaitsForOwedActions: 'INVARIANTS',
      OneLivePerformerPerRow: 'INVARIANTS',
      ReviewKeptUntilDecided: 'INVARIANTS',
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
      { guard: 'FailureKeepsReview', property: 'ReviewKeptUntilDecided', shape: reviewLostToAFailedRow },
      { guard: 'RetryReowesFailedRows', property: 'NextStageWaitsForOwedActions', shape: nextStageClaimedOverFailedRow },
      { guard: 'LeasesOnOneClock', property: 'EffectAtMostOnce', shape: performerOnAnotherClockPostsAgain },
      { guard: 'TargetSettlesWithinMargin', property: 'EffectAtMostOnce', shape: requestSettlesAfterItsLease },
      { guard: 'ClaimWaitsForOwedActions', property: 'NextStageWaitsForOwedActions', shape: nextStageClaimedWhileOwing },
      { guard: 'DoneFollowsEffect', property: 'DoneMeansEffect', shape: rowMarkedDoneBeforeEffect },
      { guard: 'PerformerIsFair', property: 'EveryOwedActionSettles', overrides: { MaxCrashes: '0', MaxStalls: '0', MaxRetries: '0' }, shape: performersStopTakingOwedRows },
    ],
  }),
  {
    name: 'outbox-sim',
    summary: "runs seeded performers that claim, crash, stall, and fail against real Postgres, and checks each of Outbox.tla's properties by name after every step",
    run: args => {
      const options = parseSimulationOptions(args);
      return withPostgres(postgres => simulationChecks(postgres, options));
    },
  },
  {
    name: 'outbox-perf',
    summary: 'owes 500 rows across 50 tasks 3 times, interleaved with 3 single rows, and times one engine performing them against a target that answers at once',
    run: () => withPostgres(perfChecks),
  },
];
