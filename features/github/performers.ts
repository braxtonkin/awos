import { actionKinds, performer, type Limits, type Outcome, type Owed, type Performers } from '../../shared/actions.ts';
import type { Database } from '../../shared/db/client.ts';
import type { ClientFor, GithubClient, Pull, Reply } from './client.ts';

export const githubKinds = [
  actionKinds.prOpenDraft.kind,
  actionKinds.prMarkReady.kind,
  actionKinds.prEvidence.kind,
  actionKinds.prUpdateBranch.kind,
  actionKinds.prMerge.kind,
  actionKinds.branchAdvance.kind,
  actionKinds.branchDelete.kind,
] as const;

export type GithubKind = (typeof githubKinds)[number];

export type OwedAt = (row: string) => Promise<Date | undefined>;

export type Connector = { readonly clientFor: ClientFor; readonly owedAt: OwedAt };

type Answer = Extract<Reply<unknown>, { readonly status: number }>;

const said = (what: string, answer: Answer): string => `GitHub answered ${String(answer.status)} to ${what}: ${answer.message}`;

const failed = <R>(what: string, answer: Answer): Outcome<R> => ({ failed: said(what, answer) });

const evidenceHeading = '## Evidence';

const evidenceMark = `\n${evidenceHeading}\n`;

const split = (body: string | null): { readonly kept: string; readonly evidence: string | null } => {
  const text = `\n${body ?? ''}`;
  const at = text.indexOf(evidenceMark);
  return at < 0 ? { kept: text.trim(), evidence: null } : { kept: text.slice(0, at).trim(), evidence: text.slice(at + evidenceMark.length).trim() };
};

export const bodyWithEvidence = (body: string | null, evidence: string): string => {
  const { kept } = split(body);
  return `${kept === '' ? '' : `${kept}\n\n`}${evidenceHeading}\n\n${evidence}`;
};

const already = (answer: Answer, words: RegExp): boolean => answer.status === 422 && words.test(answer.message);

async function withClient<P, R>(connector: Connector, owed: Owed<P>, act: (client: GithubClient) => Promise<Outcome<R>>): Promise<Outcome<R>> {
  const client = await connector.clientFor(owed.actsAs);
  return 'failed' in client ? client : act(client);
}

async function openPull(client: GithubClient, repository: string, head: string, signal: AbortSignal): Promise<Pull | Answer | undefined> {
  const found = await client.pullsByHead(repository, head, 'open', signal);
  return 'ok' in found ? found.ok.toSorted((one, other) => other.number - one.number)[0] : found;
}

const missing = (head: string): Outcome<never> => ({ failed: `No open pull request has the head branch ${head}.` });

type Opened = { readonly repository: string; readonly head: string; readonly base: string; readonly title: string; readonly body: string };

async function openDraft(client: GithubClient, owed: Owed<Opened>, { signal }: Limits): Promise<Outcome<{ readonly number: number; readonly url: string }>> {
  const { repository, head, base, title, body } = owed.payload;
  const opened = await client.openDraft(repository, { head, base, title, body }, signal);
  if ('ok' in opened) return { done: { number: opened.ok.number, url: opened.ok.html_url } };
  if (!already(opened, /already exists/i)) return failed('opening the pull request', opened);
  const pull = await openPull(client, repository, head, signal);
  if (pull === undefined || 'status' in pull || pull.base.ref !== base) return failed('opening the pull request', opened);
  return { done: { number: pull.number, url: pull.html_url } };
}

type EvidencePayload = { readonly repository: string; readonly head: string; readonly evidence: string };

async function withEvidence(client: GithubClient, { repository, head, evidence }: EvidencePayload, signal: AbortSignal): Promise<Pull | Outcome<{ readonly number: number }>> {
  const pull = await openPull(client, repository, head, signal);
  if (pull === undefined) return missing(head);
  if ('status' in pull) return failed('the pull request lookup', pull);
  if (split(pull.body).evidence === evidence.trim()) return pull;
  const written = await client.setBody(repository, pull.number, bodyWithEvidence(pull.body, evidence), signal);
  return 'ok' in written ? pull : failed('the body update', written);
}

