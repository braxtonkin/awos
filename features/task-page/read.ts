import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import type { Verdict } from '../../shared/db/types.ts';
import { emptyTranscript } from '../../shared/items.ts';
import { answerFrom, payloads } from '../../shared/requests.ts';
import { review, type Answer, type Review } from '../../shared/review.ts';
import { saidKinds, type Said } from '../../shared/said.ts';
import { marksOf } from '../../shared/task-status.ts';
import { taskState, waitingOn, type AttemptTranscript, type Cursor, type Kept, type Line, type TaskLive } from './protocol.ts';
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
  readonly said: readonly Said[];
  readonly attempts: readonly AttemptTranscript[];
  readonly cursor: Cursor | undefined;
  readonly kept: Kept;
};

export type Snapshot = { readonly live: TaskLive; readonly lines: readonly Line[]; readonly said: readonly Said[] };

const moment = z.union([z.date(), z.string()]).transform(value => new Date(value).toISOString());

const id = z.union([z.string(), z.number()]).transform(String);

const verdict = z.enum(['behavior_fail', 'changes_requested', 'environment_fail', 'fail', 'handed_off', 'lost', 'needs_input', 'not_launched', 'pass', 'red_check', 'review_required', 'stopped']) satisfies z.ZodType<Verdict>;

const reviewOf = (output: unknown): Review | null => {
  const parsed = review.loose().safeParse(output);
  return parsed.success ? { outcome: parsed.data.outcome, summary: parsed.data.summary, blocks: parsed.data.blocks } : null;
};

const snapshotRow = z.object({
  state: taskState,
  step: z.string(),
  waiting_on: waitingOn.nullable(),
  waiting_reason: z.string().nullable(),
  review_attempt: id.nullable(),
  stopped_by_name: z.string().nullable(),
  stopped_at: moment.nullable(),
  attempts: z.array(z.object({ id, step: z.string(), started_at: moment, finished_at: moment.nullable(), verdict: verdict.nullable(), output: z.unknown() })),
  lines: z.array(z.object({ attempt: id, seq: z.coerce.number(), at: moment, body: z.unknown() })),
  requests: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      payload: z.unknown(),
      at: moment,
      answer: z.enum(['recorded', 'refused']).nullable(),
      reason: z.string().nullable(),
      action_id: z.string().nullable(),
      answered_at: moment.nullable(),
      person: z.string(),
    }),
  ),
  commands: z.array(z.object({ attempt: id, kind: z.enum(['turn.start', 'turn.steer', 'turn.stop']), action_id: z.string().nullable(), client_message_id: z.string().nullable(), received_at: moment.nullable(), acted_at: moment.nullable() })),
});

type Row = z.infer<typeof snapshotRow>;

const quoted = (text: string): string => `“${text}”`;

function answerWords(answer: Answer, asked: Review | null): string {
  const block = asked?.blocks[answer.block];
  switch (answer.kind) {
    case 'pick': {
      const label = block?.kind === 'choice' ? block.options.find(option => option.id === answer.option)?.label : undefined;
      return `Picked ${quoted(label ?? answer.option)}`;
    }
    case 'untick': {
      const labels = answer.items.map(item => (block?.kind === 'checklist' ? block.items.find(listed => listed.id === item)?.label : undefined) ?? item);
      return `Unticked ${labels.map(quoted).join(', ')}`;
    }
    case 'edit':
      return `Edited the draft: ${answer.body}`;
  }
}

type Spoken = Pick<Said, 'words' | 'review' | 'block' | 'options'>;

function spokenOf(kind: Said['kind'], payload: unknown, reviews: ReadonlyMap<string, Review | null>): Spoken {
  const bare: Spoken = { words: null, review: null, block: null, options: [] };
  switch (kind) {
    case 'steer':
      return { ...bare, words: payloads.steer.parse(payload).message };
    case 'retry':
      return { ...bare, words: payloads.retry.parse(payload).note };
    case 'send_back': {
      const sent = payloads.send_back.parse(payload);
      return { ...bare, words: sent.note, review: sent.review };
    }
    case 'answer': {
      const given = payloads.answer.parse(payload);
      return { words: answerWords(given.answer, reviews.get(given.review) ?? null), review: given.review, block: given.answer.block, options: given.answer.kind === 'pick' ? [given.answer.option] : given.answer.kind === 'untick' ? given.answer.items : [] };
    }
    case 'approve':
      return { ...bare, review: payloads.approve.parse(payload).review };
    case 'stop':
      return bare;
  }
}

function saidOf(row: Row): readonly Said[] {
  const reviews = new Map(row.attempts.map(each => [each.id, reviewOf(each.output)]));
  const starts = row.commands.filter(command => command.kind === 'turn.start');
  const firstStartAfter = (moment: string | null) => {
    if (moment === null) return undefined;
    const next = row.attempts.find(each => each.started_at >= moment);
    return next === undefined ? undefined : starts.find(command => command.attempt === next.id);
  };
  return row.requests.flatMap(request => {
    const kind = saidKinds.find(each => each === request.kind);
    if (kind === undefined) return [];
    const recorded = request.answer === 'recorded';
    const steered = kind === 'steer' && recorded ? row.commands.find(command => command.kind === 'turn.steer' && command.action_id === request.action_id) : undefined;
    const started = kind !== 'steer' && recorded ? firstStartAfter(request.answered_at) : undefined;
    return [
      {
        request: request.id,
        kind,
        person: request.person,
        at: request.at,
        ...spokenOf(kind, request.payload, reviews),
        answer: answerFrom(request),
        receivedAt: kind === 'steer' ? (steered?.received_at ?? null) : recorded ? request.answered_at : null,
        actedAt: kind === 'steer' ? (steered?.acted_at ?? null) : (started?.received_at ?? null),
        clientId: steered?.client_message_id ?? null,
      },
    ];
  });
}

