import { useActionState, useEffect, useRef } from 'react';
import type { Said } from '../said.ts';
import { ready, type SendAction, type Sending } from './sending.ts';

export type Sent = (entry: Said) => void;

export function useSend(action: SendAction, onSent: Sent): readonly [Sending, (form: FormData) => void, boolean] {
  const [state, dispatch, pending] = useActionState(action, ready);
  const told = useRef<Sending>(ready);
  useEffect(() => {
    if (state === told.current) return;
    told.current = state;
    if (state.kind === 'sent') onSent(state.said);
  }, [state, onSent]);
  return [state, dispatch, pending];
}

export const pickFirst = 'Pick who you are first';
