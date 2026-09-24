import { actionKinds, owe, type ActionSpec, type Owe, type Stands } from '../../shared/actions.ts';
import type { MergeState } from '../../shared/merge-state.ts';
import type { Review } from '../../shared/review.ts';
import type { Instruction, Unasked } from '../../shared/workflow.ts';
import type { workflow } from './workflow.ts';

export const landStep: (typeof workflow)['steps'][number]['name'] = 'land';

export type DraftSetting = 'when-green' | 'at-once';

export type PullRequest = { readonly repository: string; readonly branch: string; readonly number: number | null };

export type Reading = { readonly state: MergeState; readonly draft: DraftSetting };

export type ReadPullRequest = (pull: PullRequest) => Promise<Reading>;

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
  readonly answered: readonly string[];
  readonly markedReady: boolean;
  readonly refusedAt: string | null;
  readonly gatesApproved: boolean;
  readonly evidence: string;
};

type NoApproval<K extends string> = K extends `${string}approve${string}` ? never : unknown;

const reviewed = Symbol('reviewed');

export type ReviewAction = Owe & { readonly [reviewed]: true };

export const reviewOwes = <K extends string, P, R>(kind: ActionSpec<K, P, R> & NoApproval<K>, payload: P): ReviewAction => ({ ...owe(kind, payload), [reviewed]: true });

export type ReviewAnswer = { readonly actions: readonly ReviewAction[]; readonly note: Instruction };

export type ReviewStep = (pull: PullRequest, task: { readonly key: string }) => ReviewAnswer;

export const coreReview: ReviewStep = pull => ({
  actions: [],
  note: pull.number === null ? "The pull request needs an approval under the repository's rules." : `Pull request #${String(pull.number)} needs an approval under the repository's rules.`,
});

export type Owing = 'mark-ready' | 'update-branch' | 'merge';

export type Decision =
  | { readonly kind: 'merged' }
  | { readonly kind: 'fail'; readonly why: string; readonly answers: string | null }
  | { readonly kind: 'send-back'; readonly why: string }
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

const answered = (seen: Seen, id: string): boolean => seen.record.answered.includes(id);

const unansweredEjection = (seen: Seen): string | null => {
  const value = valueOf(seen);
  return value.kind === 'ejected' && !answered(seen, value.ejection) ? value.ejection : null;
};

const unansweredReview = (seen: Seen): boolean => {
  const value = valueOf(seen);
  return value.kind === 'changes-requested' && !answered(seen, value.review.id);
};

const atOnce = (seen: Seen): boolean => seen.reading.draft === 'at-once';

const failingChecks = (seen: Seen): string => {
  const value = valueOf(seen);
  return value.kind === 'red' ? value.failing.join(', ') : '';
};

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
  { name: 'conflicting', when: seen => seen.guards.ConflictSendsBack && is('conflicting')(seen), then: () => ({ kind: 'send-back', why: 'the pull request conflicts with its base branch' }) },
  { name: 'ready at once', when: seen => atOnce(seen) && (is('green-draft')(seen) || !seen.record.markedReady), then: oweAction('mark-ready') },
  { name: 'red at once', when: seen => atOnce(seen) && is('red')(seen), then: seen => ({ kind: 'fail', why: `a check failed: ${failingChecks(seen)}`, answers: null }) },
  { name: 'red', when: seen => seen.guards.RedCheckSendsBack && is('red')(seen), then: seen => ({ kind: 'send-back', why: `a check failed: ${failingChecks(seen)}` }) },
  {
    name: 'ready when green',
    when: seen => is('green-draft')(seen) || (!seen.guards.ReadyWaitsForGreen && is('waiting-for-checks')(seen) && !seen.record.markedReady),
    then: oweAction('mark-ready'),
  },
  { name: 'checks pending', when: is('waiting-for-checks'), then: wait('checks on the head are still running') },
  { name: 'behind', when: is('behind'), then: oweAction('update-branch') },
  { name: 'changes requested', when: unansweredReview, then: seen => answer(valueOf(seen)) },
  { name: 'needs approval', when: is('review-required', 'changes-requested'), then: () => ({ kind: 'await-approval' }) },
  {
    name: 'refused',
    when: seen => seen.guards.RefusalFailsAttempt && seen.record.refusedAt === seen.reading.state.head,
    then: () => ({ kind: 'fail', why: 'GitHub refused the merge at this head', answers: null }),
  },
  { name: 'gate', when: seen => !seen.record.gatesApproved, then: () => ({ kind: 'hold-at-gate' }) },
  { name: 'ready', when: is('ready', 'ejected'), then: oweAction('merge') },
  { name: 'otherwise', when: () => true, then: seen => ({ kind: 'wait', why: `GitHub reports ${valueOf(seen).kind}` }) },
];

function answer(value: MergeState['value']): Decision {
  return value.kind === 'changes-requested' ? { kind: 'answer-review', review: value.review } : { kind: 'await-approval' };
}

