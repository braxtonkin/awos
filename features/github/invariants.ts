import { mergeState, type MergeValue } from '../../shared/merge-state.ts';

export type Truth = {
  readonly open: boolean;
  readonly queued: boolean;
  readonly unansweredEjection: string | null;
  readonly conflictReported: boolean;
  readonly draft: boolean;
  readonly leavesDraftAtOnce: boolean;
  readonly countedRed: readonly string[];
  readonly countedAllGreen: boolean;
  readonly approved: boolean;
};

export type Observation =
  | { readonly kind: 'read'; readonly head: string; readonly value: MergeValue; readonly truth: Truth }
  | { readonly kind: 'merged'; readonly head: string; readonly judged: boolean; readonly countedGreen: boolean; readonly taskStep: string; readonly how: 'direct' | 'queue' }
  | { readonly kind: 'enqueued'; readonly head: string; readonly unansweredEjection: string | null }
  | { readonly kind: 'performed'; readonly action: string; readonly outcome: 'done' | 'refused' | 'failed'; readonly faulted: boolean; readonly detail: string }
  | { readonly kind: 'opened'; readonly numbers: readonly number[] }
  | { readonly kind: 'wrote'; readonly action: string; readonly intended: number; readonly number: number; readonly what: string };

type Judge = (observation: Observation) => string | undefined;

const sameNames = (one: readonly string[], other: readonly string[]): boolean => [...one].toSorted().join(',') === [...other].toSorted().join(',');

const landDecides = (truth: Truth): boolean => truth.open && !truth.queued && truth.unansweredEjection === null;

export const properties = {
  TypeOK: observation =>
    observation.kind === 'read' && !mergeState.safeParse({ head: observation.head, value: observation.value }).success ? `the state read at ${observation.head} does not fit the merge-state type` : undefined,
  MergedHeadWasMergeable: observation => {
    if (observation.kind !== 'merged') return undefined;
    if (!observation.judged) return `GitHub merged ${observation.head} by ${observation.how}, a head no merge-state read judged ready`;
    return observation.how === 'direct' && !observation.countedGreen ? `GitHub merged ${observation.head} directly while a counted check on it was not green` : undefined;
  },
  PerformedMergeWasAllowed: observation => {
    if (observation.kind === 'merged' && observation.taskStep !== 'land') return `GitHub merged ${observation.head} by ${observation.how} while the task stood in ${observation.taskStep}`;
    if (observation.kind === 'read' && observation.truth.queued && observation.value.kind !== 'queued') return `a queued pull request read as ${observation.value.kind}`;
    return undefined;
  },
  ReadyOnlyWhenChecksGreen: observation =>
    observation.kind === 'read' && observation.value.kind === 'green-draft' && !observation.truth.leavesDraftAtOnce && !observation.truth.countedAllGreen
      ? `the draft at ${observation.head} read as green while a counted check was not green`
      : undefined,
  RedCheckReturnsToImplement: observation => {
    if (observation.kind !== 'read') return undefined;
    const { truth, value } = observation;
    if (!landDecides(truth) || truth.conflictReported || (truth.draft && truth.leavesDraftAtOnce) || truth.countedRed.length === 0) return undefined;
    return value.kind === 'red' && sameNames(value.failing, truth.countedRed) ? undefined : `checks ${truth.countedRed.join(', ')} were red at ${observation.head}, and the state read as ${value.kind}`;
  },
  ConflictReturnsToImplement: observation =>
    observation.kind === 'read' && landDecides(observation.truth) && observation.truth.conflictReported && observation.value.kind !== 'conflicting'
      ? `GitHub reported a conflict at ${observation.head}, and the state read as ${observation.value.kind}`
      : undefined,
  EjectionFailsLand: observation => {
    if (observation.kind === 'enqueued' && observation.unansweredEjection !== null) return `the pull request joined the queue again at ${observation.head} before Land answered ejection ${observation.unansweredEjection}`;
    if (observation.kind !== 'read' || !observation.truth.open || observation.truth.queued || observation.truth.unansweredEjection === null) return undefined;
    const { value } = observation;
    return value.kind === 'ejected' && value.ejection === observation.truth.unansweredEjection ? undefined : `ejection ${observation.truth.unansweredEjection} was unanswered, and the state read as ${value.kind}`;
  },
  AwaitsOnlyMissingApproval: observation =>
    observation.kind === 'read' && observation.value.kind === 'review-required' && observation.truth.approved ? `the pull request read as review-required at ${observation.head} while GitHub reported it approved` : undefined,
  ActsOnTheTaskPullRequest: observation =>
    observation.kind === 'wrote' && observation.number !== observation.intended
      ? `${observation.action} for pull request ${String(observation.intended)} sent ${observation.what} to pull request ${String(observation.number)}`
      : undefined,
  LandSettles: observation => {
    if (observation.kind === 'performed' && observation.outcome === 'failed' && !observation.faulted) return `${observation.action} failed on a definite answer, so its row would be tried again: ${observation.detail}`;
    if (observation.kind === 'opened' && new Set(observation.numbers).size > 1) return `opening one head twice made pull requests ${observation.numbers.join(' and ')}`;
    return undefined;
  },
} satisfies Readonly<Record<string, Judge>>;

export type PropertyName = keyof typeof properties;

export type Broken = { readonly property: string; readonly detail: string };

export const judge = (observation: Observation): readonly Broken[] =>
  Object.entries(properties).flatMap(([property, check]) => {
    const detail = check(observation);
    return detail === undefined ? [] : [{ property, detail }];
  });
