import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { actionKinds, marker, type Limits, type Owed, type Performer } from '../../shared/actions.ts';
import { connect } from '../../shared/db/client.ts';
import { basicAuthorization, type JiraLogin, type OpenJiraLogin } from '../../shared/jira-login.ts';
import type { Json } from '../../shared/db/types.ts';
import type { RoutineRun } from '../../shared/routine-source.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import type { JiraAccess } from './client.ts';
import { liveLanes, laneNames } from './live.ts';
import { jiraPerformers } from './performers.ts';
import { currentAssignee, jiraSearch } from './source.ts';

type FakeComment = { readonly id: string; readonly author: string; readonly properties: readonly { readonly key: string; readonly value: unknown }[] };

type FakeTicket = { readonly key: string; readonly summary: string; readonly assignee: string | null; status: string; readonly comments: FakeComment[] };

type Fake = { readonly url: string; readonly requests: string[]; readonly tickets: readonly FakeTicket[]; readonly close: () => Promise<void> };

const fakeMe = 'account-of-the-fake-login';

const fakeLogin: JiraLogin = { email: 'ada@example.com', token: 'made-up-jira-token' };

const moves: Readonly<Record<string, readonly string[]>> = { 'To Do': ['In Progress'], 'In Progress': ['Done', 'To Do'], Done: ['To Do'] };

const searchBody = z.object({ maxResults: z.int(), nextPageToken: z.string().optional() });

const commentBody = z.object({ properties: z.array(z.object({ key: z.string(), value: z.unknown() })) });

const transitionBody = z.object({ transition: z.object({ id: z.string() }) });

const bodyOf = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : JSON.parse(text);
};

const reply = (status: number, body?: unknown): Reply => (body === undefined ? { status } : { status, body });

const answer = (response: ServerResponse, { status, body }: Reply): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? '' : JSON.stringify(body));
};

const issueOf = (ticket: FakeTicket) => ({ key: ticket.key, fields: { summary: ticket.summary, assignee: ticket.assignee === null ? null : { accountId: ticket.assignee }, status: { name: ticket.status } } });

type Reply = { readonly status: number; readonly body?: unknown };

function route(tickets: FakeTicket[], plantKeyless: boolean) {
  return (method: string, path: string, query: URLSearchParams, body: unknown): Reply => {
    if (method === 'GET' && path === '/rest/api/3/myself') return reply(200, { accountId: fakeMe });
    if (method === 'POST' && path === '/rest/api/3/search/jql') {
      const { maxResults, nextPageToken } = searchBody.parse(body);
      const start = Number(nextPageToken ?? '0');
      const end = start + maxResults;
      const issues = tickets.slice(start, end).map(ticket => issueOf(ticket));
      const [first, ...rest] = issues;
      const page = plantKeyless && start === 0 && first !== undefined ? [{ fields: first.fields }, ...rest] : issues;
      return reply(200, { issues: page, ...(end < tickets.length ? { nextPageToken: String(end) } : {}), isLast: end >= tickets.length });
    }
    const [, key, rest] = /^\/rest\/api\/3\/issue\/([^/]+)(\/.*)?$/.exec(path) ?? [];
    const ticket = tickets.find(candidate => candidate.key === key);
    if (ticket === undefined) return reply(404, { errorMessages: ['Issue does not exist'] });
    if (method === 'GET' && rest === undefined) return reply(200, issueOf(ticket));
    if (method === 'GET' && rest === '/comment') {
      const start = Number(query.get('startAt') ?? '0');
      const size = Number(query.get('maxResults') ?? '50');
      return reply(200, { startAt: start, total: ticket.comments.length, comments: ticket.comments.slice(start, start + size).map(comment => ({ id: comment.id, author: { accountId: comment.author }, properties: comment.properties })) });
    }
    if (method === 'POST' && rest === '/comment') {
      const id = String(10_000 + ticket.comments.length);
      ticket.comments.push({ id, author: fakeMe, properties: commentBody.parse(body).properties });
      return reply(201, { id });
    }
    if (method === 'GET' && rest === '/transitions') return reply(200, { transitions: (moves[ticket.status] ?? []).map(to => ({ id: to, to: { name: to } })) });
    if (method === 'POST' && rest === '/transitions') {
      const { id } = transitionBody.parse(body).transition;
      if (!(moves[ticket.status] ?? []).includes(id)) return reply(400, { errorMessages: ['Transition is not valid'] });
      ticket.status = id;
      return reply(204);
    }
    return reply(404, { errorMessages: [`no fake route for ${method} ${path}`] });
  };
}

