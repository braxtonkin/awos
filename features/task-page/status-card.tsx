'use client';

import type { Review } from '../../shared/review.ts';
import { failing, isFailed } from '../../shared/task-status.ts';
import { between, clock } from '../../shared/ui/clock.ts';
import { StatusMarks } from '../../shared/ui/status.tsx';
import { color } from '../../shared/ui/tokens.ts';
import { failureOf, foundNothing, whyOf } from './ending.ts';
import { firstLine, lastReply } from './now.ts';
import type { AttemptSummary, AttemptTranscript, TaskLive } from './protocol.ts';
import { stepName } from './time.ts';
import { numbered } from './timeline.ts';

type Card = { readonly headline: string; readonly reason: string | null; readonly instruction: string | null; readonly notes: readonly string[] };

const mergeQueueNote = 'Stop does not recall a pull request from the merge queue.';

const tookOf = (attempts: readonly AttemptSummary[]): string | null => {
  const first = attempts[0];
  const last = attempts.findLast(each => each.finishedAt !== null)?.finishedAt;
  return first === undefined || last === undefined || last === null ? null : between(first.startedAt, last);
};

type LeadUp = { readonly sentBack: boolean; readonly words: string };

const leadUpOf = (task: TaskLive, failed: AttemptSummary): LeadUp | null => {
  const before = task.attempts.findLast(each => each.step !== failed.step);
  if (before === undefined) return null;
  const words = before.verdict === 'pass' ? (before.summary === null ? null : `What it tried: ${before.summary}`) : whyOf(before);
  return words === null ? null : { sentBack: before.verdict !== 'pass', words };
};

function failedCard(task: TaskLive, failed: AttemptSummary, reply: Review | undefined, notes: readonly string[]): Card {
  const leadUp = leadUpOf(task, failed);
  const instruction = task.waitingReason;
  if (!foundNothing(failed, reply)) return { ...failureOf(failed), instruction, notes: leadUp === null ? notes : [leadUp.words, ...notes] };
  const said = `The agent said: “${firstLine(reply.summary)}”`;
  return { headline: `${stepName(failed.step)} found nothing to change.`, reason: leadUp?.sentBack === true ? `${leadUp.words} ${said}` : said, instruction, notes };
}

function waitingCard(task: TaskLive, reply: Review | undefined, notes: readonly string[]): Card {
  const newest = task.attempts.at(-1);
  const step = stepName(task.step);
  const instruction = task.waitingReason;
  if (newest !== undefined && isFailed({ state: task.state, waitingOn: task.waitingOn, newestVerdict: newest.verdict })) return failedCard(task, newest, reply, notes);
  switch (task.waitingOn) {
    case 'approval':
      return { headline: `Waiting for your approval of ${step}.`, reason: null, instruction, notes };
    case 'answer':
      return { headline: `Waiting for your answer to the question ${step} asked.`, reason: null, instruction, notes };
    case 'outside_approval':
      return { headline: 'Waiting for an approval outside AutoWorker.', reason: null, instruction, notes };
    case 'retry':
    case null:
      return { headline: `${step} waits for you.`, reason: null, instruction, notes };
  }
}

function stoppedNext(task: TaskLive): string {
  const step = stepName(task.step);
  if (task.waitingOn === 'approval') return `Retry brings back the approval of ${step}, without running it again.`;
  const verdict = task.attempts.at(-1)?.verdict ?? null;
  return verdict !== null && failing[verdict] ? 'Retry starts the agent again.' : `Retry starts the agent again at ${step}.`;
}

function cardOf(task: TaskLive, reply: Review | undefined, zone: string): Card {
  const notes = task.mergeQueued && task.state !== 'done' ? [mergeQueueNote] : [];
  const newest = task.attempts.at(-1);
  switch (task.state) {
    case 'ready': {
      const step = stepName(newest?.finishedAt === null ? newest.step : task.step);
      const headline =
        newest === undefined || newest.finishedAt !== null
          ? `${step} starts in a moment.`
          : numbered(task.attempts, newest.id) <= 1
            ? `${step} has been running since ${clock(newest.startedAt, zone)}.`
            : `${step} has been running again since ${clock(newest.startedAt, zone)}, on try ${String(numbered(task.attempts, newest.id))}.`;
      return { headline, reason: null, instruction: 'Follow the agent on the right, and stop it there if it goes wrong.', notes };
    }
    case 'waiting':
      return waitingCard(task, reply, notes);
    case 'stopped':
      return { headline: task.stoppedBy === null ? `This task stopped during ${stepName(task.step)}.` : `${task.stoppedBy.name} stopped this task at ${clock(task.stoppedBy.at, zone)}.`, reason: null, instruction: stoppedNext(task), notes };
    case 'done': {
      const took = tookOf(task.attempts);
      return { headline: 'The task landed.', reason: null, instruction: null, notes: took === null ? [] : [`It took ${took} from start to merge.`] };
    }
  }
}

type StatusCardProps = { readonly task: TaskLive; readonly attempts: readonly AttemptTranscript[]; readonly zone: string };

export function StatusCard({ task, attempts, zone }: StatusCardProps) {
  const newest = task.attempts.at(-1);
  const card = cardOf(task, newest === undefined ? undefined : lastReply(attempts, newest.id), zone);
  return (
    <section data-status={task.state} aria-label="Status" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, padding: '20px 24px', borderRadius: 12, background: color('surface'), border: `1px solid ${color('rule')}` }}>
      <StatusMarks marks={task.marks} />
      <p data-card="headline" style={{ margin: 0, fontSize: 15, lineHeight: '22px', fontWeight: 600 }}>
        {card.headline}
      </p>
      {card.reason === null ? null : (
        <p data-card="reason" style={{ margin: 0, fontSize: 14, lineHeight: '20px' }}>
          {card.reason}
        </p>
      )}
      {card.instruction === null ? null : (
        <p data-card="instruction" style={{ margin: 0, fontSize: 14, lineHeight: '20px' }}>
          {card.instruction}
        </p>
      )}
      {card.notes.map(note => (
        <p key={note} data-card="note" style={{ margin: 0, fontSize: 13, color: color('muted') }}>
          {note}
        </p>
      ))}
    </section>
  );
}
