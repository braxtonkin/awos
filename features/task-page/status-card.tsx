'use client';

import { useState } from 'react';
import type { Verdict } from '../../shared/db/types.ts';
import { isFailed } from '../../shared/task-status.ts';
import { clock } from '../../shared/ui/clock.ts';
import { StatusMarks } from '../../shared/ui/status.tsx';
import { color } from '../../shared/ui/tokens.ts';
import { useFrames, type Stream } from '../../shared/ui/use-frames.ts';
import { frame, type TaskLive } from './protocol.ts';
import { stepName } from './time.ts';
import { numbered } from './timeline.ts';

export function useLive(initial: TaskLive, stream: Stream): TaskLive {
  const [task, setTask] = useState(initial);
  useFrames(stream, frame, next => {
    if (next.kind === 'task') setTask(next.task);
  });
  return task;
}

type Card = { readonly headline: string; readonly instruction: string | null; readonly notes: readonly string[] };

type Landing = { readonly mergeQueued: boolean; readonly took: string | null };

const failures: Readonly<Record<Verdict, ((step: string) => string) | null>> = {
  behavior_fail: step => `${step} found the behavior still wrong.`,
  environment_fail: step => `${step} could not run because the environment broke, not the change.`,
  fail: step => `${step} failed.`,
  red_check: () => 'A check on the pull request is red.',
  lost: step => `The agent stopped answering during ${step}.`,
  not_launched: step => `The agent could not start ${step}.`,
  changes_requested: null,
  handed_off: null,
  needs_input: null,
  pass: null,
  review_required: null,
  stopped: null,
};

const triedOf = (live: TaskLive): string | null => {
  const newest = live.attempts.at(-1);
  return newest === undefined ? null : (live.attempts.findLast(each => each.step !== newest.step && each.summary !== null)?.summary ?? null);
};

const mergeQueueNote = 'Stop does not recall a pull request from the merge queue.';

function waitingCard(task: TaskLive, notes: readonly string[]): Card {
  const newest = task.attempts.at(-1);
  const step = stepName(task.step);
  const instruction = task.waitingReason;
  const verdict = newest?.verdict ?? null;
  if (verdict !== null && newest !== undefined && isFailed({ state: task.state, waitingOn: task.waitingOn, newestVerdict: verdict })) {
    const failed = failures[verdict];
    const tried = triedOf(task);
    return { headline: failed === null ? `${stepName(newest.step)} failed.` : failed(stepName(newest.step)), instruction, notes: tried === null ? notes : [`What it tried: ${tried}`, ...notes] };
  }
  switch (task.waitingOn) {
    case 'approval':
      return { headline: `Waiting for your approval of ${step}.`, instruction, notes };
    case 'answer':
      return { headline: `Waiting for your answer to the question ${step} asked.`, instruction, notes };
    case 'outside_approval':
      return { headline: 'Waiting for an approval outside AutoWorker.', instruction, notes };
    case 'retry':
    case null:
      return { headline: `${step} waits for you.`, instruction, notes };
  }
}

function stoppedNext(task: TaskLive): string {
  const step = stepName(task.step);
  if (task.waitingOn === 'approval') return `Retry brings back the approval of ${step}, without running it again.`;
  const verdict = task.attempts.at(-1)?.verdict ?? null;
  return verdict !== null && failures[verdict] !== null ? 'Retry starts the agent again.' : `Retry starts the agent again at ${step}.`;
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
      return { headline, instruction: 'Follow the agent on the right, and stop it there if it goes wrong.', notes };
    }
    case 'waiting':
      return waitingCard(task, notes);
    case 'stopped':
      return { headline: task.stoppedBy === null ? `This task stopped during ${stepName(task.step)}.` : `${task.stoppedBy.name} stopped this task at ${clock(task.stoppedBy.at, zone)}.`, instruction: stoppedNext(task), notes };
    case 'done':
      return { headline: 'The task landed.', instruction: null, notes: landing.took === null ? [] : [`It took ${landing.took} from start to merge.`] };
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
