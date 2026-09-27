import { isDeepStrictEqual, parseArgs } from 'node:util';
import { z } from 'zod';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { schemaChecks } from './catalog.ts';
import { failedChecksReader } from './checks.ts';
import { githubClient } from './client.ts';
import { liveScenario } from './live.ts';
import { mutantName, mutants, simulate, type MutantName, type Run } from './simulate.ts';

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

const failedAt = 'f'.repeat(40);

const escape = String.fromCharCode(27);

const jobLog = Array.from({ length: 200 }, (_, index) => `2026-09-27T08:00:${String(index % 60).padStart(2, '0')}.1234567Z ${escape}[31mline ${String(index + 1)}${escape}[0m`).join('\r\n');

const answering =
  (routes: Readonly<Record<string, unknown>>): typeof fetch =>
  input => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const found = routes[`${url.pathname}${url.searchParams.has('check_name') ? `?${url.searchParams.get('check_name') ?? ''}` : ''}`];
    if (found === undefined) return Promise.resolve(new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } }));
    return Promise.resolve(
      typeof found === 'string' ? new Response(found, { status: 200, headers: { 'content-type': 'text/plain' } }) : new Response(JSON.stringify(found), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
  };

const actionsRun = { id: 11, status: 'completed', conclusion: 'failure', details_url: 'https://github.com/sim/repo/actions/runs/7/job/11', app: { slug: 'github-actions' }, output: { title: null, summary: null } };

const checkRoutes: Readonly<Record<string, unknown>> = {
  [`/repos/sim/repo/commits/${failedAt}/check-runs?build`]: { total_count: 1, check_runs: [actionsRun] },
  '/repos/sim/repo/actions/jobs/11': { id: 11, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run npm test', conclusion: 'failure' }, { name: 'Post job', conclusion: 'skipped' }] },
  '/repos/sim/repo/actions/jobs/11/logs': jobLog,
  [`/repos/sim/repo/commits/${failedAt}/check-runs?legacy`]: { total_count: 0, check_runs: [] },
  [`/repos/sim/repo/commits/${failedAt}/check-runs?missing`]: { total_count: 0, check_runs: [] },
  [`/repos/sim/repo/commits/${failedAt}/check-runs?planted`]: { total_count: 1, check_runs: [{ ...actionsRun, id: undefined }] },
  [`/repos/sim/repo/commits/${failedAt}/status`]: { statuses: [{ context: 'legacy', state: 'failure', description: 'Build failed', target_url: 'https://ci.example/1' }] },
};

const tailExpected = Array.from({ length: 60 }, (_, index) => `line ${String(index + 141)}`).join('\n');

async function failedChecksCheck(): Promise<readonly Check[]> {
  const client = githubClient({ token: 'planted', baseUrl: 'https://github.invalid', pageSize: 100, fetch: answering(checkRoutes) });
  const read = failedChecksReader(() => Promise.resolve(client), 10_000);
  const [build, legacy, missing, planted] = await read('ada', 'sim/repo', failedAt, ['build', 'legacy', 'missing', 'planted']);
  const expected: readonly (readonly [string, unknown, unknown])[] = [
    ["an Actions check reads as its failing step and the last 60 lines of its job's log, with no ANSI codes or timestamps", build, { name: 'build', kind: 'logged', conclusion: 'failure', step: 'Run npm test', log: tailExpected }],
    ['a commit status with no log reads as its description and target URL', legacy, { name: 'legacy', kind: 'described', conclusion: 'failure', description: 'Build failed', url: 'https://ci.example/1' }],
    ['a check GitHub does not report reads as unread, with the reason', missing, { name: 'missing', kind: 'unread', why: `GitHub reports no check run or status named missing on ${failedAt}` }],
  ];
  const plantedName = 'the reader refuses a planted check run without its id by the field, and records the check as unread';
  const plantedWhy = planted?.kind === 'unread' ? planted.why : JSON.stringify(planted);
  return [
    ...expected.map(([what, got, wanted]) => (isDeepStrictEqual(got, wanted) ? pass(`the failed-check reader: ${what}`, JSON.stringify(got).slice(0, 200)) : fail(`the failed-check reader: ${what}`, `${JSON.stringify(got)}, not ${JSON.stringify(wanted)}`))),
    planted?.kind === 'unread' && plantedWhy.includes('check_runs') && plantedWhy.includes('id') ? pass(plantedName, plantedWhy.replace(/\s+/g, ' ')) : fail(plantedName, plantedWhy),
  ];
}

async function simulationChecks(options: SimulationOptions): Promise<readonly Check[]> {
  if (options.mutant === 'all') {
    const checks: Check[] = [await parseCheck(), ...(await failedChecksCheck()), ...(await withPostgres(schemaChecks))];
    for (const mutant of mutantName.options) checks.push(await mutantCheck(mutant, options));
    return checks;
  }
  if (options.mutant !== undefined) return [await mutantCheck(options.mutant, options)];
  return [...(await cleanSeeds(options)), await parseCheck(), ...(await failedChecksCheck())];
}

export const scenarios: readonly Scenario[] = [
  {
    name: 'github-sim',
    summary:
      'reads merge states and performs pull request actions through the real client against a seeded fake GitHub with pushes, late checks, reviews from ignored and other reviewers, conflicts, queue ejections, and lost replies, and checks every Land property after each step; --mutant all proves each guard the connector holds can fail, and each schema check named github_ refuses its plant',
    run: args => {
      const parsed = simulationOptions.safeParse(parseArgs({ args: [...args], options: simulationFlags, strict: true, allowPositionals: false }).values);
      if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
      return simulationChecks(parsed.data);
    },
    nightly: () => [['--seeds', '1000']],
  },
  liveScenario,
];
