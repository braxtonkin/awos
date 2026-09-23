import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { fail, pass, type Check, type Scenario } from './check.ts';

const loginFile = '/codex/auth.json';
const loginCheck = 'no mounted Codex login holds a refresh token';
const answerWait = 15_000;

const unset = (input: unknown): string | undefined => (input === undefined ? 'missing' : input === '' ? 'empty' : undefined);

const Token = z
  .string({ error: issue => unset(issue.input) })
  .regex(/^\S+$/, { error: issue => unset(issue.input) ?? 'holds a space or a line break' });

const Sandbox = z.object({
  JIRA_SITE: z.url({ protocol: /^https$/, error: issue => unset(issue.input) ?? 'not an https address' }),
  JIRA_EMAIL: z.email({ error: issue => unset(issue.input) ?? 'not an email address' }),
  JIRA_API_TOKEN: Token,
  GITHUB_TOKEN: Token,
});

type Sandbox = z.infer<typeof Sandbox>;

const CodexLogin = z.object({ tokens: z.object({ access_token: z.string().min(1), refresh_token: z.string().nullish() }) });

const GitHubUser = z.object({ login: z.string() });

function sandboxKeys(): { readonly checks: readonly Check[]; readonly sandbox: Sandbox | undefined } {
  const parsed = Sandbox.safeParse(process.env);
  const checks = Sandbox.keyof().options.map(key => {
    const issue = parsed.error?.issues.find(candidate => candidate.path[0] === key);
    return issue === undefined ? pass(`${key} set`, '') : fail(`${key} set`, issue.message);
  });
  return { checks, sandbox: parsed.success ? parsed.data : undefined };
}

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function codexLogin(): Promise<Check> {
  let text: string;
  try {
    text = await readFile(loginFile, 'utf8');
  } catch (error) {
    return isMissing(error) ? pass(loginCheck, `none is mounted at ${loginFile}`) : fail(loginCheck, `${loginFile} is not a readable file`);
  }
  const login = CodexLogin.safeParse(parseJson(text));
  if (!login.success) return fail(loginCheck, `${loginFile} is not a Codex login`);
  return (login.data.tokens.refresh_token ?? '') === ''
    ? pass(loginCheck, `the one at ${loginFile} is access-only`)
    : fail(loginCheck, `the one at ${loginFile} holds one, so a lane could rotate the login. Mount an access-only copy`);
}

const errorCode = (error: unknown): string => {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') return cause.code;
  return error instanceof Error ? error.name : 'unknown error';
};

async function ask(url: URL, headers: Readonly<Record<string, string>>): Promise<Response | string> {
  try {
    return await fetch(url, { headers, signal: AbortSignal.timeout(answerWait) });
  } catch (error) {
    return `no answer, ${errorCode(error)}`;
  }
}

async function jira(sandbox: Sandbox): Promise<Check> {
  const basic = Buffer.from(`${sandbox.JIRA_EMAIL}:${sandbox.JIRA_API_TOKEN}`).toString('base64');
  const answer = await ask(new URL('/rest/api/3/myself', sandbox.JIRA_SITE), { authorization: `Basic ${basic}`, accept: 'application/json' });
  if (typeof answer === 'string') return fail('jira unreachable', answer);
  return answer.status === 200 ? pass('jira 200', '') : fail(`jira ${String(answer.status)}`, '');
}

async function github(sandbox: Sandbox): Promise<Check> {
  const answer = await ask(new URL('https://api.github.com/user'), {
    authorization: `Bearer ${sandbox.GITHUB_TOKEN}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'autoworker-verify',
    'x-github-api-version': '2022-11-28',
  });
  if (typeof answer === 'string') return fail('github unreachable', answer);
  if (answer.status !== 200) return fail(`github ${String(answer.status)}`, '');
  const user = GitHubUser.safeParse(await answer.json());
  return pass('github 200', user.success ? `as ${user.data.login}` : '');
}

export const accounts: Scenario = {
  name: 'accounts',
  summary: 'checks the sandbox keys, the mounted Codex login, and the Jira and GitHub tokens, and prints no value',
  run: async () => {
    const { checks, sandbox } = sandboxKeys();
    const login = await codexLogin();
    if (sandbox === undefined || !login.passed) return [...checks, login];
    return [...checks, login, await jira(sandbox), await github(sandbox)];
  },
};
