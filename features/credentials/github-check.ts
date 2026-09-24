import { Octokit } from '@octokit/core';
import { z } from 'zod';
import type { Check, Checked } from './kinds.ts';

export type GithubCheckSettings = { readonly baseUrl: string; readonly timeoutMs: number };

export const githubApi = 'https://api.github.com';

const expirationHeader = 'github-authentication-token-expiration';

const expiration = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/, { error: 'must look like 2026-10-01 12:00:00 UTC' })
  .transform(text => `${text.slice(0, 10)}T${text.slice(11, 19)}Z`)
  .pipe(z.iso.datetime())
  .transform(text => new Date(text));

const refusal = z.object({ status: z.int(), message: z.string() });

const thrown = z.object({ message: z.string() });

function expiryOf(header: unknown): Pick<Checked, 'expiresAt' | 'cause'> {
  if (header === undefined) return { expiresAt: null, cause: 'GitHub answered 200 for GET /user and sent no expiry, so the token does not expire.' };
  const parsed = expiration.safeParse(header);
  if (!parsed.success) return { expiresAt: null, cause: `GitHub answered 200 for GET /user, but its ${expirationHeader} header could not be read, so the expiry is unknown.` };
  return { expiresAt: parsed.data, cause: `GitHub answered 200 for GET /user, and the token expires at ${parsed.data.toISOString()}.` };
}

function failureOf(error: unknown): Checked {
  const refused = refusal.safeParse(error);
  if (refused.success && refused.data.status === 401) return { verdict: 'invalid', cause: `GitHub answered 401 for GET /user: ${refused.data.message}`, expiresAt: null };
  if (refused.success) return { verdict: 'unknown', cause: `GitHub answered ${String(refused.data.status)} for GET /user: ${refused.data.message}`, expiresAt: null };
  return { verdict: 'unknown', cause: `GET /user failed before GitHub answered: ${thrown.safeParse(error).data?.message ?? 'an error with no message'}`, expiresAt: null };
}

export const githubCheck = (settings: GithubCheckSettings): Check => ({
  rotates: () => false,
  run: async token => {
    const octokit = new Octokit({ auth: token, baseUrl: settings.baseUrl });
    try {
      const response = await octokit.request('GET /user', { request: { signal: AbortSignal.timeout(settings.timeoutMs) } });
      return { verdict: 'valid', ...expiryOf(response.headers[expirationHeader]) };
    } catch (error) {
      return failureOf(error);
    }
  },
});
