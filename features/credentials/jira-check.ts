import { basicAuthorization, jiraLogin } from '../../shared/jira-login.ts';
import type { Check, Checked } from './kinds.ts';

export type JiraCheckSettings = { readonly site: string | undefined; readonly timeoutMs: number };

const unused = { kind: 'unused' } as const;

const unknown = (cause: string): Checked => ({ verdict: 'unknown', cause, expiresAt: null, refresh: unused });

const verdictOf = (status: number): Checked => {
  if (status === 200) return { verdict: 'valid', cause: 'Jira answered 200 for GET /rest/api/3/myself.', expiresAt: null, refresh: unused };
  if (status === 401) return { verdict: 'invalid', cause: 'Jira answered 401 for GET /rest/api/3/myself, so the email or the API token is wrong, or the token was revoked. Store a new Jira login.', expiresAt: null, refresh: unused };
  return unknown(`Jira answered ${String(status)} for GET /rest/api/3/myself.`);
};

export const jiraCheck = (settings: JiraCheckSettings): Check => ({
  rotates: () => false,
  run: async secret => {
    const { site } = settings;
    if (site === undefined) return unknown('The engine has no JIRA_SITE, so it cannot ask Jira about this login. Set JIRA_SITE on the engine.');
    const login = jiraLogin.safeParse(secret);
    if (!login.success) return { verdict: 'invalid', cause: 'The stored Jira login is not email:token. Store the Jira login again.', expiresAt: null, refresh: unused };
    try {
      const answer = await fetch(new URL('/rest/api/3/myself', site), {
        headers: { authorization: basicAuthorization(login.data), accept: 'application/json' },
        signal: AbortSignal.timeout(settings.timeoutMs),
      });
      await answer.body?.cancel();
      return verdictOf(answer.status);
    } catch (error) {
      return unknown(`GET /rest/api/3/myself failed before Jira answered: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});