export type Range = { readonly after: Cursor | undefined; readonly limit: number };

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
      'task.review_attempt',
      'stopper.name as stopped_by_name',
      'stop.at as stopped_at',
      jsonArrayFrom(
        eb.selectFrom('attempt').select(['attempt.id', 'attempt.step', 'attempt.started_at', 'attempt.finished_at', 'attempt.verdict', 'attempt.output']).whereRef('attempt.task_id', '=', 'task.id').orderBy('attempt.id'),
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
          .innerJoin('person', 'person.id', 'person_request.person_id')
          .select(['person_request.id', 'person_request.kind', 'person_request.payload', 'person_request.at', 'person_request.answer', 'person_request.reason', 'person_request.action_id', 'person_request.answered_at', 'person.name as person'])
          .whereRef('person_request.task_id', '=', 'task.id')
          .orderBy('person_request.position'),
      ).as('requests'),
      jsonArrayFrom(
        eb
          .selectFrom('attempt_command')
          .innerJoin('attempt', 'attempt.id', 'attempt_command.attempt_id')
          .select(['attempt_command.attempt_id as attempt', 'attempt_command.kind', 'attempt_command.action_id', 'attempt_command.client_message_id', 'attempt_command.received_at', 'attempt_command.acted_at'])
          .whereRef('attempt.task_id', '=', 'task.id')
          .orderBy('attempt_command.attempt_id')
          .orderBy('attempt_command.seq'),
      ).as('commands'),
    ])
    .where('task.id', '=', task)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const parsed = snapshotRow.parse(row);
  const newest = parsed.attempts.at(-1);
  const waitingReview = parsed.attempts.find(each => each.id === parsed.review_attempt);
  const asked = waitingReview === undefined ? null : reviewOf(waitingReview.output);
  return {
    live: {
      state: parsed.state,
      step: parsed.step,
      waitingOn: parsed.waiting_on,
      waitingReason: parsed.waiting_reason,
      marks: marksOf({ state: parsed.state, waitingOn: parsed.waiting_on, newestVerdict: newest?.verdict ?? null }),
      stoppedBy: parsed.stopped_by_name === null || parsed.stopped_at === null ? null : { name: parsed.stopped_by_name, at: parsed.stopped_at },
      attempts: parsed.attempts.map(each => ({ id: each.id, step: each.step, startedAt: each.started_at, finishedAt: each.finished_at, verdict: each.verdict, summary: reviewOf(each.output)?.summary ?? null })),
      review: waitingReview === undefined || asked === null ? null : { attempt: waitingReview.id, review: asked },
    },
    lines: parsed.lines,
    said: saidOf(parsed),
  };
}

export async function heard(db: Database, task: string, request: string): Promise<Said | undefined> {
  return (await snapshot(db, task, { after: undefined, limit: 0 }))?.said.find(entry => entry.request === request);
}

const everyLine = 100_000;

const dayMs = 24 * 60 * 60 * 1000;

export const transcriptDays = 30;

export const historyDays = 180;

const keptOf = (live: TaskLive, now: Date): Kept => {
  const ended = live.state === 'done' ? live.attempts.at(-1)?.finishedAt : null;
  if (ended === null || ended === undefined) return null;
  const at = new Date(ended).getTime();
  if (now.getTime() - at <= transcriptDays * dayMs) return null;
  return { transcriptUntil: new Date(at + transcriptDays * dayMs).toISOString(), historyUntil: new Date(at + historyDays * dayMs).toISOString() };
};

export async function taskIdOf(db: Database, key: string): Promise<string | undefined> {
  return (await db.selectFrom('task').select('task.id').where('task.key', '=', key).executeTakeFirst())?.id;
}

export async function keyAsStored(db: Database, typed: string): Promise<string> {
  const found = await db.selectFrom('task').select('task.key').where(eb => eb(eb.fn<string>('upper', ['task.key']), '=', typed.toUpperCase())).orderBy('task.key').executeTakeFirst();
  return found?.key ?? typed;
}

export async function readTask(db: Database, key: string, now: Date = new Date()): Promise<TaskPageData | undefined> {
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
  const found = await snapshot(db, header.id, { after: undefined, limit: everyLine });
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
    said: found.said,
    attempts: extend(
      found.live.attempts.map(each => ({ attempt: each.id, transcript: emptyTranscript, times: {}, actions: {} })),
      found.lines,
    ),
    cursor: last === undefined ? undefined : { attempt: last.attempt, line: last.seq },
    kept: keptOf(found.live, now),
  };
}
