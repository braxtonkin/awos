import { z } from 'zod';
import { ticket as ticketKey } from '../../shared/actions.ts';
import { basicAuthorization, type JiraLogin, type OpenJiraLogin } from '../../shared/jira-login.ts';

export type JiraAccess = { readonly site: string | undefined; readonly timeoutMs: number; readonly logins: OpenJiraLogin };

type Method = 'GET' | 'POST' | 'PUT';

const account = z.object({ accountId: z.string().min(1) });

export const jiraPayloads = {
  myself: account,
  searchPage: z.object({
    issues: z.array(z.object({ key: ticketKey, fields: z.object({ summary: z.string(), assignee: account.nullish() }) })),
    nextPageToken: z.string().min(1).nullish(),
    isLast: z.boolean().optional(),
  }),
  ticket: z.object({ key: ticketKey, fields: z.object({ summary: z.string(), assignee: account.nullish(), status: z.object({ name: z.string().min(1) }) }) }),
  commentPage: z.object({
    startAt: z.int(),
    total: z.int(),
    comments: z.array(z.object({ id: z.string().min(1), author: account.optional(), properties: z.array(z.object({ key: z.string(), value: z.unknown() })).default([]) })),
  }),
  created: z.object({ id: z.string().min(1) }),
  transitions: z.object({ transitions: z.array(z.object({ id: z.string().min(1), to: z.object({ name: z.string().min(1) }) })) }),
  nothing: z.null(),
};

export type Found = { readonly key: string; readonly summary: string; readonly assignee: string | null };

export type Ticket = Found & { readonly status: string };

export type Comment = { readonly id: string; readonly author: string | null; readonly properties: ReadonlyMap<string, unknown> };

export type Transition = { readonly id: string; readonly to: string };

export type Jira = {
  readonly who: string;
  readonly call: <S extends z.ZodType>(method: Method, path: string, schema: S, body?: unknown) => Promise<z.output<S>>;
  readonly myself: () => Promise<string>;
  readonly search: (jql: string, pageSize: number) => Promise<readonly Found[]>;
  readonly ticket: (key: string) => Promise<Ticket>;
  readonly comments: (key: string) => Promise<readonly Comment[]>;
  readonly comment: (key: string, body: unknown, properties: Readonly<Record<string, unknown>>) => Promise<string>;
  readonly transitions: (key: string) => Promise<readonly Transition[]>;
  readonly transition: (key: string, id: string) => Promise<void>;
};

const commentPageSize = 100;

const issuePath = (key: string): string => `/rest/api/3/issue/${encodeURIComponent(key)}`;

function parsedAnswer(text: string): unknown {
  if (text === '') return null;
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return text;
  }
}

export function jiraClient(site: string, login: JiraLogin, who: string, signal: AbortSignal): Jira {
  const authorization = basicAuthorization(login);
  const call = async <S extends z.ZodType>(method: Method, path: string, schema: S, body?: unknown): Promise<z.output<S>> => {
    const route = `${method} ${path.split('?')[0] ?? path}`;
    const answer = await fetch(new URL(path, site), {
      method,
      headers: { authorization, accept: 'application/json', 'content-type': 'application/json' },
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await answer.text();
    if (!answer.ok) throw new Error(`Jira answered ${String(answer.status)} for ${route} as ${who}: ${text.slice(0, 300)}`);
    const parsed = schema.safeParse(parsedAnswer(text));
    if (!parsed.success) throw new Error(`Jira's answer to ${route} does not parse. ${z.prettifyError(parsed.error)}`);
    return parsed.data;
  };
  return {
    who,
    call,
    myself: async () => (await call('GET', '/rest/api/3/myself', jiraPayloads.myself)).accountId,
    search: async (jql, pageSize) => {
      const found: Found[] = [];
      let token: string | undefined;
      do {
        const page = await call('POST', '/rest/api/3/search/jql', jiraPayloads.searchPage, { jql, maxResults: pageSize, fields: ['summary', 'assignee'], ...(token === undefined ? {} : { nextPageToken: token }) });
        found.push(...page.issues.map(issue => ({ key: issue.key, summary: issue.fields.summary, assignee: issue.fields.assignee?.accountId ?? null })));
        token = page.isLast === true ? undefined : (page.nextPageToken ?? undefined);
      } while (token !== undefined);
      return found;
    },
    ticket: async key => {
      const { fields } = await call('GET', `${issuePath(key)}?fields=summary,assignee,status`, jiraPayloads.ticket);
      return { key, summary: fields.summary, assignee: fields.assignee?.accountId ?? null, status: fields.status.name };
    },
    comments: async key => {
      const found: Comment[] = [];
      for (;;) {
        const page = await call('GET', `${issuePath(key)}/comment?startAt=${String(found.length)}&maxResults=${String(commentPageSize)}&orderBy=created&expand=properties`, jiraPayloads.commentPage);
        found.push(...page.comments.map(comment => ({ id: comment.id, author: comment.author?.accountId ?? null, properties: new Map(comment.properties.map(property => [property.key, property.value])) })));
        if (page.comments.length === 0 || found.length >= page.total) return found;
      }
    },
    comment: async (key, body, properties) =>
      (await call('POST', `${issuePath(key)}/comment`, jiraPayloads.created, { body, properties: Object.entries(properties).map(([name, value]) => ({ key: name, value })) })).id,
    transitions: async key => (await call('GET', `${issuePath(key)}/transitions`, jiraPayloads.transitions)).transitions.map(move => ({ id: move.id, to: move.to.name })),
    transition: async (key, id) => {
      await call('POST', `${issuePath(key)}/transitions`, jiraPayloads.nothing, { transition: { id } });
    },
  };
}

export async function signedInAs(access: JiraAccess, person: string, signal: AbortSignal): Promise<Jira> {
  const jira = await jiraAs(access, person, signal);
  await jira.myself();
  return jira;
}

export async function jiraAs(access: JiraAccess, person: string, signal: AbortSignal): Promise<Jira> {
  if (access.site === undefined) throw new Error('The engine has no JIRA_SITE, so it cannot reach Jira. Set JIRA_SITE on the engine.');
  const opened = await access.logins(person);
  if ('refused' in opened) throw new Error(opened.refused);
  return jiraClient(access.site, opened.login, opened.who, signal);
}
