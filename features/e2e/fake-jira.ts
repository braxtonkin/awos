import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import { ticket as ticketKey } from '../../shared/actions.ts';
import { json, serve, type Answer, type Asked, type Route, type Served } from './fake-http.ts';

const statuses = ['To Do', 'In Progress', 'Done'] as const;

type Status = (typeof statuses)[number];

const transitionIds: Readonly<Record<Status, string>> = { 'To Do': '11', 'In Progress': '21', Done: '31' };

type AdfNode = { readonly type: string; readonly text?: string | undefined; readonly content?: readonly AdfNode[] | undefined };

const adfNode: z.ZodType<AdfNode> = z.lazy(() => z.object({ type: z.string().min(1), text: z.string().optional(), content: z.array(adfNode).optional() }));

const adfDocument = z.looseObject({ type: z.literal('doc'), version: z.literal(1), content: z.array(adfNode) });

type Body = { readonly text: string; readonly adf: unknown };

type Comment = { readonly id: string; readonly author: string; readonly body: Body; readonly created: string; readonly properties: ReadonlyMap<string, unknown> };

type Ticket = {
  readonly id: string;
  readonly key: string;
  readonly project: string;
  readonly summary: string;
  readonly description: string | null;
  readonly labels: readonly string[];
  readonly assignee: string | null;
  readonly created: string;
  status: Status;
  readonly comments: Comment[];
};

export type FakeJiraSettings = { readonly email: string; readonly token: string; readonly accountId: string };

const bodies = {
  issue: z.object({
    fields: z.object({
      project: z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
      issuetype: z.object({ name: z.string() }).optional(),
      summary: z.string().min(1),
      description: z.string().nullish(),
      labels: z.array(z.string().regex(/^\S+$/)).default([]),
      assignee: z.object({ accountId: z.string().min(1) }).nullish(),
    }),
  }),
  textComment: z.object({ body: z.string().min(1) }),
  adfComment: z.object({ body: adfDocument, properties: z.array(z.object({ key: z.string().min(1), value: z.unknown() })).default([]) }),
  search: z.object({ jql: z.string(), maxResults: z.int().positive().default(50), nextPageToken: z.string().optional(), fields: z.array(z.string()).optional() }),
  transition: z.object({ transition: z.object({ id: z.string().min(1) }) }),
};

const jiraTime = (): string => new Date().toISOString().replace('Z', '+0000');

const inlineText = (node: AdfNode): string => {
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(inlineText).join('');
};

const adfToText = (content: readonly AdfNode[]): string => content.map(inlineText).join('\n\n');

const textToAdf = (text: string) => ({
  version: 1,
  type: 'doc',
  content: text
    .split(/\n\s*\n/)
    .filter(block => block.trim() !== '')
    .map(block => ({
      type: 'paragraph',
      content: block.split('\n').flatMap((line, index) => [...(index === 0 ? [] : [{ type: 'hardBreak' }]), ...(line === '' ? [] : [{ type: 'text', text: line }])]),
    })),
});

type Clause = (ticket: Ticket) => boolean;

const fields: Readonly<Record<string, (ticket: Ticket) => readonly string[]>> = {
  project: ticket => [ticket.project],
  key: ticket => [ticket.key],
  issuekey: ticket => [ticket.key],
  labels: ticket => ticket.labels,
  assignee: ticket => (ticket.assignee === null ? [] : [ticket.assignee]),
  status: ticket => [ticket.status],
};

const unquoted = (value: string): string => value.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');

