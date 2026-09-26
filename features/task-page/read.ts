import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import type { Verdict } from '../../shared/db/types.ts';
import { emptyTranscript } from '../../shared/items.ts';
import type { AnswerRow } from '../../shared/requests.ts';
import { marksOf } from '../../shared/task-status.ts';
import { taskState, waitingOn, type AttemptTranscript, type Cursor, type Line, type TaskLive } from './protocol.ts';
import { extend } from './timeline.ts';

export type Header = {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly routine: string;
  readonly repository: string | null;
  readonly runsAs: string | null;
  readonly foundAt: string;
};

export type TaskPageData = {
  readonly header: Header;
  readonly live: TaskLive;
  readonly attempts: readonly AttemptTranscript[];
  readonly cursor: Cursor | undefined;
};

export type Snapshot = { readonly live: TaskLive; readonly lines: readonly Line[]; readonly answers: readonly AnswerRow[] };

const moment = z.union([z.date(), z.string()]).transform(value => new Date(value).toISOString());

const id = z.union([z.string(), z.number()]).transform(String);

const snapshotRow = z.object({
  state: taskState,
  step: z.string(),
  waiting_on: waitingOn.nullable(),
  waiting_reason: z.string().nullable(),
  stopped_by_name: z.string().nullable(),
  stopped_at: moment.nullable(),
  attempts: z.array(
    z.object({
      id,
      step: z.string(),
      started_at: moment,
      finished_at: moment.nullable(),
      verdict: z.enum(['behavior_fail', 'changes_requested', 'environment_fail', 'fail', 'handed_off', 'lost', 'needs_input', 'not_launched', 'pass', 'red_check', 'review_required', 'stopped']).nullable() satisfies z.ZodType<Verdict | null>,
    }),
  ),
  lines: z.array(z.object({ attempt: id, seq: z.coerce.number(), at: moment, body: z.unknown() })),
  answers: z.array(z.object({ id: z.string(), answer: z.enum(['recorded', 'refused']).nullable(), reason: z.string().nullable(), action_id: z.string().nullable() })),
});

export type Range = { readonly after: Cursor | undefined; readonly limit: number; readonly answersSince: Date };

export async function snapshot(db: Database, task: string, range: Range): Promise<Snapshot | undefined> {
  const { after } = range;
  const row = await db
    .selectFrom('task')
    .leftJoin('human_action as stop', 'stop.id', 'task.stopped_by')
    .leftJoin('person as stopper', 'stopper.id', 'stop.person_id')
    .select(eb => [
      'task.state',
      'task.step',
      'task.waiting_on',
      'task.waiting_reason',
      'stopper.name as stopped_by_name',
      'stop.at as stopped_at',
      jsonArrayFrom(
        eb.selectFrom('attempt').select(['attempt.id', 'attempt.step', 'attempt.started_at', 'attempt.finished_at', 'attempt.verdict']).whereRef('attempt.task_id', '=', 'task.id').orderBy('attempt.id'),
      ).as('attempts'),
      jsonArrayFrom(
        eb
          .selectFrom('attempt_event')
          .innerJoin('attempt', 'attempt.id', 'attempt_event.attempt_id')
          .select(['attempt_event.attempt_id as attempt', 'attempt_event.seq', 'attempt_event.stored_at as at', 'attempt_event.body'])
          .whereRef('attempt.task_id', '=', 'task.id')
          .where('attempt_event.kind', '=', 'app')
          .where(inner => (after === undefined ? inner.lit(true) : inner(inner.refTuple('attempt_event.attempt_id', 'attempt_event.seq'), '>', inner.tuple(after.attempt, String(after.line)))))
          .orderBy('attempt_event.attempt_id')
          .orderBy('attempt_event.seq')
          .limit(range.limit),
      ).as('lines'),
      jsonArrayFrom(
        eb
          .selectFrom('person_request')
          .select(['person_request.id', 'person_request.answer', 'person_request.reason', 'person_request.action_id'])
          .whereRef('person_request.task_id', '=', 'task.id')
          .where('person_request.at', '>=', range.answersSince)
          .orderBy('person_request.position'),
      ).as('answers'),
    ])
    .where('task.id', '=', task)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const parsed = snapshotRow.parse(row);
  const newest = parsed.attempts.at(-1);
  return {
    live: {
      state: parsed.state,
      step: parsed.step,
      waitingOn: parsed.waiting_on,
      waitingReason: parsed.waiting_reason,
      marks: marksOf({ state: parsed.state, waitingOn: parsed.waiting_on, newestVerdict: newest?.verdict ?? null }),
      stoppedBy: parsed.stopped_by_name === null || parsed.stopped_at === null ? null : { name: parsed.stopped_by_name, at: parsed.stopped_at },
      attempts: parsed.attempts.map(each => ({ id: each.id, step: each.step, startedAt: each.started_at, finishedAt: each.finished_at })),
    },
    lines: parsed.lines,
    answers: parsed.answers,
  };
}

const everyLine = 100_000;

export async function taskIdOf(db: Database, key: string): Promise<string | undefined> {
  return (await db.selectFrom('task').select('task.id').where('task.key', '=', key).executeTakeFirst())?.id;
}

export async function keyAsStored(db: Database, typed: string): Promise<string> {
  const found = await db.selectFrom('task').select('task.key').where(eb => eb(eb.fn<string>('upper', ['task.key']), '=', typed.toUpperCase())).orderBy('task.key').executeTakeFirst();
  return found?.key ?? typed;
}

export async function readTask(db: Database, key: string): Promise<TaskPageData | undefined> {
  const header = await db
    .selectFrom('task')
    .innerJoin('routine_version as version', join => join.onRef('version.routine_id', '=', 'task.routine_id').onRef('version.version', '=', 'task.found_version'))
    .leftJoin('repository', 'repository.id', 'task.repository_id')
    .select(eb => [
      'task.id',
      'task.key',
      'task.title',
      'task.found_at',
      'version.name as routine',
      'repository.github',
      'repository.branch',
      eb
        .selectFrom('attempt')
        .innerJoin('person', 'person.id', 'attempt.run_as_id')
        .select('person.name')
        .whereRef('attempt.task_id', '=', 'task.id')
        .orderBy('attempt.id', 'desc')
        .limit(1)
        .as('runs_as'),
    ])
    .where('task.key', '=', key)
    .executeTakeFirst();
  if (header === undefined) return undefined;
  const found = await snapshot(db, header.id, { after: undefined, limit: everyLine, answersSince: new Date() });
  if (found === undefined) return undefined;
  const last = found.lines.at(-1);
  return {
    header: {
      id: header.id,
      key: header.key,
      title: header.title,
      routine: header.routine,
      repository: header.github === null || header.branch === null ? null : `${header.github} → ${header.branch}`,
      runsAs: header.runs_as,
      foundAt: header.found_at.toISOString(),
    },
    live: found.live,
    attempts: extend(
      found.live.attempts.map(each => ({ attempt: each.id, transcript: emptyTranscript, times: {} })),
      found.lines,
    ),
    cursor: last === undefined ? undefined : { attempt: last.attempt, line: last.seq },
  };
}
