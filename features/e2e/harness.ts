import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectCluster } from '../../shared/cluster.ts';
import { connect, type Database } from '../../shared/db/client.ts';
import { fail, info, pass, type Check, type Line } from '../../tools/verify/check.ts';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { endStatus, teamAccount, type Fault, type RunAs } from './autoworker.ts';
import type { Entry } from './catalog.ts';
import type { CleanSources } from './clean.ts';
import { drivers, type DriverName } from './driver.ts';
import { steps, walk, type DriverEnd, type Reached, type Walk } from './frontier.ts';
import type { GitHub, SeedFile } from './github.ts';
import type { Comment, Jira } from './jira.ts';
import { agentTurnMs, plantedSecretCheck, recordChecks } from './record-checks.ts';
import { linksFrom, renderReport, seconds, stepRuns, type StepRun } from './report.ts';
import type { World } from './world.ts';

export type Inspect = (scope: { readonly database: Database; readonly clean: CleanSources; readonly ticket: string }) => Promise<readonly Check[]>;

export type Options = {
  readonly driver: DriverName;
  readonly entry: Entry;
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly project: string;
  readonly branch: string | undefined;
  readonly fault: Fault | undefined;
  readonly runAs: RunAs;
  readonly assigned: boolean;
  readonly inspect: Inspect | undefined;
};

export type RunResult = {
  readonly branch: string;
  readonly ticket: string;
  readonly checks: readonly Line[];
  readonly reportLink: string;
  readonly toCleanMs: number | undefined;
  readonly steps: readonly StepRun[];
};

const sandboxFolder = fileURLToPath(new URL('sandbox/', import.meta.url));
const skipped = new Set(['node_modules']);
const overheadBudgetMs = 60_000;
const timeoutGraceMs = 15_000;
const filedToMergedBudgetMs = 45 * 60_000;
const filedToCleanBudgetMs = 45 * 60_000;
const autoworkerOverheadBudgetMs = 10 * 60_000;
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

const within = (name: string, ms: number | undefined, budgetMs: number, missing: string): Line =>
  ms === undefined ? info(name, 'n/a', missing) : ms <= budgetMs ? pass(name, seconds(ms)) : fail(name, seconds(ms));

type Timing = { readonly overheadMs: number; readonly elapsedMs: number; readonly autoworkerOverheadMs: number | undefined };

function frontierChecks(options: Options, result: Walk, timing: Timing, mainUnchanged: boolean): readonly Line[] {
  const found = new Map<string, Reached>(result.reached.map(step => [step.name, step]));
  const filed = found.get('ticket filed')?.at.getTime() ?? 0;
  const perStep = steps.map(({ name }) => {
    const step = found.get(name);
    return step === undefined ? fail(name, 'not reached') : pass(name, `${step.at.toISOString()}, +${seconds(step.at.getTime() - filed)}, ${step.detail}`);
  });
  const since = (name: string): number | undefined => {
    const step = found.get(name);
    return step === undefined ? undefined : step.at.getTime() - filed;
  };
  return [
    ...perStep,
    result.stop.kind === 'complete' ? pass('frontier reaches clean', stopLine(result)) : fail('frontier reaches clean', `furthest step: ${result.reached.at(-1)?.name ?? 'none'}. ${stopLine(result)}`),
    within('ticket filed to merged within 45 minutes', since('merged'), filedToMergedBudgetMs, 'not merged'),
    within('ticket filed to clean within 45 minutes', since('clean'), filedToCleanBudgetMs, 'not clean'),
    timing.overheadMs <= overheadBudgetMs ? pass('harness overhead within 60 s', seconds(timing.overheadMs)) : fail('harness overhead within 60 s', seconds(timing.overheadMs)),
    timing.elapsedMs <= options.timeoutMs + timeoutGraceMs ? pass('run ends within its timeout plus 15 s', `${seconds(timing.elapsedMs)} of ${seconds(options.timeoutMs)}`) : fail('run ends within its timeout plus 15 s', `${seconds(timing.elapsedMs)} of ${seconds(options.timeoutMs)}`),
    within("AutoWorker's overhead within 10 minutes", timing.autoworkerOverheadMs, autoworkerOverheadBudgetMs, 'not measured, because the run did not reach clean with the AutoWorker driver'),
    mainUnchanged ? pass('main unchanged', '') : fail('main unchanged', 'main moved during the run'),
  ];
}

