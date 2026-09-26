'use client';

import type { Said } from '../../shared/said.ts';
import { field, hint, primary, secondary } from '../../shared/ui/controls.ts';
import type { SendAction } from '../../shared/ui/sending.ts';
import { color } from '../../shared/ui/tokens.ts';
import { pickFirst, useSend, type Sent } from '../../shared/ui/use-send.ts';

type RetryProps = { readonly task: string; readonly action: SendAction; readonly said: readonly Said[]; readonly onSent: Sent; readonly advice: string; readonly leading: boolean };

export function Retry({ task, action, said, onSent, advice, leading }: RetryProps) {
  const [state, dispatch, pending] = useSend(action, onSent);
  const answer = state.kind === 'sent' ? (said.find(entry => entry.request === state.said.request)?.answer ?? state.answer) : undefined;
  const told = state.kind === 'pick-first' ? pickFirst : answer !== undefined && answer !== 'waiting' && 'refused' in answer ? answer.refused : undefined;
  return (
    <form action={dispatch} key={state.kind === 'sent' ? state.said.request : 'new'} data-retry="form" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input type="hidden" name="task" value={task} />
      <textarea name="note" aria-label="Note for the next attempt" placeholder="Tell the agent what to do differently" maxLength={4000} rows={3} style={field} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {told === undefined ? (
          <span style={hint}>{advice}</span>
        ) : (
          <span role="status" data-retry="refused" style={{ fontSize: 13, color: color('ink') }}>
            {told}
          </span>
        )}
        <button type="submit" data-retry="send" disabled={pending} style={{ ...(leading ? primary : secondary), marginLeft: 'auto' }}>
          {pending ? 'Sending' : 'Retry'}
        </button>
      </div>
    </form>
  );
}
