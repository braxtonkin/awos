import { z } from 'zod';
import { codexLogin } from '../../shared/codex-login.ts';
import type { ConnectorKind, CredentialState, JsonObject } from '../../shared/db/types.ts';
import { jiraLogin } from '../../shared/jira-login.ts';

type Inputs = {
  readonly codex: { readonly login: string; readonly madeForAutoWorker: boolean };
  readonly github: { readonly token: string };
  readonly jira: { readonly login: string };
};

export type Secret = { readonly [K in ConnectorKind]: { readonly connector: K } & Inputs[K] }[ConnectorKind];

export type Verdict = CredentialState;

export type Checked = {
  readonly verdict: Verdict;
  readonly cause: string;
  readonly expiresAt: Date | null;
  readonly rotated?: string;
};

export type Check = {
  readonly rotates: (secret: string) => boolean;
  readonly run: (secret: string, now: Date) => Promise<Checked>;
};

export type Read =
  | { readonly text: string; readonly expiresAt: Date | null; readonly audit: JsonObject }
  | { readonly refused: 'malformed' | 'refresh-token-not-made-for-autoworker'; readonly reason: string };

export type Unread = Extract<Read, { readonly refused: string }>['refused'];

const githubToken = z.string().regex(/^\S+$/, { error: 'must be one word with no spaces or line breaks' });

const refreshSignsOthersOut =
  'This Codex login holds a refresh token, and when the engine refreshes it, every other copy of this login is signed out, such as the Codex CLI on your computer. Store a login made for AutoWorker with `codex login --device-auth` and mark it as made for AutoWorker, or store a copy whose tokens.refresh_token is blank.';

function readCodex({ login, madeForAutoWorker }: Inputs['codex']): Read {
  const parsed = codexLogin.safeParse(login);
  if (!parsed.success) {
    return { refused: 'malformed', reason: `This is not a Codex login. Paste the whole auth.json that \`codex login\` wrote. ${z.prettifyError(parsed.error)}` };
  }
  const { access_token: access, refresh_token: refresh } = parsed.data.tokens;
  if (refresh.trim() !== '' && !madeForAutoWorker) return { refused: 'refresh-token-not-made-for-autoworker', reason: refreshSignsOthersOut };
  return { text: login, expiresAt: new Date(access.exp * 1000), audit: { madeForAutoWorker } };
}

function readGithub({ token }: Inputs['github']): Read {
  const parsed = githubToken.safeParse(token);
  if (!parsed.success) {
    return { refused: 'malformed', reason: `This is not a GitHub token. Copy the token from GitHub again and paste only the token. ${z.prettifyError(parsed.error)}` };
  }
  return { text: parsed.data, expiresAt: null, audit: {} };
}

function readJira({ login }: Inputs['jira']): Read {
  const parsed = jiraLogin.safeParse(login);
  if (!parsed.success) {
    return { refused: 'malformed', reason: `This is not a Jira login. Join the email of the Jira account and its API token with a colon, as email:token. ${z.prettifyError(parsed.error)}` };
  }
  return { text: `${parsed.data.email}:${parsed.data.token}`, expiresAt: null, audit: {} };
}

export function refreshable(login: string): boolean {
  const parsed = codexLogin.safeParse(login);
  return parsed.success && parsed.data.tokens.refresh_token.trim() !== '';
}

export function read(secret: Secret): Read {
  switch (secret.connector) {
    case 'codex':
      return readCodex(secret);
    case 'github':
      return readGithub(secret);
    case 'jira':
      return readJira(secret);
  }
}
