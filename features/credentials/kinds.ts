import { z } from 'zod';
import type { ConnectorKind, CredentialState, JsonObject } from '../../shared/db/types.ts';

type Inputs = {
  readonly codex: { readonly login: string; readonly madeForAutoWorker: boolean };
  readonly github: { readonly token: string };
};

export type Secret = { readonly [K in ConnectorKind]: { readonly connector: K } & Inputs[K] }[ConnectorKind];

export type Verdict = CredentialState;

export type RefreshUse = { readonly kind: 'unused' } | { readonly kind: 'maybe-used' } | { readonly kind: 'rotated'; readonly login: string };

export type Checked = {
  readonly verdict: Verdict;
  readonly cause: string;
  readonly expiresAt: Date | null;
  readonly refresh: RefreshUse;
};

export type Check = {
  readonly rotates: (secret: string) => boolean;
  readonly run: (secret: string, now: Date) => Promise<Checked>;
};

export type Read =
  | { readonly text: string; readonly expiresAt: Date | null; readonly audit: JsonObject }
  | { readonly refused: 'malformed' | 'refresh-token-not-made-for-autoworker'; readonly reason: string };

export type Unread = Extract<Read, { readonly refused: string }>['refused'];

const lastSecondBeforeYear10000 = 253_402_300_799;

const json = z.string().transform((text, context): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    context.issues.push({ code: 'custom', message: 'must be JSON', input: undefined });
    return z.NEVER;
  }
});

const accessToken = z
  .string()
  .transform(token => token.split('.'))
  .pipe(z.tuple([z.string(), z.base64url(), z.string()], { error: 'must be a JWT, three base64url parts joined by dots' }))
  .transform(([, payload]) => Buffer.from(payload, 'base64url').toString('utf8'))
  .pipe(json)
  .pipe(z.looseObject({ exp: z.int().positive().max(lastSecondBeforeYear10000, { error: 'must be a time before the year 10000' }) }));

export const codexLogin = json.pipe(
  z.looseObject({
    tokens: z.looseObject({ access_token: accessToken, refresh_token: z.string() }),
  }),
);

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

const rawLogin = json.pipe(z.looseObject({ tokens: z.looseObject({}) }));

const accessOnlyLogin = z.string().brand<'AccessOnlyLogin'>();

export type AccessOnlyLogin = z.infer<typeof accessOnlyLogin>;

export type AccessOnly = { readonly login: AccessOnlyLogin; readonly expiresAt: Date } | { readonly refused: 'malformed'; readonly reason: string };

export function accessOnly(login: string): AccessOnly {
  const parsed = codexLogin.safeParse(login);
  const raw = rawLogin.safeParse(login);
  if (!parsed.success || !raw.success) return { refused: 'malformed', reason: 'The stored Codex login is not a Codex auth.json, so no access-only copy was made. Replace the login.' };
  const blanked = { ...raw.data, tokens: { ...raw.data.tokens, refresh_token: '' } };
  return { login: accessOnlyLogin.parse(`${JSON.stringify(blanked, null, 2)}\n`), expiresAt: new Date(parsed.data.tokens.access_token.exp * 1000) };
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
  }
}
