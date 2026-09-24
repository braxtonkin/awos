import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { codexLogin } from '../../shared/codex-login.ts';

export const layout = { workspace: '/workspace', codexHome: '/home/codex/.codex' } as const;

const commit = z.string().regex(/^[0-9a-f]{40}$/, { error: 'must be a full 40-character commit id' });

export const attemptBranch = (taskKey: string, attempt: number): string => `autoworker/${taskKey}-attempt-${String(attempt)}`;

export const jobEnvironment = z.object({
  ATTEMPT_ID: z.string().regex(/^[1-9][0-9]*$/, { error: 'must be an attempt id' }),
  ATTEMPT_TOKEN: z.string().min(32, { error: 'must be at least 32 characters' }),
  ENGINE_URL: z.url({ protocol: /^https?$/ }),
  REPO_URL: z.url({ protocol: /^(https|git)$/ }),
  START_COMMIT: commit,
  ATTEMPT_BRANCH: z.string().regex(/^autoworker\/[A-Za-z0-9._-]+-attempt-[1-9][0-9]*$/, { error: 'must be autoworker/<task key>-attempt-<n>' }),
  GITHUB_TOKEN: z.string().regex(/^\S+$/, { error: 'must be one word' }),
  CODEX_AUTH_JSON: z.string().refine(login => codexLogin.safeParse(login).data?.tokens.refresh_token === '', {
    error: 'must be an access-only Codex auth.json, whose tokens.refresh_token is blank',
  }),
  GIT_AUTHOR_NAME: z.string().trim().min(1),
  GIT_AUTHOR_EMAIL: z.email(),
});

export type JobEnvironment = z.infer<typeof jobEnvironment>;

export type SecretKey = keyof JobEnvironment;

export function readJobEnvironment(env: NodeJS.ProcessEnv): JobEnvironment | { readonly problems: readonly string[] } {
  const parsed = jobEnvironment.safeParse(env);
  return parsed.success ? parsed.data : { problems: parsed.error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`) };
}

export type Account = { readonly uid: number; readonly gid: number; readonly home: string };

export type Accounts = { readonly bridge: Account; readonly codex: Account };

export async function accounts(): Promise<Accounts> {
  const found = new Map(
    (await readFile('/etc/passwd', 'utf8')).split('\n').flatMap(line => {
      const [name, , uid, gid, , home] = line.split(':');
      return name === undefined || home === undefined ? [] : [[name, { uid: Number(uid), gid: Number(gid), home }] as const];
    }),
  );
  const bridge = found.get('bridge');
  const codex = found.get('codex');
  if (bridge === undefined || codex === undefined) throw new Error('this image has no bridge and codex users, so it does not extend the attempt image');
  return { bridge, codex };
}

const credentialHelper = '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$GITHUB_TOKEN"; }; f';

type Run = { readonly as: Account; readonly env: Readonly<Record<string, string>>; readonly input?: string };

const asCodex = (as: Account, env: JobEnvironment): Run => ({
  as,
  env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', HOME: as.home, GITHUB_TOKEN: env.GITHUB_TOKEN, GIT_TERMINAL_PROMPT: '0' },
});

function run(command: string, args: readonly string[], { as, env, input }: Run, cwd = '/'): Promise<string> {
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

const git = (args: readonly string[], given: Run): Promise<string> => run('git', ['-C', layout.workspace, ...args], given);

export type Ready = { readonly commit: string; readonly branch: string };

export async function prepareWorkspace(env: JobEnvironment): Promise<Ready> {
  const { codex } = await accounts();
  const given = asCodex(codex, env);
  await run('git', ['init', '--quiet', `--initial-branch=${env.ATTEMPT_BRANCH}`, layout.workspace], given);
  for (const [key, value] of [
    ['credential.helper', credentialHelper],
    ['user.name', env.GIT_AUTHOR_NAME],
    ['user.email', env.GIT_AUTHOR_EMAIL],
  ] as const) {
    await git(['config', key, value], given);
  }
  await git(['remote', 'add', 'origin', env.REPO_URL], given);
  await git(['fetch', '--quiet', 'origin', env.START_COMMIT], given);
  await git(['checkout', '--quiet', '-B', env.ATTEMPT_BRANCH, env.START_COMMIT], given);
  const head = await git(['rev-parse', 'HEAD'], given);
  if (head !== env.START_COMMIT) throw new Error(`the workspace is at ${head}, not the start commit ${env.START_COMMIT}`);
  await run('sh', ['-c', 'umask 077 && mkdir -p "$1" && cat > "$1/auth.json"', 'sh', layout.codexHome], { ...given, input: env.CODEX_AUTH_JSON });
  return { commit: head, branch: env.ATTEMPT_BRANCH };
}

export type StepPush = { readonly pushed: string } | { readonly unchanged: string };

export async function pushStep(env: JobEnvironment, message: string, lastPushed: string | undefined): Promise<StepPush> {
  const { codex } = await accounts();
  const given = asCodex(codex, env);
  await git(['add', '--all'], given);
  const staged = await git(['diff', '--cached', '--name-only'], given);
  if (staged !== '') await git(['commit', '--quiet', '--message', message], given);
  const head = await git(['rev-parse', 'HEAD'], given);
  if (head === (lastPushed ?? env.START_COMMIT)) return { unchanged: head };
  const ref = `refs/heads/${env.ATTEMPT_BRANCH}`;
  await git(['push', '--quiet', '--no-verify', `--force-with-lease=${ref}:${lastPushed ?? ''}`, 'origin', `HEAD:${ref}`], given);
  return { pushed: head };
}
