import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { z } from 'zod';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { accessCopy, faultNames, runAsNames, type Fault, type RunAs } from './autoworker.ts';
import { Catalog, catalog, type Entry } from './catalog.ts';
import { cleanScenarios } from './clean-lanes.ts';
import { driverNames, type DriverName } from './driver.ts';
import { githubFromEnvironment, githubPayloads } from './github.ts';
import { createRunBranch, runEndToEnd, type Inspect, type RunResult } from './harness.ts';
import { jiraPayloads } from './jira.ts';
import { laneChecks, lanes, laneTen } from './lanes.ts';
import { parsePayload, PayloadRejected } from './payload.ts';
import { parkedScenario } from './parked.ts';
import { seconds } from './report.ts';
import { roundTripScenario } from './round-trip.ts';
import { sandboxWorld, worldNames, type World, type WorldName } from './world.ts';

const defaultRepository = 'braxtonkdev/autoworker-oss';
const defaultProject = 'SBX';

const schemas: Readonly<Record<string, z.ZodType>> = {
  ...Object.fromEntries(Object.entries(jiraPayloads).map(([name, schema]) => [`jira.${name}`, schema])),
  ...Object.fromEntries(Object.entries(githubPayloads).map(([name, schema]) => [`github.${name}`, schema])),
  catalog: Catalog,
};

const openWorld = (name: WorldName, repository: string): Promise<World> => {
  switch (name) {
    case 'sandbox':
      return Promise.resolve(sandboxWorld(repository, accessCopy));
    case 'local':
      return Promise.reject(new Error('the local world is not wired yet'));
  }
};