export function decideLand(reading: Reading, record: LandRecord, guards: Guards): { readonly rule: string; readonly decision: Decision } {
  const seen: Seen = { reading, record, guards };
  const rule = rules.find(candidate => candidate.when(seen)) ?? rules[rules.length - 1];
  if (rule === undefined) throw new Error('Land has no rules.');
  return { rule: rule.name, decision: rule.then(seen) };
}

export const resumes = (reading: Reading, record: LandRecord, guards: Guards): boolean => {
  const { value } = reading.state;
  if (value.kind === 'changes-requested') return guards.AnyReviewResumesLand && !record.answered.includes(value.review.id);
  return value.kind !== 'review-required';
};

export type LandOutput = Review & { readonly answers?: string };

const said = (summary: string, body: string, answers: string | null = null): LandOutput => ({
  outcome: 'done',
  summary,
  blocks: [{ kind: 'text', title: null, body }],
  ...(answers === null ? {} : { answers }),
});

export type AtLand = {
  readonly task: string;
  readonly key: string;
  readonly pull: PullRequest;
  readonly awaiting: boolean;
  readonly owes: boolean;
  readonly attempt: string | null;
  readonly record: LandRecord;
};

export type Follow = { readonly whenDone: readonly Owe[]; readonly whenAwaiting: ReviewAnswer | null };

export type LandStore = {
  readonly atLand: () => Promise<readonly AtLand[]>;
  readonly claim: (task: string) => Promise<string | undefined>;
  readonly renew: (attempt: string) => Promise<boolean>;
  readonly handOff: (attempt: string, output: LandOutput, owes: readonly Owe[]) => Promise<boolean>;
  readonly finish: (attempt: string, verdict: Unasked | null, output: LandOutput, follow: Follow) => Promise<boolean>;
  readonly resume: (task: string) => Promise<boolean>;
};

export type Land = { readonly store: LandStore; readonly read: ReadPullRequest; readonly review: ReviewStep; readonly guards: Guards };

const nothingFollows: Follow = { whenDone: [], whenAwaiting: null };

const ticketKey = /^[A-Z][A-Z0-9_]*-\d+$/;

function owedFor(action: Owing, task: AtLand, reading: Reading): Owe {
  const { repository, branch } = task.pull;
  switch (action) {
    case 'mark-ready':
      return owe(actionKinds.prMarkReady, { repository, head: branch, evidence: task.record.evidence });
    case 'update-branch':
      return owe(actionKinds.prUpdateBranch, { repository, head: branch, commit: reading.state.head });
    case 'merge':
      return owe(actionKinds.prMerge, { repository, head: branch, commit: reading.state.head });
  }
}

function afterMerge(task: AtLand, reading: Reading): readonly Owe[] {
  const pull = task.pull.number === null ? 'the pull request' : `pull request #${String(task.pull.number)}`;
  const comment = ticketKey.test(task.key)
    ? [owe(actionKinds.ticketComment, { ticket: task.key, text: `AutoWorker merged ${pull} at ${reading.state.head}.`, linkPullRequest: true })]
    : [];
  return [...comment, owe(actionKinds.branchDelete, { repository: task.pull.repository, branch: task.pull.branch })];
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
      return done(await store.finish(attempt, 'red_check', said('Land sent the task back to Implement.', `Land sent the task back, because ${decision.why}.`), nothingFollows), `sent the task back, because ${decision.why}`);
    case 'answer-review': {
      const { review } = decision;
      const body = [`${review.reviewer} asked for changes.`, review.body, ...review.comments.map(comment => `${comment.path ?? 'the pull request'}${comment.line === null ? '' : `:${String(comment.line)}`}: ${comment.body}`)].join('\n');
      return done(await store.finish(attempt, 'changes_requested', said('A review asked for changes.', body, review.id), nothingFollows), `answered review ${review.id}`);
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

async function landOne(land: Land, task: AtLand): Promise<string> {
  if (land.guards.LandWaitsForMergeRow && task.owes) return 'skipped, because it owes an action';
  if (task.awaiting) {
    const reading = await land.read(task.pull);
    if (!resumes(reading, task.record, land.guards)) return `still waits, because GitHub reports ${reading.state.value.kind}`;
    return (await land.store.resume(task.task)) ? `resumed Land, because GitHub reports ${reading.state.value.kind}` : 'was no longer waiting, so it did nothing';
  }
  const attempt = task.attempt ?? (await land.store.claim(task.task));
  if (attempt === undefined) return 'could not be claimed';
  if (!(await land.store.renew(attempt))) return `lost attempt ${attempt} before it read GitHub`;
  const reading = await land.read(task.pull);
  const { rule, decision } = decideLand(reading, task.record, land.guards);
  return `read ${reading.state.value.kind} at ${reading.state.head}, matched ${rule}, and ${await act(land, task, attempt, reading, decision)}`;
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
