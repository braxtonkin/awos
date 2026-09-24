import { z } from 'zod';

export const outcomes = ['done', 'needs_input', 'blocked'] as const;

const option = z.strictObject({ id: z.string(), label: z.string() });

const blocks = {
  text: z.strictObject({ kind: z.enum(['text']), title: z.string().nullable(), body: z.string() }),
  list: z.strictObject({ kind: z.enum(['list']), title: z.string().nullable(), items: z.array(z.string()) }),
  choice: z.strictObject({ kind: z.enum(['choice']), title: z.string().nullable(), question: z.string(), options: z.array(option), recommended: z.string().nullable() }),
  checklist: z.strictObject({ kind: z.enum(['checklist']), title: z.string().nullable(), items: z.array(option) }),
  draft: z.strictObject({ kind: z.enum(['draft']), title: z.string().nullable(), body: z.string() }),
} as const;

type Blocks = typeof blocks;

const reviewOf = <S extends z.ZodType>(block: S) => z.strictObject({ outcome: z.enum(outcomes), summary: z.string(), blocks: z.array(block) });

export const review = reviewOf(z.union([blocks.text, blocks.list, blocks.choice, blocks.checklist, blocks.draft]));

export const reviewWith = <A extends keyof Blocks, B extends keyof Blocks>(first: A, second: B) => reviewOf(z.union([blocks[first], blocks[second]]));

export type Review = z.infer<typeof review>;

export type BlockKind = Review['blocks'][number]['kind'];

export const answer = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pick'), block: z.int().nonnegative(), option: z.string() }),
  z.strictObject({ kind: z.literal('untick'), block: z.int().nonnegative(), items: z.array(z.string()).min(1) }),
  z.strictObject({ kind: z.literal('edit'), block: z.int().nonnegative(), body: z.string().max(20000) }),
]);

export type Answer = z.infer<typeof answer>;
