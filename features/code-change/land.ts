import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { actionKinds, owe, ticket, type ActionSpec, type Owe, type Stands } from '../../shared/actions.ts';
import { mergeState, type Answered, type MergeState, type ReadMergeState } from '../../shared/merge-state.ts';
import { review, type Review } from '../../shared/review.ts';
import type { SendBack } from '../../shared/rework.ts';
import type { Instruction, Unasked } from '../../shared/workflow.ts';
import type { workflow } from './workflow.ts';

export const landStep: (typeof workflow)['steps'][number]['name'] = 'land';

export const conflictWhy = 'the pull request conflicts with its base branch';

export type DraftSetting = 'when-green' | 'at-once';

export type PullRequest = { readonly repository: string; readonly repositoryId: string; readonly branch: string; readonly number: number | null; readonly actsAs: string | null };

export type Reading = { readonly number: number; readonly state: MergeState; readonly draft: DraftSetting };

export type Answer = { readonly kind: 'ejection' | 'review' | 'refusal'; readonly id: string };

export type Guards = {
  readonly ReadyWaitsForGreen: boolean;
  readonly RedCheckSendsBack: boolean;
  readonly ConflictSendsBack: boolean;
  readonly EjectionEndsAttempt: boolean;
  readonly LandWaitsForMergeRow: boolean;
  readonly LandWaitsWhileQueued: boolean;
  readonly RefusalFailsAttempt: boolean;
  readonly AnyReviewResumesLand: boolean;
};

export const guarded: Guards = {
  ReadyWaitsForGreen: true,
  RedCheckSendsBack: true,
  ConflictSendsBack: true,
  EjectionEndsAttempt: true,
  LandWaitsForMergeRow: true,
  LandWaitsWhileQueued: true,
  RefusalFailsAttempt: true,
  AnyReviewResumesLand: true,
};

export type LandRecord = {
  readonly draftLeaves: DraftSetting;
  readonly answered: readonly Answer[];
  readonly markedReady: boolean;
  readonly refused: { readonly row: string; readonly head: string | null } | null;
  readonly updatedAt: string | null;
  readonly gatesApproved: boolean;
  readonly evidence: string;
};

type ReviewKind = (typeof actionKinds.ticketComment | typeof actionKinds.ticketTransition)['kind'];

const reviewed = Symbol('reviewed');

export type ReviewAction = Owe<ReviewKind> & { readonly [reviewed]: true };

export const reviewOwes = <K extends ReviewKind, P, R>(kind: ActionSpec<K, P, R>, payload: P): ReviewAction => ({ ...owe(kind, payload), [reviewed]: true });

export type ReviewAnswer = { readonly actions: readonly ReviewAction[]; readonly note: Instruction };

export type ReviewStep = (pull: PullRequest, task: { readonly key: string }) => ReviewAnswer;

export const coreReview: ReviewStep = pull => ({
  actions: [],
  note: pull.number === null ? "The pull request needs an approval under the repository's rules." : `Pull request #${String(pull.number)} needs an approval under the repository's rules.`,
});

export type Owing = 'mark-ready' | 'update-branch' | 'merge';

export type Decision =
  | { readonly kind: 'merged' }
  | { readonly kind: 'fail'; readonly why: string; readonly answers: Answer | null }
  | { readonly kind: 'send-back'; readonly verdict: Extract<Unasked, 'conflict' | 'red_check'>; readonly why: string; readonly failing: readonly [string, ...string[]] | null }
  | { readonly kind: 'owe'; readonly action: Owing }
  | { readonly kind: 'wait'; readonly why: string }
  | { readonly kind: 'answer-review'; readonly review: Extract<MergeState['value'], { readonly kind: 'changes-requested' }>['review'] }
  | { readonly kind: 'await-approval' }
  | { readonly kind: 'hold-at-gate' };

type Seen = { readonly reading: Reading; readonly record: LandRecord; readonly guards: Guards };

type Rule = { readonly name: string; readonly when: (seen: Seen) => boolean; readonly then: (seen: Seen) => Decision };

const valueOf = ({ reading }: Seen): MergeState['value'] => reading.state.value;

const is =
  (...kinds: readonly MergeState['value']['kind'][]) =>
  (seen: Seen): boolean =>
    kinds.includes(valueOf(seen).kind);

const answered = (seen: Seen, id: string): boolean => seen.record.answered.some(entry => entry.id === id);

export const latestAnswered = (record: LandRecord): Answered => ({
  ejection: record.answered.findLast(entry => entry.kind === 'ejection')?.id ?? null,
  review: record.answered.findLast(entry => entry.kind === 'review')?.id ?? null,
});

const unansweredEjection = (seen: Seen): Answer | null => {
  const value = valueOf(seen);
  return value.kind === 'ejected' && !answered(seen, value.ejection) ? { kind: 'ejection', id: value.ejection } : null;
};

