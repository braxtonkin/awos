'use client';

import type { Said } from '../../shared/said.ts';
import type { SendAction, Sending } from '../../shared/ui/sending.ts';
import { color } from '../../shared/ui/tokens.ts';
import { pickFirst, useSend, type Sent } from '../../shared/ui/use-send.ts';

const told = (state: Sending, said: readonly Said[]): string | undefined => {
  if (state.kind === 'pick-first') return pickFirst;
  if (state.kind !== 'sent') return undefined;
  const answer = said.find(entry => entry.request === state.said.request)?.answer ?? state.answer;
  if (answer === 'waiting') return 'Waiting for the engine';
  return 'recorded' in answer ? 'Stopped' : answer.refused;
};

type StopProps = { readonly task: string; readonly action: SendAction; readonly said: readonly Said[]; readonly stoppable: boolean; readonly onSent: Sent };

export function Stop({ task, action, said, stoppable, onSent }: StopProps) {
  const [state, dispatch, pending] = useSend(action, onSent);
  const sentence = pending ? undefined : told(state, said);
  if (sentence === undefined && !pending && !stoppable) return null;
  const quiet = { fontSize: 13, color: color('muted') } as const;
  return (
    <form action={dispatch} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
      <input type="hidden" name="task" value={task} />
      {sentence === undefined ? (
        <>
          <span style={quiet}>Stopping keeps the work already pushed.</span>
          <button type="submit" data-stop="button" style={{ ...quiet, color: color('ink'), padding: 0, border: 0, background: 'none', textDecoration: 'underline', textUnderlineOffset: 2, cursor: 'pointer' }}>
            {pending ? 'Sending' : 'Stop task'}
          </button>
        </>
      ) : (
        <span role="status" data-stop="said" style={{ ...quiet, color: color('ink') }}>
          {sentence}
        </span>
      )}
    </form>
  );
}
