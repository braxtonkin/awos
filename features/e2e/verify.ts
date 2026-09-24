import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import type { z } from 'zod';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { Catalog, catalog } from './catalog.ts';
import { driverNames } from './driver.ts';
import { githubPayloads } from './github.ts';
import { accessFromEnvironment, createRunBranch, runEndToEnd } from './harness.ts';
import { jiraPayloads } from './jira.ts';
import { parsePayload, PayloadRejected } from './payload.ts';

const defaultRepository = 'braxtonkdev/autoworker-oss';
const defaultProject = 'SBX';

const schemas: Readonly<Record<string, z.ZodType>> = {
  ...Object.fromEntries(Object.entries(jiraPayloads).map(([name, schema]) => [`jira.${name}`, schema])),
  ...Object.fromEntries(Object.entries(githubPayloads).map(([name, schema]) => [`github.${name}`, schema])),
  catalog: Catalog,
};

const pick = <T>(items: readonly T[]): T => {
  const item = items[Math.floor(Math.random() * items.length)];
  if (item === undefined) throw new Error('there is nothing to pick from');
  return item;
};

const e2e: Scenario = {
  name: 'e2e',
  summary: 'files an SBX ticket on a new e2e/run-* branch, lets a driver play AutoWorker, and checks each step up to merged',
  run: async args => {
    const { values } = parseArgs({
      args: [...args],
      options: {
        driver: { type: 'string', default: 'throwaway' },
        timeout: { type: 'string', default: '2700' },
        poll: { type: 'string', default: '15' },
        entry: { type: 'string' },
        repository: { type: 'string', default: defaultRepository },
        project: { type: 'string', default: defaultProject },
        branch: { type: 'string' },
      },
    });
    const driver = driverNames.find(name => name === values.driver);
    if (driver === undefined) return [fail('driver named', `--driver must be one of ${driverNames.join(', ')}`)];
    const entry = values.entry === undefined ? pick(catalog) : catalog.find(candidate => candidate.name === values.entry);
    if (entry === undefined) return [fail('entry named', `--entry must be one of ${catalog.map(candidate => candidate.name).join(', ')}`)];
    const timeout = Number(values.timeout);
    const poll = Number(values.poll);
    if (!Number.isInteger(timeout) || timeout <= 0 || !Number.isInteger(poll) || poll <= 0) return [fail('times given', '--timeout and --poll take whole seconds above 0')];
    return runEndToEnd({ driver, entry, timeoutMs: timeout * 1000, pollMs: poll * 1000, repository: values.repository, project: values.project, branch: values.branch }, line => {
      process.stdout.write(`${line}\n`);
    });
  },
};

const e2eBranch: Scenario = {
  name: 'e2e-branch',
  summary: 'makes a new e2e/run-* branch from the sandbox folder alone and prints its name',
  run: async args => {
    const { values } = parseArgs({ args: [...args], options: { repository: { type: 'string', default: defaultRepository } } });
    const { github } = accessFromEnvironment(values.repository);
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

export const scenarios: readonly Scenario[] = [e2e, e2eBranch, e2ePayload];
