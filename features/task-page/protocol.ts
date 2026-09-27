import { z } from 'zod';
import type { TaskState, Verdict, WaitingOn } from '../../shared/db/types.ts';
import type { Transcript } from '../../shared/items.ts';
import { reproduction } from '../../shared/reproduction.ts';
import { review } from '../../shared/review.ts';
import { said, type Said } from '../../shared/said.ts';
import { marks } from '../../shared/task-status.ts';
import type { Action } from './tool-actions.ts';

export type Cursor = { readonly attempt: string; readonly line: number };

const cursorText = /^([1-9]\d*):(0|[1-9]\d*)$/;

export const cursorOf = (text: string | null): Cursor | undefined => {
  const found = cursorText.exec(text ?? '');
  return found?.[1] === undefined || found[2] === undefined ? undefined : { attempt: found[1], line: Number(found[2]) };
};

export const textOf = (cursor: Cursor): string => `${cursor.attempt}:${String(cursor.line)}`;

const moment = z.iso.datetime({ offset: true });

export const verdict = z.enum(['behavior_fail', 'changes_requested', 'environment_fail', 'fail', 'handed_off', 'lost', 'needs_input', 'not_launched', 'pass', 'red_check', 'review_required', 'stopped']) satisfies z.ZodType<Verdict>;

const attempt = z.strictObject({
  id: z.string(),
  step: z.string(),
  person: z.string(),
  startedAt: moment,
  finishedAt: moment.nullable(),
  verdict: verdict.nullable(),
  outcome: z.string().nullable(),
  summary: z.string().nullable(),
  body: z.string().nullable(),
});

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
  review: z.strictObject({ attempt: z.string(), review }).nullable(),
  mergeQueued: z.boolean(),
});

export type TaskLive = z.infer<typeof live>;

const field = z.strictObject({ name: z.string(), text: z.string() });

export type Field = z.infer<typeof field>;

const shown = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('reproduction'), reproduction }), z.strictObject({ kind: z.literal('fields'), blocks: z.array(field), facts: z.array(field) })]);

export type Shown = z.infer<typeof shown>;

const evidence = z.strictObject({ attempt: z.string(), step: z.string(), recordedAt: moment, shown });

export type Evidence = z.infer<typeof evidence>;

const line = z.strictObject({ kind: z.literal('line'), attempt: z.string(), seq: z.int().nonnegative(), at: moment, body: z.unknown() });

export type Line = Omit<z.infer<typeof line>, 'kind'>;

export const frame = z.discriminatedUnion('kind', [line, z.strictObject({ kind: z.literal('said'), said: z.array(said) }), z.strictObject({ kind: z.literal('task'), task: live }), z.strictObject({ kind: z.literal('evidence'), evidence: z.array(evidence) })]);

export type Frame = z.infer<typeof frame>;

export type AttemptTranscript = {
  readonly attempt: string;
  readonly transcript: Transcript;
  readonly times: Readonly<Record<string, string>>;
  readonly actions: Readonly<Record<string, Action>>;
};

export type Live = { readonly task: TaskLive; readonly attempts: readonly AttemptTranscript[]; readonly said: readonly Said[]; readonly evidence: readonly Evidence[] };

export type Kept = { readonly transcriptUntil: string; readonly historyUntil: string } | null;
