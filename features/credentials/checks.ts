import type { ConnectorKind } from '../../shared/db/types.ts';
import { codexCheck, type CodexCheckSettings } from './codex-check.ts';
import { githubCheck, type GithubCheckSettings } from './github-check.ts';
import type { Check } from './kinds.ts';

export type Checks = { readonly [K in ConnectorKind]: Check };

export type CheckSettings = { readonly codex: CodexCheckSettings; readonly github: GithubCheckSettings };

export const checksFor = (settings: CheckSettings): Checks => ({
  codex: codexCheck(settings.codex),
  github: githubCheck(settings.github),
});
