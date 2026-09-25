import { githubTokenFromEnvironment, githubWithToken, type GitHub } from './github.ts';
import { jiraAt, jiraLoginFromEnvironment, type Jira } from './jira.ts';

export const worldNames = ['sandbox', 'local'] as const;

export type WorldName = (typeof worldNames)[number];

export type EngineWorld = {
  readonly settings: Readonly<Record<string, string>>;
  readonly secrets: { readonly github: string; readonly jiraLogin: string };
  readonly codexLogin: () => Promise<string>;
  readonly image: (attemptImage: string) => Promise<string>;
  readonly trustLogins: boolean;
};

export type World = {
  readonly name: WorldName;
  readonly jira: Jira;
  readonly github: GitHub;
  readonly engine: EngineWorld;
  readonly stop: () => Promise<void>;
};

export function sandboxWorld(repository: string, codexLogin: () => Promise<string>): World {
  const login = jiraLoginFromEnvironment(process.env);
  const githubToken = githubTokenFromEnvironment(process.env);
  const jira = jiraAt(login.site, login.email, login.token);
  return {
    name: 'sandbox',
    jira,
    github: githubWithToken(githubToken, repository),
    engine: {
      settings: { JIRA_SITE: jira.site },
      secrets: { github: githubToken, jiraLogin: `${login.email}:${login.token}` },
      codexLogin,
      image: attemptImage => Promise.resolve(attemptImage),
      trustLogins: false,
    },
    stop: () => Promise.resolve(),
  };
}
