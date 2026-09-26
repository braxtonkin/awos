import type { Verdict } from '../../shared/db/types.ts';
import type { AttemptSummary } from './protocol.ts';

const words: Readonly<Record<Verdict, string | null>> = {
  pass: 'Passed',
  behavior_fail: 'Behavior still wrong',
  environment_fail: 'The environment broke',
  lost: 'Lost, because the agent stopped answering',
  not_launched: 'Could not start',
  needs_input: 'Asked a question',
  changes_requested: 'Changes were requested',
  review_required: 'Waited for a review',
  handed_off: 'Handed off',
  stopped: 'Stopped by a person',
  fail: null,
  red_check: null,
};

type Ended = Pick<AttemptSummary, 'verdict' | 'outcome' | 'summary' | 'body'>;

const ownWords = (attempt: Ended): string | null => (attempt.outcome === 'done' ? (attempt.body ?? attempt.summary) : (attempt.summary ?? attempt.body));

export const resultOf = (attempt: Ended): string => (attempt.verdict === null ? 'Still running' : (words[attempt.verdict] ?? ownWords(attempt) ?? 'Failed'));
