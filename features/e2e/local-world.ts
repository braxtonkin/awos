import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gitServer } from '../../tools/verify/cluster.ts';
import { startFakeGitHub } from './fake-github.ts';
import { startFakeJira } from './fake-jira.ts';
import { githubAt, type GitHub } from './github.ts';
import { jiraAt, type Jira } from './jira.ts';

const run = promisify(execFile);

export const localLogins = {
  githubToken: 'fake-github-token',
  jiraEmail: 'owner@example.com',
  jiraToken: 'fake-jira-token',
  jiraAccountId: 'fake-account-1',
} as const;

export type EngineSettings = { readonly GITHUB_API_URL: string; readonly GIT_BASE_URL: string; readonly JIRA_SITE: string };

export type EngineSecrets = { readonly GITHUB_TOKEN: string; readonly AUTOWORKER_JIRA_LOGIN: string };

export type LocalWorld = {
  readonly jira: Jira;
  readonly github: GitHub;
  readonly engine: { readonly settings: EngineSettings; readonly secrets: EngineSecrets };
  readonly stop: () => Promise<void>;
};

async function emptyBareRepository(folder: string, repository: string): Promise<string> {
  const bare = join(folder, `${repository}.git`);
  await mkdir(dirname(bare), { recursive: true });
  await run('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  await run('git', ['-C', bare, 'config', 'daemon.receivepack', 'true']);
  await run('git', ['-C', bare, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
  return bare;
}

export async function startLocalWorld(address: string, repository: string): Promise<LocalWorld> {
  const git = await gitServer(address);
  const bare = await emptyBareRepository(git.folder, repository);
  const github = await startFakeGitHub({ bare, repository, token: localLogins.githubToken });
  const jira = await startFakeJira({ email: localLogins.jiraEmail, token: localLogins.jiraToken, accountId: localLogins.jiraAccountId });
  return {
    jira: jiraAt(jira.url, localLogins.jiraEmail, localLogins.jiraToken),
    github: githubAt({ apiUrl: github.url, token: localLogins.githubToken, repository, webUrl: github.webUrl, cloneUrl: `${git.base}${repository}.git`, pushEnvironment: {} }),
    engine: {
      settings: { GITHUB_API_URL: github.url, GIT_BASE_URL: git.base, JIRA_SITE: jira.url },
      secrets: { GITHUB_TOKEN: localLogins.githubToken, AUTOWORKER_JIRA_LOGIN: `${localLogins.jiraEmail}:${localLogins.jiraToken}` },
    },
    stop: async () => {
      await jira.stop();
      await github.stop();
      await git.stop();
    },
  };
}
