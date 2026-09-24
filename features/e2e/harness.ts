import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from '../../shared/db/client.ts';
import { fail, pass, type Check } from '../../tools/verify/check.ts';
import { withPostgres } from '../../tools/verify/postgres.ts';
import type { Entry } from './catalog.ts';
import { drivers, type DriverName } from './driver.ts';
import { steps, walk, type DriverEnd, type Reached, type Walk } from './frontier.ts';
import { githubFromEnvironment, type GitHub, type SeedFile } from './github.ts';
import { jiraFromEnvironment, type Jira } from './jira.ts';
import { linksFrom, renderReport, seconds, stepRuns } from './report.ts';

export type Options = {
  readonly driver: DriverName;
  readonly entry: Entry;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly repository: string;
  readonly project: string;
  readonly branch: string | undefined;
};

const sandboxFolder = fileURLToPath(new URL('sandbox/', import.meta.url));
const skipped = new Set(['node_modules']);
const overheadBudgetMs = 60_000;
const timeoutGraceMs = 15_000;
const filedToMergedBudgetMs = 45 * 60_000;
const driverStopWaitMs = 30_000;

async function sandboxFiles(folder: string): Promise<readonly SeedFile[]> {
  const files: SeedFile[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true, recursive: true })) {
    const path = join(entry.parentPath, entry.name);
    const inside = relative(folder, path).split('\\').join('/');
    if (!entry.isFile() || inside.split('/').some(part => skipped.has(part))) continue;
    files.push({ path: inside, content: await readFile(path, 'utf8') });
  }
  return files;
}

const runPrefix = 'e2e/run-';

const newRunId = (): string => `${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15).toLowerCase()}-${randomBytes(2).toString('hex')}`;

export async function createRunBranch(github: GitHub): Promise<{ readonly id: string; readonly branch: string; readonly seed: string }> {
  const id = newRunId();
  const branch = `${runPrefix}${id}`;
  const seed = await github.seedBranch(branch, await sandboxFiles(sandboxFolder), `Seed ${branch} from the sandbox folder`);
  return { id, branch, seed };
}

async function existingRunBranch(github: GitHub, branch: string): Promise<{ readonly id: string; readonly branch: string }> {
  const id = branch.startsWith(runPrefix) ? branch.slice(runPrefix.length) : '';
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`--branch must name a run branch, ${runPrefix}<id>`);
  if ((await github.branchHead(branch)) === undefined) throw new Error(`${branch} does not exist`);
  return { id, branch };
}

export const accessFromEnvironment = (repository: string): { readonly jira: Jira; readonly github: GitHub } => ({
  jira: jiraFromEnvironment(process.env),
  github: githubFromEnvironment(process.env, repository),
});

function stopLine(result: Walk): string {
  switch (result.stop.kind) {
    case 'complete':
      return 'every step reached';
    case 'failed':
      return `${result.stop.step} failed: ${result.stop.reason}`;
    case 'timed out':
      return `timed out waiting for ${result.stop.step}: ${result.stop.note}`;
    case 'driver failed':
      return `the driver failed before ${result.stop.step}: ${result.stop.reason}`;
  }
}

function checks(options: Options, result: Walk, overheadMs: number, elapsedMs: number, mainUnchanged: boolean, reportLink: string): readonly Check[] {
  const found = new Map<string, Reached>(result.reached.map(step => [step.name, step]));
  const filed = found.get('ticket filed')?.at.getTime() ?? 0;
  const perStep = steps.map(({ name }) => {
    const step = found.get(name);
    return step === undefined ? fail(name, 'not reached') : pass(name, `${step.at.toISOString()}, +${seconds(step.at.getTime() - filed)}, ${step.detail}`);
  });
  const merged = found.get('merged');
  return [
    ...perStep,
    result.stop.kind === 'complete' ? pass('frontier reaches merged', stopLine(result)) : fail('frontier reaches merged', `furthest step: ${result.reached.at(-1)?.name ?? 'none'}. ${stopLine(result)}`),
    merged === undefined || merged.at.getTime() - filed <= filedToMergedBudgetMs ? pass('ticket filed to merged within 45 minutes', merged === undefined ? 'not merged' : seconds(merged.at.getTime() - filed)) : fail('ticket filed to merged within 45 minutes', seconds(merged.at.getTime() - filed)),
    overheadMs <= overheadBudgetMs ? pass('harness overhead within 60 s', seconds(overheadMs)) : fail('harness overhead within 60 s', seconds(overheadMs)),
    elapsedMs <= options.timeoutMs + timeoutGraceMs ? pass('run ends within its timeout plus 15 s', `${seconds(elapsedMs)} of ${seconds(options.timeoutMs)}`) : fail('run ends within its timeout plus 15 s', `${seconds(elapsedMs)} of ${seconds(options.timeoutMs)}`),
    mainUnchanged ? pass('main unchanged', '') : fail('main unchanged', 'main moved during the run'),
    pass('report posted', reportLink),
  ];
}

