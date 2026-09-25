import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ownerLabel } from '../verify/owner-label.ts';

type Yaml = null | string | readonly Yaml[] | { readonly [key: string]: Yaml };

type Line = { readonly number: number; readonly indent: number; readonly text: string };

type Step = { readonly job: string; readonly name: string; readonly args: readonly string[] };

type Plan = { readonly steps: readonly Step[]; readonly problems: readonly string[] };

type Result = { readonly name: string; readonly exit: number | null; readonly seconds: number; readonly log: string };

const root = fileURLToPath(new URL('../../', import.meta.url));
const workflowFile = '.github/workflows/ci.yml';
const setupJob = 'setup';
const setupRuns: ReadonlySet<string> = new Set(['docker compose build verify', 'docker compose run --rm verify npm ci']);
const verifyRun = 'docker compose run --rm verify ';
const plainWord = /^[A-Za-z0-9_./=:@+-]+$/;
const mappingEntry = /^([A-Za-z0-9_-]+):(?: (.*))?$/;
const unreadableStart = /^[-?:,\]{}#&*!|>%@`]/;

class Unreadable extends Error {}

const unreadable = (line: Line, problem: string): Unreadable => new Unreadable(`${workflowFile}:${String(line.number)} ${problem}`);

function linesOf(text: string): Line[] {
  return text.split('\n').flatMap((raw, index) => {
    const line = raw.replace(/\r$/, '');
    const at = { number: index + 1, indent: 0, text: line };
    if (line.includes('\t')) throw unreadable(at, 'holds a tab. Indent with spaces.');
    const text = line.trimStart();
    if (text === '') return [];
    const found = { number: index + 1, indent: line.length - text.length, text: text.trimEnd() };
    if (text.startsWith('#')) throw unreadable(found, 'holds a comment, which the ci-local reader does not read.');
    return [found];
  });
}

function scalar(line: Line, value: string): Yaml {
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw unreadable(line, `holds the single-quoted value ${value}, which does not end on its line.`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"')) {
    if (!/^"[^"\\]*"$/.test(value)) throw unreadable(line, `holds the double-quoted value ${value}, which ends off its line or holds an escape.`);
    return value.slice(1, -1);
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw unreadable(line, `holds the flow sequence ${value}, which does not end on its line.`);
    return value
      .slice(1, -1)
      .split(',')
      .map(item => item.trim())
      .map(item => {
        if (!plainWord.test(item)) throw unreadable(line, `holds the flow item "${item}", which is not a plain word.`);
        return item;
      });
  }
  if (unreadableStart.test(value)) throw unreadable(line, `holds the value "${value}", which starts with ${value.charAt(0)}, and the ci-local reader does not read that form.`);
  if (value.includes(' #') || value.includes(': ')) throw unreadable(line, `holds the value "${value}", which holds " #" or ": ", and the ci-local reader does not read that form.`);
  return value;
}

function readYaml(text: string): Yaml {
  const lines = linesOf(text);
  let at = 0;
  const peek = (): Line | undefined => lines[at];

  const block = (indent: number): Yaml => {
    const first = peek();
    if (first === undefined || first.indent !== indent) throw new Unreadable(`${workflowFile} ends where a nested value belongs.`);
    return first.text === '-' || first.text.startsWith('- ') ? sequence(indent) : mapping(indent);
  };

  const nested = (parent: Line): Yaml => {
    const next = peek();
    return next === undefined || next.indent <= parent.indent ? null : block(next.indent);
  };

  const sequence = (indent: number): Yaml => {
    const items: Yaml[] = [];
    for (let line = peek(); line?.indent === indent && (line.text === '-' || line.text.startsWith('- ')); line = peek()) {
      const content = line.text.slice(1).trimStart();
      if (content === '') {
        at += 1;
        items.push(nested(line));
      } else if (mappingEntry.test(content)) {
        lines[at] = { number: line.number, indent: indent + line.text.length - content.length, text: content };
        items.push(mapping(indent + line.text.length - content.length));
      } else {
        at += 1;
        items.push(scalar(line, content));
      }
    }
    return items;
  };

  const mapping = (indent: number): Yaml => {
    const entries: Record<string, Yaml> = {};
    for (let line = peek(); line?.indent === indent; line = peek()) {
      const [, key, value] = mappingEntry.exec(line.text) ?? [];
      if (key === undefined) throw unreadable(line, `holds "${line.text}", which is not a key and a value.`);
      if (Object.hasOwn(entries, key)) throw unreadable(line, `repeats the key ${key}.`);
      at += 1;
      entries[key] = value === undefined ? nested(line) : scalar(line, value);
    }
    return entries;
  };

  const value = block(0);
  const left = peek();
  if (left !== undefined) throw unreadable(left, 'is indented where no value can hold it.');
  return value;
}

