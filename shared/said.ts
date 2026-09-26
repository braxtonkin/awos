import { z } from 'zod';
import type { RequestAnswer, RequestKind } from './requests.ts';

const moment = z.iso.datetime({ offset: true });

export const requestAnswer = z.union([z.literal('waiting'), z.strictObject({ recorded: z.string() }), z.strictObject({ refused: z.string() })]) satisfies z.ZodType<RequestAnswer>;

export const saidKinds = ['steer', 'retry', 'answer', 'send_back', 'approve', 'stop'] as const satisfies readonly RequestKind[];

export const said = z.strictObject({
  request: z.uuid(),
  kind: z.enum(saidKinds),
  person: z.string(),
  at: moment,
  words: z.string().nullable(),
  answer: requestAnswer,
  receivedAt: moment.nullable(),
  actedAt: moment.nullable(),
  clientId: z.string().nullable(),
  review: z.string().nullable(),
  block: z.int().nonnegative().nullable(),
  options: z.array(z.string()).readonly(),
});

export type Said = z.infer<typeof said>;

export type Delivery = 'refused' | 'sent' | 'received' | 'acted';

export const deliveryOf = (entry: Said): Delivery => {
  if (entry.answer !== 'waiting' && 'refused' in entry.answer) return 'refused';
  if (entry.actedAt !== null) return 'acted';
  return entry.receivedAt === null ? 'sent' : 'received';
};