function clauseOf(text: string, me: string): Clause | string {
  const found = /^(\w+)\s+(is not|is|not in|in)\s+(.+)$/i.exec(text) ?? /^(\w+)\s*(!=|=)\s*(.+)$/.exec(text);
  const [, rawField = '', rawOperator = '', rawValue = ''] = found ?? [];
  const field = fields[rawField.toLowerCase()];
  if (found === null || field === undefined) return `The fake Jira does not understand the JQL clause '${text}'.`;
  const operator = rawOperator.toLowerCase();
  const valueOf = (value: string): string => (/^currentUser\(\)$/i.test(value.trim()) ? me : unquoted(value));
  const holds = (ticket: Ticket): readonly string[] => field(ticket).map(value => value.toLowerCase());
  if (operator === 'is' || operator === 'is not') {
    if (!/^(empty|null)$/i.test(rawValue.trim())) return `The fake Jira only understands '${rawField} ${operator} EMPTY'.`;
    return operator === 'is' ? ticket => holds(ticket).length === 0 : ticket => holds(ticket).length > 0;
  }
  if (operator === 'in' || operator === 'not in') {
    const list = /^\((.*)\)$/.exec(rawValue.trim())?.[1];
    if (list === undefined) return `The fake Jira expects a list in parentheses after '${rawField} ${operator}'.`;
    const values = list.split(',').map(valueOf).map(value => value.toLowerCase());
    return operator === 'in' ? ticket => holds(ticket).some(value => values.includes(value)) : ticket => !holds(ticket).some(value => values.includes(value));
  }
  const value = valueOf(rawValue).toLowerCase();
  return operator === '=' ? ticket => holds(ticket).includes(value) : ticket => !holds(ticket).includes(value);
}