export async function runEndToEnd(options: Options, out: (line: string) => void): Promise<readonly Check[]> {
  const started = Date.now();
  const deadline = started + options.timeoutMs;
  let busyMs = 0;
  const timed = async <T>(work: () => Promise<T>): Promise<T> => {
    const began = performance.now();
    try {
      return await work();
    } finally {
      busyMs += performance.now() - began;
    }
  };
  const { jira, github } = accessFromEnvironment(options.repository);
  return withPostgres(async postgres => {
    busyMs += postgres.readyInMs;
    const scratch = await timed(() => postgres.scratch());
    const database = connect(scratch.url, 2);
    const { accountId, mainBefore, id, branch } = await timed(async () => ({ accountId: await jira.accountId(), mainBefore: await github.branchHead('main'), ...(options.branch === undefined ? await createRunBranch(github) : await existingRunBranch(github, options.branch)) }));
    out(`run branch ${branch}`);
    const label = `e2e-run-${id}`;
    const ticket = await timed(() => jira.fileTicket({ project: options.project, summary: options.entry.summary, description: options.entry.description, label, assignee: accountId }));
    out(`ticket ${ticket} ${jira.browse(ticket)}, entry ${options.entry.name}, driver ${options.driver}`);
    const workdir = join(homedir(), '.e2e', id);
    await mkdir(workdir, { recursive: true, mode: 0o700 });
    const driverStop = new AbortController();
    let driverEnd: DriverEnd | undefined;
    const driving = drivers[options.driver]({ ticket, branch, databaseUrl: scratch.url, jira, github, workdir, signal: driverStop.signal, log: line => { out(`  driver: ${line}`); } }).then(
      () => {
        driverEnd = { ok: true };
      },
      (error: unknown) => {
        driverEnd = { ok: false, reason: error instanceof Error ? error.message : String(error) };
        out(`  driver failed: ${driverEnd.reason}`);
      },
    );
    const walkStop = new AbortController();
    try {
      const run = { branch, ticket, label, accountId, entry: options.entry, jira, github, database, workdir, signal: walkStop.signal };
      const filed = Date.now();
      const result = await walk(run, {
        deadline,
        pollMs: options.pollMs,
        driverEnd: () => driverEnd,
        onReach: step => {
          out(`${step.name.padEnd(20)}${step.at.toISOString()}  +${seconds(step.at.getTime() - filed)}`);
        },
      });
      busyMs += result.busyMs;
      driverStop.abort();
      await Promise.race([driving, new Promise(resolve => setTimeout(resolve, driverStopWaitMs))]);
      out(`furthest step: ${result.reached.at(-1)?.name ?? 'none'}`);
      const { mainAfter, reportLink } = await timed(async () => {
        const posted = await jira.comment(
          ticket,
          renderReport({
            branch,
            driver: options.driver,
            entry: options.entry.name,
            furthest: result.reached.at(-1)?.name ?? 'none',
            stop: stopLine(result),
            timeline: result.reached,
            steps: await stepRuns(database, ticket),
            links: linksFrom(jira.browse(ticket), result.reached),
            overheadMs: busyMs,
          }),
        );
        return { mainAfter: await github.branchHead('main'), reportLink: jira.commentLink(ticket, posted) };
      });
      out(`report ${reportLink}`);
      return checks(options, result, busyMs, Date.now() - started, mainBefore === mainAfter, reportLink);
    } finally {
      walkStop.abort();
      driverStop.abort();
      await database.destroy();
      await rm(workdir, { recursive: true, force: true });
    }
  });
}
