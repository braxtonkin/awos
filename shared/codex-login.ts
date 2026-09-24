import { z } from 'zod';

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
