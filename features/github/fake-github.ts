import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CheckResult } from './client.ts';

export const repository = 'sim/repo';

export const base = 'main';

export const checkNames = { required: 'build', counted: 'lint', ignorable: 'flaky' } as const;

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED';

export type FakeReview = { readonly id: string; readonly reviewer: string; readonly state: ReviewState; readonly at: number; readonly body: string };

export type Ejection = { readonly id: string; readonly reason: string; readonly at: number; readonly head: string };

export type FakePull = {
  readonly number: number;
  readonly nodeId: string;
  readonly branch: string;
  readonly base: string;
  body: string;
  draft: boolean;
  closed: boolean;
  merged: { readonly head: string } | null;
  conflict: boolean;
  behind: boolean;
  mergeabilityKnown: boolean;
  ruleBlocks: boolean;
  readonly reviews: FakeReview[];
  queued: { readonly head: string } | null;
  readonly ejections: Ejection[];
};

export type Settings = { readonly queue: boolean; readonly requireReviews: boolean; readonly strict: boolean };

export type Merged = { readonly number: number; readonly head: string; readonly how: 'direct' | 'queue' };

export type Enqueued = { readonly number: number; readonly head: string; readonly lastEjection: string | null };

export type Written = { readonly number: number; readonly what: string };

export type World = {
  time: number;
  serial: number;
  settings: Settings;
  readonly commits: Map<string, readonly string[]>;
  readonly checks: Map<string, Map<string, CheckResult>>;
  readonly earlier: Map<string, Map<string, CheckResult>>;
  readonly branches: Map<string, string>;
  readonly pulls: FakePull[];
  readonly merges: Merged[];
  readonly enqueues: Enqueued[];
  calls: number;
  readonly written: Written[];
};

export const at = (time: number): string => new Date(Date.UTC(2026, 0, 1) + time * 1000).toISOString().replace('.000Z', 'Z');

const sha = (text: string): string => createHash('sha1').update(text).digest('hex');

export function newWorld(settings: Settings): World {
  const root = sha('root');
  return {
    time: 0,
    serial: 0,
    settings,
    commits: new Map([[root, []]]),
    checks: new Map(),
    earlier: new Map(),
    branches: new Map([[base, root]]),
    pulls: [],
    merges: [],
    enqueues: [],
    calls: 0,
    written: [],
  };
}

export function commitOn(world: World, parents: readonly string[]): string {
  world.serial += 1;
  const made = sha(`commit ${String(world.serial)}`);
  world.commits.set(made, parents);
  world.checks.set(made, new Map([[checkNames.counted, 'pending'], [checkNames.ignorable, 'pending']]));
  return made;
}

export const headOf = (world: World, pull: FakePull): string => (pull.merged === null ? (world.branches.get(pull.branch) ?? '') : pull.merged.head);

export const checksAt = (world: World, head: string): Map<string, CheckResult> => world.checks.get(head) ?? new Map<string, CheckResult>();

export function rerun(world: World, head: string, name: string): void {
  const checks = checksAt(world, head);
  const result = checks.get(name);
  if (result === undefined || result === 'pending') return;
  world.earlier.set(head, new Map([...(world.earlier.get(head) ?? []), [name, result]]));
  checks.set(name, 'pending');
}

function ancestors(world: World, commit: string): ReadonlySet<string> {
  const seen = new Set<string>();
  const stack = [commit];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(world.commits.get(next) ?? []));
  }
  return seen;
}

export function eject(world: World, pull: FakePull, reason: string): void {
  if (pull.queued === null) return;
  world.serial += 1;
  pull.ejections.push({ id: `EJ_${String(world.serial)}`, reason, at: world.time, head: pull.queued.head });
  pull.queued = null;
}

export function moveBranch(world: World, branch: string, to: string): void {
  world.branches.set(branch, to);
  for (const pull of world.pulls.filter(entry => entry.branch === branch && !entry.closed && entry.merged === null)) {
    pull.conflict = false;
    pull.mergeabilityKnown = false;
    eject(world, pull, 'The head moved while the pull request was queued.');
  }
}

const latestByReviewer = (pull: FakePull): readonly FakeReview[] => [...Map.groupBy(pull.reviews, review => review.reviewer).values()].flatMap(reviews => reviews.slice(-1));

