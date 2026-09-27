'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { deliveryOf, type Said } from '../../shared/said.ts';
import { isFailed, type Mark } from '../../shared/task-status.ts';
import { DeliveryLine } from '../../shared/ui/delivery.tsx';
import { ReviewCard } from '../../shared/ui/review.tsx';
import type { SendAction } from '../../shared/ui/sending.ts';
import { StatusMarks } from '../../shared/ui/status.tsx';
import { color, type ColorName } from '../../shared/ui/tokens.ts';
import type { Sent } from '../../shared/ui/use-send.ts';
import { Message } from './message.tsx';
import { nowOf, type Tone } from './now.ts';
import type { AttemptTranscript, Kept, TaskLive } from './protocol.ts';
import { Retry } from './retry.tsx';
import { Stop } from './stop.tsx';
import { Transcript } from './transcript.tsx';

export type PanelActions = { readonly stop: SendAction; readonly steer: SendAction; readonly retry: SendAction; readonly review: SendAction };

export type AgentPanelProps = {
  readonly task: string;
  readonly attempts: readonly AttemptTranscript[];
  readonly live: TaskLive;
  readonly said: readonly Said[];
  readonly onSent: Sent;
  readonly kept: Kept;
  readonly actions: PanelActions;
  readonly zone: string;
};

const tones: Readonly<Record<Tone, ColorName>> = { run: 'run', attn: 'attn', muted: 'ink' };

const marked: Readonly<Partial<Record<Tone, Mark>>> = { attn: 'needs-you' };

type Dock = 'question' | 'retry' | 'message' | 'none';

const dockOf = (task: TaskLive, draft: string): Dock => {
  if (task.state === 'waiting' && task.waitingOn === 'answer' && task.review !== null) return 'question';
  if (task.state === 'ready' || draft !== '') return 'message';
  if (task.state === 'stopped' || (task.state === 'waiting' && task.waitingOn === 'retry')) return 'retry';
  return 'none';
};

const adviceOf = (task: TaskLive): string =>
  task.attempts.at(-1)?.verdict === 'environment_fail' ? 'Fix the environment first. A note is optional.' : 'Your note goes to the next attempt.';

function Docked({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <section aria-label={label} style={{ flex: 'none', maxHeight: '55%', overflow: 'auto', padding: '16px 20px', borderTop: `1px solid ${color('rule')}`, background: color('surface') }}>
      {children}
    </section>
  );
}

export function AgentPanel({ task: taskId, attempts, live: task, said, onSent, kept, actions, zone }: AgentPanelProps) {
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const box = scroller.current;
    if (box !== null && pinned.current) box.scrollTop = box.scrollHeight;
  }, [attempts, said]);
  const onScroll = (): void => {
    const box = scroller.current;
    if (box !== null) pinned.current = box.scrollHeight - box.scrollTop - box.clientHeight < 32;
  };
  const newest = task.attempts.at(-1);
  const streaming = task.state === 'ready' && newest !== undefined && newest.finishedAt === null;
  const now = nowOf(task, attempts, zone);
  const mark = now === null ? undefined : marked[now.tone];
  const dock = dockOf(task, draft);
  const latest = said.findLast(entry => entry.words !== null && entry.kind !== 'answer' && deliveryOf(entry) !== 'refused');
  const failed = isFailed({ state: task.state, waitingOn: task.waitingOn, newestVerdict: newest?.verdict ?? null });
  return (
    <aside aria-label="Agent" style={{ position: 'sticky', top: 0, height: 'calc(100vh - 56px)', display: 'flex', flexDirection: 'column', background: color('surface'), borderLeft: `1px solid ${color('rule')}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 20px 0', minHeight: 40 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Agent</h2>
        {streaming ? (
          <span data-live="true" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: color('run') }}>
            <span aria-hidden="true" className="pulse" style={{ width: 6, height: 6, borderRadius: '50%', background: color('run') }} />
            Live
          </span>
        ) : null}
        <span style={{ marginLeft: 'auto' }}>
          <Stop task={taskId} action={actions.stop} said={said} stoppable={streaming} onSent={onSent} />
        </span>
      </div>
      {now === null && latest === undefined ? null : (
        <div data-now={now?.tone} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 20px 16px', borderBottom: `1px solid ${color('rule')}` }}>
          {now === null ? null : (
            <>
              {mark === undefined ? null : <StatusMarks marks={[mark]} />}
              <p style={{ margin: 0, fontSize: 15, fontWeight: 500, color: color(tones[now.tone]), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: now.tone === 'run' ? 'nowrap' : 'normal' }}>
                {now.lead === null ? null : <span style={{ color: color('muted'), fontWeight: 400 }}>{`${now.lead} · `}</span>}
                {now.line}
              </p>
              {now.detail === null ? null : <p style={{ margin: 0, fontSize: 13, color: color('muted') }}>{now.detail}</p>}
            </>
          )}
          {latest === undefined ? null : (
            <p data-msg="person" data-delivery={deliveryOf(latest)} data-latest="true" style={{ margin: 0, fontSize: 13, display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{`${latest.person}: “${latest.words ?? ''}”`}</span>
              <span style={{ flex: 'none' }}>
                <DeliveryLine entry={latest} zone={zone} />
              </span>
            </p>
          )}
        </div>
      )}
      <div ref={scroller} onScroll={onScroll} data-transcript="true" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 8 }}>
        <Transcript attempts={attempts} summaries={task.attempts} said={said} kept={kept} zone={zone} />
      </div>
      {dock === 'question' && task.review !== null ? (
        <Docked label="The agent's question">
          <ReviewCard task={taskId} attempt={task.review.attempt} review={task.review.review} said={said} act={actions.review} onSent={onSent} zone={zone} />
        </Docked>
      ) : null}
      {dock === 'message' ? (
        <Docked label="Message the agent">
          <Message task={taskId} action={actions.steer} said={said} draft={draft} setDraft={setDraft} onSent={onSent} />
        </Docked>
      ) : null}
      {dock === 'retry' ? (
        <Docked label={failed ? 'Retry with a note' : 'Retry'}>
          <Retry task={taskId} action={actions.retry} said={said} onSent={onSent} advice={adviceOf(task)} leading={failed || task.state === 'stopped'} />
        </Docked>
      ) : null}
    </aside>
  );
}
