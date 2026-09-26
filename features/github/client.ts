import { Octokit } from '@octokit/core';
import { z } from 'zod';

export type Reply<T> = { readonly ok: T } | { readonly status: number; readonly message: string };

export type GithubSettings = { readonly token: string; readonly baseUrl: string; readonly pageSize: number; readonly fetch?: typeof fetch };

const commit = z.string().regex(/^[0-9a-f]{40}$/);

const pull = z.object({
  number: z.int().positive(),
  node_id: z.string().min(1),
  html_url: z.url(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean(),
  merged_at: z.string().nullable(),
  body: z.string().nullable(),
  head: z.object({ ref: z.string(), sha: commit }),
  base: z.object({ ref: z.string() }),
});

export type Pull = z.infer<typeof pull>;

const refusal = z.object({
  status: z.int(),
  response: z.object({ data: z.looseObject({ message: z.string().optional(), errors: z.array(z.looseObject({ message: z.string().optional() })).optional() }).optional() }).optional(),
  message: z.string(),
});

const graphqlErrors = z.object({ errors: z.array(z.object({ type: z.string().optional(), message: z.string() })).min(1) });

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });

const checkRun = z.object({
  __typename: z.literal('CheckRun'),
  name: z.string().min(1),
  status: z.string(),
  conclusion: z.string().nullable(),
  startedAt: z.iso.datetime().nullable(),
});

const statusContext = z.object({ __typename: z.literal('StatusContext'), context: z.string().min(1), state: z.string(), createdAt: z.iso.datetime() });

const context = z.discriminatedUnion('__typename', [checkRun, statusContext]);

const contexts = z.object({ pageInfo, nodes: z.array(context) });

const reviewComments = z.object({ pageInfo, nodes: z.array(z.object({ path: z.string().nullable(), line: z.int().positive().nullable(), body: z.string() })) });

const review = z.object({
  id: z.string().min(1),
  state: z.string(),
  submittedAt: z.iso.datetime().nullable(),
  body: z.string(),
  author: z.object({ login: z.string().min(1) }).nullable(),
  comments: reviewComments,
});

const reviews = z.object({ pageInfo, nodes: z.array(review) });

const rule = z.object({
  type: z.string(),
  parameters: z.looseObject({ requiredStatusChecks: z.array(z.object({ context: z.string().min(1) })).optional() }).nullable(),
});

const factsData = z.object({
  repository: z.object({
    pullRequest: z.object({
      id: z.string().min(1),
      number: z.int().positive(),
      url: z.url(),
      state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
      isDraft: z.boolean(),
      mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
      mergeStateStatus: z.string(),
      reviewDecision: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED']).nullable(),
      isInMergeQueue: z.boolean(),
      mergeQueueEntry: z.object({ headCommit: z.object({ oid: commit }).nullable() }).nullable(),
      headRefOid: commit,
      baseRef: z.object({ rules: z.object({ nodes: z.array(rule) }), branchProtectionRule: z.object({ requiredStatusCheckContexts: z.array(z.string()).nullable() }).nullable() }).nullable(),
      commits: z.object({ nodes: z.array(z.object({ commit: z.object({ oid: commit, statusCheckRollup: z.object({ contexts }).nullable() }) })) }),
      latestOpinionatedReviews: reviews,
      timelineItems: z.object({
        nodes: z.array(z.object({ id: z.string().min(1), reason: z.string().nullable(), createdAt: z.iso.datetime(), beforeCommit: z.object({ oid: commit }).nullable() })),
      }),
    }),
  }),
  answered: z.object({ submittedAt: z.iso.datetime().nullable() }).nullable().optional(),
});

export type CheckResult = 'pending' | 'green' | 'red';

export type Ran = { readonly name: string; readonly result: CheckResult; readonly at: string | null };

export type ReviewFacts = {
  readonly id: string;
  readonly state: string;
  readonly reviewer: string;
  readonly body: string;
  readonly submittedAt: string;
  readonly comments: readonly { readonly path: string | null; readonly line: number | null; readonly body: string }[];
};

