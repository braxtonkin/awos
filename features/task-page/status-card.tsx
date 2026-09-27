'use client';

import { useState } from 'react';
import { failing, isFailed } from '../../shared/task-status.ts';
import { clock } from '../../shared/ui/clock.ts';
import { StatusMarks } from '../../shared/ui/status.tsx';
import { color } from '../../shared/ui/tokens.ts';
import { useFrames, type Stream } from '../../shared/ui/use-frames.ts';
import { failureOf, whyOf } from './ending.ts';
import { frame, type AttemptSummary, type TaskLive } from './protocol.ts';
import { stepName } from './time.ts';
import { numbered } from './timeline.ts';

export function useLive(initial: TaskLive, stream: Stream): TaskLive {
  const [task, setTask] = useState(initial);
  useFrames(stream, frame, next => {
    if (next.kind === 'task') setTask(next.task);
  });
  return task;
}

type Card = { readonly headline: string; readonly reason: string | null; readonly instruction: string | null; readonly notes: readonly string[] };

type Landing = { readonly mergeQueued: boolean; readonly took: string | null };

const mergeQueueNote = 'Stop does not recall a pull request from the merge queue.';

const leadUpOf = (task: TaskLive, failed: AttemptSummary): string | null => {
  const before = task.attempts.findLast(each => each.step !== failed.step);
  if (before === undefined) return null;
  if (before.verdict !== 'pass') return whyOf(before);
  return before.summary === null ? null : `What it tried: ${before.summary}`;
};

function waitingCard(task: TaskLive, notes: readonly string[]): Card {
  const newest = task.attempts.at(-1);
  const step = stepName(task.step);
  const instruction = task.waitingReason;
  if (newest !== undefined && isFailed({ state: task.state, waitingOn: task.waitingOn, newestVerdict: newest.verdict })) {
    const leadUp = leadUpOf(task, newest);
    return { ...failureOf(newest), instruction, notes: leadUp === null ? notes : [leadUp, ...notes] };
  }
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

function cardOf(task: TaskLive, landing: Landing, zone: string): Card {
  const notes = landing.mergeQueued && task.state !== 'done' ? [mergeQueueNote] : [];
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
      return waitingCard(task, notes);
    case 'stopped':
      return { headline: task.stoppedBy === null ? `This task stopped during ${stepName(task.step)}.` : `${task.stoppedBy.name} stopped this task at ${clock(task.stoppedBy.at, zone)}.`, reason: null, instruction: stoppedNext(task), notes };
    case 'done':
      return { headline: 'The task landed.', reason: null, instruction: null, notes: landing.took === null ? [] : [`It took ${landing.took} from start to merge.`] };
  }
}

type StatusCardProps = { readonly initial: TaskLive; readonly landing: Landing; readonly stream: Stream; readonly zone: string };

export function StatusCard({ initial, landing, stream, zone }: StatusCardProps) {
  const task = useLive(initial, stream);
  const card = cardOf(task, landing, zone);
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