function jqlFilter(jql: string, me: string): Clause | string {
  const where = jql.replace(/\s+order\s+by\s+.*$/i, '').trim();
  if (where === '') return () => true;
  const clauses = where.split(/\s+AND\s+(?=(?:[^"]*"[^"]*")*[^"]*$)/i).map(text => clauseOf(text.trim(), me));
  const refused = clauses.find(clause => typeof clause === 'string');
  if (refused !== undefined) return refused;
  const tests = clauses.filter(clause => typeof clause !== 'string');
  return ticket => tests.every(test => test(ticket));
}

export async function startFakeJira(settings: FakeJiraSettings): Promise<Served> {
  const tickets: Ticket[] = [];
  let serial = 0;
  const account = { accountId: settings.accountId, emailAddress: settings.email, displayName: 'Fake Jira owner', active: true };
  const person = (accountId: string | null) => (accountId === null ? null : { accountId, displayName: accountId === settings.accountId ? account.displayName : accountId });

  const next = (): string => String((serial += 1));

  const ticketOf = (key: string | undefined): Ticket | undefined => tickets.find(ticket => ticket.key === key);

  const missing = (): Answer => json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} }, 404);

  const withTicket = (answer: (asked: Asked, ticket: Ticket) => Answer) => (asked: Asked, match: readonly string[]) => {
    const ticket = ticketOf(match[0]);
    return ticket === undefined ? missing() : answer(asked, ticket);
  };

  const invalid = (error: z.ZodError): Answer => json({ errorMessages: [z.prettifyError(error)], errors: {} }, 400);

  const issueJson = (ticket: Ticket, version: 2 | 3) => ({
    id: ticket.id,
    key: ticket.key,
    fields: {
      summary: ticket.summary,
      description: version === 2 || ticket.description === null ? ticket.description : textToAdf(ticket.description),
      labels: ticket.labels,
      created: ticket.created,
      assignee: person(ticket.assignee),
      status: { name: ticket.status },
      project: { key: ticket.project },
    },
  });

  const commentJson = (comment: Comment, version: 2 | 3, properties: boolean) => ({
    id: comment.id,
    author: person(comment.author),
    body: version === 2 ? comment.body.text : (comment.body.adf ?? textToAdf(comment.body.text)),
    created: comment.created,
    updated: comment.created,
    ...(properties ? { properties: [...comment.properties].map(([key, value]) => ({ key, value })) } : {}),
  });

  const createIssue = (asked: Asked): Answer => {
    const body = bodies.issue.safeParse(asked.body);
    if (!body.success) return invalid(body.error);
    const { fields } = body.data;
    const assignee = fields.assignee?.accountId ?? null;
    if (assignee !== null && assignee !== settings.accountId) return json({ errorMessages: [], errors: { assignee: `User '${assignee}' does not exist.` } }, 400);
    const id = next();
    const number = tickets.filter(ticket => ticket.project === fields.project.key).length + 1;
    const ticket: Ticket = {
      id,
      key: `${fields.project.key}-${String(number)}`,
      project: fields.project.key,
      summary: fields.summary,
      description: fields.description ?? null,
      labels: fields.labels,
      assignee,
      created: jiraTime(),
      status: 'To Do',
      comments: [],
    };
    tickets.push(ticket);
    return json({ id, key: ticket.key, self: `/rest/api/2/issue/${id}` }, 201);
  };

  const listComments = (version: 2 | 3) =>
    withTicket((asked, ticket) => {
      const startAt = Number.parseInt(asked.query.get('startAt') ?? '0', 10);
      const maxResults = Number.parseInt(asked.query.get('maxResults') ?? '50', 10);
      const properties = (asked.query.get('expand') ?? '').split(',').includes('properties');
      const shown = ticket.comments.slice(startAt, startAt + maxResults).map(comment => commentJson(comment, version, properties));
      return json({ startAt, maxResults, total: ticket.comments.length, comments: shown });
    });

  const addComment = (version: 2 | 3) =>
    withTicket((asked, ticket) => {
      const parsed = version === 2 ? bodies.textComment.safeParse(asked.body) : bodies.adfComment.safeParse(asked.body);
      if (!parsed.success) return invalid(parsed.error);
      const posted = parsed.data;
      const body: Body = typeof posted.body === 'string' ? { text: posted.body, adf: null } : { text: adfToText(posted.body.content), adf: posted.body };
      const properties = 'properties' in posted ? new Map(posted.properties.map(property => [property.key, property.value])) : new Map<string, unknown>();
      const comment: Comment = { id: next(), author: settings.accountId, body, created: jiraTime(), properties };
      ticket.comments.push(comment);
      return json(commentJson(comment, version, true), 201);
    });

  const search = (asked: Asked): Answer => {
    const body = bodies.search.safeParse(asked.body);
    if (!body.success) return invalid(body.error);
    const filter = jqlFilter(body.data.jql, settings.accountId);
    if (typeof filter === 'string') return json({ errorMessages: [filter], errors: {} }, 400);
    const start = Number.parseInt(body.data.nextPageToken ?? '0', 10);
    const matched = tickets.filter(filter);
    const end = start + body.data.maxResults;
    const shown = matched.slice(start, end).map(ticket => ({ id: ticket.id, key: ticket.key, fields: issueJson(ticket, 3).fields }));
    return json({ issues: shown, isLast: end >= matched.length, ...(end >= matched.length ? {} : { nextPageToken: String(end) }) });
  };

  const transitions = withTicket((_asked, ticket) =>
    json({ transitions: statuses.filter(status => status !== ticket.status).map(status => ({ id: transitionIds[status], name: status, to: { name: status } })) }),
  );

  const transition = withTicket((asked, ticket) => {
    const body = bodies.transition.safeParse(asked.body);
    if (!body.success) return invalid(body.error);
    const to = statuses.find(status => transitionIds[status] === body.data.transition.id && status !== ticket.status);
    if (to === undefined) return json({ errorMessages: [`Transition id '${body.data.transition.id}' is not valid for this issue.`], errors: {} }, 400);
    ticket.status = to;
    return { status: 204 };
  });

  const routes: readonly Route[] = [
    { method: 'GET', path: /^\/rest\/api\/[23]\/myself$/, answer: () => json(account) },
    { method: 'POST', path: /^\/rest\/api\/2\/issue$/, answer: createIssue },
    { method: 'POST', path: /^\/rest\/api\/3\/search\/jql$/, answer: search },
    {
      method: 'GET',
      path: /^\/rest\/api\/([23])\/issue\/([^/]+)$/,
      answer: (asked, [version, key]) => (ticketKey.safeParse(key).success ? withTicket((_asked, ticket) => json(issueJson(ticket, version === '2' ? 2 : 3)))(asked, [key ?? '']) : missing()),
    },
    { method: 'GET', path: /^\/rest\/api\/2\/issue\/([^/]+)\/comment$/, answer: listComments(2) },
    { method: 'GET', path: /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/, answer: listComments(3) },
    { method: 'POST', path: /^\/rest\/api\/2\/issue\/([^/]+)\/comment$/, answer: addComment(2) },
    { method: 'POST', path: /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/, answer: addComment(3) },
    { method: 'GET', path: /^\/rest\/api\/[23]\/issue\/([^/]+)\/transitions$/, answer: transitions },
    { method: 'POST', path: /^\/rest\/api\/[23]\/issue\/([^/]+)\/transitions$/, answer: transition },
  ];

  const expected = `Basic ${Buffer.from(`${settings.email}:${settings.token}`).toString('base64')}`;
  const admits = (headers: IncomingHttpHeaders): boolean => headers.authorization === expected;

  return serve({ name: 'Jira', routes, admits });
}
