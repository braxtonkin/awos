'use client';

import { useState } from 'react';
import { StatusMarks } from '../../shared/ui/status.tsx';
import { color } from '../../shared/ui/tokens.ts';
import { useFrames, type Stream } from '../../shared/ui/use-frames.ts';
import { frame, type TaskLive } from './protocol.ts';
import { clock } from '../../shared/ui/clock.ts';
import { stepName } from './time.ts';
import { numbered } from './timeline.ts';

const runningSince = (step: string, attempt: number, at: string): string => (attempt <= 1 ? `${step} has been running since ${at}.` : `${step} has been running again since ${at}, on try ${String(attempt)}.`);

const sentenceOf = (task: TaskLive, zone: string): string => {
  const newest = task.attempts.at(-1);
  switch (task.state) {
    case 'ready':
      return newest === undefined || newest.finishedAt !== null ? `${stepName(task.step)} is next.` : runningSince(stepName(newest.step), numbered(task.attempts, newest.id), clock(newest.startedAt, zone));
    case 'waiting':
      return task.waitingReason ?? `${stepName(task.step)} waits for a person.`;
    case 'stopped':
      return task.stoppedBy === null ? `This task stopped during ${stepName(task.step)}.` : `${task.stoppedBy.name} stopped this task at ${clock(task.stoppedBy.at, zone)}.`;
    case 'done':
      return 'The task landed.';
  }
};

type LiveStatusProps = { readonly initial: TaskLive; readonly stream: Stream; readonly zone: string };

export function LiveStatus({ initial, stream, zone }: LiveStatusProps) {
  const [task, setTask] = useState(initial);
  useFrames(stream, frame, next => {
    if (next.kind === 'task') setTask(next.task);
  });
  return (
    <section data-status={task.state} style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 8, padding: '20px 24px', borderRadius: 12, background: color('surface'), border: `1px solid ${color('rule')}` }}>
      <StatusMarks marks={task.marks} />
      <p style={{ margin: 0, fontSize: 15, fontWeight: 500 }}>{sentenceOf(task, zone)}</p>
    </section>
  );
}
