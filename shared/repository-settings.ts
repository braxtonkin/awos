import { z } from 'zod';
import { slug, words } from './routine-draft.ts';

export const github = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { error: 'must name an owner and a repository, such as example/sandbox' });

export const imageByDigest = z.string().regex(/^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/, {
  error: 'must name the image by its sha256 digest, as name@sha256:<64 hex digits>, because a tag can move',
});

export const draftLeaves = z.enum(['when-green', 'at-once']);

export type DraftLeaves = z.output<typeof draftLeaves>;

const repositoryId = z.string().regex(/^[1-9]\d*$/, { error: 'must be the id of a listed repository' });

export const repositorySave = z.strictObject({
  repository: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('new'), github }), z.strictObject({ kind: z.literal('listed'), id: repositoryId })]),
  branch: words,
  image: imageByDigest.nullable(),
  fastTestCommand: words.nullable(),
  setupCommand: words.nullable(),
  verifyProvider: slug,
  ignorableChecks: z.array(words),
  draftLeaves,
  ignoredReviewers: z.array(words),
});

export type RepositorySave = z.output<typeof repositorySave>;
