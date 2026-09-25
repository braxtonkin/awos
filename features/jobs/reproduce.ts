import { spawn } from 'node:child_process';
import { outputLimit, reproductionPath, type RanScript, type Reproduction, type Side } from '../../shared/reproduction.ts';
import { accounts, asBridge, asUser, bridgeGit, layout, path, run, type Account, type JobEnvironment } from './workspace.ts';

export type ReproducePlan = { readonly base: string; readonly change: string; readonly setup: string | null };

export type Limits = { readonly setupMs: number; readonly runMs: number; readonly graceMs: number };

export const reproduceLimits: Limits = { setupMs: 600_000, runMs: 300_000, graceMs: 2_000 };

const scriptLimit = outputLimit;

const kept = (text: string): string => (text.length <= outputLimit ? text : `[first ${String(text.length - outputLimit)} characters cut]\n${text.slice(-outputLimit)}`);

type Contained = { readonly as: Account; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly graceMs: number };

function contained(command: string, args: readonly string[], given: Contained): Promise<RanScript> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: given.cwd, env: given.env, uid: given.as.uid, gid: given.as.gid, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const keep = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-(outputLimit * 2));
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const group = (): void => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      group();
    }, given.timeoutMs);
    let finished = false;
    const finish = (exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      group();
      resolve({ exitCode, timedOut, output: kept(output) });
    };
    child.on('error', error => {
      output += `\n${error.message}`;
      finish(null);
    });
    child.on('exit', code => {
      setTimeout(() => {
        finish(code);
      }, given.graceMs);
    });
    child.on('close', code => {
      finish(code);
    });
  });
}

async function killAll(...users: readonly Account[]): Promise<void> {
  for (const user of users) await contained('sh', ['-c', 'kill -KILL -1 2>/dev/null; true'], { as: user, cwd: '/', env: { PATH: path() }, timeoutMs: 10_000, graceMs: 100 });
}

async function readScript(codex: Account): Promise<{ readonly script: string } | { readonly reason: string }> {
  const read = await contained('sh', ['-c', `test -f "$1" && head -c ${String(scriptLimit + 1)} "$1"`, 'sh', reproductionPath], {
    as: codex,
    cwd: '/',
    env: { PATH: path() },
    timeoutMs: 10_000,
    graceMs: 100,
  });
  if (read.exitCode !== 0) return { reason: `the agent left no file at ${reproductionPath}` };
  if (read.output.length > scriptLimit) return { reason: `the script at ${reproductionPath} is longer than ${String(scriptLimit)} characters` };
  if (read.output.trim() === '') return { reason: `the script at ${reproductionPath} is empty` };
  return { script: read.output };
}

function extract(bridgeRun: ReturnType<typeof asBridge>, runner: Account, commit: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = spawn('git', [`--git-dir=${layout.bridgeGit}`, 'archive', '--format=tar', commit], { env: bridgeRun.env, uid: bridgeRun.as.uid, gid: bridgeRun.as.gid, stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-x', '-C', into], { env: { PATH: path() }, uid: runner.uid, gid: runner.gid, stdio: ['pipe', 'ignore', 'pipe'] });
    archive.stdout.pipe(tar.stdin);
    let err = '';
    archive.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    tar.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    let archived: number | null = null;
    archive.on('close', code => (archived = code));
    archive.on('error', reject);
    tar.on('error', reject);
    tar.on('close', code => {
      if (code === 0 && archived === 0) resolve();
      else reject(new Error(`checking out ${commit} failed: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

async function ensureCommit(env: JobEnvironment, bridgeRun: ReturnType<typeof asBridge>, commit: string): Promise<void> {
  const present = await bridgeGit(['cat-file', '-e', `${commit}^{commit}`], bridgeRun).then(
    () => true,
    () => false,
  );
  if (!present) await bridgeGit(['fetch', '--quiet', env.REPO_URL, commit], bridgeRun);
}

async function checkout(env: JobEnvironment, commit: string, script: string): Promise<{ readonly folder: string; readonly file: string } | { readonly failed: string }> {
  const { bridge, reproduce: runner } = await accounts();
  const bridgeRun = asBridge(bridge, env);
  const asRunner = asUser(runner);
  try {
    await ensureCommit(env, bridgeRun, commit);
    const folder = await run('mktemp', ['-d', '/tmp/autoworker-run.XXXXXX'], asRunner);
    await run('mkdir', [`${folder}/tree`, `${folder}/home`, `${folder}/tmp`], asRunner);
    await run('sh', ['-c', 'cat > "$1"', 'sh', `${folder}/reproduce.sh`], { ...asRunner, input: script });
    await extract(bridgeRun, runner, commit, `${folder}/tree`);
    return { folder, file: `${folder}/reproduce.sh` };
  } catch (error) {
    return { failed: kept(error instanceof Error ? error.message : String(error)) };
  }
}

const inTree = 'cd "$1" || exit 125; shift; exec sh "$@"';

async function side(env: JobEnvironment, plan: ReproducePlan, commit: string, script: string, limits: Limits): Promise<Side> {
  const { codex, reproduce: runner } = await accounts();
  await killAll(codex, runner);
  const made = await checkout(env, commit, script);
  if ('failed' in made) return { commit, checkout: made.failed, setup: null, run: null };
  const scrubbed = { PATH: path(), HOME: `${made.folder}/home`, TMPDIR: `${made.folder}/tmp`, LANG: 'C.UTF-8', CI: 'true' };
  const given = { as: runner, cwd: '/', env: scrubbed, graceMs: limits.graceMs };
  const tree = `${made.folder}/tree`;
  const setup = plan.setup === null ? null : await contained('sh', ['-c', inTree, 'sh', tree, '-c', plan.setup], { ...given, timeoutMs: limits.setupMs });
  const ready = setup === null || (setup.exitCode === 0 && !setup.timedOut);
  const ran = ready ? await contained('sh', ['-c', inTree, 'sh', tree, made.file], { ...given, timeoutMs: limits.runMs }) : null;
  await killAll(codex, runner);
  return { commit, checkout: null, setup, run: ran };
}

export async function reproduce(env: JobEnvironment, plan: ReproducePlan, limits: Limits = reproduceLimits): Promise<Reproduction> {
  const { codex, reproduce: runner } = await accounts();
  await killAll(codex, runner);
  const read = await readScript(codex);
  if ('reason' in read) return { state: 'no_script', reason: read.reason };
  const base = await side(env, plan, plan.base, read.script, limits);
  const change = await side(env, plan, plan.change, read.script, limits);
  return { state: 'ran', script: read.script, base, change };
}
