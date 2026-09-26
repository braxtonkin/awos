import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { codexLogin } from '../../shared/codex-login.ts';
import { outputLimit, setupLog, type RanScript } from '../../shared/reproduction.ts';

export const layout = { workspace: '/workspace', codexHome: '/home/codex/.codex', bridgeGit: '/var/lib/autoworker/attempt.git', startBundle: '/var/lib/autoworker/start.bundle' } as const;

const commit = z.string().regex(/^[0-9a-f]{40}$/, { error: 'must be a full 40-character commit id' });

export const attemptBranch = (taskKey: string, attempt: number): string => `autoworker/${taskKey}-attempt-${String(attempt)}`;

const common = z.object({
  ATTEMPT_ID: z.string().regex(/^[1-9][0-9]*$/, { error: 'must be an attempt id' }),
  ATTEMPT_TOKEN: z.string().min(32, { error: 'must be at least 32 characters' }),
  ENGINE_URL: z.url({ protocol: /^https?$/ }),
  REPO_URL: z.url({ protocol: /^(https|git)$/ }),
  START_COMMIT: commit,
  ATTEMPT_BRANCH: z.string().regex(/^autoworker\/[A-Za-z0-9._/-]+-attempt-[1-9][0-9]*$/, { error: 'must be autoworker/<task key>-attempt-<n>' }),
  GITHUB_TOKEN: z.string().regex(/^\S+$/, { error: 'must be one word' }),
  CODEX_AUTH_JSON: z.string().refine(login => codexLogin.safeParse(login).data?.tokens.refresh_token === '', {
    error: 'must be an access-only Codex auth.json, whose tokens.refresh_token is blank',
  }),
  GIT_AUTHOR_NAME: z.string().trim().min(1),
  GIT_AUTHOR_EMAIL: z.email(),
});

const setupCommand = z.string().trim().transform(text => (text === '' ? null : text));

const plan = z.discriminatedUnion('AFTER_TURN', [
  z.object({ AFTER_TURN: z.literal('push'), SETUP_COMMAND: setupCommand, MERGE_HEAD: z.union([z.literal(''), commit]).transform(value => (value === '' ? null : value)) }),
  z.object({ AFTER_TURN: z.literal('reproduce'), BASE_COMMIT: commit, SETUP_COMMAND: setupCommand }),
]);

export type PlanKeys = z.input<typeof plan>;

export const jobEnvironment = common.and(plan);

export type JobEnvironment = z.infer<typeof jobEnvironment>;

export type SecretKeys = { readonly [Key in keyof z.infer<typeof common>]: string } & PlanKeys;