export const reviewDecision = (world: World, pull: FakePull): 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null => {
  if (!world.settings.requireReviews) return null;
  const latest = latestByReviewer(pull);
  if (latest.some(review => review.state === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  return latest.some(review => review.state === 'APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED';
};

const requiredGreen = (world: World, head: string): boolean => checksAt(world, head).get(checkNames.required) === 'green';

export const allows = (world: World, pull: FakePull, head: string): boolean =>
  !pull.closed &&
  pull.merged === null &&
  !pull.draft &&
  !pull.conflict &&
  !pull.ruleBlocks &&
  headOf(world, pull) === head &&
  requiredGreen(world, head) &&
  (reviewDecision(world, pull) ?? 'APPROVED') === 'APPROVED' &&
  !(world.settings.strict && pull.behind);

function mergeStateStatus(world: World, pull: FakePull): string {
  const head = headOf(world, pull);
  if (pull.draft) return 'DRAFT';
  if (!pull.mergeabilityKnown) return 'UNKNOWN';
  if (pull.conflict) return 'DIRTY';
  if (pull.ruleBlocks || !requiredGreen(world, head) || (reviewDecision(world, pull) ?? 'APPROVED') !== 'APPROVED') return 'BLOCKED';
  if (world.settings.strict && pull.behind) return 'BEHIND';
  return [...checksAt(world, head).values()].includes('red') ? 'UNSTABLE' : 'CLEAN';
}

export function mergeNow(world: World, pull: FakePull, head: string, how: Merged['how']): void {
  pull.merged = { head };
  pull.queued = null;
  world.merges.push({ number: pull.number, head, how });
}

type Answer = { readonly status: number; readonly body?: unknown };

const ok = (body: unknown, status = 200): Answer => ({ status, body });

const refuse = (status: number, message: string, detail?: string): Answer => ({ status, body: { message, ...(detail === undefined ? {} : { errors: [{ message: detail }] }) } });

const graphqlError = (message: string): Answer => ok({ errors: [{ type: 'UNPROCESSABLE', message }] });

const restPull = (world: World, pull: FakePull) => ({
  number: pull.number,
  node_id: pull.nodeId,
  html_url: `https://github.com/${repository}/pull/${String(pull.number)}`,
  state: pull.closed || pull.merged !== null ? 'closed' : 'open',
  draft: pull.draft,
  merged_at: pull.merged === null ? null : at(world.time),
  body: pull.body,
  head: { ref: pull.branch, sha: headOf(world, pull) },
  base: { ref: pull.base },
});

const page = <T>(items: readonly T[], first: number, after: string | undefined) => {
  const start = after === undefined ? 0 : Number.parseInt(after, 10);
  const end = start + first;
  return { pageInfo: { hasNextPage: end < items.length, endCursor: String(end) }, nodes: items.slice(start, end) };
};

const checkRun = (name: string, result: CheckResult, startedAt: string | null) => ({
  __typename: 'CheckRun',
  name,
  status: result !== 'pending' ? 'COMPLETED' : startedAt === null ? 'QUEUED' : 'IN_PROGRESS',
  conclusion: result === 'pending' ? null : result === 'green' ? 'SUCCESS' : 'FAILURE',
  startedAt,
});

const contextsOf = (world: World, head: string) =>
  [...checksAt(world, head)].flatMap(([name, result]) => {
    const earlier = result === 'pending' ? world.earlier.get(head)?.get(name) : undefined;
    return earlier === undefined ? [checkRun(name, result, at(0))] : [checkRun(name, earlier, at(0)), checkRun(name, result, null)];
  });

const reviewNode = (review: FakeReview, first: number) => ({
  id: review.id,
  state: review.state,
  submittedAt: at(review.at),
  body: review.body,
  author: { login: review.reviewer },
  comments: page([{ path: 'src/a.ts', line: 3, body: `First note of ${review.id}.` }, { path: null, line: null, body: `Second note of ${review.id}.` }, { path: 'src/b.ts', line: 9, body: `Third note of ${review.id}.` }], first, undefined),
});

const variables = z.looseObject({ first: z.int().optional(), after: z.string().optional(), number: z.int().optional(), id: z.string().optional(), head: z.string().optional(), oid: z.string().optional(), review: z.string().optional(), answered: z.string().optional(), withAnswered: z.boolean().optional() });

const graphqlBody = z.object({ query: z.string(), variables });

function facts(world: World, pull: FakePull, first: number, answered: string | undefined) {
  const head = headOf(world, pull);
  const answeredReview = pull.reviews.find(review => review.id === answered);
  const ejection = pull.ejections.at(-1);
  return {
    repository: {
      pullRequest: {
        id: pull.nodeId,
        number: pull.number,
        url: `https://github.com/${repository}/pull/${String(pull.number)}`,
        state: pull.merged !== null ? 'MERGED' : pull.closed ? 'CLOSED' : 'OPEN',
        isDraft: pull.draft,
        mergeable: !pull.mergeabilityKnown ? 'UNKNOWN' : pull.conflict ? 'CONFLICTING' : 'MERGEABLE',
        mergeStateStatus: mergeStateStatus(world, pull),
        reviewDecision: reviewDecision(world, pull),
        isInMergeQueue: pull.queued !== null,
        mergeQueueEntry: pull.queued === null ? null : { headCommit: { oid: pull.queued.head } },
        headRefOid: head,
        baseRef: {
          rules: {
            nodes: [
              { type: 'REQUIRED_STATUS_CHECKS', parameters: { requiredStatusChecks: [{ context: checkNames.required }] } },
              ...(world.settings.queue ? [{ type: 'MERGE_QUEUE', parameters: {} }] : []),
            ],
          },
          branchProtectionRule: null,
        },
        commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: page(contextsOf(world, head), first, undefined) } } }] },
        latestOpinionatedReviews: page(
          latestByReviewer(pull).map(review => reviewNode(review, first)),
          first,
          undefined,
        ),
        timelineItems: { nodes: ejection === undefined ? [] : [{ id: ejection.id, reason: ejection.reason, createdAt: at(ejection.at), beforeCommit: { oid: ejection.head } }] },
      },
    },
    ...(answered === undefined ? {} : { answered: answeredReview === undefined ? null : { submittedAt: at(answeredReview.at) } }),
  };
}