const shuffled = <T>(items: readonly T[]): readonly T[] =>
  items
    .map(item => ({ item, key: Math.random() }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);

type Series = {
  readonly world: WorldName;
  readonly repository: string;
  readonly driver: DriverName;
  readonly entries: readonly Entry[];
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly project: string;
  readonly branch: string | undefined;
  readonly fault: Fault | undefined;
  readonly runAs: RunAs;
  readonly assigned: boolean;
  readonly inspect: Inspect | undefined;
};

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const tokensLine = (result: RunResult): string =>
  result.steps.map(step => `${step.step} ${step.inputTokens === undefined ? 'none' : String(step.inputTokens)}`).join(', ') || 'no attempts';

async function runSeries(series: Series): Promise<readonly Check[]> {
  const world = await openWorld(series.world, series.repository);
  const checks: Check[] = [];
  const results: RunResult[] = [];
  try {
    for (const [index, entry] of series.entries.entries()) {
      const label = series.entries.length === 1 ? '' : `run ${String(index + 1)}: `;
      out(`${label || 'run: '}entry ${entry.name}`);
      const result = await runEndToEnd(world, { driver: series.driver, entry, timeoutMs: series.timeoutMs, pollMs: series.pollMs, project: series.project, branch: series.branch, fault: series.fault, runAs: series.runAs, assigned: series.assigned, inspect: series.inspect }, out);
      results.push(result);
      checks.push(...result.checks.map(check => ({ ...check, name: `${label}${check.name}` })));
      out(`${label || 'run: '}${result.ticket} on ${result.branch}, time to clean ${result.toCleanMs === undefined ? 'not reached' : seconds(result.toCleanMs)}, report ${result.reportLink}, input tokens per step: ${tokensLine(result)}`);
      if (result.checks.some(check => !check.passed)) break;
    }
  } finally {
    await world.stop();
  }
  if (series.entries.length > 1) {
    const clean = results.filter(result => result.checks.every(check => check.passed)).length;
    const name = `${String(series.entries.length)} runs in a row reach clean`;
    checks.push(clean === series.entries.length ? pass(name, results.map(result => `${result.ticket} ${result.toCleanMs === undefined ? '' : seconds(result.toCleanMs)}`).join(', ')) : fail(name, `stopped at run ${String(results.length)}, after ${String(clean)} clean runs`));
  }
  return checks;
}

const seriesOptions = {
  driver: { type: 'string', default: 'autoworker' },
  world: { type: 'string', default: 'sandbox' },
  runs: { type: 'string', default: '1' },
  fault: { type: 'string' },
  'run-as': { type: 'string', default: 'assignee' },
  unassigned: { type: 'boolean', default: false },
  timeout: { type: 'string', default: '2700' },
  poll: { type: 'string', default: '15' },
  entry: { type: 'string' },
  repository: { type: 'string', default: defaultRepository },
  project: { type: 'string', default: defaultProject },
  branch: { type: 'string' },
} as const;

type Parsed = ReturnType<typeof parseArgs<{ args: string[]; options: typeof seriesOptions; allowPositionals: true }>>['values'];

function seriesFrom(values: Parsed, inspect: Inspect | undefined): Series | Check {
  const driver = driverNames.find(name => name === values.driver);
  if (driver === undefined) return fail('driver named', `--driver must be one of ${driverNames.join(', ')}`);
  const world = worldNames.find(name => name === values.world);
  if (world === undefined) return fail('world named', `--world must be one of ${worldNames.join(', ')}`);
  const fault = values.fault === undefined ? undefined : faultNames.find(name => name === values.fault);
  if (values.fault !== undefined && fault === undefined) return fail('fault named', `--fault must be one of ${faultNames.join(', ')}`);
  if (fault !== undefined && driver !== 'autoworker') return fail('fault needs AutoWorker', '--fault works only with --driver autoworker');
  const runAs = runAsNames.find(name => name === values['run-as']);
  if (runAs === undefined) return fail('run-as named', `--run-as must be one of ${runAsNames.join(', ')}`);
  const runs = Number(values.runs);
  const timeout = Number(values.timeout);
  const poll = Number(values.poll);
  if (!Number.isInteger(runs) || runs <= 0 || runs > catalog.length) return fail('runs given', `--runs takes a whole number from 1 to ${String(catalog.length)}, one catalog entry per run`);
  if (!Number.isInteger(timeout) || timeout <= 0 || !Number.isInteger(poll) || poll <= 0) return fail('times given', '--timeout and --poll take whole seconds above 0');
  if (runs > 1 && (values.entry !== undefined || values.branch !== undefined)) return fail('runs given', '--runs above 1 makes a new run branch and picks a new catalog entry for each run, so it takes no --entry or --branch');
  const named = values.entry === undefined ? undefined : catalog.find(candidate => candidate.name === values.entry);
  if (values.entry !== undefined && named === undefined) return fail('entry named', `--entry must be one of ${catalog.map(candidate => candidate.name).join(', ')}`);
  return {
    world,
    repository: values.repository,
    driver,
    entries: named === undefined ? shuffled(catalog).slice(0, runs) : [named],
    timeoutMs: timeout * 1000,
    pollMs: poll * 1000,
    project: values.project,
    branch: values.branch,
    fault,
    runAs,
    assigned: !values.unassigned,
    inspect,
  };
}

const e2e: Scenario = {
  name: 'e2e',
  summary: 'files an SBX ticket on a new e2e/run-* branch per run, lets a driver (AutoWorker by default) take it to merged and clean, checks the record, and posts a report; --runs N runs in a row and stops at the first failure, --fault injects engine-restart or lost-job, --world local runs offline against fakes on kind',
  run: async args => {
    const { values } = parseArgs({ args: [...args], options: seriesOptions, allowPositionals: true });
    const series = seriesFrom(values, undefined);
    return 'passed' in series ? [series] : runSeries(series);
  },
};

const p7Lane: Scenario = {
  name: 'p7-lane',
  summary: "runs one of P7's live lanes by number, 1 to 10, and passes on the checks that lane names; it takes e2e's --world, --repository, and --project",
  run: async args => {
    const { values, positionals } = parseArgs({ args: [...args], options: seriesOptions, allowPositionals: true });
    const number = Number(positionals[0]);
    if (number === 10) return [fail('lane 10: run in the verify service', laneTen)];
    const lane = lanes.find(candidate => candidate.number === number);
    if (lane === undefined) return [fail('lane named', `name a lane from 1 to 10; ${lanes.map(candidate => `${String(candidate.number)} ${candidate.slug}`).join(', ')}, 10 all`)];
    out(`lane ${String(lane.number)} ${lane.slug}: ${lane.procedure}`);
    if (lane.before !== undefined) out(`lane ${String(lane.number)} first needs: ${lane.before}`);
    const series = seriesFrom(
      {
        ...values,
        runs: String(lane.runs),
        ...(lane.fault === undefined ? {} : { fault: lane.fault }),
        'run-as': lane.runAs,
        unassigned: !lane.assigned,
        timeout: String(lane.timeoutSeconds),
      },
      lane.inspect,
    );
    if ('passed' in series) return [series];
    const checks = await runSeries(series);
    const decided = laneChecks(lane, checks);
    const name = `lane ${String(lane.number)} ${lane.slug}`;
    return [...checks.filter(check => !decided.includes(check)).map(check => ({ name: `info: ${check.name}`, passed: true, detail: `${check.passed ? "passed" : "failed, which does not decide this lane"}: ${check.detail}` })), ...decided, decided.length > 0 && decided.every(check => check.passed) ? pass(name, `${String(decided.length)} deciding checks passed`) : fail(name, `${String(decided.filter(check => !check.passed).length)} of ${String(decided.length)} deciding checks failed`)];
  },
};

const e2eBranch: Scenario = {
  name: 'e2e-branch',
  summary: 'makes a new e2e/run-* branch from the sandbox folder alone and prints its name',
  run: async args => {
    const { values } = parseArgs({ args: [...args], options: { repository: { type: 'string', default: defaultRepository } } });
    const github = githubFromEnvironment(process.env, values.repository);
    const mainBefore = await github.branchHead('main');
    const made = await createRunBranch(github);
    process.stdout.write(`${made.branch}\n`);
    const head = await github.branchHead(made.branch);
    return [
      head === made.seed ? pass('run branch created', `${made.branch} at ${made.seed}`) : fail('run branch created', `${made.branch} points at ${head ?? 'nothing'}`),
      (await github.branchHead('main')) === mainBefore ? pass('main unchanged', mainBefore ?? '') : fail('main unchanged', 'main moved'),
    ];
  },
};

type Plant = { readonly schema: string; readonly valid: unknown; readonly remove: readonly (string | number)[] };

const pull = {
  number: 1,
  node_id: 'PR_1',
  html_url: 'https://github.com/owner/repository/pull/1',
  title: 'SBX-1 Add titleCase',
  body: null,
  state: 'closed',
  draft: false,
  merged_at: '2026-09-24T00:00:00Z',
  merge_commit_sha: 'abc',
  head: { ref: 'e2e/run-1-work/SBX-1', sha: 'def' },
  base: { ref: 'e2e/run-1' },
};

const plants: readonly Plant[] = [
  { schema: 'jira.comments', valid: { startAt: 0, total: 1, comments: [{ id: '1', body: 'h3. Plan', created: '2026-09-24T00:00:00.000+0000' }] }, remove: ['comments', 0, 'body'] },
  { schema: 'jira.issue', valid: { key: 'SBX-1', fields: { summary: 's', description: null, labels: [], created: 'c', assignee: null } }, remove: ['fields', 'labels'] },
  { schema: 'jira.myself', valid: { accountId: 'a' }, remove: ['accountId'] },
  { schema: 'github.pull', valid: pull, remove: ['merged_at'] },
  { schema: 'github.pulls', valid: [pull], remove: [0, 'head', 'sha'] },
  { schema: 'github.checkRuns', valid: { total_count: 1, check_runs: [{ name: 'sandbox', status: 'completed', conclusion: 'success', completed_at: 'c', html_url: 'https://github.com/owner/repository/runs/1' }] }, remove: ['check_runs', 0, 'conclusion'] },
  { schema: 'catalog', valid: catalog, remove: [0, 'acceptance'] },
];

function withoutPath(value: unknown, path: readonly (string | number)[]): unknown {
  const copy: unknown = structuredClone(value);
  const last = path.at(-1);
  let parent: unknown = copy;
  for (const key of path.slice(0, -1)) parent = typeof parent === 'object' && parent !== null ? Reflect.get(parent, key) : undefined;
  if (typeof parent !== 'object' || parent === null || last === undefined) throw new Error(`the plant path ${path.join('.')} does not exist`);
  Reflect.deleteProperty(parent, last);
  return copy;
}

function parsed(schema: string, payload: unknown): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  const found = schemas[schema];
  if (found === undefined) throw new Error(`there is no schema named ${schema}. Schemas: ${Object.keys(schemas).join(', ')}`);
  try {
    parsePayload(schema, found, payload);
    return { ok: true };
  } catch (error) {
    if (error instanceof PayloadRejected) return { ok: false, message: error.message };
    throw error;
  }
}