function duplicateComments(comments: readonly Comment[]): Check {
  const counts = new Map<string, number>();
  for (const comment of comments) counts.set(comment.body.trim(), (counts.get(comment.body.trim()) ?? 0) + 1);
  const repeated = [...counts].filter(([, count]) => count > 1);
  const name = `duplicate comments ${String(repeated.length)}`;
  return repeated.length === 0 ? pass(name, `${String(comments.length)} comments, each once`) : fail(name, repeated.map(([body, count]) => `${String(count)} times: ${body.slice(0, 80)}`).join('; '));
}

async function endStatusCheck(jira: Jira, ticket: string): Promise<Check> {
  const status = (await jira.issue(ticket)).fields.status.name;
  const name = `the ticket ends in ${endStatus}, the routine's end status`;
  return status === endStatus ? pass(name, `${ticket} is ${status}`) : fail(name, `${ticket} is ${status}`);
}

async function pullRequestCheck(github: GitHub, branch: string, ticket: string): Promise<Check> {
  const naming = (await github.pulls(branch)).filter(pull => pull.title.includes(ticket) || (pull.body ?? '').includes(ticket));
  const name = `pull requests ${String(naming.length)}`;
  return naming.length === 1 ? pass(name, `pull request ${String(naming[0]?.number)} names ${ticket}`) : fail(name, `${naming.map(pull => String(pull.number)).join(', ') || 'none'} into ${branch} name ${ticket}, and exactly one should`);
}

const reportRows = (runs: readonly StepRun[]): readonly string[] => runs.map(run => `|${run.step}|${run.attempt}|`);

function reportReadBack(posted: Comment | undefined, runs: readonly StepRun[], reached: readonly Reached[]): Check {
  const name = 'the report comment reads back from Jira with its timeline, input tokens per step, and every link';
  if (posted === undefined) return fail(name, 'the report comment was not found on the ticket');
  const missing = [
    ...reached.map(step => `|${step.name}|`),
    ...reportRows(runs),
    'Input tokens in all:',
    '[ticket|',
    '[pull request|',
    '[merge commit|',
    '[pull request CI run|',
    '[run branch CI run|',
  ].filter(part => !posted.body.includes(part));
  return missing.length === 0 && !posted.body.includes('Missing:') ? pass(name, `comment ${posted.id}, ${String(posted.body.length)} characters`) : fail(name, `missing ${missing.join(', ')}${posted.body.includes('Missing:') ? ', and it lists missing links' : ''}`);
}

