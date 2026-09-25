import type { Database } from '../../shared/db/client.ts';
import type { DraftLeaves } from '../../shared/db/types.ts';
import type { Answered, MergeRead, MergeValue, PullRequest, ReadMergeState } from '../../shared/merge-state.ts';
import type { CheckResult, ClientFor, GithubClient, PullFacts, Ran } from './client.ts';

export type Rules = { readonly ignorableChecks: ReadonlySet<string>; readonly ignoredReviewers: ReadonlySet<string>; readonly draftLeaves: DraftLeaves };

type ChangesRequested = Extract<MergeValue, { readonly kind: 'changes-requested' }>;

export type View = {
  readonly merged: boolean;
  readonly queued: boolean;
  readonly ejection: { readonly id: string; readonly reason: string } | null;
  readonly conflicting: boolean;
  readonly draft: boolean;
  readonly leavesDraftAtOnce: boolean;
  readonly failing: readonly string[];
  readonly checksPending: boolean;
  readonly mergeabilityKnown: boolean;
  readonly changes: ChangesRequested['review'] | null;
  readonly reviewBlocks: boolean;
  readonly behind: boolean;
  readonly mergeable: boolean;
};

export type Rank = { readonly name: string; readonly value: (view: View) => MergeValue | undefined };

const when = (holds: boolean, value: MergeValue): MergeValue | undefined => (holds ? value : undefined);

const redOf = (failing: readonly string[]): MergeValue | undefined => {
  const [first, ...rest] = failing;
  return first === undefined ? undefined : { kind: 'red', failing: [first, ...rest] };
};

export const ranking: readonly Rank[] = [
  { name: 'merged', value: view => when(view.merged, { kind: 'merged' }) },
  { name: 'queued', value: view => when(view.queued, { kind: 'queued' }) },
  { name: 'ejected', value: ({ ejection }) => (ejection === null ? undefined : { kind: 'ejected', ejection: ejection.id, reason: ejection.reason }) },
  { name: 'conflicting', value: view => when(view.conflicting, { kind: 'conflicting' }) },
  { name: 'draft-leaves-at-once', value: view => when(view.draft && view.leavesDraftAtOnce, { kind: 'green-draft' }) },
  { name: 'red', value: view => redOf(view.failing) },
  { name: 'green-draft', value: view => when(view.draft && !view.checksPending, { kind: 'green-draft' }) },
  { name: 'waiting-for-checks', value: view => when(view.draft || view.checksPending || !view.mergeabilityKnown, { kind: 'waiting-for-checks' }) },
  { name: 'changes-requested', value: ({ changes }) => (changes === null ? undefined : { kind: 'changes-requested', review: changes }) },
  { name: 'review-required', value: view => when(view.reviewBlocks, { kind: 'review-required' }) },
  { name: 'behind', value: view => when(view.behind, { kind: 'behind' }) },
  { name: 'ready', value: view => when(view.mergeable, { kind: 'ready' }) },
];

const severity: Readonly<Record<CheckResult, number>> = { green: 0, pending: 1, red: 2 };

const started = (one: Ran, other: Ran): number => (one.at === null || other.at === null ? Number(one.at === null) - Number(other.at === null) : one.at.localeCompare(other.at));

const latest = (runs: readonly Ran[]): Ran | undefined => runs.toSorted((one, other) => started(one, other) || severity[one.result] - severity[other.result]).at(-1);

function countedResults(facts: PullFacts, rules: Rules): ReadonlyMap<string, CheckResult> {
  const byName = Map.groupBy(
    facts.checks.filter(check => !rules.ignorableChecks.has(check.name)),
    check => check.name,
  );
  const results = new Map<string, CheckResult>();
  for (const [name, runs] of byName) results.set(name, latest(runs)?.result ?? 'pending');
  return results;
}

const mergeableStatuses: ReadonlySet<string> = new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS']);

