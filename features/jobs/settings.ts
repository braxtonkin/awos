import { z } from 'zod';

export const imageReference = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/, { error: 'must name the image by its sha256 digest, as name@sha256:<64 hex digits>, because a tag can move' })
  .brand<'ImageReference'>();

export type ImageReference = z.infer<typeof imageReference>;

const whole = z.coerce.number().int().positive();

export const jobSettings = {
  JOB_IMAGE: imageReference.optional(),
  JOB_NAMESPACE: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/).default('default'),
  JOB_SERVICE_ACCOUNT: z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/).default('autoworker-job'),
  JOB_DEADLINE_SECONDS: whole.default(4 * 60 * 60),
  SWEEP_EVERY_MS: whole.default(30_000),
};

export type JobSettings = {
  readonly image: ImageReference;
  readonly namespace: string;
  readonly serviceAccount: string;
  readonly deadlineSeconds: number;
};