export type PullFacts = {
  readonly id: string;
  readonly number: number;
  readonly state: 'OPEN' | 'CLOSED' | 'MERGED';
  readonly head: string;
  readonly checkedHead: string | null;
  readonly draft: boolean;
  readonly mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  readonly mergeStateStatus: string;
  readonly reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  readonly queuedAt: string | null;
  readonly usesMergeQueue: boolean;
  readonly required: readonly string[];
  readonly checks: readonly Ran[];
  readonly reviews: readonly ReviewFacts[];
  readonly answeredAt: string | null;
  readonly ejection: { readonly id: string; readonly reason: string; readonly at: string; readonly head: string | null } | null;
};

const factsQuery = `query Facts($owner: String!, $name: String!, $number: Int!, $first: Int!, $answered: ID!, $withAnswered: Boolean!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number url state isDraft mergeable mergeStateStatus reviewDecision isInMergeQueue
      mergeQueueEntry { headCommit { oid } }
      headRefOid
      baseRef {
        rules(first: 100) { nodes { type parameters { ... on RequiredStatusChecksParameters { requiredStatusChecks { context } } } } }
        branchProtectionRule { requiredStatusCheckContexts }
      }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: $first) {
        pageInfo { hasNextPage endCursor }
        nodes { __typename ... on CheckRun { name status conclusion startedAt } ... on StatusContext { context state createdAt } }
      } } } } }
      latestOpinionatedReviews(first: $first, writersOnly: true) {
        pageInfo { hasNextPage endCursor }
        nodes { id state submittedAt body author { login } comments(first: $first) { pageInfo { hasNextPage endCursor } nodes { path line body } } }
      }
      timelineItems(last: 1, itemTypes: [REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes { ... on RemovedFromMergeQueueEvent { id reason createdAt beforeCommit { oid } } } }
    }
  }
  answered: node(id: $answered) @include(if: $withAnswered) { ... on PullRequestReview { submittedAt } }
}`;

const contextsQuery = `query Contexts($owner: String!, $name: String!, $oid: GitObjectID!, $first: Int!, $after: String!) {
  repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { statusCheckRollup { contexts(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { __typename ... on CheckRun { name status conclusion startedAt } ... on StatusContext { context state createdAt } }
  } } } } }
}`;

const contextsData = z.object({ repository: z.object({ object: z.object({ statusCheckRollup: z.object({ contexts }) }) }) });

const reviewsQuery = `query Reviews($owner: String!, $name: String!, $number: Int!, $first: Int!, $after: String!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { latestOpinionatedReviews(first: $first, after: $after, writersOnly: true) {
    pageInfo { hasNextPage endCursor }
    nodes { id state submittedAt body author { login } comments(first: $first) { pageInfo { hasNextPage endCursor } nodes { path line body } } }
  } } }
}`;

const reviewsData = z.object({ repository: z.object({ pullRequest: z.object({ latestOpinionatedReviews: reviews }) }) });

const commentsQuery = `query Comments($review: ID!, $first: Int!, $after: String!) {
  node(id: $review) { ... on PullRequestReview { comments(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { path line body } } } }
}`;

const commentsData = z.object({ node: z.object({ comments: reviewComments }) });

const readyMutation = `mutation Ready($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`;

const readyData = z.object({ markPullRequestReadyForReview: z.object({ pullRequest: z.object({ isDraft: z.boolean() }) }) });

const enqueueMutation = `mutation Enqueue($id: ID!, $head: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $head }) { mergeQueueEntry { headCommit { oid } } }
}`;

const enqueueData = z.object({ enqueuePullRequest: z.object({ mergeQueueEntry: z.object({ headCommit: z.object({ oid: commit }).nullable() }).nullable() }) });

const ref = z.object({ object: z.object({ sha: commit }) });

const parents = z.object({ parents: z.array(z.object({ sha: commit })) });

const merged = z.object({ merged: z.boolean(), sha: commit });

const noAnswer = 0;

const noReview = 'none';

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function refused(error: unknown): { readonly status: number; readonly message: string } {
  const parsed = refusal.safeParse(error);
  if (!parsed.success) return { status: noAnswer, message: reason(error) };
  const data = parsed.data.response?.data;
  const details = (data?.errors ?? []).flatMap(entry => (entry.message === undefined ? [] : [entry.message]));
  return { status: parsed.data.status, message: [data?.message ?? parsed.data.message, ...details].join(' ') };
}

