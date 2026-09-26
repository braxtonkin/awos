import { z } from 'zod';
import type { TaskState, WaitingOn } from '../../shared/db/types.ts';
import type { Transcript } from '../../shared/items.ts';
import type { RequestAnswer } from '../../shared/requests.ts';
import { marks } from '../../shared/task-status.ts';

export type Cursor = { readonly attempt: string; readonly line: number };

const cursorText = /^([1-9]\d*):(0|[1-9]\d*)$/;

export const cursorOf = (text: string | null): Cursor | undefined => {
  const found = cursorText.exec(text ?? '');
  return found?.[1] === undefined || found[2] === undefined ? undefined : { attempt: found[1], line: Number(found[2]) };
};

export const textOf = (cursor: Cursor): string => `${cursor.attempt}:${String(cursor.line)}`;

const moment = z.iso.datetime({ offset: true });

const attempt = z.strictObject({ id: z.string(), step: z.string(), startedAt: moment, finishedAt: moment.nullable() });

export type AttemptSummary = z.infer<typeof attempt>;

export const taskState = z.enum(['ready', 'waiting', 'stopped', 'done']) satisfies z.ZodType<TaskState>;

export const waitingOn = z.enum(['answer', 'approval', 'outside_approval', 'retry']) satisfies z.ZodType<WaitingOn>;

const live = z.strictObject({
  state: taskState,
  step: z.string(),
  waitingOn: waitingOn.nullable(),
  waitingReason: z.string().nullable(),
  marks: z.array(z.enum(marks)).readonly(),
  stoppedBy: z.strictObject({ name: z.string(), at: moment }).nullable(),
  attempts: z.array(attempt),
});

export type TaskLive = z.infer<typeof live>;

const requestAnswer = z.union([z.literal('waiting'), z.strictObject({ recorded: z.string() }), z.strictObject({ refused: z.string() })]) satisfies z.ZodType<RequestAnswer>;

const line = z.strictObject({ kind: z.literal('line'), attempt: z.string(), seq: z.int().nonnegative(), at: moment, body: z.unknown() });

export type Line = Omit<z.infer<typeof line>, 'kind'>;

export const frame = z.discriminatedUnion('kind', [
  line,
  z.strictObject({ kind: z.literal('answer'), request: z.uuid(), answer: requestAnswer }),
  z.strictObject({ kind: z.literal('task'), task: live }),
]);

export type Frame = z.infer<typeof frame>;

export type AttemptTranscript = { readonly attempt: string; readonly transcript: Transcript; readonly times: Readonly<Record<string, string>> };

export type StopState = { readonly kind: 'ready' } | { readonly kind: 'pick-first' } | { readonly kind: 'sent'; readonly request: string; readonly answer: RequestAnswer };

export type StopAction = (previous: StopState, form: FormData) => Promise<StopState>;