const unansweredReview = (seen: Seen): boolean => {
  const value = valueOf(seen);
  return value.kind === 'changes-requested' && !answered(seen, value.review.id);
};

const unansweredRefusal = (seen: Seen): Answer | null => {
  const { refused } = seen.record;
  return refused !== null && !answered(seen, refused.row) && (refused.head === null || refused.head === seen.reading.state.head) ? { kind: 'refusal', id: refused.row } : null;
};

const atOnce = (seen: Seen): boolean => seen.reading.draft === 'at-once';

const failingChecks = (seen: Seen): readonly [string, ...string[]] | null => {
  const value = valueOf(seen);
  return value.kind === 'red' ? value.failing : null;
};

const checksFailed = (failing: readonly string[] | null): string => `a check failed: ${(failing ?? []).join(', ')}`;

const wait = (why: string) => (): Decision => ({ kind: 'wait', why });

const oweAction = (action: Owing) => (): Decision => ({ kind: 'owe', action });

export const rules: readonly Rule[] = [
  { name: 'queued', when: seen => seen.guards.LandWaitsWhileQueued && is('queued')(seen), then: wait('the pull request is in the merge queue') },
  { name: 'merged', when: is('merged'), then: () => ({ kind: 'merged' }) },
  {
    name: 'ejected',
    when: seen => seen.guards.EjectionEndsAttempt && unansweredEjection(seen) !== null,
    then: seen => {
      const value = valueOf(seen);
      return { kind: 'fail', why: `the merge queue ejected the pull request${value.kind === 'ejected' ? `: ${value.reason}` : ''}`, answers: unansweredEjection(seen) };
    },
  },
  { name: 'conflicting', when: seen => seen.guards.ConflictSendsBack && is('conflicting')(seen), then: () => ({ kind: 'send-back', verdict: 'conflict', why: conflictWhy, failing: null }) },
  { name: 'ready at once', when: seen => atOnce(seen) && !seen.record.markedReady, then: oweAction('mark-ready') },
  {
    name: 'still a draft',
    when: seen => is('green-draft')(seen) && seen.record.markedReady,
    then: () => ({ kind: 'fail', why: 'the pull request is still a draft after AutoWorker marked it ready', answers: null }),
  },
  { name: 'red at once', when: seen => atOnce(seen) && is('red')(seen), then: seen => ({ kind: 'fail', why: checksFailed(failingChecks(seen)), answers: null }) },
  { name: 'red', when: seen => seen.guards.RedCheckSendsBack && is('red')(seen), then: seen => ({ kind: 'send-back', verdict: 'red_check', why: checksFailed(failingChecks(seen)), failing: failingChecks(seen) }) },
  {
    name: 'ready when green',
    when: seen => is('green-draft')(seen) || (!seen.guards.ReadyWaitsForGreen && is('waiting-for-checks')(seen) && !seen.record.markedReady),
    then: oweAction('mark-ready'),
  },
  { name: 'checks pending', when: is('waiting-for-checks'), then: wait('checks on the head are still running') },
  {
    name: 'still behind',
    when: seen => is('behind')(seen) && seen.record.updatedAt === seen.reading.state.head,
    then: () => ({ kind: 'fail', why: 'the branch is still behind its base after AutoWorker updated it at this head', answers: null }),
  },
  { name: 'behind', when: is('behind'), then: oweAction('update-branch') },
  { name: 'changes requested', when: unansweredReview, then: seen => answer(valueOf(seen)) },
  { name: 'needs approval', when: is('review-required', 'changes-requested'), then: () => ({ kind: 'await-approval' }) },
  {
    name: 'refused',
    when: seen => seen.guards.RefusalFailsAttempt && unansweredRefusal(seen) !== null,
    then: seen => ({ kind: 'fail', why: 'GitHub refused the merge at this head', answers: unansweredRefusal(seen) }),
  },
  { name: 'gate', when: seen => !seen.record.gatesApproved, then: () => ({ kind: 'hold-at-gate' }) },
  { name: 'ready', when: is('ready'), then: oweAction('merge') },
];

const otherwise = (seen: Seen): Decision => ({ kind: 'wait', why: `GitHub reports ${valueOf(seen).kind}` });

function answer(value: MergeState['value']): Decision {
  return value.kind === 'changes-requested' ? { kind: 'answer-review', review: value.review } : { kind: 'await-approval' };
}

export function decideLand(reading: Reading, record: LandRecord, guards: Guards): { readonly rule: string; readonly decision: Decision } {
  const seen: Seen = { reading, record, guards };
  const rule = rules.find(candidate => candidate.when(seen));
  return rule === undefined ? { rule: 'otherwise', decision: otherwise(seen) } : { rule: rule.name, decision: rule.then(seen) };
}

