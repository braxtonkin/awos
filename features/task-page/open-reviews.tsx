'use client';

import { useCallback, useState } from 'react';
import type { Said } from '../../shared/said.ts';
import { ReviewCard } from '../../shared/ui/review.tsx';
import type { SendAction } from '../../shared/ui/sending.ts';
import { color } from '../../shared/ui/tokens.ts';
import { useFrames, type Stream } from '../../shared/ui/use-frames.ts';
import { frame, type TaskLive } from './protocol.ts';
import { stepName } from './time.ts';

type OpenReviewsProps = { readonly task: string; readonly live: TaskLive; readonly said: readonly Said[]; readonly stream: Stream; readonly act: SendAction; readonly zone: string };

export function OpenReviews({ task: taskId, live, said: saidFirst, stream, act, zone }: OpenReviewsProps) {
  const [task, setTask] = useState(live);
  const [said, setSaid] = useState(saidFirst);
  useFrames(stream, frame, next => {
    if (next.kind === 'task') setTask(next.task);
    if (next.kind === 'said') setSaid(next.said);
  });
  const onSent = useCallback((entry: Said) => {
    setSaid(known => (known.some(each => each.request === entry.request) ? known : [...known, entry]));
  }, []);
  if (task.state !== 'waiting' || task.waitingOn !== 'approval' || task.review === null) return null;
  return (
    <section aria-label="Open review" data-gate={task.review.attempt} style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '20px 24px', borderRadius: 12, background: color('surface'), border: `1px solid ${color('rule')}` }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{`Review of ${stepName(task.step)}`}</h2>
      <ReviewCard task={taskId} attempt={task.review.attempt} review={task.review.review} said={said} act={act} onSent={onSent} zone={zone} />
    </section>
  );
}
