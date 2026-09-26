import type { RequestAnswer } from '../../shared/requests.ts';

export const presses = ['pause', 'resume', 'run_now'] as const;

export type Press = (typeof presses)[number];

export type PressState = { readonly kind: 'ready' } | { readonly kind: 'pick-first' } | { readonly kind: 'sent'; readonly press: Press; readonly answer: RequestAnswer };

export type PressAction = (previous: PressState, form: FormData) => Promise<PressState>;

export type SaveOutcome =
  | { readonly kind: 'ready' }
  | { readonly kind: 'pick-first' }
  | { readonly kind: 'invalid'; readonly problems: readonly string[] }
  | { readonly kind: 'waiting' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'saved'; readonly version: number };

export type SaveState = SaveOutcome & { readonly request: string };

export type SaveAction = (previous: SaveState, form: FormData) => Promise<SaveState>;