export const resumes = (reading: Reading, record: LandRecord, guards: Guards): boolean => {
  const { value } = reading.state;
  if (value.kind === 'changes-requested') return guards.AnyReviewResumesLand && !record.answered.some(entry => entry.id === value.review.id);
  return value.kind !== 'review-required';
};

export type Failed = { readonly head: string; readonly checks: readonly [string, ...string[]] };

export type LandOutput = Review & { readonly answers?: Answer; readonly failed?: Failed };

const said = (summary: string, body: string, answers: Answer | null = null): LandOutput => ({
  outcome: 'done',
  summary,
  blocks: [{ kind: 'text', title: null, body }],
  ...(answers === null ? {} : { answers }),
});

export const sentBack = (why: string, failed: Failed | null = null): LandOutput => ({
  ...said('Land sent the task back to Implement.', `Land sent the task back, because ${why}.`),
  ...(failed === null ? {} : { failed }),
});

const failedOutput = z.object({ failed: z.object({ head: z.string().regex(/^[0-9a-f]{40}$/), checks: z.tuple([z.string().min(1)], z.string().min(1)) }) });

const checksIn = /^Land sent the task back, because a check failed: (.+)\.$/;

const conflictAsRedCheck = sentBack(conflictWhy);

export function redCheckSentBack(output: unknown): SendBack {
  if (isDeepStrictEqual(output, conflictAsRedCheck)) return { kind: 'conflict' };
  const recorded = failedOutput.safeParse(output);
  if (recorded.success) return { kind: 'check', head: recorded.data.failed.head, names: recorded.data.failed.checks };
  const told = review.safeParse(output).data?.blocks.flatMap(block => (block.kind === 'text' ? [checksIn.exec(block.body)?.[1]] : [])).find(found => found !== undefined);
  const [first = 'the failing check', ...rest] = told?.split(', ') ?? [];
  return { kind: 'check', head: null, names: [first, ...rest] };
}

export type TicketStatuses = { readonly start: string | null; readonly end: string | null };

export type AtLand = {
  readonly task: string;
  readonly key: string;
  readonly pull: PullRequest;
  readonly awaiting: boolean;
  readonly owes: boolean;
  readonly attempt: string | null;
  readonly statuses: TicketStatuses;
  readonly record: LandRecord;
};

export type Follow = { readonly whenDone: readonly Owe[]; readonly whenAwaiting: ReviewAnswer | null };

export type LandStore = {
  readonly atLand: () => Promise<readonly AtLand[]>;
  readonly reread: (task: string) => Promise<AtLand | undefined>;
  readonly claim: (task: string) => Promise<string | undefined>;
  readonly renew: (attempt: string) => Promise<boolean>;
  readonly handOff: (attempt: string, output: LandOutput, owes: readonly Owe[]) => Promise<boolean>;
  readonly finish: (attempt: string, verdict: Unasked | null, output: LandOutput, follow: Follow) => Promise<boolean>;
  readonly resume: (task: string) => Promise<boolean>;
};

export type Land = { readonly store: LandStore; readonly read: ReadMergeState; readonly review: ReviewStep; readonly guards: Guards; readonly readTimeoutMs: number };

const nothingFollows: Follow = { whenDone: [], whenAwaiting: null };

function owedFor(action: Owing, task: AtLand, reading: Reading): Owe {
  const pull = { repository: task.pull.repository, number: reading.number };
  switch (action) {
    case 'mark-ready':
      return owe(actionKinds.prMarkReady, { ...pull, evidence: task.record.evidence });
    case 'update-branch':
      return owe(actionKinds.prUpdateBranch, { ...pull, commit: reading.state.head });
    case 'merge':
      return owe(actionKinds.prMerge, { ...pull, commit: reading.state.head });
  }
}

function afterMerge(task: AtLand, reading: Reading): readonly Owe[] {
  const pull = `pull request #${String(reading.number)}`;
  const isTicket = ticket.safeParse(task.key).success;
  const comment = isTicket ? [owe(actionKinds.ticketComment, { ticket: task.key, text: `AutoWorker merged ${pull} at ${reading.state.head}.`, linkPullRequest: true })] : [];
  const ended = isTicket && task.statuses.end !== null ? [owe(actionKinds.ticketTransition, { ticket: task.key, status: task.statuses.end, from: task.statuses.start })] : [];
  return [...comment, ...ended, owe(actionKinds.branchDelete, { repository: task.pull.repository, branch: task.pull.branch })];
}

