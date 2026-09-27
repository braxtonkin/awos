import type { Verdict } from '../../shared/db/types.ts';
import type { Review } from '../../shared/review.ts';
import type { AttemptSummary } from './protocol.ts';
import { stepName } from './time.ts';

type Told = { readonly word: string; readonly failed: ((step: string) => string) | null };

const told: Readonly<Record<Verdict, Told | null>> = {
  pass: { word: 'Passed', failed: null },
  behavior_fail: { word: 'Behavior still wrong', failed: step => `${step} found the behavior still wrong.` },
  environment_fail: { word: 'The environment broke', failed: step => `${step} could not run because the environment broke, not the change.` },
  lost: { word: 'Lost, because the agent stopped answering', failed: step => `The agent stopped answering during ${step}.` },
  not_launched: { word: 'Could not start', failed: step => `The agent could not start ${step}.` },
  needs_input: { word: 'Asked a question', failed: null },
  changes_requested: { word: 'Changes were requested', failed: null },
  review_required: { word: 'Waited for a review', failed: null },
  handed_off: { word: 'Handed off', failed: null },
  stopped: { word: 'Stopped by a person', failed: null },
  fail: null,
  red_check: null,
  conflict: null,
};

type Ended = Pick<AttemptSummary, 'step' | 'verdict' | 'outcome' | 'summary' | 'body'>;

const ownWords = (attempt: Ended): string | null => (attempt.outcome === 'done' ? (attempt.body ?? attempt.summary) : (attempt.summary ?? attempt.body));

const toldOf = (attempt: Ended): Told | null => (attempt.verdict === null ? null : told[attempt.verdict]);

const phraseOf = (attempt: Ended): string | null => toldOf(attempt)?.failed?.(stepName(attempt.step)) ?? null;

export const resultOf = (attempt: Ended): string => (attempt.verdict === null ? 'Still running' : (toldOf(attempt)?.word ?? ownWords(attempt) ?? 'Failed'));

export const whyOf = (attempt: Ended): string | null => phraseOf(attempt) ?? ownWords(attempt);

const madeNoChange = 'The agent made no change.';

export const foundNothing = (attempt: Ended, reply: Review | undefined): reply is Review => attempt.verdict === 'fail' && attempt.summary === madeNoChange && reply?.outcome === 'done';

export const failureOf = (attempt: Ended): { readonly headline: string; readonly reason: string | null } => {
  const phrase = phraseOf(attempt);
  return phrase === null ? { headline: `${stepName(attempt.step)} failed.`, reason: ownWords(attempt) } : { headline: phrase, reason: null };
};
