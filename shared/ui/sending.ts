import type { RequestAnswer } from '../requests.ts';
import type { Said } from '../said.ts';

export type Sending = { readonly kind: 'ready' } | { readonly kind: 'pick-first' } | { readonly kind: 'sent'; readonly said: Said; readonly answer: RequestAnswer };

export type SendAction = (previous: Sending, form: FormData) => Promise<Sending>;

export const ready: Sending = { kind: 'ready' };
