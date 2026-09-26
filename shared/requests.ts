import { setTimeout as wait } from 'node:timers/promises';
import { sql } from 'kysely';
import { z } from 'zod';
import { refusal, type Database } from './db/client.ts';
import { repositorySave } from './repository-settings.ts';
import { answer, note } from './review.ts';
import { routineDraft } from './routine-draft.ts';

const review = z.string().regex(/^[1-9]\d*$/, { error: 'must be the id of the attempt whose review the request names' });

const nothing = z.strictObject({});

export const message = z.string().trim().min(1).max(4000);

export const requestKinds = {
  stop: { on: 'task', payload: nothing },
  retry: { on: 'task', payload: z.strictObject({ note: note.nullable() }) },
  approve: { on: 'task', payload: z.strictObject({ review }) },
  send_back: { on: 'task', payload: z.strictObject({ review, note }) },
  answer: { on: 'task', payload: z.strictObject({ review, answer }) },
  steer: { on: 'task', payload: z.strictObject({ message }) },
  pause: { on: 'routine', payload: nothing },
  resume: { on: 'routine', payload: nothing },
  run_now: { on: 'routine', payload: nothing },
  save_routine: { on: 'routine', payload: routineDraft },
  save_repository: { on: 'repository', payload: repositorySave },
} as const;

export type RequestKind = keyof typeof requestKinds;

export const requestKind = z.enum(Object.keys(requestKinds) as [RequestKind, ...RequestKind[]]);

export type PayloadOf<K extends RequestKind> = z.output<(typeof requestKinds)[K]['payload']>;

export type TargetKind = (typeof requestKinds)[RequestKind]['on'];

export type TargetOf<K extends RequestKind> = K extends 'save_routine' ? string | null : K extends 'save_repository' ? null : string;

const target = z.string().regex(/^[1-9]\d*$/, { error: 'must be the id of the task or routine the request names' });

export const targets: { readonly [K in RequestKind]: z.ZodType<TargetOf<K>> } = {
  stop: target,
  retry: target,
  approve: target,
  send_back: target,
  answer: target,
  steer: target,
  pause: target,
  resume: target,
  run_now: target,
  save_routine: target.nullable(),
  save_repository: z.null(),
};

export const payloads: { readonly [K in RequestKind]: z.ZodType<PayloadOf<K>> } = {
  stop: requestKinds.stop.payload,
  retry: requestKinds.retry.payload,
  approve: requestKinds.approve.payload,
  send_back: requestKinds.send_back.payload,
  answer: requestKinds.answer.payload,
  steer: requestKinds.steer.payload,
  pause: requestKinds.pause.payload,
  resume: requestKinds.resume.payload,
  run_now: requestKinds.run_now.payload,
  save_routine: requestKinds.save_routine.payload,
  save_repository: requestKinds.save_repository.payload,
};

type AskedAs<K extends RequestKind> = { readonly id: string; readonly person: string; readonly at: Date; readonly kind: K; readonly target: TargetOf<K>; readonly payload: PayloadOf<K> };

export type Asked = { readonly [K in RequestKind]: AskedAs<K> }[RequestKind];

export type Sent = { readonly sent: string } | { readonly refused: 'id-taken' };

export type RequestAnswer = 'waiting' | { readonly recorded: string } | { readonly refused: string };

const positionTries = 20;

const columnOf = (kind: RequestKind): 'task_id' | 'routine_id' => (requestKinds[kind].on === 'task' ? 'task_id' : 'routine_id');

async function insert(db: Database, asked: Asked, payload: string): Promise<boolean> {
  const inserted = await db
    .insertInto('person_request')
    .values({ id: asked.id, person_id: asked.person, at: asked.at, kind: asked.kind, payload, ...(columnOf(asked.kind) === 'task_id' ? { task_id: asked.target } : { routine_id: asked.target }) })
    .onConflict(conflict => conflict.column('id').doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted !== undefined;
}

async function sameRequest(db: Database, asked: Asked, payload: string): Promise<boolean> {
  const found = await db
    .selectFrom('person_request')
    .select('id')
    .where('id', '=', asked.id)
    .where('person_id', '=', asked.person)
    .where('kind', '=', asked.kind)
    .where(columnOf(asked.kind), 'is not distinct from', asked.target)
    .where(sql<boolean>`payload = ${payload}::jsonb`)
    .executeTakeFirst();
  return found !== undefined;
}

export async function request(db: Database, asked: Asked): Promise<Sent> {
  if (db.isTransaction) throw new Error('request retries its insert when another request takes the same place, which a transaction cannot survive, so pass it the database, not a transaction.');
  const payload = JSON.stringify(payloads[asked.kind].parse(asked.payload));
  for (let tried = 1; tried <= positionTries; tried += 1) {
    try {
      if (await insert(db, asked, payload)) return { sent: asked.id };
      return (await sameRequest(db, asked, payload)) ? { sent: asked.id } : { refused: 'id-taken' };
    } catch (error) {
      const refused = refusal(error);
      if (refused?.kind !== 'unique' || refused.name !== 'one_request_per_position') throw error;
    }
  }
  throw new Error(`The request ${asked.id} lost the race for its place in line ${String(positionTries)} times, so it was not sent.`);
}

export type AnswerRow = { readonly id: string; readonly answer: 'recorded' | 'refused' | null; readonly reason: string | null; readonly action_id: string | null };

export function answerFrom(row: AnswerRow): RequestAnswer {
  if (row.answer === null) return 'waiting';
  if (row.answer === 'recorded' && row.action_id !== null) return { recorded: row.action_id };
  if (row.answer === 'refused' && row.reason !== null) return { refused: row.reason };
  throw new Error(`The request ${row.id} holds an answer that answer_names_its_action and refusal_says_why forbid.`);
}

export async function answerOf(db: Database, id: string): Promise<RequestAnswer | undefined> {
  const row = await db.selectFrom('person_request').select(['id', 'answer', 'reason', 'action_id']).where('id', '=', id).executeTakeFirst();
  return row === undefined ? undefined : answerFrom(row);
}

const answerPollMs = 100;

export async function answerWithin(db: Database, id: string, waitMs: number): Promise<RequestAnswer | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const found = await answerOf(db, id);
    if (found !== 'waiting' || Date.now() >= deadline) return found;
    await wait(answerPollMs);
  }
}