const isPull = (value: Pull | Outcome<{ readonly number: number }>): value is Pull => 'node_id' in value;

async function showEvidence(client: GithubClient, owed: Owed<EvidencePayload>, { signal }: Limits): Promise<Outcome<{ readonly number: number }>> {
  const pull = await withEvidence(client, owed.payload, signal);
  return isPull(pull) ? { done: { number: pull.number } } : pull;
}

async function markReady(client: GithubClient, owed: Owed<EvidencePayload>, { signal }: Limits): Promise<Outcome<{ readonly number: number }>> {
  const pull = await withEvidence(client, owed.payload, signal);
  if (!isPull(pull)) return pull;
  if (!pull.draft) return { done: { number: pull.number } };
  const ready = await client.markReady(pull.node_id, signal);
  if (!('ok' in ready)) return failed('marking the pull request ready', ready);
  return ready.ok.draft ? { failed: `Pull request ${String(pull.number)} is still a draft after GitHub accepted the ready call.` } : { done: { number: pull.number } };
}

async function updateBranch(client: GithubClient, owed: Owed<{ readonly repository: string; readonly head: string; readonly commit: string }>, { signal }: Limits): Promise<Outcome<{ readonly head: string }>> {
  const { repository, head, commit } = owed.payload;
  const pull = await openPull(client, repository, head, signal);
  if (pull === undefined) return missing(head);
  if ('status' in pull) return failed('the pull request lookup', pull);
  if (pull.head.sha !== commit) {
    const parents = await client.parentsOf(repository, pull.head.sha, signal);
    if (!('ok' in parents)) return failed('the head commit lookup', parents);
    return parents.ok.length === 2 && parents.ok[0] === commit
      ? { done: { head: pull.head.sha } }
      : { refused: { reason: `The head of ${head} is ${pull.head.sha}, not ${commit}.`, head: commit } };
  }
  const updated = await client.updateBranch(repository, pull.number, commit, signal);
  if ('ok' in updated || already(updated, /no new commits/i)) return { done: { head: commit } };
  return updated.status === 422 ? { refused: { reason: said('the update', updated), head: commit } } : failed('the update', updated);
}

type MergeOutcome = Outcome<
  | { readonly outcome: 'merged'; readonly head: string }
  | { readonly outcome: 'queued'; readonly head: string }
  | { readonly outcome: 'ejected'; readonly head: string; readonly ejection: string; readonly reason: string }
>;

async function merge(client: GithubClient, owedAt: OwedAt, owed: Owed<{ readonly repository: string; readonly head: string; readonly commit: string }>, { signal }: Limits): Promise<MergeOutcome> {
  const { repository, head, commit } = owed.payload;
  const pulls = await client.pullsByHead(repository, head, 'all', signal);
  if (!('ok' in pulls)) return failed('the pull request lookup', pulls);
  const pull = pulls.ok.toSorted((one, other) => other.number - one.number)[0];
  if (pull === undefined) return missing(head);
  if (pull.merged_at !== null) return { done: { outcome: 'merged', head: pull.head.sha } };
  const facts = await client.pullFacts(repository, pull.number, null, signal);
  if (!('ok' in facts)) return failed('the pull request read', facts);
  if (facts.ok.queuedAt !== null) return { done: { outcome: 'queued', head: facts.ok.queuedAt } };
  const since = await owedAt(owed.row);
  const ejection = facts.ok.ejection;
  if (ejection !== null && since !== undefined && new Date(ejection.at) >= since) {
    return { done: { outcome: 'ejected', head: ejection.head ?? commit, ejection: ejection.id, reason: ejection.reason } };
  }
  if (facts.ok.state === 'CLOSED') return { refused: { reason: `Pull request ${String(pull.number)} is closed.`, head: commit } };
  if (facts.ok.usesMergeQueue) {
    const queued = await client.enqueue(facts.ok.id, commit, signal);
    if ('ok' in queued) return { done: { outcome: 'queued', head: queued.ok.head ?? commit } };
    return queued.status === 422 ? { refused: { reason: said('joining the merge queue', queued), head: commit } } : failed('joining the merge queue', queued);
  }
  const merged = await client.merge(repository, pull.number, commit, signal);
  if ('ok' in merged) return merged.ok.merged ? { done: { outcome: 'merged', head: commit } } : { failed: `GitHub did not merge pull request ${String(pull.number)}.` };
  return merged.status === 405 || merged.status === 409 || merged.status === 422 ? { refused: { reason: said('the merge', merged), head: commit } } : failed('the merge', merged);
}

