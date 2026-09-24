import { z } from 'zod';

export const outcomes = ['done', 'needs_input', 'blocked'] as const;

const option = z.strictObject({ id: z.string(), label: z.string() });

const block = z.union([
  z.strictObject({ kind: z.enum(['text']), title: z.string().nullable(), body: z.string() }),
  z.strictObject({ kind: z.enum(['list']), title: z.string().nullable(), items: z.array(z.string()) }),
  z.strictObject({ kind: z.enum(['choice']), title: z.string().nullable(), question: z.string(), options: z.array(option), recommended: z.string().nullable() }),
  z.strictObject({ kind: z.enum(['checklist']), title: z.string().nullable(), items: z.array(option) }),
  z.strictObject({ kind: z.enum(['draft']), title: z.string().nullable(), body: z.string() }),
]);

export const review = z.strictObject({ outcome: z.enum(outcomes), summary: z.string(), blocks: z.array(block) });

export type Review = z.infer<typeof review>;

export type BlockKind = Review['blocks'][number]['kind'];

export const answer = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pick'), block: z.int().nonnegative(), option: z.string() }),
  z.strictObject({ kind: z.literal('untick'), block: z.int().nonnegative(), items: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal('edit'), block: z.int().nonnegative(), body: z.string().max(20000) }),
]);

export type Answer = z.infer<typeof answer>;
