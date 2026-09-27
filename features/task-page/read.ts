import { sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import { emptyTranscript } from '../../shared/items.ts';
import { reproduction } from '../../shared/reproduction.ts';
import { answerFrom, payloads } from '../../shared/requests.ts';
import { review, type Answer, type Review } from '../../shared/review.ts';
import { saidKinds, type Said } from '../../shared/said.ts';
import { marksOf, verdict } from '../../shared/task-status.ts';
import { taskState, waitingOn, type AttemptSummary, type Cursor, type Evidence, type Field, type Kept, type Line, type Live, type Shown, type TaskLive } from './protocol.ts';
import { extend } from './timeline.ts';

export type Header = {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly routine: string;
  readonly repository: string | null;
  readonly foundAt: string;
};

export type Step = { readonly name: string; readonly gate: boolean };

export type TaskPageData = {
  readonly header: Header;
  readonly steps: readonly Step[];
  readonly live: Live;
  readonly cursor: Cursor | undefined;
  readonly kept: Kept;
};

export type Snapshot = { readonly live: TaskLive; readonly lines: readonly Line[]; readonly said: readonly Said[]; readonly evidence: readonly Evidence[] };

const moment = z.union([z.date(), z.string()]).transform(value => new Date(value).toISOString());

const id = z.union([z.string(), z.number()]).transform(String);

const reviewOf = (output: unknown): Review | null => {
  const parsed = review.loose().safeParse(output);
  return parsed.success ? { outcome: parsed.data.outcome, summary: parsed.data.summary, blocks: parsed.data.blocks } : null;
};

const recorded = z.looseObject({ outcome: z.string().nullable().catch(null), summary: z.string(), blocks: z.array(z.unknown()).catch([]) });

const textBlock = z.object({ kind: z.literal('text'), body: z.string() });

type Words = Pick<AttemptSummary, 'outcome' | 'summary' | 'body'>;

function wordsOf(output: unknown): Words {
  const parsed = recorded.safeParse(output);
  if (!parsed.success) return { outcome: null, summary: null, body: null };
  const bodies = parsed.data.blocks.flatMap(block => textBlock.safeParse(block).data?.body.trim() ?? []).filter(body => body !== '');
  const summary = parsed.data.summary.trim();
  return { outcome: parsed.data.outcome, summary: summary === '' ? null : summary, body: bodies.length === 0 ? null : bodies.join('\n\n') };
}

const snapshotRow = z.object({
  state: taskState,
  step: z.string(),
  waiting_on: waitingOn.nullable(),
  waiting_reason: z.string().nullable(),
  review_attempt: id.nullable(),
  stopped_by_name: z.string().nullable(),
  stopped_at: moment.nullable(),
  attempts: z.array(z.object({ id, step: z.string(), person: z.string(), started_at: moment, finished_at: moment.nullable(), verdict: verdict.nullable(), output: z.unknown() })),
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
  evidence: z.array(z.object({ attempt: id, step: z.string(), recorded_at: moment, body: z.unknown() })),
  merge_queued: z.boolean(),
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

const mergeKind = 'pr.merge';

export type Range = { readonly after: Cursor | undefined; readonly limit: number; readonly evidenceAfter: string | undefined };

export async function snapshot(db: Database, task: string, range: Range): Promise<Snapshot | undefined> {
  const { after, evidenceAfter } = range;
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
        eb
          .selectFrom('attempt')
          .innerJoin('person', 'person.id', 'attempt.run_as_id')
          .select(['attempt.id', 'attempt.step', 'person.name as person', 'attempt.started_at', 'attempt.finished_at', 'attempt.verdict', 'attempt.output'])
          .whereRef('attempt.task_id', '=', 'task.id')
          .orderBy('attempt.id'),
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
      jsonArrayFrom(
        eb
          .selectFrom('evidence')
          .innerJoin('attempt', 'attempt.id', 'evidence.attempt_id')
          .select(['evidence.attempt_id as attempt', 'attempt.step', 'evidence.recorded_at', 'evidence.body'])
          .whereRef('evidence.task_id', '=', 'task.id')
          .where(inner => (evidenceAfter === undefined ? inner.lit(true) : inner('evidence.attempt_id', '>', evidenceAfter)))
          .orderBy('evidence.attempt_id'),
      ).as('evidence'),
      eb.exists(eb.selectFrom('outbox').select('outbox.kind').whereRef('outbox.task_id', '=', 'task.id').where('outbox.kind', '=', mergeKind).where('outbox.state', 'in', ['owed', 'done'])).as('merge_queued'),
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
      attempts: parsed.attempts.map(each => ({ id: each.id, step: each.step, person: each.person, startedAt: each.started_at, finishedAt: each.finished_at, verdict: each.verdict, ...wordsOf(each.output) })),
      review: waitingReview === undefined || asked === null ? null : { attempt: waitingReview.id, review: asked },
      mergeQueued: parsed.merge_queued,
    },
    lines: parsed.lines,
    said: saidOf(parsed),
    evidence: parsed.evidence.map(row => ({ attempt: row.attempt, step: row.step, recordedAt: row.recorded_at, shown: shownOf(row.body) })),
  };
}

export async function heard(db: Database, task: string, request: string): Promise<Said | undefined> {
  return (await snapshot(db, task, { after: undefined, limit: 0, evidenceAfter: undefined }))?.said.find(entry => entry.request === request);
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

const spoken = (machineName: string): string => {
  const spaced = machineName.replaceAll(/[-_]+/g, ' ');
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
};

type Leaf = Field & { readonly block: boolean };

const counted = (path: readonly string[], index: number): readonly string[] => [...path.slice(0, -1), `${path.at(-1) ?? 'Item'} ${String(index + 1)}`];

function leavesOf(value: unknown, path: readonly string[]): readonly Leaf[] {
  const name = path.length === 0 ? 'Evidence' : path.join(' › ');
  if (typeof value === 'string') return [{ name, text: value, block: true }];
  if (typeof value === 'number' || typeof value === 'boolean') return [{ name, text: String(value), block: false }];
  if (Array.isArray(value)) return value.flatMap((each: unknown, index) => leavesOf(each, counted(path, index)));
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([field, each]: [string, unknown]) => leavesOf(each, [...path, spoken(field)]));
  return [];
}

const fieldsOf = (body: unknown): Shown => {
  const leaves = leavesOf(body, []);
  const bare = ({ name, text }: Leaf): Field => ({ name, text });
  return { kind: 'fields', blocks: leaves.filter(leaf => leaf.block).map(bare), facts: leaves.filter(leaf => !leaf.block).map(bare) };
};

const shownOf = (body: unknown): Shown => {
  const parsed = reproduction.safeParse(body);
  return parsed.success ? { kind: 'reproduction', reproduction: parsed.data } : fieldsOf(body);
};

async function stepsOf(db: Database, task: { readonly workflow: string; readonly gates: readonly string[] }): Promise<readonly Step[]> {
  const steps = await db.selectFrom('published_workflow_step').select('published_workflow_step.name').where('published_workflow_step.workflow', '=', task.workflow).orderBy('published_workflow_step.position').execute();
  return steps.map(step => ({ name: step.name, gate: task.gates.includes(step.name) }));
}

export async function readTask(db: Database, key: string, now: Date = new Date()): Promise<TaskPageData | undefined> {
  const header = await db
    .selectFrom('task')
    .innerJoin('routine_version as version', join => join.onRef('version.routine_id', '=', 'task.routine_id').onRef('version.version', '=', 'task.found_version'))
    .leftJoin('repository', 'repository.id', 'task.repository_id')
    .select([
      'task.id',
      'task.key',
      'task.title',
      'task.found_at',
      'task.workflow',
      sql<string[]>`version.gates::text[]`.as('gates'),
      'version.name as routine',
      'repository.github',
      'repository.branch',
    ])
    .where('task.key', '=', key)
    .executeTakeFirst();
  if (header === undefined) return undefined;
  const [found, steps] = await Promise.all([snapshot(db, header.id, { after: undefined, limit: everyLine, evidenceAfter: undefined }), stepsOf(db, header)]);
  if (found === undefined) return undefined;
  const last = found.lines.at(-1);
  return {
    header: {
      id: header.id,
      key: header.key,
      title: header.title,
      routine: header.routine,
      repository: header.github === null || header.branch === null ? null : `${header.github} → ${header.branch}`,
      foundAt: header.found_at.toISOString(),
    },
    steps,
    live: {
      task: found.live,
      attempts: extend(
        found.live.attempts.map(each => ({ attempt: each.id, transcript: emptyTranscript, times: {}, actions: {} })),
        found.lines,
      ),
      said: found.said,
      evidence: found.evidence,
    },
    cursor: last === undefined ? undefined : { attempt: last.attempt, line: last.seq },
    kept: keptOf(found.live, now),
  };
}
