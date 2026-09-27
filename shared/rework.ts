import { z } from 'zod';

const commit = z.string().regex(/^[0-9a-f]{40}$/);

export const logTail = { lines: 60, characters: 6000 } as const;

export const personNote = z.strictObject({ by: z.string().min(1), text: z.string().min(1) });

export type PersonNote = z.infer<typeof personNote>;

const notes = z.array(personNote);

const named = { name: z.string().min(1) };

export const failedCheck = z.discriminatedUnion('kind', [
  z.strictObject({ ...named, kind: z.literal('logged'), conclusion: z.string().min(1), step: z.string().min(1).nullable(), log: z.string().max(logTail.characters) }),
  z.strictObject({ ...named, kind: z.literal('described'), conclusion: z.string().min(1), description: z.string().nullable(), url: z.string().nullable() }),
  z.strictObject({ ...named, kind: z.literal('unread'), why: z.string().min(1) }),
]);

export type FailedCheck = z.infer<typeof failedCheck>;

export const reworkObligation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('conflict'), branch: z.string().min(1), head: commit, notes }),
  z.strictObject({ kind: z.literal('check'), head: commit, checks: z.tuple([failedCheck], failedCheck), notes }),
  z.strictObject({ kind: z.literal('behavior'), evidence: z.string().min(1), notes }),
  z.strictObject({ kind: z.literal('review'), review: z.string().min(1), notes }),
  z.strictObject({ kind: z.literal('note'), notes: z.tuple([personNote], personNote) }),
]);

export type ReworkObligation = z.infer<typeof reworkObligation>;

export type ObligationKind = ReworkObligation['kind'];

export type SendBack =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'check'; readonly head: string | null; readonly names: readonly [string, ...string[]] }
  | { readonly kind: 'behavior'; readonly evidence: string }
  | { readonly kind: 'review'; readonly review: string };

export type Demanding = Extract<ReworkObligation, { readonly kind: 'check' | 'behavior' | 'review' }>;

const changeDemanded: { readonly [K in ObligationKind]: K extends Demanding['kind'] ? true : false } = { conflict: false, check: true, behavior: true, review: true, note: false };

export const demandsChange = (obligation: ReworkObligation): obligation is Demanding => changeDemanded[obligation.kind];
