'use client';

import { useActionState } from 'react';
import { color } from '../../shared/ui/tokens.ts';
import type { Press, PressAction, PressState } from './protocol.ts';

const recorded: Readonly<Record<Press, string>> = { pause: 'Paused', resume: 'Resumed', run_now: 'Runs on the next pass' };

const said = (state: PressState): string | undefined => {
  if (state.kind === 'ready') return undefined;
  if (state.kind === 'pick-first') return 'Pick who you are first';
  if (state.answer === 'waiting') return 'Waiting for the engine';
  return 'recorded' in state.answer ? recorded[state.press] : state.answer.refused;
};

const ready: PressState = { kind: 'ready' };

type RoutineActionsProps = { readonly routine: string; readonly paused: boolean; readonly press: PressAction };

export function RoutineActions({ routine, paused, press }: RoutineActionsProps) {
  const [state, dispatch, pending] = useActionState(press, ready);
  const sentence = pending ? 'Sending' : said(state);
  const button = { height: 28, padding: '0 10px', borderRadius: 6, border: `1px solid ${color('rule')}`, background: color('surface'), fontSize: 13, fontWeight: 500, cursor: 'pointer' } as const;
  return (
    <form action={dispatch} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
      <input type="hidden" name="routine" value={routine} />
      {sentence === undefined ? null : (
        <span role="status" data-press="said" style={{ fontSize: 13, color: color('muted') }}>
          {sentence}
        </span>
      )}
      <button type="submit" name="press" value={paused ? 'resume' : 'pause'} disabled={pending} data-press={paused ? 'resume' : 'pause'} className="hov" style={button}>
        {paused ? 'Resume' : 'Pause'}
      </button>
      <button type="submit" name="press" value="run_now" disabled={pending} data-press="run_now" className="hov" style={button}>
        Run now
      </button>
    </form>
  );
}
