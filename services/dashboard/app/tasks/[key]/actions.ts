'use server';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { heard } from '../../../../../features/task-page/read.ts';
import { refusal } from '../../../../../shared/db/client.ts';
import { answerWithin, payloads, request, type Asked } from '../../../../../shared/requests.ts';
import type { Sending } from '../../../../../shared/ui/sending.ts';
import { database } from '../../../database.ts';
import { acting } from '../../../identity.ts';

const id = z.string().regex(/^[1-9]\d*$/);

const onTask = z.object({ task: id });

const stopWaitMs = 2000;

const messageWaitMs = 0;

type Asking = Asked extends infer Each ? (Each extends Asked ? Omit<Each, 'id' | 'person' | 'at'> : never) : never;

async function send(asking: Asking, waitMs: number): Promise<Sending> {
  const person = await acting();
  if (person === undefined) return { kind: 'pick-first' };
  const db = database();
  const asked: Asked = { ...asking, id: randomUUID(), person, at: new Date() };
  try {
    const sent = await request(db, asked);
    if ('refused' in sent) throw new Error(`The new request id ${asked.id} was already taken.`);
  } catch (error) {
    const refused = refusal(error);
    if (refused?.kind === 'foreign_key' && refused.name === 'request_asked_by_person') return { kind: 'pick-first' };
    throw error;
  }
  const answer = (await answerWithin(db, asked.id, waitMs)) ?? 'waiting';
  const said = await heard(db, asked.target, asked.id);
  if (said === undefined) throw new Error(`The request ${asked.id} was written but reads back as nothing.`);
  return { kind: 'sent', said, answer };
}

export async function stopTask(_previous: Sending, form: FormData): Promise<Sending> {
  const { task } = onTask.parse({ task: form.get('task') });
  return send({ kind: 'stop', target: task, payload: payloads.stop.parse({}) }, stopWaitMs);
}

const steering = onTask.extend({ message: z.string() });

export async function steerTask(_previous: Sending, form: FormData): Promise<Sending> {
  const { task, message } = steering.parse({ task: form.get('task'), message: form.get('message') });
  return send({ kind: 'steer', target: task, payload: payloads.steer.parse({ message }) }, messageWaitMs);
}

const retrying = onTask.extend({ note: z.string().transform(text => (text.trim() === '' ? null : text)) });

export async function retryTask(_previous: Sending, form: FormData): Promise<Sending> {
  const { task, note } = retrying.parse({ task: form.get('task'), note: form.get('note') ?? '' });
  return send({ kind: 'retry', target: task, payload: payloads.retry.parse({ note }) }, messageWaitMs);
}

const block = z.coerce.number().int().nonnegative();

const reviewing = z.union([
  onTask.extend({ intent: z.literal('approve'), review: id }),
  onTask.extend({ intent: z.literal('send_back'), review: id, note: z.string() }),
  onTask.extend({ intent: z.literal('answer'), review: id, answer: z.literal('pick'), block, option: z.string() }),
  onTask.extend({ intent: z.literal('answer'), review: id, answer: z.literal('untick'), block, item: z.string() }),
  onTask.extend({ intent: z.literal('answer'), review: id, answer: z.literal('edit'), block, body: z.string() }),
]);

const fields = (form: FormData): Readonly<Record<string, unknown>> => Object.fromEntries([...form.entries()].filter(([name]) => !name.startsWith('$')));

function asking(given: z.infer<typeof reviewing>): Asking {
  const { task: target, review } = given;
  switch (given.intent) {
    case 'approve':
      return { kind: 'approve', target, payload: payloads.approve.parse({ review }) };
    case 'send_back':
      return { kind: 'send_back', target, payload: payloads.send_back.parse({ review, note: given.note }) };
    case 'answer': {
      const answer = given.answer === 'pick' ? { kind: 'pick', block: given.block, option: given.option } : given.answer === 'untick' ? { kind: 'untick', block: given.block, items: [given.item] } : { kind: 'edit', block: given.block, body: given.body };
      return { kind: 'answer', target, payload: payloads.answer.parse({ review, answer }) };
    }
  }
}

export async function reviewTask(_previous: Sending, form: FormData): Promise<Sending> {
  return send(asking(reviewing.parse(fields(form))), messageWaitMs);
}