export async function runEndToEnd(world: World, options: Options, out: (line: string) => void): Promise<RunResult> {
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
  const { jira, github } = world;
  return withPostgres(async postgres => {
    busyMs += postgres.readyInMs;
    const scratch = await timed(() => postgres.scratch());
    const database = connect(scratch.url, 2);
    const { accountId, mainBefore, id, branch } = await timed(async () => ({ accountId: await jira.accountId(), mainBefore: await github.branchHead('main'), ...(options.branch === undefined ? await createRunBranch(github) : await existingRunBranch(github, options.branch)) }));
    out(`run branch ${branch}`);
    const label = `e2e-run-${id}`;
    const assignee = options.assigned ? accountId : null;
    const ticket = await timed(() => jira.fileTicket({ project: options.project, summary: options.entry.summary, description: options.entry.description, label, assignee }));
    out(`ticket ${ticket} ${jira.browse(ticket)}, entry ${options.entry.name}, driver ${options.driver}, world ${world.name}`);
    const workdir = join(homedir(), '.e2e', id);
    await mkdir(workdir, { recursive: true, mode: 0o700 });
    const namespace = `e2e-${id}`;
    const clean: CleanSources = { database, cluster: connectCluster(namespace), branchesStartingWith: github.branchesStartingWith };
    const driverChecks: Check[] = [];
    const driverStop = new AbortController();
    let driverEnd: DriverEnd | undefined;
    const driving = drivers[options.driver]({
      ticket,
      branch,
      databaseUrl: scratch.url,
      namespace,
      jira,
      github,
      world: world.engine,
      fault: options.fault,
      runAs: options.runAs,
      check: found => {
        driverChecks.push(found);
        out(`  driver: ${found.passed ? 'PASS' : 'FAIL'} ${found.name}: ${found.detail}`);
      },
      workdir,
      signal: driverStop.signal,
      log: line => {
        out(`  driver: ${line}`);
      },
    }).then(
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
      const run = { branch, ticket, label, assignee, entry: options.entry, jira, github, database, workdir, clean, signal: walkStop.signal };
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
      const cleanAt = result.reached.find(step => step.name === 'clean')?.at;
      const filedAt = result.reached.find(step => step.name === 'ticket filed')?.at;
      const toCleanMs = cleanAt === undefined || filedAt === undefined ? undefined : cleanAt.getTime() - filedAt.getTime();
      const expectedRunAs = options.runAs === 'team' ? teamAccount : jira.email.toLowerCase();
      const recorded = cleanAt === undefined || options.driver !== 'autoworker' ? [] : [...(await recordChecks(database, ticket, expectedRunAs, options.entry.description)), await endStatusCheck(jira, ticket), await plantedSecretCheck(clean, ticket)];
      const autoworkerOverheadMs = toCleanMs === undefined || options.driver !== 'autoworker' ? undefined : toCleanMs - (await agentTurnMs(database, ticket));
      const inspected = options.inspect === undefined ? [] : await options.inspect({ database, clean, ticket });
      driverStop.abort();
      await Promise.race([driving, new Promise(resolve => setTimeout(resolve, driverStopWaitMs))]);
      out(`furthest step: ${result.reached.at(-1)?.name ?? 'none'}`);
      const runs = await stepRuns(database, ticket);
      const { mainAfter, reportLink, posted, sideChecks } = await timed(async () => {
        const sideChecks = [duplicateComments(await jira.comments(ticket)), await pullRequestCheck(github, branch, ticket)];
        const comment = await jira.comment(
          ticket,
          renderReport({
            branch,
            driver: options.driver,
            entry: options.entry.name,
            furthest: result.reached.at(-1)?.name ?? 'none',
            stop: stopLine(result),
            timeline: result.reached,
            steps: runs,
            links: linksFrom(jira.browse(ticket), result.reached),
            overheadMs: busyMs,
            autoworkerOverheadMs,
          }),
        );
        const posted = (await jira.comments(ticket)).find(found => found.id === comment.id);
        return { mainAfter: await github.branchHead('main'), reportLink: jira.commentLink(ticket, comment), posted, sideChecks };
      });
      out(`report ${reportLink}`);
      const timing = { overheadMs: busyMs, elapsedMs: Date.now() - started, autoworkerOverheadMs };
      const checks = [
        ...frontierChecks(options, result, timing, mainBefore === mainAfter),
        ...recorded,
        ...sideChecks,
        ...driverChecks,
        ...inspected,
        pass('report posted', reportLink),
        ...(cleanAt === undefined ? [] : [reportReadBack(posted, runs, result.reached)]),
      ];
      return { branch, ticket, checks, reportLink, toCleanMs, steps: runs };
    } finally {
      walkStop.abort();
      driverStop.abort();
      await database.destroy();
      await rm(workdir, { recursive: true, force: true });
    }
  });
}
