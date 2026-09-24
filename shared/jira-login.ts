import { z } from 'zod';

export const jiraLogin = z
  .string()
  .trim()
  .transform((text, context) => {
    const colon = text.indexOf(':');
    if (colon > 0) return { email: text.slice(0, colon), token: text.slice(colon + 1) };
    context.issues.push({ code: 'custom', message: 'must be the Jira email and API token joined by a colon, as email:token', input: undefined });
    return z.NEVER;
  })
  .pipe(
    z.object({
      email: z.email({ error: 'must start with the email of the Jira account' }),
      token: z.string().regex(/^\S+$/, { error: 'must end with the API token, one word with no spaces' }),
    }),
  );

export type JiraLogin = z.output<typeof jiraLogin>;

export const basicAuthorization = ({ email, token }: JiraLogin): string => `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

export type OpenedJiraLogin = { readonly login: JiraLogin; readonly who: string } | { readonly refused: string };

export type OpenJiraLogin = (person: string) => Promise<OpenedJiraLogin>;