function unansweredChanges(facts: PullFacts, rules: Rules, answered: Answered): View['changes'] {
  const open = facts.reviews
    .filter(review => review.state === 'CHANGES_REQUESTED' && !rules.ignoredReviewers.has(review.reviewer) && review.id !== answered.review)
    .filter(review => facts.answeredAt === null || review.submittedAt > facts.answeredAt)
    .toSorted((one, other) => one.submittedAt.localeCompare(other.submittedAt));
  const review = open.at(-1);
  return review === undefined ? null : { id: review.id, reviewer: review.reviewer, body: review.body, comments: [...review.comments] };
}

export function viewOf(facts: PullFacts, rules: Rules, answered: Answered): View {
  const counted = countedResults(facts, rules);
  const reported = new Set(facts.checks.map(check => check.name));
  const results = [...counted.values()];
  return {
    merged: facts.state === 'MERGED',
    queued: facts.queuedAt !== null,
    ejection: facts.ejection === null || facts.ejection.id === answered.ejection ? null : { id: facts.ejection.id, reason: facts.ejection.reason },
    conflicting: facts.mergeable === 'CONFLICTING',
    draft: facts.draft,
    leavesDraftAtOnce: rules.draftLeaves === 'at-once',
    failing: [...counted].filter(([, result]) => result === 'red').map(([name]) => name).toSorted(),
    checksPending: facts.checkedHead !== facts.head || results.includes('pending') || facts.required.some(name => !reported.has(name)),
    mergeabilityKnown: facts.mergeable !== 'UNKNOWN',
    changes: unansweredChanges(facts, rules, answered),
    reviewBlocks: facts.reviewDecision === 'REVIEW_REQUIRED' || facts.reviewDecision === 'CHANGES_REQUESTED' || (facts.mergeStateStatus === 'BLOCKED' && facts.reviewDecision !== 'APPROVED'),
    behind: facts.mergeStateStatus === 'BEHIND',
    mergeable: facts.mergeable === 'MERGEABLE' && mergeableStatuses.has(facts.mergeStateStatus),
  };
}

export const reduce = (view: View, ranks: readonly Rank[] = ranking): MergeValue =>
  ranks.reduce<MergeValue | undefined>((found, rank) => found ?? rank.value(view), undefined) ?? { kind: 'waiting-for-checks' };

export type Target = { readonly github: string; readonly number: number; readonly rules: Rules };

export async function readWith(client: GithubClient, target: Target, answered: Answered, signal: AbortSignal, ranks: readonly Rank[] = ranking): Promise<MergeRead> {
  const facts = await client.pullFacts(target.github, target.number, answered.review, signal);
  if (!('ok' in facts)) return { failed: `GitHub answered ${String(facts.status)} reading pull request ${String(target.number)} of ${target.github}: ${facts.message}` };
  if (facts.ok.state === 'CLOSED') return { failed: `Pull request ${String(target.number)} of ${target.github} was closed without merging.` };
  return { state: { head: facts.ok.head, value: reduce(viewOf(facts.ok, target.rules, answered), ranks) } };
}

type RulesRow = { readonly ignorable_checks: readonly string[]; readonly ignored_reviewers: readonly string[]; readonly draft_leaves: DraftLeaves };

export const rulesOf = (row: RulesRow): Rules => ({ ignorableChecks: new Set(row.ignorable_checks), ignoredReviewers: new Set(row.ignored_reviewers), draftLeaves: row.draft_leaves });

async function targetOf(db: Database, pullRequest: PullRequest): Promise<Target | undefined> {
  const row = await db
    .selectFrom('repository')
    .select(['github', 'ignorable_checks', 'ignored_reviewers', 'draft_leaves'])
    .where('id', '=', pullRequest.repositoryId)
    .executeTakeFirst();
  return row === undefined ? undefined : { github: row.github, number: pullRequest.number, rules: rulesOf(row) };
}

export const mergeStateReader =
  (db: Database, clientFor: ClientFor): ReadMergeState =>
  async (pullRequest, answered, signal) => {
    const target = await targetOf(db, pullRequest);
    if (target === undefined) return { failed: `Repository ${pullRequest.repositoryId} does not exist.` };
    const client = await clientFor(pullRequest.actsAs);
    return 'failed' in client ? client : readWith(client, target, answered, signal);
  };