async function act(land: Land, task: AtLand, attempt: string, reading: Reading, decision: Decision): Promise<string> {
  const { store } = land;
  const read = `${reading.state.value.kind} at ${reading.state.head}`;
  const done = (applied: boolean, what: string): string => (applied ? what : `found attempt ${attempt} already finished, so it did nothing`);
  switch (decision.kind) {
    case 'wait':
      return `waits, because ${decision.why}`;
    case 'owe': {
      const owed = owedFor(decision.action, task, reading);
      return done(await store.handOff(attempt, said(`Land owed ${owed.kind}.`, `GitHub reported ${read}, so Land owed ${owed.kind}.`), [owed]), `owed ${owed.kind}`);
    }
    case 'merged':
      return done(
        await store.finish(attempt, null, said('The pull request merged.', `GitHub reported ${read}.`), { whenDone: afterMerge(task, reading), whenAwaiting: null }),
        'finished Land, because the pull request merged',
      );
    case 'fail':
      return done(await store.finish(attempt, 'fail', said('Land failed this attempt.', `Land failed the attempt, because ${decision.why}.`, decision.answers), nothingFollows), `failed the attempt, because ${decision.why}`);
    case 'send-back':
      return done(
        await store.finish(attempt, decision.verdict, sentBack(decision.why, decision.failing === null ? null : { head: reading.state.head, checks: decision.failing }), nothingFollows),
        `sent the task back, because ${decision.why}`,
      );
    case 'answer-review': {
      const { review } = decision;
      const body = [`${review.reviewer} asked for changes.`, review.body, ...review.comments.map(comment => `${comment.path ?? 'the pull request'}${comment.line === null ? '' : `:${String(comment.line)}`}: ${comment.body}`)].join('\n');
      return done(await store.finish(attempt, 'changes_requested', said('A review asked for changes.', body, { kind: 'review', id: review.id }), nothingFollows), `answered review ${review.id}`);
    }
    case 'await-approval': {
      const answered = land.review(task.pull, { key: task.key });
      return done(
        await store.finish(attempt, 'review_required', said('The pull request needs an approval.', answered.note), { whenDone: [], whenAwaiting: answered }),
        `waits for an approval and owed ${String(answered.actions.length)} review actions`,
      );
    }
    case 'hold-at-gate':
      return done(await store.finish(attempt, null, said('Land would merge past an unapproved gate.', `GitHub reported ${read}, and a gate is not approved.`), nothingFollows), 'handed the unapproved gate to the task runner');
  }
}

async function readState(land: Land, pull: PullRequest, record: LandRecord): Promise<Reading | string> {
  if (pull.number === null || pull.actsAs === null) return 'no pull request is recorded for the task';
  try {
    const read = await land.read({ repositoryId: pull.repositoryId, number: pull.number, actsAs: pull.actsAs }, latestAnswered(record), AbortSignal.timeout(land.readTimeoutMs));
    if ('failed' in read) return `reading the pull request failed: ${read.failed}`;
    const parsed = mergeState.safeParse(read.state);
    return parsed.success ? { number: pull.number, state: parsed.data, draft: record.draftLeaves } : `the merge state did not parse: ${parsed.error.message}`;
  } catch (error) {
    return `reading the pull request failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function landOne(land: Land, task: AtLand): Promise<string> {
  if (land.guards.LandWaitsForMergeRow && task.owes) return 'skipped, because it owes an action';
  if (task.awaiting) {
    const reading = await readState(land, task.pull, task.record);
    if (typeof reading === 'string') return `still waits, because ${reading}`;
    if (!resumes(reading, task.record, land.guards)) return `still waits, because GitHub reports ${reading.state.value.kind}`;
    return (await land.store.resume(task.task)) ? `resumed Land, because GitHub reports ${reading.state.value.kind}` : 'was no longer waiting, so it did nothing';
  }
  const attempt = task.attempt ?? (await land.store.claim(task.task));
  if (attempt === undefined) return 'could not be claimed';
  const held = await land.store.reread(task.task);
  if (held === undefined) return 'left Land before its record was read';
  const reading = await readState(land, held.pull, held.record);
  if (typeof reading === 'string') return `left attempt ${attempt} unrenewed, so the reaper releases it if this keeps failing, because ${reading}`;
  if (!(await land.store.renew(attempt))) return `lost attempt ${attempt} while it read GitHub`;
  const { rule, decision } = decideLand(reading, held.record, land.guards);
  return `read ${reading.state.value.kind} at ${reading.state.head}, matched ${rule}, and ${await act(land, held, attempt, reading, decision)}`;
}

export async function landPass(land: Land): Promise<readonly string[]> {
  const tasks = await land.store.atLand();
  const lines: string[] = [];
  for (const task of tasks) {
    try {
      lines.push(`task ${task.key} ${await landOne(land, task)}`);
    } catch (error) {
      lines.push(`task ${task.key} failed its pass, so the next pass tries again. ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return lines;
}

export const landStands: Stands = eb => eb.and([eb('task.step', '=', landStep), eb('task.state', '=', 'ready')]);