const resultOf = (conclusion: string | null, status: string): CheckResult => {
  if (status !== 'COMPLETED') return 'pending';
  return conclusion === 'SUCCESS' || conclusion === 'NEUTRAL' || conclusion === 'SKIPPED' ? 'green' : 'red';
};

const statusResult = (state: string): CheckResult => {
  if (state === 'SUCCESS') return 'green';
  return state === 'FAILURE' || state === 'ERROR' ? 'red' : 'pending';
};

const ranOf = (node: z.infer<typeof context>): Ran =>
  node.__typename === 'CheckRun'
    ? { name: node.name, result: resultOf(node.conclusion, node.status), at: node.startedAt }
    : { name: node.context, result: statusResult(node.state), at: node.createdAt };

const refPath = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/');

export type GithubClient = ReturnType<typeof githubClient>;

export function githubClient(settings: GithubSettings) {
  const octokit = new Octokit({ auth: settings.token, baseUrl: settings.baseUrl, request: { retries: 0, ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }) } });
  const first = settings.pageSize;

  async function rest<T>(schema: z.ZodType<T>, route: string, parameters: Record<string, unknown>, signal: AbortSignal): Promise<Reply<T>> {
    try {
      const answer = await octokit.request(route, { ...parameters, request: { signal } });
      const data: unknown = answer.data;
      const parsed = schema.safeParse(data);
      return parsed.success ? { ok: parsed.data } : { status: answer.status, message: `GitHub's answer to ${route} does not parse. ${z.prettifyError(parsed.error)}` };
    } catch (error) {
      return refused(error);
    }
  }

  async function graphql<T>(schema: z.ZodType<T>, query: string, variables: Record<string, unknown>, signal: AbortSignal): Promise<Reply<T>> {
    const answer = await rest(z.looseObject({ data: z.unknown().optional(), errors: z.unknown().optional() }), 'POST /graphql', { query, variables }, signal);
    if (!('ok' in answer)) return answer;
    const errors = graphqlErrors.safeParse(answer.ok);
    if (errors.success) return { status: 422, message: errors.data.errors.map(entry => `${entry.type ?? 'ERROR'}: ${entry.message}`).join(' ') };
    const parsed = schema.safeParse(answer.ok.data);
    return parsed.success ? { ok: parsed.data } : { status: 200, message: `GitHub's GraphQL answer does not parse. ${z.prettifyError(parsed.error)}` };
  }

  const split = (repository: string): { readonly owner: string; readonly name: string } => {
    const [owner = '', name = ''] = repository.split('/');
    return { owner, name };
  };

  async function allContexts(repository: string, oid: string, page: z.infer<typeof contexts>, signal: AbortSignal): Promise<Reply<readonly Ran[]>> {
    const found = page.nodes.map(ranOf);
    let info = page.pageInfo;
    while (info.hasNextPage && info.endCursor !== null) {
      const next = await graphql(contextsData, contextsQuery, { ...split(repository), oid, first, after: info.endCursor }, signal);
      if (!('ok' in next)) return next;
      const more = next.ok.repository.object.statusCheckRollup.contexts;
      found.push(...more.nodes.map(ranOf));
      info = more.pageInfo;
    }
    return { ok: found };
  }

  async function allComments(submitted: z.infer<typeof review>, signal: AbortSignal): Promise<Reply<ReviewFacts['comments']>> {
    const found = [...submitted.comments.nodes];
    let info = submitted.comments.pageInfo;
    while (info.hasNextPage && info.endCursor !== null) {
      const next = await graphql(commentsData, commentsQuery, { review: submitted.id, first, after: info.endCursor }, signal);
      if (!('ok' in next)) return next;
      found.push(...next.ok.node.comments.nodes);
      info = next.ok.node.comments.pageInfo;
    }
    return { ok: found };
  }

  async function allReviews(repository: string, number: number, page: z.infer<typeof reviews>, signal: AbortSignal): Promise<Reply<readonly ReviewFacts[]>> {
    const nodes = [...page.nodes];
    let info = page.pageInfo;
    while (info.hasNextPage && info.endCursor !== null) {
      const next = await graphql(reviewsData, reviewsQuery, { ...split(repository), number, first, after: info.endCursor }, signal);
      if (!('ok' in next)) return next;
      nodes.push(...next.ok.repository.pullRequest.latestOpinionatedReviews.nodes);
      info = next.ok.repository.pullRequest.latestOpinionatedReviews.pageInfo;
    }
    const found: ReviewFacts[] = [];
    for (const node of nodes) {
      if (node.submittedAt === null || node.author === null) continue;
      const comments = node.state === 'CHANGES_REQUESTED' ? await allComments(node, signal) : { ok: node.comments.nodes };
      if (!('ok' in comments)) return comments;
      found.push({ id: node.id, state: node.state, reviewer: node.author.login, body: node.body, submittedAt: node.submittedAt, comments: comments.ok });
    }
    return { ok: found };
  }

  return {
    pullFacts: async (repository: string, number: number, answeredReview: string | null, signal: AbortSignal): Promise<Reply<PullFacts>> => {
      const answer = await graphql(factsData, factsQuery, { ...split(repository), number, first, answered: answeredReview ?? noReview, withAnswered: answeredReview !== null }, signal);
      if (!('ok' in answer)) return answer;
      const found = answer.ok.repository.pullRequest;
      const last = found.commits.nodes.at(-1)?.commit;
      const rollup = last?.statusCheckRollup?.contexts;
      const checks = last === undefined || rollup === undefined ? { ok: [] } : await allContexts(repository, last.oid, rollup, signal);
      if (!('ok' in checks)) return checks;
      const reviewed = await allReviews(repository, number, found.latestOpinionatedReviews, signal);
      if (!('ok' in reviewed)) return reviewed;
      const rules = found.baseRef?.rules.nodes ?? [];
      const ejection = found.timelineItems.nodes.at(-1);
      return {
        ok: {
          id: found.id,
          number: found.number,
          state: found.state,
          head: found.headRefOid,
          checkedHead: last?.oid ?? null,
          draft: found.isDraft,
          mergeable: found.mergeable,
          mergeStateStatus: found.mergeStateStatus,
          reviewDecision: found.reviewDecision,
          queuedAt: found.isInMergeQueue ? (found.mergeQueueEntry?.headCommit?.oid ?? found.headRefOid) : null,
          usesMergeQueue: rules.some(entry => entry.type === 'MERGE_QUEUE'),
          required: [
            ...rules.flatMap(entry => (entry.parameters?.requiredStatusChecks ?? []).map(check => check.context)),
            ...(found.baseRef?.branchProtectionRule?.requiredStatusCheckContexts ?? []),
          ],
          checks: checks.ok,
          reviews: reviewed.ok,
          answeredAt: answer.ok.answered?.submittedAt ?? null,
          ejection: ejection === undefined ? null : { id: ejection.id, reason: ejection.reason ?? '', at: ejection.createdAt, head: ejection.beforeCommit?.oid ?? null },
        },
      };
    },
    pullsByHead: async (repository: string, head: string, state: 'open' | 'all', signal: AbortSignal): Promise<Reply<readonly Pull[]>> => {
      const found: Pull[] = [];
      for (let page = 1; ; page += 1) {
        const answer = await rest(z.array(pull), 'GET /repos/{owner}/{repo}/pulls', { owner: split(repository).owner, repo: split(repository).name, head: `${split(repository).owner}:${head}`, state, per_page: first, page }, signal);
        if (!('ok' in answer)) return answer;
        found.push(...answer.ok);
        if (answer.ok.length < first) return { ok: found };
      }
    },
    openDraft: (repository: string, opened: { readonly head: string; readonly base: string; readonly title: string; readonly body: string }, signal: AbortSignal): Promise<Reply<Pull>> =>
      rest(pull, 'POST /repos/{owner}/{repo}/pulls', { owner: split(repository).owner, repo: split(repository).name, ...opened, draft: true }, signal),
    pull: (repository: string, number: number, signal: AbortSignal): Promise<Reply<Pull>> =>
      rest(pull, 'GET /repos/{owner}/{repo}/pulls/{pull_number}', { owner: split(repository).owner, repo: split(repository).name, pull_number: number }, signal),
    setBody: (repository: string, number: number, body: string, signal: AbortSignal): Promise<Reply<Pull>> =>
      rest(pull, 'PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { owner: split(repository).owner, repo: split(repository).name, pull_number: number, body }, signal),
    markReady: async (pullId: string, signal: AbortSignal): Promise<Reply<{ readonly draft: boolean }>> => {
      const answer = await graphql(readyData, readyMutation, { id: pullId }, signal);
      return 'ok' in answer ? { ok: { draft: answer.ok.markPullRequestReadyForReview.pullRequest.isDraft } } : answer;
    },
    updateBranch: (repository: string, number: number, expectedHead: string, signal: AbortSignal): Promise<Reply<unknown>> =>
      rest(z.unknown(), 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch', { owner: split(repository).owner, repo: split(repository).name, pull_number: number, expected_head_sha: expectedHead }, signal),
    parentsOf: async (repository: string, sha: string, signal: AbortSignal): Promise<Reply<readonly string[]>> => {
      const answer = await rest(parents, 'GET /repos/{owner}/{repo}/commits/{ref}', { owner: split(repository).owner, repo: split(repository).name, ref: sha }, signal);
      return 'ok' in answer ? { ok: answer.ok.parents.map(parent => parent.sha) } : answer;
    },
    merge: (repository: string, number: number, sha: string, signal: AbortSignal): Promise<Reply<z.infer<typeof merged>>> =>
      rest(merged, 'PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { owner: split(repository).owner, repo: split(repository).name, pull_number: number, sha, merge_method: 'merge' }, signal),
    enqueue: async (pullId: string, head: string, signal: AbortSignal): Promise<Reply<{ readonly head: string | null }>> => {
      const answer = await graphql(enqueueData, enqueueMutation, { id: pullId, head }, signal);
      return 'ok' in answer ? { ok: { head: answer.ok.enqueuePullRequest.mergeQueueEntry?.headCommit?.oid ?? null } } : answer;
    },
    branchHead: async (repository: string, branch: string, signal: AbortSignal): Promise<Reply<string | null>> => {
      const answer = await rest(ref, `GET /repos/{owner}/{repo}/git/ref/heads/${refPath(branch)}`, { owner: split(repository).owner, repo: split(repository).name }, signal);
      if ('ok' in answer) return { ok: answer.ok.object.sha };
      return answer.status === 404 ? { ok: null } : answer;
    },
    createBranch: (repository: string, branch: string, sha: string, signal: AbortSignal): Promise<Reply<z.infer<typeof ref>>> =>
      rest(ref, 'POST /repos/{owner}/{repo}/git/refs', { owner: split(repository).owner, repo: split(repository).name, ref: `refs/heads/${branch}`, sha }, signal),
    moveBranch: (repository: string, branch: string, sha: string, signal: AbortSignal): Promise<Reply<z.infer<typeof ref>>> =>
      rest(ref, `PATCH /repos/{owner}/{repo}/git/refs/heads/${refPath(branch)}`, { owner: split(repository).owner, repo: split(repository).name, sha, force: false }, signal),
    deleteBranch: (repository: string, branch: string, signal: AbortSignal): Promise<Reply<unknown>> =>
      rest(z.unknown(), `DELETE /repos/{owner}/{repo}/git/refs/heads/${refPath(branch)}`, { owner: split(repository).owner, repo: split(repository).name }, signal),
  };
}

export type OpenToken = (actsAs: string) => Promise<{ readonly token: string } | { readonly failed: string }>;

export type ClientFor = (actsAs: string) => Promise<GithubClient | { readonly failed: string }>;

export const clientsFrom =
  (openToken: OpenToken, baseUrl: string): ClientFor =>
  async actsAs => {
    const opened = await openToken(actsAs);
    return 'failed' in opened ? opened : githubClient({ token: opened.token, baseUrl, pageSize: 100 });
  };
