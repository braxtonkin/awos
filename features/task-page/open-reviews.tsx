'use client';

import type { Said } from '../../shared/said.ts';
import { ReviewCard } from '../../shared/ui/review.tsx';
import type { SendAction } from '../../shared/ui/sending.ts';
import { color } from '../../shared/ui/tokens.ts';
import type { Sent } from '../../shared/ui/use-send.ts';
import type { TaskLive } from './protocol.ts';
import { stepName } from './time.ts';

type OpenReviewsProps = { readonly task: string; readonly live: TaskLive; readonly said: readonly Said[]; readonly onSent: Sent; readonly act: SendAction; readonly zone: string };

export function OpenReviews({ task: taskId, live: task, said, onSent, act, zone }: OpenReviewsProps) {
  if (task.state !== 'waiting' || task.waitingOn !== 'approval' || task.review === null) return null;
  return (
    <section aria-label="Open review" data-gate={task.review.attempt} style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '20px 24px', borderRadius: 12, background: color('surface'), border: `1px solid ${color('rule')}` }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{`Review of ${stepName(task.step)}`}</h2>
      <ReviewCard task={taskId} attempt={task.review.attempt} review={task.review.review} said={said} act={act} onSent={onSent} zone={zone} />
    </section>
  );
}