const checkoutStep = z.strictObject({
  uses: z.string().regex(/^actions\/checkout@[0-9a-f]{40}$/),
  with: z.strictObject({ 'persist-credentials': z.literal('false') }).optional(),
});

const runStep = z.strictObject({ name: z.string().optional(), run: z.string() });

const workflowSchema = z.strictObject({
  name: z.string().optional(),
  on: z.unknown(),
  concurrency: z.unknown(),
  permissions: z.unknown(),
  jobs: z.record(z.string(), z.strictObject({ 'runs-on': z.string(), 'timeout-minutes': z.string().optional(), steps: z.array(z.unknown()).min(1) })),
});

const described = (step: unknown): string => {
  if (typeof step !== 'object' || step === null || Array.isArray(step)) return `is ${JSON.stringify(step)}`;
  return 'uses' in step && typeof step.uses === 'string' ? `uses ${step.uses}` : `has the keys ${Object.keys(step).join(', ')}`;
};

function command(run: string): readonly string[] | undefined {
  if (run === 'docker compose build verify') return run.split(' ').slice(1);
  if (!run.startsWith(verifyRun)) return undefined;
  const words = run.slice(verifyRun.length).split(' ');
  return words.every(word => plainWord.test(word)) ? ['compose', 'run', '--rm', '-T', 'verify', ...words] : undefined;
}

function planOf(text: string): Plan {
  let tree: Yaml;
  try {
    tree = readYaml(text);
  } catch (error) {
    if (error instanceof Unreadable) return { steps: [], problems: [error.message] };
    throw error;
  }
  const parsed = workflowSchema.safeParse(tree);
  if (!parsed.success) return { steps: [], problems: parsed.error.issues.map(issue => `${workflowFile} ${issue.path.map(String).join('.')}: ${issue.message}`) };
  const setup: Step[] = [];
  const steps: Step[] = [];
  const problems: string[] = [];
  for (const [job, { steps: listed }] of Object.entries(parsed.data.jobs)) {
    listed.forEach((step, index) => {
      const where = `${workflowFile} job ${job} step ${String(index + 1)}`;
      if (checkoutStep.safeParse(step).success) return;
      const run = runStep.safeParse(step);
      if (!run.success) {
        problems.push(`${where} ${described(step)}, which ci-local cannot run. It runs only run: steps and actions/checkout.`);
        return;
      }
      const args = command(run.data.run);
      if (args === undefined) {
        problems.push(`${where} runs "${run.data.run}", which ci-local cannot run. It runs docker compose build verify, and docker compose run --rm verify followed by plain words.`);
        return;
      }
      const isSetup = setupRuns.has(run.data.run);
      if (isSetup && setup.some(known => known.args.join(' ') === args.join(' '))) return;
      const owner = isSetup ? setupJob : job;
      (isSetup ? setup : steps).push({ job: owner, name: `${owner}: docker ${args.join(' ')}`, args });
    });
  }
  return { steps: [...setup, ...steps], problems };
}

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

function removeStepContainers(project: string, run: string | undefined): readonly string[] {
  const steps = dockerLines(['ps', '--all', '--quiet', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`, '--filter', run === undefined ? `label=${runLabel}` : `label=${runLabel}=${run}`]);
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

const labeled = (args: readonly string[], run: string): readonly string[] => {
  const [compose, verb, ...rest] = args;
  return compose === 'compose' && verb === 'run' ? [compose, verb, '--label', `${runLabel}=${run}`, ...rest] : args;
};

async function runStepOf(step: Step, index: number, folder: string, run: string): Promise<Result> {
  const log = join(folder, `${String(index + 1).padStart(2, '0')}-${step.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}.log`);
  const fd = openSync(log, 'w');
  const started = performance.now();
  try {
    writeFileSync(fd, `$ docker ${step.args.join(' ')}\n`);
    const exit = await new Promise<number | null>(resolve => {
      const child = spawn('docker', labeled(step.args, run), {
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
    await Promise.all(
      jobs.map(async job => {
        for (const index of indexesOf(job)) await run(index);
      }),
    );
    const ran = finished.filter(result => result !== undefined);
    const passed = !stopping.signal.aborted && ran.length === plan.length && ran.every(result => result.exit === 0);
    const rows = ran.map(result => `${String(result.exit).padEnd(6)}${String(result.seconds).padStart(7)}s  ${result.name}`);
    const wall = Math.round((performance.now() - started) / 1000);
    const verdict = stopping.signal.aborted ? 'STOPPED by node tools/ci-local/main.ts --stop' : passed ? 'PASS' : 'FAIL';
    const summary = `${header}exit  seconds  step\n${rows.join('\n')}\nwall time ${String(wall)}s, with setup first and then each job's steps in order, the jobs at the same time\n${verdict}\n`;
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