function fakeJira(tickets: FakeTicket[], plantKeyless = false): Promise<Fake> {
  const requests: string[] = [];
  const handle = route(tickets, plantKeyless);
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake');
    requests.push(`${request.method ?? '?'} ${url.pathname}`);
    if (request.headers.authorization !== basicAuthorization(fakeLogin) && url.pathname === '/rest/api/3/search/jql') {
      answer(response, reply(200, { issues: [], isLast: true }));
      return;
    }
    if (request.headers.authorization !== basicAuthorization(fakeLogin)) {
      answer(response, reply(401, { errorMessages: ['Client must be authenticated to access this resource.'] }));
      return;
    }
    bodyOf(request)
      .then(body => {
        answer(response, handle(request.method ?? 'GET', url.pathname, url.searchParams, body));
      })
      .catch((error: unknown) => {
        answer(response, reply(500, { errorMessages: [error instanceof Error ? error.message : String(error)] }));
      });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${String(port)}`, requests, tickets, close: () => new Promise(done => server.close(() => { done(); })) });
    });
  });
}

const probe = (key: string, status = 'To Do'): FakeTicket => ({ key, summary: `Probe ${key}`, assignee: fakeMe, status, comments: [] });

const loginsOf =
  (logins: Readonly<Record<string, JiraLogin>>): OpenJiraLogin =>
  person => {
    const login = logins[person];
    return Promise.resolve(login === undefined ? { refused: `person ${person} has no Jira login` } : { login, who: `person ${person}` });
  };

const accessTo = (fake: Fake, logins: Readonly<Record<string, JiraLogin>> = { '1': fakeLogin }): JiraAccess => ({ site: fake.url, timeoutMs: 10_000, logins: loginsOf(logins) });

const runAs = (person: string, source: Json): RoutineRun => ({ run: '1', routine: '1', name: 'Probe search', reason: 'schedule', occurrence: new Date(), runAs: person, source });

const limits = (): Limits => ({ deadline: new Date(Date.now() + 10_000), signal: AbortSignal.timeout(10_000) });

const owed = (kind: string, payload: unknown): Owed<unknown> => ({ row: '1', task: '1', kind, payload, marker: marker.parse(randomBytes(18).toString('base64url')), actsAs: '1' });

const expect = (name: string, holds: boolean, detail: string): Check => (holds ? pass(name, detail) : fail(name, detail));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function withFake<T>(tickets: FakeTicket[], work: (fake: Fake) => Promise<T>, plantKeyless = false): Promise<T> {
  const fake = await fakeJira(tickets, plantKeyless);
  try {
    return await work(fake);
  } finally {
    await fake.close();
  }
}

const unusedDatabase = () => connect('postgres://nobody@127.0.0.1:1/unused', 1);

async function performersOf<T>(fake: Fake, work: (performers: ReturnType<typeof jiraPerformers>) => Promise<T>): Promise<T> {
  const db = unusedDatabase();
  try {
    return await work(jiraPerformers(accessTo(fake), db));
  } finally {
    await db.destroy();
  }
}

async function performOnce(performer: Performer, row: Owed<unknown>, checkMarker: boolean): Promise<string> {
  if (checkMarker && performer.find !== null) {
    const found = await performer.find(row, limits());
    if ('found' in found) return 'found';
    if ('failed' in found) return `failed: ${found.failed}`;
  }
  const outcome = await performer.call(row, limits());
  return 'done' in outcome ? 'done' : 'failed' in outcome ? `failed: ${outcome.failed}` : `refused: ${outcome.refused.reason}`;
}

const searchFollowsPages = (): Promise<Check> =>
  withFake(['P-1', 'P-2', 'P-3', 'P-4', 'P-5'].map(key => probe(key)), async fake => {
    const found = await jiraSearch(accessTo(fake)).find(runAs('1', { kind: 'jira-search', jql: 'project = P', pageSize: 2 }));
    const searches = fake.requests.filter(line => line === 'POST /rest/api/3/search/jql').length;
    return expect(
      'the search follows the page token to the last page and returns each key, summary, and assignee',
      found.map(item => item.key).join(',') === 'P-1,P-2,P-3,P-4,P-5' && searches === 3 && found.every(item => item.assignee === fakeMe && item.title === `Probe ${item.key}`),
      `${String(found.length)} work items over ${String(searches)} searches of page size 2: ${found.map(item => item.key).join(', ')}`,
    );
  });

const keylessResultRejected = (): Promise<Check> =>
  withFake(
    [probe('P-1'), probe('P-2')],
    async fake => {
      const outcome = await jiraSearch(accessTo(fake))
        .find(runAs('1', { kind: 'jira-search', jql: 'project = P' }))
        .then(
          items => `it returned ${String(items.length)} items`,
          (error: unknown) => messageOf(error),
        );
      return expect('a planted search result without key is rejected by the parse, which names key', outcome.includes('does not parse') && outcome.includes('key'), outcome);
    },
    true,
  );

const searchNamesItsIdentity = (): Promise<Check> =>
  withFake([probe('P-1')], async fake => {
    const madeUp = await jiraSearch(accessTo(fake, { '1': fakeLogin, '2': { email: 'bo@example.com', token: 'made-up' } }))
      .find(runAs('2', { kind: 'jira-search', jql: 'project = P' }))
      .then(
        () => 'it succeeded',
        (error: unknown) => messageOf(error),
      );
    const noQuery = await jiraSearch(accessTo(fake))
      .find(runAs('1', { kind: 'jira-search' }))
      .then(
        () => 'it succeeded',
        (error: unknown) => messageOf(error),
      );
    return expect(
      'a search as a person whose token Jira refuses fails with 401 and names the person, and a source with no JQL is refused',
      madeUp.includes('401') && madeUp.includes('person 2') && noQuery.includes('jql'),
      `made-up token: ${madeUp} | no JQL: ${noQuery}`,
    );
  });

const assigneeRead = (): Promise<Check> =>
  withFake([probe('P-1'), { ...probe('P-2'), assignee: null }], async fake => {
    const read = currentAssignee(accessTo(fake));
    const [assigned, unassigned] = [await read('P-1', '1'), await read('P-2', '1')];
    return expect('the assignee read returns the account id, or null for an unassigned ticket', assigned === fakeMe && unassigned === null, `P-1: ${assigned ?? 'null'}, P-2: ${unassigned ?? 'null'}`);
  });

const commentPostsOnce = (): Promise<Check> =>
  withFake([probe('P-1')], fake =>
    performersOf(fake, async performers => {
      const row = owed('ticket.comment', { ticket: 'P-1', text: 'First line.\nSecond line.\n\nNext paragraph.', linkPullRequest: false });
      const outcomes = [await performOnce(performers['ticket.comment'], row, true), await performOnce(performers['ticket.comment'], row, true)];
      const comments = fake.tickets[0]?.comments ?? [];
      return expect(
        'a comment row performed, then performed again after a crash, finds its marker and posts one comment',
        outcomes.join(',') === 'done,found' && comments.length === 1,
        `outcomes ${outcomes.join(', ')}; ${String(comments.length)} comments, the first with properties ${JSON.stringify(comments[0]?.properties ?? [])}`,
      );
    }),
  );

const noMarkerPostsTwice = (): Promise<Check> =>
  withFake([probe('P-1')], fake =>
    performersOf(fake, async performers => {
      const row = owed('ticket.comment', { ticket: 'P-1', text: 'A comment.', linkPullRequest: false });
      const outcomes = [await performOnce(performers['ticket.comment'], row, false), await performOnce(performers['ticket.comment'], row, false)];
      const comments = fake.tickets[0]?.comments.length ?? 0;
      return expect('without the marker check the same row posts two comments, the negative control', outcomes.join(',') === 'done,done' && comments === 2, `outcomes ${outcomes.join(', ')}; ${String(comments)} comments`);
    }),
  );

const othersMarkerIgnored = (): Promise<Check> =>
  withFake([probe('P-1')], fake =>
    performersOf(fake, async performers => {
      const row = owed('ticket.comment', { ticket: 'P-1', text: 'A comment.', linkPullRequest: false });
      fake.tickets[0]?.comments.push({ id: '1', author: 'someone-else', properties: [{ key: 'autoworker', value: { marker: row.marker } }] });
      const outcome = await performOnce(performers['ticket.comment'], row, true);
      const comments = fake.tickets[0]?.comments.length ?? 0;
      return expect('a comment that carries the marker but was written by someone else does not count', outcome === 'done' && comments === 2, `outcome ${outcome}; ${String(comments)} comments`);
    }),
  );

const transitionsByState = (): Promise<Check> =>
  withFake([probe('P-1'), probe('P-2', 'In Progress'), probe('P-3')], fake =>
    performersOf(fake, async performers => {
      const move = performers['ticket.transition'];
      const same = await performOnce(move, owed('ticket.transition', { ticket: 'P-1', status: 'To Do', from: 'To Do' }), true);
      const sameMoves = fake.requests.filter(line => line === 'POST /rest/api/3/issue/P-1/transitions').length;
      const left = await performOnce(move, owed('ticket.transition', { ticket: 'P-2', status: 'Done', from: 'To Do' }), true);
      const moved = await performOnce(move, owed('ticket.transition', { ticket: 'P-3', status: 'In Progress', from: 'To Do' }), true);
      const unreachable = await performOnce(move, owed('ticket.transition', { ticket: 'P-3', status: 'Blocked', from: null }), true);
      return expect(
        'a move to the current status is done with no transition, a ticket not in the expected status fails and names it, a move follows the transition by name, and an unreachable status fails',
        same === 'done' &&
          sameMoves === 0 &&
          left.startsWith('failed') &&
          left.includes('"In Progress"') &&
          moved === 'done' &&
          fake.tickets[2]?.status === 'In Progress' &&
          unreachable.startsWith('failed') &&
          unreachable.includes('"Blocked"'),
        `same: ${same}; left: ${left}; moved: ${moved}; unreachable: ${unreachable}`,
      );
    }),
  );

const offlineChecks = [
  searchFollowsPages,
  keylessResultRejected,
  searchNamesItsIdentity,
  assigneeRead,
  commentPostsOnce,
  noMarkerPostsTwice,
  othersMarkerIgnored,
  transitionsByState,
];

async function offline(): Promise<readonly Check[]> {
  const checks: Check[] = [];
  for (const check of offlineChecks) checks.push(await check().catch((error: unknown) => fail(check.name, messageOf(error))));
  return checks;
}

const kindsCovered = (): Promise<Check> =>
  withFake([], fake =>
    performersOf(fake, performers => {
      const registered = Object.values(performers).map(entry => entry.kind);
      const pinned = [actionKinds.ticketComment.kind, actionKinds.ticketTransition.kind];
      return Promise.resolve(expect('the Jira performers cover exactly the pinned ticket kinds', registered.join(',') === pinned.join(','), registered.join(', ')));
    }),
  );

export const scenarios: readonly Scenario[] = [
  {
    name: 'jira',
    summary: 'runs the Jira search source, the assignee read, and the comment and transition performers against a local fake Jira, with the keyless result and the marker-less comment as negative controls',
    run: async () => [await kindsCovered(), ...(await offline())],
  },
  {
    name: 'jira-live',
    summary: `runs one live lane against the sandbox Jira with the real engine: --lane ${laneNames.join(', ')}. Needs JIRA_SITE, JIRA_EMAIL, JIRA_API_TOKEN, and JIRA_PROJECT`,
    run: async args => {
      const { values } = parseArgs({ args: [...args], options: { lane: { type: 'string', default: 'flow' }, 'start-status': { type: 'string', default: 'In Progress' }, 'end-status': { type: 'string', default: 'Done' } } });
      return liveLanes(values.lane, { start: values['start-status'], end: values['end-status'] });
    },
  },
];
