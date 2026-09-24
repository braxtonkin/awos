import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

const helper = '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$GITHUB_TOKEN"; }; f';

export const repositoryUrl = (base: string, github: string): string => `${base.endsWith('/') ? base : `${base}/`}${github}.git`;

export async function remoteHead(url: string, branch: string, token: string): Promise<string> {
  const { protocol, origin } = new URL(url);
  const credential = protocol === 'https:' ? ['-c', `credential.${origin}.helper=${helper}`] : [];
  const { stdout } = await run('git', [...credential, 'ls-remote', url, `refs/heads/${branch}`], {
    cwd: tmpdir(),
    env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', GITHUB_TOKEN: token, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    timeout: 60_000,
  });
  const head = /^([0-9a-f]{40})\t/m.exec(stdout)?.[1];
  if (head === undefined) throw new Error(`${url} has no branch ${branch}`);
  return head;
}