async function advance(client: GithubClient, owed: Owed<{ readonly repository: string; readonly branch: string; readonly from: string | null; readonly to: string }>, { signal }: Limits): Promise<Outcome<{ readonly head: string }>> {
  const { repository, branch, from, to } = owed.payload;
  const holds = await client.branchHead(repository, branch, signal);
  if (!('ok' in holds)) return failed('the branch lookup', holds);
  if (holds.ok === to) return { done: { head: to } };
  if (holds.ok !== from) return { refused: { reason: `Branch ${branch} holds ${holds.ok ?? 'nothing'}, not ${from ?? 'nothing'}.`, head: from } };
  const moved = from === null ? await client.createBranch(repository, branch, to, signal) : await client.moveBranch(repository, branch, to, signal);
  if ('ok' in moved) return { done: { head: to } };
  return moved.status === 422 ? { refused: { reason: said('the branch move', moved), head: from } } : failed('the branch move', moved);
}

async function remove(client: GithubClient, owed: Owed<{ readonly repository: string; readonly branch: string }>, { signal }: Limits): Promise<Outcome<{ readonly deleted: boolean }>> {
  const deleted = await client.deleteBranch(owed.payload.repository, owed.payload.branch, signal);
  if ('ok' in deleted) return { done: { deleted: true } };
  return deleted.status === 404 || already(deleted, /does not exist/i) ? { done: { deleted: false } } : failed('the branch delete', deleted);
}

export const githubPerformers = (connector: Connector): Performers<GithubKind> => ({
  'pr.open-draft': performer(actionKinds.prOpenDraft, { catches: 'duplicates', call: (owed, limits) => withClient(connector, owed, client => openDraft(client, owed, limits)) }),
  'pr.mark-ready': performer(actionKinds.prMarkReady, { catches: 'duplicates', call: (owed, limits) => withClient(connector, owed, client => markReady(client, owed, limits)) }),
  'pr.evidence': performer(actionKinds.prEvidence, { catches: 'duplicates', call: (owed, limits) => withClient(connector, owed, client => showEvidence(client, owed, limits)) }),
  'pr.update-branch': performer(actionKinds.prUpdateBranch, { catches: 'duplicates', call: (owed, limits) => withClient(connector, owed, client => updateBranch(client, owed, limits)) }),
  'pr.merge': performer(
    actionKinds.prMerge,
    { catches: 'duplicates', call: (owed, limits) => withClient(connector, owed, client => merge(client, connector.owedAt, owed, limits)) },
    eb => eb('task.step', '=', 'land'),
  ),
  'branch.advance': performer(actionKinds.branchAdvance, { catches: 'duplicates', call: (owed, limits) => withClient(connector, owed, client => advance(client, owed, limits)) }),
  'branch.delete': performer(actionKinds.branchDelete, { catches: 'duplicates', call: (owed, limits) => withClient(connector, owed, client => remove(client, owed, limits)) }),
});

export const outboxOwedAt =
  (db: Database): OwedAt =>
  async row => (await db.selectFrom('outbox').select('owed_at').where('id', '=', row).executeTakeFirst())?.owed_at;