const e2ePayload: Scenario = {
  name: 'e2e-payload',
  summary: 'parses planted Jira, GitHub, and catalog payloads with a field removed, or one --file against one --schema, and passes only when each rejection names its field',
  run: async args => {
    const { values } = parseArgs({ args: [...args], options: { schema: { type: 'string' }, file: { type: 'string' } } });
    if (values.schema !== undefined && values.file !== undefined) {
      const result = parsed(values.schema, JSON.parse(await readFile(values.file, 'utf8')));
      return [result.ok ? pass(`${values.schema} accepts ${values.file}`, '') : fail(`${values.schema} accepts ${values.file}`, result.message)];
    }
    const checks: Check[] = [];
    for (const plant of plants) {
      const field = plant.remove.join('.');
      const valid = parsed(plant.schema, plant.valid);
      checks.push(valid.ok ? pass(`${plant.schema} accepts its sample`, '') : fail(`${plant.schema} accepts its sample`, valid.message));
      const planted = parsed(plant.schema, withoutPath(plant.valid, plant.remove));
      checks.push(!planted.ok && planted.message.includes(`${field}:`) ? pass(`${plant.schema} rejects a missing ${field} by name`, planted.message) : fail(`${plant.schema} rejects a missing ${field} by name`, planted.ok ? 'it accepted the plant' : planted.message));
    }
    return checks;
  },
};

export const scenarios: readonly Scenario[] = [e2e, p7Lane, e2eBranch, e2ePayload, ...cleanScenarios, roundTripScenario, parkedScenario];
