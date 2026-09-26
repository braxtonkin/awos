import { z } from 'zod';
import type { RequestAnswer } from '../../shared/requests.ts';
import { requestAnswer } from '../../shared/said.ts';

export const frame = z.strictObject({ kind: z.literal('answer'), request: z.uuid(), answer: requestAnswer, repository: z.string().nullable() });

export type Frame = z.infer<typeof frame>;

export const fields = ['github', 'branch', 'image', 'fastTestCommand', 'setupCommand', 'verifyProvider', 'ignorableChecks', 'draftLeaves', 'ignoredReviewers'] as const;

export type Field = (typeof fields)[number];

export type Problems = Readonly<Partial<Record<Field, string>>>;

export type SaveState =
  | { readonly kind: 'ready' }
  | { readonly kind: 'saved' }
  | { readonly kind: 'pick-first' }
  | { readonly kind: 'invalid'; readonly problems: Problems }
  | { readonly kind: 'sent'; readonly request: string; readonly answer: RequestAnswer; readonly repository: string | null };

export type SaveAction = (previous: SaveState, form: FormData) => Promise<SaveState>;

export const streamPath = '/repositories/stream';
