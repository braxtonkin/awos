'use client';

import { useEffect, useRef } from 'react';
import type { Said } from '../../shared/said.ts';
import type { SendAction } from '../../shared/ui/sending.ts';
import { field, hint, primary } from '../../shared/ui/controls.ts';
import { color } from '../../shared/ui/tokens.ts';
import { pickFirst, useSend, type Sent } from '../../shared/ui/use-send.ts';

type MessageProps = {
  readonly task: string;
  readonly action: SendAction;
  readonly said: readonly Said[];
  readonly draft: string;
  readonly setDraft: (text: string) => void;
  readonly onSent: Sent;
};

export function Message({ task, action, said, draft, setDraft, onSent }: MessageProps) {
  const [state, dispatch, pending] = useSend(action, onSent);
  const sent = state.kind === 'sent' ? state.said : undefined;
  const answer = state.kind === 'sent' ? (said.find(entry => entry.request === state.said.request)?.answer ?? state.answer) : undefined;
  const refused = answer !== undefined && answer !== 'waiting' && 'refused' in answer ? answer.refused : undefined;
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (sent === undefined || answer === undefined || answer === 'waiting' || handled.current === sent.request) return;
    handled.current = sent.request;
    if ('recorded' in answer && draft.trim() === sent.words) setDraft('');
  }, [sent, answer, draft, setDraft]);
  const told = state.kind === 'pick-first' ? pickFirst : refused;
  return (
    <form action={dispatch} data-message="form" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <input type="hidden" name="task" value={task} />
      <textarea
        name="message"
        aria-label="Message to the agent"
        placeholder="Tell the agent what to change or check"
        required
        maxLength={4000}
        rows={2}
        value={draft}
        onChange={event => {
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
        }}
        style={field}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {told === undefined ? (
          <span style={hint}>The agent reads it before its next step.</span>
        ) : (
          <span role="status" data-message="refused" style={{ fontSize: 13, color: color('ink') }}>
            {told}
          </span>
        )}
        <button type="submit" data-message="send" disabled={pending} style={{ ...primary, marginLeft: 'auto' }}>
          {pending ? 'Sending' : 'Send'}
        </button>
      </div>
    </form>
  );
}
