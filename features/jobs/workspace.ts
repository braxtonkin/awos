import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { codexLogin } from '../../shared/codex-login.ts';

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

const afterTurn = z.discriminatedUnion('AFTER_TURN', [
  z.object({ AFTER_TURN: z.literal('push') }),
  z.object({ AFTER_TURN: z.literal('reproduce'), BASE_COMMIT: commit, SETUP_COMMAND: z.string().trim().transform(text => (text === '' ? null : text)) }),
]);

export type AfterTurnKeys = z.input<typeof afterTurn>;

export const jobEnvironment = common.and(afterTurn);

export type JobEnvironment = z.infer<typeof jobEnvironment>;

export type SecretKeys = { readonly [Key in keyof z.infer<typeof common>]: string } & AfterTurnKeys;

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

export const bridgeGit = (args: readonly string[], given: Run): Promise<string> => run('git', [`--git-dir=${layout.bridgeGit}`, `--work-tree=${layout.workspace}`, ...args], given);

const codexGit = (args: readonly string[], given: Run): Promise<string> => run('git', ['-C', layout.workspace, ...args], given);

export type Ready = { readonly commit: string; readonly branch: string };

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
  await bridgeGit(['fetch', '--quiet', env.REPO_URL, env.START_COMMIT], owner);
  await bridgeGit(['update-ref', ref, env.START_COMMIT], owner);
  await bridgeGit(['symbolic-ref', 'HEAD', ref], owner);
  await bridgeGit(['bundle', 'create', '--quiet', layout.startBundle, ref], owner);
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
  await run('sh', ['-c', 'umask 077 && mkdir -p "$1" && cat > "$1/auth.json"', 'sh', layout.codexHome], { ...agent, input: env.CODEX_AUTH_JSON });
  return { commit: env.START_COMMIT, branch: env.ATTEMPT_BRANCH };
}

export type StepPush = { readonly pushed: string } | { readonly unchanged: string };

export async function pushStep(env: JobEnvironment, message: string, lastPushed: string | undefined): Promise<StepPush> {
  const { bridge } = await accounts();
  const owner = asBridge(bridge, env);
  await bridgeGit(['add', '--all'], owner);
  const staged = await bridgeGit(['diff', '--cached', '--name-only'], owner);
  if (staged !== '') await bridgeGit(['commit', '--quiet', '--no-verify', '--message', message], owner);
  const head = await bridgeGit(['rev-parse', 'HEAD'], owner);
  const trees = await bridgeGit(['rev-parse', 'HEAD^{tree}', `${lastPushed ?? env.START_COMMIT}^{tree}`], owner);
  const [now, before] = trees.split('\n');
  if (now === before) return { unchanged: head };
  const ref = `refs/heads/${env.ATTEMPT_BRANCH}`;
  try {
    await bridgeGit(['push', '--quiet', '--no-verify', `--force-with-lease=${ref}:${lastPushed ?? ''}`, env.REPO_URL, `HEAD:${ref}`], owner);
  } catch (error) {
    const remote = (await bridgeGit(['ls-remote', env.REPO_URL, ref], owner)).split('\t')[0];
    if (remote !== head) throw error;
  }
  return { pushed: head };
}
