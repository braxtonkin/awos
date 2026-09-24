import { z } from 'zod';

const commit = z.string().regex(/^[0-9a-f]{40}$/);

const reviewComment = z.object({ path: z.string().nullable(), line: z.int().positive().nullable(), body: z.string() });

export const wholeReview = z.object({ id: z.string().min(1), reviewer: z.string().min(1), body: z.string(), comments: z.array(reviewComment) });

export const mergeValue = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('waiting-for-checks') }),
  z.object({ kind: z.literal('red'), failing: z.tuple([z.string().min(1)], z.string().min(1)) }),
  z.object({ kind: z.literal('green-draft') }),
  z.object({ kind: z.literal('review-required') }),
  z.object({ kind: z.literal('changes-requested'), review: wholeReview }),
  z.object({ kind: z.literal('behind') }),
  z.object({ kind: z.literal('conflicting') }),
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('queued') }),
  z.object({ kind: z.literal('ejected'), ejection: z.string().min(1), reason: z.string() }),
  z.object({ kind: z.literal('merged') }),
]);

export const mergeState = z.object({ head: commit, value: mergeValue });

export type MergeState = z.infer<typeof mergeState>;

export type MergeValue = z.infer<typeof mergeValue>;

export type PullRequest = { readonly repositoryId: string; readonly number: number; readonly actsAs: string };

export type Answered = { readonly ejection: string | null; readonly review: string | null };

export type MergeRead = { readonly state: MergeState } | { readonly failed: string };

export type ReadMergeState = (pullRequest: PullRequest, answered: Answered, signal: AbortSignal) => Promise<MergeRead>;
