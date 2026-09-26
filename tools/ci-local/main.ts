import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { budgetFile, ceilingsAt, secondsKey } from '../budget/budget.ts';
import { ownerLabel } from '../verify/owner-label.ts';
import { planOf, setupJob, workflowFile, type Step } from './workflow.ts';

type Result = { readonly name: string; readonly exit: number | null; readonly seconds: number; readonly log: string };

const root = fileURLToPath(new URL('../../', import.meta.url));
function git(args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

const runRecord = z.strictObject({ pid: z.number().int().positive(), sha: z.string(), startedAt: z.string(), project: z.string(), run: z.string() });

type RunRecord = z.infer<typeof runRecord>;

const results = join(root, 'ci-local');
const recordFile = join(results, 'run.json');
const stopFile = join(results, 'stop');
const runLabel = 'autoworker.ci-local.run';
const jobLabel = 'autoworker.ci-local.job';
const stopWaitMs = 60_000;

const composeProject = (): string => process.env['COMPOSE_PROJECT_NAME'] ?? basename(root).toLowerCase().replace(/[^a-z0-9_-]/g, '');

function recorded(): RunRecord | undefined {
  if (!existsSync(recordFile)) return undefined;
  const parsed = runRecord.safeParse(JSON.parse(readFileSync(recordFile, 'utf8')));
  if (!parsed.success) throw new Error(`${recordFile} is not a ci-local run record. Delete it only after checking that no run in this worktree is alive.`);
  return parsed.data;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

const describedRun = (record: RunRecord): string => `run ${record.run}, pid ${String(record.pid)}, at ${record.sha}, started ${record.startedAt}, compose project ${record.project}`;

function dockerLines(args: readonly string[]): readonly string[] {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.split('\n').map(line => line.trim()).filter(line => line !== '');
}

function removeStepContainers(project: string, run: string | undefined, job?: string): readonly string[] {
  const filters = ['--filter', `label=com.docker.compose.project=${project}`, '--filter', run === undefined ? `label=${runLabel}` : `label=${runLabel}=${run}`, ...(job === undefined ? [] : ['--filter', `label=${jobLabel}=${job}`])];
  const steps = dockerLines(['ps', '--all', '--quiet', '--no-trunc', ...filters]);
  const owned = steps.flatMap(id => dockerLines(['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=${ownerLabel}=${id}`]));
  const doomed = [...steps, ...owned];
  if (doomed.length > 0) dockerLines(['rm', '--force', '--volumes', ...doomed]);
  return doomed;
}

function clearStale(record: RunRecord | undefined): void {
  const removed = removeStepContainers(record?.project ?? composeProject(), undefined);
  if (record !== undefined) process.stdout.write(`The recorded ${describedRun(record)} is no longer alive.\n`);
  if (removed.length > 0) process.stdout.write(`Removed ${String(removed.length)} containers that an earlier run in this worktree left behind: ${removed.map(id => id.slice(0, 12)).join(', ')}\n`);
  rmSync(recordFile, { force: true });
  rmSync(stopFile, { force: true });
}

async function stop(): Promise<number> {
  const record = recorded();
  if (record === undefined) {
    process.stdout.write(`No ci-local run is recorded in ${root}, so there is nothing to stop.\n`);
    return 0;
  }
  if (!isAlive(record.pid)) {
    clearStale(record);
    return 0;
  }
  writeFileSync(stopFile, record.run);
  process.stdout.write(`Asked ${describedRun(record)} to stop.\n`);
  const deadline = Date.now() + stopWaitMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 500));
    if (recorded()?.run !== record.run) {
      process.stdout.write(`Run ${record.run} stopped and removed its containers.\n`);
      return 0;
    }
  }
  process.stderr.write(`Run ${record.run} did not stop within ${String(stopWaitMs / 1000)}s. Its pid ${String(record.pid)} is still alive, and ${stopFile} still asks it to stop.\n`);
  return 1;
}

const labeled = (args: readonly string[], run: string, job: string): readonly string[] => {
  const [compose, verb, ...rest] = args;
  return compose === 'compose' && verb === 'run' ? [compose, verb, '--label', `${runLabel}=${run}`, '--label', `${jobLabel}=${job}`, ...rest] : args;
};

function timeCeilings(plan: readonly Step[]): ReadonlyMap<string, number> | string {
  const ceilings = ceilingsAt(root);
  if (typeof ceilings === 'string') return ceilings;
  const jobs = [...new Set(plan.map(step => step.job))].filter(job => job !== setupJob);
  const missing = jobs.filter(job => !ceilings.has(secondsKey(job)));
  if (missing.length > 0) return `${budgetFile} has no time ceiling for the jobs ${missing.join(', ')}. Run npm run budget to see what to add.`;
  return new Map(jobs.map(job => [job, ceilings.get(secondsKey(job)) ?? 0]));
}

async function runStepOf(step: Step, index: number, folder: string, run: string): Promise<Result> {
  const log = join(folder, `${String(index + 1).padStart(2, '0')}-${step.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}.log`);
  const fd = openSync(log, 'w');
  const started = performance.now();
  try {
    writeFileSync(fd, `$ docker ${step.args.join(' ')}\n`);
    const exit = await new Promise<number | null>(resolve => {
      const child = spawn('docker', labeled(step.args, run, step.job), {
        cwd: root,
        stdio: ['ignore', fd, fd],
        env: process.platform === 'win32' ? { ...process.env, MSYS_NO_PATHCONV: '1' } : process.env,
      });
      child.on('error', error => {
        writeFileSync(fd, `\ndocker did not start: ${error.message}\n`);
        resolve(null);
      });
      child.on('close', resolve);
    });
    return { name: step.name, exit, seconds: Math.round((performance.now() - started) / 1000), log };
  } finally {
    closeSync(fd);
  }
}

async function runAll(plan: readonly Step[]): Promise<number> {
  const sha = git(['rev-parse', 'HEAD']);
  process.stdout.write(`ci-local at ${sha}\n`);
  const dirty = git(['status', '--porcelain']);
  if (dirty !== '') {
    process.stderr.write(`The worktree has uncommitted changes, so a result could not be tied to ${sha}. Commit or stash them first:\n${dirty}\n`);
    return 2;
  }
  const ceilings = timeCeilings(plan);
  if (typeof ceilings === 'string') {
    process.stderr.write(`${ceilings}\n`);
    return 2;
  }
  const earlier = recorded();
  if (earlier !== undefined && isAlive(earlier.pid)) {
    process.stderr.write(`Another ci-local run is alive in this worktree: ${describedRun(earlier)}. Wait for it, or stop it with node tools/ci-local/main.ts --stop.\n`);
    return 2;
  }
  clearStale(earlier);
  const record: RunRecord = { pid: process.pid, sha, startedAt: new Date().toISOString(), project: composeProject(), run: randomUUID() };
  mkdirSync(results, { recursive: true });
  try {
    writeFileSync(recordFile, `${JSON.stringify(record)}\n`, { flag: 'wx' });
  } catch {
    process.stderr.write(`Another ci-local run recorded itself in ${recordFile} at the same moment. Run node tools/ci-local/main.ts again once it ends.\n`);
    return 2;
  }
  process.stdout.write(`Recorded ${describedRun(record)} in ${recordFile}. Stop it only with node tools/ci-local/main.ts --stop.\n`);
  const stopping = new AbortController();
  const watch = setInterval(() => {
    if (stopping.signal.aborted || !existsSync(stopFile) || readFileSync(stopFile, 'utf8') !== record.run) return;
    stopping.abort();
    removeStepContainers(record.project, record.run);
  }, 1000);
  try {
    const folder = join(results, sha);
    rmSync(folder, { recursive: true, force: true });
    mkdirSync(folder, { recursive: true });
    const started = performance.now();
    const header = `ci-local at ${sha}, started ${record.startedAt}\n`;
    const finished: (Result | undefined)[] = plan.map(() => undefined);
    let printed = 0;
    const run = async (index: number): Promise<void> => {
      const step = plan[index];
      if (step === undefined || stopping.signal.aborted) return;
      finished[index] = await runStepOf(step, index, folder, record.run);
      for (let next = finished[printed]; next !== undefined; next = finished[printed]) {
        process.stdout.write(`${next.name}\n  exit ${String(next.exit)} in ${String(next.seconds)}s, log ${next.log}\n`);
        printed += 1;
      }
    };
    const indexesOf = (job: string): readonly number[] => plan.flatMap((step, index) => (step.job === job ? [index] : []));
    for (const index of indexesOf(setupJob)) await run(index);
    const jobs = [...new Set(plan.map(step => step.job))].filter(job => job !== setupJob);
    const overtime = new Set<string>();
    const took = new Map<string, number>();
    await Promise.all(
      jobs.map(async job => {
        const jobStarted = performance.now();
        const tripwire = setTimeout(() => {
          overtime.add(job);
          removeStepContainers(record.project, record.run, job);
        }, (ceilings.get(job) ?? 0) * 1000);
        try {
          for (const index of indexesOf(job)) if (!overtime.has(job)) await run(index);
        } finally {
          clearTimeout(tripwire);
          took.set(job, Math.round((performance.now() - jobStarted) / 1000));
        }
      }),
    );
    const ran = finished.filter(result => result !== undefined);
    const passed = !stopping.signal.aborted && overtime.size === 0 && ran.length === plan.length && ran.every(result => result.exit === 0);
    const timed = jobs.map(job => `job ${job} took ${String(took.get(job) ?? 0)}s of its ${String(ceilings.get(job) ?? 0)}s ceiling in ${budgetFile}${overtime.has(job) ? ', and ci-local stopped it at the ceiling' : ''}`);
    const rows = ran.map(result => `${String(result.exit).padEnd(6)}${String(result.seconds).padStart(7)}s  ${result.name}`);
    const wall = Math.round((performance.now() - started) / 1000);
    const verdict = stopping.signal.aborted ? 'STOPPED by node tools/ci-local/main.ts --stop' : passed ? 'PASS' : overtime.size > 0 ? `FAIL, because ${[...overtime].join(', ')} passed a time ceiling` : 'FAIL';
    const summary = `${header}exit  seconds  step\n${rows.join('\n')}\n${timed.join('\n')}\nwall time ${String(wall)}s, with setup first and then each job's steps in order, the jobs at the same time\n${verdict}\n`;
    writeFileSync(join(folder, 'summary.txt'), summary);
    process.stdout.write(`\n${summary}`);
    return stopping.signal.aborted ? 3 : passed ? 0 : 1;
  } finally {
    clearInterval(watch);
    rmSync(stopFile, { force: true });
    rmSync(recordFile, { force: true });
  }
}

const mode = process.argv.slice(2);
const only = mode.length === 1 ? mode[0] : undefined;
if (only === '--stop') {
  process.exitCode = await stop();
} else {
  const { steps, problems } = planOf(readFileSync(join(root, workflowFile), 'utf8'));
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}
`);
    process.exitCode = 1;
  } else if (only === '--plan') {
    for (const step of steps) process.stdout.write(`${step.name}
`);
  } else if (mode.length === 0) {
    process.exitCode = await runAll(steps);
  } else {
    process.stderr.write('Run node tools/ci-local/main.ts to run CI, add --plan to print its steps without running them, or run it with --stop to stop the run this worktree recorded.\n');
    process.exitCode = 2;
  }
}
