import { githubFromEnvironment, type GitHub } from './github.ts';
import { jiraFromEnvironment, type Jira } from './jira.ts';

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
  const jira = jiraFromEnvironment(process.env);
  return {
    name: 'sandbox',
    jira,
    github: githubFromEnvironment(process.env, repository),
    engine: {
      settings: { JIRA_SITE: jira.site },
      secrets: { github: process.env['GITHUB_TOKEN'] ?? '', jiraLogin: `${jira.email}:${process.env['JIRA_API_TOKEN'] ?? ''}` },
      codexLogin,
      image: attemptImage => Promise.resolve(attemptImage),
      trustLogins: false,
    },
    stop: () => Promise.resolve(),
  };
}