export function readJobEnvironment(env: NodeJS.ProcessEnv): JobEnvironment | { readonly problems: readonly string[] } {
  const parsed = jobEnvironment.safeParse(env);
  return parsed.success ? parsed.data : { problems: parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`) };
}

export type Account = { readonly uid: number; readonly gid: number; readonly home: string };

export type Accounts = { readonly bridge: Account; readonly codex: Account; readonly reproduce: Account };

export async function accounts(): Promise<Accounts> {
  const found = new Map(
    (await readFile('/etc/passwd', 'utf8')).split('\n').flatMap(line => {
      const [name, , uid, gid, , home] = line.split(':');
      return name === undefined || home === undefined ? [] : [[name, { uid: Number(uid), gid: Number(gid), home }] as const];
    }),
  );
  const bridge = found.get('bridge');
  const codex = found.get('codex');
  const reproduce = found.get('reproduce');
  if (bridge === undefined || codex === undefined || reproduce === undefined) throw new Error('this image has no bridge, codex, and reproduce users, so it does not extend the attempt image');
  return { bridge, codex, reproduce };
}

const credentialHelper = '!f() { test "$1" = get && printf "username=x-access-token\npassword=%s\n" "$GITHUB_TOKEN"; }; f';

export type Run = { readonly as: Account; readonly env: Readonly<Record<string, string>>; readonly input?: string };

export const path = (): string => process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin';

export const quiet = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } as const;

export const asBridge = (as: Account, env: JobEnvironment): Run => ({ as, env: { PATH: path(), HOME: as.home, GITHUB_TOKEN: env.GITHUB_TOKEN, ...quiet } });

export const asUser = (as: Account): Run => ({ as, env: { PATH: path(), HOME: as.home, ...quiet } });

export function run(command: string, args: readonly string[], { as, env, input }: Run, cwd = '/'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, uid: as.uid, gid: as.gid, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${command} ${args.slice(0, 2).join(' ')} ended ${signal ?? `with exit ${String(code)}`}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

export const kept = (text: string): string => (text.length <= outputLimit ? text : `[first ${String(text.length - outputLimit)} characters cut]\n${text.slice(-outputLimit)}`);

export type Contained = { readonly as: Account; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly timeoutMs: number; readonly graceMs: number };

export function contained(command: string, args: readonly string[], given: Contained): Promise<RanScript> {
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

export const bridgeGit = (args: readonly string[], given: Run): Promise<string> => run('git', [`--git-dir=${layout.bridgeGit}`, `--work-tree=${layout.workspace}`, ...args], given);

const codexGit = (args: readonly string[], given: Run): Promise<string> => run('git', ['-C', layout.workspace, ...args], given);

export type Ready = { readonly commit: string; readonly branch: string; readonly merging: string | null };

const mergeRef = 'refs/heads/autoworker-base';

const isAncestor = (git: Git, ancestor: string, commit: string): Promise<boolean> =>
  git(['merge-base', '--is-ancestor', ancestor, commit]).then(
    () => true,
    () => false,
  );

async function startMerge(agent: Run, merging: string): Promise<void> {
  await codexGit(['-c', 'merge.conflictStyle=zdiff3', 'merge', '--quiet', '--no-ff', '--no-commit', merging], agent).catch(() => undefined);
  const started = await codexGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], agent).catch(() => '');
  if (started !== merging) throw new Error(`git did not start merging ${merging} into the workspace`);
}

export async function prepareWorkspace(env: JobEnvironment): Promise<Ready> {
  const { bridge, codex } = await accounts();
  const owner = asBridge(bridge, env);
  const agent = asUser(codex);
  const ref = `refs/heads/${env.ATTEMPT_BRANCH}`;
  await run('git', ['init', '--quiet', '--bare', layout.bridgeGit], owner);
  await run('chmod', ['0700', layout.bridgeGit], owner);
  for (const [key, value] of [
    ['core.bare', 'false'],
    [`credential.${new URL(env.REPO_URL).origin}.helper`, credentialHelper],
    ['user.name', env.GIT_AUTHOR_NAME],
    ['user.email', env.GIT_AUTHOR_EMAIL],
  ] as const) {
    await bridgeGit(['config', key, value], owner);
  }
  const merge = env.AFTER_TURN === 'push' ? env.MERGE_HEAD : null;
  await bridgeGit(['fetch', '--quiet', env.REPO_URL, env.START_COMMIT, ...(merge === null ? [] : [merge])], owner);
  await bridgeGit(['update-ref', ref, env.START_COMMIT], owner);
  await bridgeGit(['symbolic-ref', 'HEAD', ref], owner);
  const merging = merge !== null && !(await isAncestor(asGit(owner), merge, env.START_COMMIT)) ? merge : null;
  if (merging !== null) await bridgeGit(['update-ref', mergeRef, merging], owner);
  await bridgeGit(['bundle', 'create', '--quiet', layout.startBundle, ref, ...(merging === null ? [] : [mergeRef])], owner);
  await run('git', ['clone', '--quiet', '--no-checkout', layout.startBundle, layout.workspace], agent);
  for (const [key, value] of [
    ['user.name', env.GIT_AUTHOR_NAME],
    ['user.email', env.GIT_AUTHOR_EMAIL],
  ] as const) {
    await codexGit(['config', key, value], agent);
  }
  await codexGit(['checkout', '--quiet', '-B', env.ATTEMPT_BRANCH, env.START_COMMIT], agent);
  await bridgeGit(['read-tree', 'HEAD'], owner);
  const heads = [await bridgeGit(['rev-parse', 'HEAD'], owner), await codexGit(['rev-parse', 'HEAD'], agent)];
  if (heads.some(head => head !== env.START_COMMIT)) throw new Error(`the workspace is at ${heads.join(' and ')}, not the start commit ${env.START_COMMIT}`);
  if (merging !== null) await startMerge(agent, merging);
  await run('sh', ['-c', 'umask 077 && mkdir -p "$1" && cat > "$1/auth.json"', 'sh', layout.codexHome], { ...agent, input: env.CODEX_AUTH_JSON });
  return { commit: env.START_COMMIT, branch: env.ATTEMPT_BRANCH, merging };
}

export const setupMs = 600_000;

export type Baseline = { readonly before: string; readonly after: string };

export type SetUp = { readonly ended: string; readonly baseline: Baseline };

const snapshot = async (owner: Run): Promise<string> => {
  await bridgeGit(['add', '--all'], owner);
  return bridgeGit(['write-tree'], owner);
};

const endedAs = (command: string, ran: RanScript): string =>
  `\`${command}\` ${ran.timedOut ? `ran out of time after ${String(setupMs / 1000)} s` : ran.exitCode === null ? 'did not start' : `exited ${String(ran.exitCode)}`}`;

export async function setUp(env: JobEnvironment): Promise<SetUp | null> {
  if (env.AFTER_TURN !== 'push' || env.SETUP_COMMAND === null) return null;
  const { bridge, codex } = await accounts();
  const owner = asBridge(bridge, env);
  const before = await snapshot(owner);
  const ran = await contained('sh', ['-c', env.SETUP_COMMAND], { as: codex, cwd: layout.workspace, env: { PATH: path(), HOME: layout.codexHome, LANG: 'C.UTF-8', CI: 'true' }, timeoutMs: setupMs, graceMs: 2_000 });
  const after = await snapshot(owner);
  const ended = endedAs(env.SETUP_COMMAND, ran);
  await run('sh', ['-c', 'cat > "$1"', 'sh', setupLog], { ...asUser(codex), input: `${ended}.\n\n${ran.output}\n` });
  return { ended, baseline: { before, after } };
}

export type Git = (args: readonly string[], input?: string) => Promise<string>;

const removed = /^0+$/;

export async function withoutSetup(git: Git, { before, after }: Baseline): Promise<string> {
  const now = await git(['write-tree']);
  const fields = (await git(['diff-tree', '-r', '-z', '--no-renames', after, now])).split('\0');
  const records: string[] = [];
  for (let at = 0; at + 1 < fields.length; at += 2) {
    const [, mode = '', , object = ''] = (fields[at] ?? '').slice(1).split(' ');
    records.push(`${removed.test(mode) ? '0' : mode} ${object}\t${fields[at + 1] ?? ''}`);
  }
  await git(['read-tree', before]);
  if (records.length > 0) await git(['update-index', '-z', '--index-info'], `${records.join('\0')}\0`);
  return git(['write-tree']);
}

const asGit =
  (owner: Run): Git =>
  (args, input) =>
    bridgeGit(args, input === undefined ? owner : { ...owner, input });

export type MergeCheck = { readonly start: string; readonly merge: string; readonly tree: string };

const marker = /^([<=>|])\1{6}( |$)/;

const listed = (files: readonly string[]): string => files.map(file => `\`${file}\``).join(', ');

const changedFiles = async (git: Git, from: string, to: string): Promise<ReadonlySet<string>> =>
  new Set((await git(['diff-tree', '-r', '-z', '--name-only', '--no-renames', from, to])).split('\0').filter(file => file !== ''));

const linesAt = async (git: Git, at: string, file: string): Promise<ReadonlySet<string>> => new Set((await git(['cat-file', 'blob', `${at}:${file}`]).catch(() => '')).split('\n'));

export async function mergeProblem(git: Git, { start, merge, tree }: MergeCheck): Promise<string | null> {
  const common = await git(['merge-base', start, merge]);
  const [theirs, ours, kept] = await Promise.all([changedFiles(git, common, merge), changedFiles(git, common, start), changedFiles(git, start, tree)]);
  const marked: string[] = [];
  for (const file of [...theirs].filter(changed => ours.has(changed))) {
    const [now, before, incoming] = await Promise.all([linesAt(git, tree, file), linesAt(git, start, file), linesAt(git, merge, file)]);
    if ([...now].some(line => marker.test(line) && !before.has(line) && !incoming.has(line))) marked.push(file);
  }
  if (marked.length > 0) return `${listed(marked)} still ${marked.length === 1 ? 'holds' : 'hold'} conflict markers`;
  const dropped = [...theirs].filter(file => !ours.has(file) && !kept.has(file));
  return dropped.length > 0 ? `the merge takes back what the base branch changed in ${listed(dropped)}` : null;
}

const probe = (codex: Account, args: readonly string[]): Promise<RanScript> =>
  contained('git', ['-C', layout.workspace, ...args], { as: codex, cwd: '/', env: { PATH: path(), HOME: codex.home, ...quiet }, timeoutMs: 60_000, graceMs: 100 });

async function stillMerging(codex: Account, merge: string): Promise<boolean> {
  const head = await probe(codex, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']);
  if (head.exitCode === 0 && head.output.trim() === merge) return true;
  return (await probe(codex, ['merge-base', '--is-ancestor', merge, 'HEAD'])).exitCode === 0;
}

export type StepPush = { readonly pushed: string } | { readonly unchanged: string } | { readonly declined: string };

export async function pushStep(env: JobEnvironment, message: string, lastPushed: string | undefined, baseline: Baseline | null = null): Promise<StepPush> {
  const { bridge, codex } = await accounts();
  const owner = asBridge(bridge, env);
  const git = asGit(owner);
  await git(['add', '--all']);
  const tree = baseline === null ? await git(['write-tree']) : await withoutSetup(git, baseline);
  const [parent = '', parentTree = '', before = ''] = (await git(['rev-parse', 'HEAD', 'HEAD^{tree}', `${lastPushed ?? env.START_COMMIT}^{tree}`])).split('\n');
  const merge = env.AFTER_TURN === 'push' && env.MERGE_HEAD !== null && !(await isAncestor(git, env.MERGE_HEAD, parent)) ? env.MERGE_HEAD : null;
  if (merge !== null) {
    const problem = (await stillMerging(codex, merge)) ? await mergeProblem(git, { start: parent, merge, tree }) : `the workspace no longer holds the merge of ${merge}, so the pull request would still conflict with its base branch`;
    if (problem !== null) return { declined: problem };
  }
  const head = merge !== null ? await git(['commit-tree', tree, '-p', parent, '-p', merge, '-m', message]) : tree === parentTree ? parent : await git(['commit-tree', tree, '-p', parent, '-m', message]);
  if (head !== parent) await git(['update-ref', 'HEAD', head]);
  if (merge === null && tree === before) return { unchanged: head };
  const ref = `refs/heads/${env.ATTEMPT_BRANCH}`;
  try {
    await bridgeGit(['push', '--quiet', '--no-verify', `--force-with-lease=${ref}:${lastPushed ?? ''}`, env.REPO_URL, `HEAD:${ref}`], owner);
  } catch (error) {
    const remote = (await bridgeGit(['ls-remote', env.REPO_URL, ref], owner)).split('\t')[0];
    if (remote !== head) throw error;
  }
  return { pushed: head };
}
