'use client';

import { useActionState, useState } from 'react';
import type { RequestAnswer } from '../../shared/requests.ts';
import { color } from '../../shared/ui/tokens.ts';
import { useFrames, type Stream } from '../../shared/ui/use-frames.ts';
import { frame, type StopAction, type StopState } from './protocol.ts';

const said = (state: StopState, answer: RequestAnswer | undefined): string | undefined => {
  if (state.kind === 'pick-first') return 'Pick who you are first';
  if (answer === undefined) return undefined;
  if (answer === 'waiting') return 'Waiting for the engine';
  return 'recorded' in answer ? 'Stopped' : answer.refused;
};

const ready: StopState = { kind: 'ready' };

type StopProps = { readonly task: string; readonly action: StopAction; readonly stream: Stream; readonly running: boolean };

export function Stop({ task, action, stream, running }: StopProps) {
  const [state, dispatch, pending] = useActionState(action, ready);
  const [answers, setAnswers] = useState<Readonly<Record<string, RequestAnswer>>>({});
  const [stoppable, setStoppable] = useState(running);
  useFrames(stream, frame, next => {
    if (next.kind === 'answer') setAnswers(known => ({ ...known, [next.request]: next.answer }));
    if (next.kind === 'task') setStoppable(next.task.state === 'ready' || next.task.state === 'waiting');
  });
  const answer = state.kind === 'sent' ? (answers[state.request] ?? state.answer) : undefined;
  const sentence = pending ? undefined : said(state, answer);
  if (sentence === undefined && !pending && !stoppable) return null;
  const quiet = { fontSize: 13, color: color('muted') } as const;
  return (
    <form action={dispatch} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
      <input type="hidden" name="task" value={task} />
      {sentence === undefined ? (
        <>
          <button type="submit" data-stop="button" style={{ ...quiet, padding: 0, border: 0, background: 'none', textDecoration: 'underline', textUnderlineOffset: 2, cursor: 'pointer' }}>
            {pending ? 'Sending' : 'Stop task'}
          </button>
          <span style={quiet}>keeps the branch and what the agent did</span>
        </>
      ) : (
        <span role="status" data-stop="said" style={{ ...quiet, color: color('ink') }}>
          {sentence}
        </span>
      )}
    </form>
  );
}
