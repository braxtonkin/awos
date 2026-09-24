import type { ConnectorKind } from '../../shared/db/types.ts';
import { codexCheck, type CodexCheckSettings } from './codex-check.ts';
import { githubCheck, type GithubCheckSettings } from './github-check.ts';
import { jiraCheck, type JiraCheckSettings } from './jira-check.ts';
import type { Check } from './kinds.ts';

export type Checks = { readonly [K in ConnectorKind]: Check };

export type CheckSettings = { readonly codex: CodexCheckSettings; readonly github: GithubCheckSettings; readonly jira: JiraCheckSettings };

export const checksFor = (settings: CheckSettings): Checks => ({
  codex: codexCheck(settings.codex),
  github: githubCheck(settings.github),
  jira: jiraCheck(settings.jira),
});