function graphql(world: World, body: unknown): Answer {
  const parsed = graphqlBody.parse(body);
  const given = parsed.variables;
  const first = given.first ?? 100;
  const byId = world.pulls.find(pull => pull.nodeId === given.id);
  const byNumber = world.pulls.find(pull => pull.number === given.number);
  if (parsed.query.includes('markPullRequestReadyForReview')) {
    if (byId === undefined) return graphqlError('Could not resolve to a PullRequest.');
    world.written.push({ number: byId.number, what: 'mark ready' });
    byId.draft = false;
    return ok({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
  }
  if (parsed.query.includes('enqueuePullRequest')) {
    if (byId === undefined) return graphqlError('Could not resolve to a PullRequest.');
    if (!world.settings.queue) return graphqlError('The base branch does not use a merge queue.');
    const head = headOf(world, byId);
    if (byId.queued !== null) return ok({ data: { enqueuePullRequest: { mergeQueueEntry: { headCommit: { oid: byId.queued.head } } } } });
    if (given.head !== undefined && given.head !== head) return graphqlError(`The expected head ${given.head} is not the head ${head}.`);
    if (!allows(world, byId, head)) return graphqlError('The pull request is not mergeable.');
    world.enqueues.push({ number: byId.number, head, lastEjection: byId.ejections.at(-1)?.id ?? null });
    byId.queued = { head };
    return ok({ data: { enqueuePullRequest: { mergeQueueEntry: { headCommit: { oid: head } } } } });
  }
  if (parsed.query.startsWith('query Facts')) {
    if (byNumber === undefined) return graphqlError('Could not resolve to a PullRequest.');
    return ok({ data: facts(world, byNumber, first, given.withAnswered === true ? given.answered : undefined) });
  }
  if (parsed.query.startsWith('query Contexts')) {
    return ok({ data: { repository: { object: { statusCheckRollup: { contexts: page(contextsOf(world, given.oid ?? ''), first, given.after) } } } } });
  }
  if (parsed.query.startsWith('query Reviews')) {
    if (byNumber === undefined) return graphqlError('Could not resolve to a PullRequest.');
    return ok({ data: { repository: { pullRequest: { latestOpinionatedReviews: page(latestByReviewer(byNumber).map(review => reviewNode(review, first)), first, given.after) } } } });
  }
  if (parsed.query.startsWith('query Comments')) {
    const review = world.pulls.flatMap(pull => pull.reviews).find(entry => entry.id === given.review);
    if (review === undefined) return graphqlError('Could not resolve to a PullRequestReview.');
    return ok({ data: { node: { comments: page(reviewNode(review, 100).comments.nodes, first, given.after) } } });
  }
  return graphqlError('The fake GitHub does not know this query.');
}

const openPullOn = (world: World, branch: string, into: string): FakePull | undefined => world.pulls.find(pull => pull.branch === branch && pull.base === into && !pull.closed && pull.merged === null);

export function openPullRequest(world: World, branch: string, into: string, body: string, draft: boolean): FakePull {
  world.serial += 1;
  const pull: FakePull = {
    number: world.pulls.length + 1,
    nodeId: `PR_${String(world.serial)}`,
    branch,
    base: into,
    body,
    draft,
    closed: false,
    merged: null,
    conflict: false,
    behind: false,
    mergeabilityKnown: false,
    ruleBlocks: false,
    reviews: [],
    queued: null,
    ejections: [],
  };
  world.pulls.push(pull);
  return pull;
}

const jsonBody = z.record(z.string(), z.unknown());

function rest(world: World, method: string, path: string, query: URLSearchParams, body: Readonly<Record<string, unknown>>): Answer {
  const prefix = `/repos/${repository}`;
  if (!path.startsWith(prefix)) return refuse(404, 'Not Found');
  const route = path.slice(prefix.length);
  const pullRoute = /^\/pulls\/(\d+)(\/update-branch|\/merge)?$/.exec(route);
  const refRoute = /^\/git\/refs?\/heads\/(.+)$/.exec(route);
  const commitRoute = /^\/commits\/([0-9a-f]{40})$/.exec(route);
  if (method === 'GET' && route === '/pulls') {
    const head = (query.get('head') ?? '').replace(/^[^:]+:/, '');
    const state = query.get('state') ?? 'open';
    const perPage = Number.parseInt(query.get('per_page') ?? '30', 10);
    const pageNumber = Number.parseInt(query.get('page') ?? '1', 10);
    const found = world.pulls.filter(pull => pull.branch === head && (state === 'all' || (!pull.closed && pull.merged === null)));
    return ok(found.slice((pageNumber - 1) * perPage, pageNumber * perPage).map(pull => restPull(world, pull)));
  }
  if (method === 'POST' && route === '/pulls') {
    const head = String(body['head']);
    const into = String(body['base']);
    if (!world.branches.has(head)) return refuse(422, 'Validation Failed', `The head ${head} does not exist.`);
    if (openPullOn(world, head, into) !== undefined) return refuse(422, 'Validation Failed', `A pull request already exists for sim:${head}.`);
    return ok(restPull(world, openPullRequest(world, head, into, String(body['body']), body['draft'] === true)), 201);
  }
  if (pullRoute !== null) {
    const pull = world.pulls.find(entry => entry.number === Number.parseInt(pullRoute[1] ?? '', 10));
    if (pull === undefined) return refuse(404, 'Not Found');
    const head = headOf(world, pull);
    if (method === 'GET' && pullRoute[2] === undefined) return ok(restPull(world, pull));
    if (method !== 'GET') world.written.push({ number: pull.number, what: `${method} ${pullRoute[2] ?? 'body'}` });
    if (method === 'PATCH' && pullRoute[2] === undefined) {
      pull.body = String(body['body']);
      return ok(restPull(world, pull));
    }
    if (method === 'PUT' && pullRoute[2] === '/update-branch') {
      if (body['expected_head_sha'] !== undefined && body['expected_head_sha'] !== head) return refuse(422, "expected head sha didn't match current head ref.");
      if (!pull.behind) return refuse(422, 'There are no new commits on the base branch.');
      pull.behind = false;
      moveBranch(world, pull.branch, commitOn(world, [head, world.branches.get(base) ?? '']));
      return ok({ message: 'Updating pull request branch.' }, 202);
    }
    if (method === 'PUT' && pullRoute[2] === '/merge') {
      if (pull.merged !== null) return refuse(405, 'Pull Request is not mergeable');
      if (world.settings.queue) return refuse(405, 'Changes must be made through the merge queue');
      if (body['sha'] !== undefined && body['sha'] !== head) return refuse(409, 'Head branch was modified. Review and try the merge again.');
      if (!allows(world, pull, head)) return refuse(405, 'Pull Request is not mergeable');
      mergeNow(world, pull, head, 'direct');
      return ok({ merged: true, sha: commitOn(world, [world.branches.get(base) ?? '', head]), message: 'Pull Request successfully merged' });
    }
  }
  if (method === 'GET' && commitRoute !== null) {
    const parents = world.commits.get(commitRoute[1] ?? '');
    return parents === undefined ? refuse(422, 'No commit found') : ok({ parents: parents.map(parent => ({ sha: parent })) });
  }
  if (method === 'POST' && route === '/git/refs') {
    const branch = String(body['ref']).replace(/^refs\/heads\//, '');
    if (world.branches.has(branch)) return refuse(422, 'Reference already exists');
    world.branches.set(branch, String(body['sha']));
    return ok({ ref: `refs/heads/${branch}`, object: { sha: String(body['sha']) } }, 201);
  }
  if (refRoute !== null) {
    const branch = decodeURIComponent(refRoute[1] ?? '');
    const holds = world.branches.get(branch);
    if (method === 'GET') return holds === undefined ? refuse(404, 'Not Found') : ok({ ref: `refs/heads/${branch}`, object: { sha: holds } });
    if (holds === undefined) return refuse(422, 'Reference does not exist');
    if (method === 'DELETE') {
      world.branches.delete(branch);
      return { status: 204 };
    }
    if (method === 'PATCH') {
      const to = String(body['sha']);
      if (body['force'] !== true && !ancestors(world, to).has(holds)) return refuse(422, 'Update is not a fast forward');
      moveBranch(world, branch, to);
      return ok({ ref: `refs/heads/${branch}`, object: { sha: to } });
    }
  }
  return refuse(404, 'Not Found');
}

export type Faults = {
  readonly loseReply: (method: string, path: string) => boolean;
  readonly rewrite: (method: string, path: string, body: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
  readonly racePush: () => boolean;
};

const mergeTarget = (world: World, method: string, path: string, body: Readonly<Record<string, unknown>>): FakePull | undefined => {
  const merging = method === 'PUT' ? /\/pulls\/(\d+)\/merge$/.exec(path) : null;
  if (merging !== null) return world.pulls.find(pull => pull.number === Number.parseInt(merging[1] ?? '', 10));
  const parsed = path === '/graphql' ? graphqlBody.safeParse(body) : undefined;
  return parsed?.success === true && parsed.data.query.includes('enqueuePullRequest') ? world.pulls.find(pull => pull.nodeId === parsed.data.variables.id) : undefined;
};

function pushTested(world: World, pull: FakePull): void {
  const tested = commitOn(world, [headOf(world, pull)]);
  world.checks.set(tested, new Map([[checkNames.required, 'green'], [checkNames.counted, 'green'], [checkNames.ignorable, 'green']]));
  moveBranch(world, pull.branch, tested);
}

export const fakeFetch =
  (world: World, faults: Faults): typeof fetch =>
  async (input, init) => {
    world.calls += 1;
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? 'GET';
    const text = typeof init?.body === 'string' ? init.body : '';
    const given = faults.rewrite(method, url.pathname, text === '' ? {} : jsonBody.parse(JSON.parse(text)));
    const raced = mergeTarget(world, method, url.pathname, given);
    if (raced !== undefined && raced.merged === null && !raced.closed && faults.racePush()) pushTested(world, raced);
    const answer = url.pathname === '/graphql' ? graphql(world, given) : rest(world, method, url.pathname, url.searchParams, given);
    if (method !== 'GET' && !url.pathname.endsWith('/graphql') && faults.loseReply(method, url.pathname)) throw new TypeError('fetch failed, because the reply was lost');
    if (url.pathname === '/graphql' && /mutation/.test(text) && faults.loseReply(method, url.pathname)) throw new TypeError('fetch failed, because the reply was lost');
    return Promise.resolve(
      new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json; charset=utf-8' } }),
    );
  };
