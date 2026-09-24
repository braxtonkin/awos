import { z } from 'zod';
import { parsePayload } from './payload.ts';

const answerWait = 30_000;

const JiraKeys = z.object({
  JIRA_SITE: z.url({ protocol: /^https$/ }),
  JIRA_EMAIL: z.email(),
  JIRA_API_TOKEN: z.string().regex(/^\S+$/),
});

const Comment = z.object({ id: z.string().min(1), body: z.string(), created: z.string().min(1) });

export const jiraPayloads = {
  myself: z.object({ accountId: z.string().min(1) }),
  created: z.object({ id: z.string().min(1), key: z.string().min(1) }),
  issue: z.object({
    key: z.string().min(1),
    fields: z.object({
      summary: z.string(),
      description: z.string().nullable(),
      labels: z.array(z.string()),
      created: z.string().min(1),
      assignee: z.object({ accountId: z.string().min(1) }).nullable(),
    }),
  }),
  comment: Comment,
  comments: z.object({ startAt: z.number(), total: z.number(), comments: z.array(Comment) }),
};

export type Comment = z.infer<typeof Comment>;
export type Issue = z.infer<typeof jiraPayloads.issue>;

type NewTicket = {
  readonly project: string;
  readonly summary: string;
  readonly description: string;
  readonly label: string;
  readonly assignee: string | null;
};

export type Jira = {
  readonly site: string;
  readonly email: string;
  readonly accountId: () => Promise<string>;
  readonly fileTicket: (ticket: NewTicket) => Promise<string>;
  readonly issue: (key: string) => Promise<Issue>;
  readonly comments: (key: string) => Promise<readonly Comment[]>;
  readonly comment: (key: string, body: string) => Promise<Comment>;
  readonly browse: (key: string) => string;
  readonly commentLink: (key: string, comment: Comment) => string;
};

type Method = 'GET' | 'POST';

export function jiraFromEnvironment(env: NodeJS.ProcessEnv): Jira {
  const keys = JiraKeys.safeParse(env);
  if (!keys.success) throw new Error(`The Jira keys are not usable: ${keys.error.issues.map(issue => String(issue.path[0])).join(', ')}`);
  return jiraAt(keys.data.JIRA_SITE, keys.data.JIRA_EMAIL, keys.data.JIRA_API_TOKEN);
}

export function jiraAt(site: string, email: string, token: string): Jira {
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

  const call = async <Schema extends z.ZodType>(method: Method, path: string, schema: Schema, body?: unknown): Promise<z.output<Schema>> => {
    const answer = await fetch(new URL(path, site), {
      method,
      headers: { authorization, accept: 'application/json', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(answerWait),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await answer.text();
    if (!answer.ok) throw new Error(`Jira ${method} ${path.split('?')[0] ?? path} answered ${String(answer.status)}: ${text.slice(0, 500)}`);
    return parsePayload(`Jira ${method} ${path.split('?')[0] ?? path}`, schema, JSON.parse(text));
  };

  const pageSize = 100;

  return {
    site,
    email,
    accountId: async () => (await call('GET', '/rest/api/2/myself', jiraPayloads.myself)).accountId,
    fileTicket: async ticket =>
      (
        await call('POST', '/rest/api/2/issue', jiraPayloads.created, {
          fields: {
            project: { key: ticket.project },
            issuetype: { name: 'Task' },
            summary: ticket.summary,
            description: ticket.description,
            labels: [ticket.label],
            assignee: ticket.assignee === null ? null : { accountId: ticket.assignee },
          },
        })
      ).key,
    issue: key => call('GET', `/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description,labels,created,assignee`, jiraPayloads.issue),
    comments: async key => {
      const found: Comment[] = [];
      for (;;) {
        const page = await call('GET', `/rest/api/2/issue/${encodeURIComponent(key)}/comment?startAt=${String(found.length)}&maxResults=${String(pageSize)}&orderBy=created`, jiraPayloads.comments);
        found.push(...page.comments);
        if (page.comments.length === 0 || found.length >= page.total) return found;
      }
    },
    comment: (key, body) => call('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, jiraPayloads.comment, { body }),
    browse: key => new URL(`/browse/${encodeURIComponent(key)}`, site).href,
    commentLink: (key, comment) => new URL(`/browse/${encodeURIComponent(key)}?focusedCommentId=${encodeURIComponent(comment.id)}`, site).href,
  };
}
