'use server';

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StopState } from '../../../../../features/task-page/protocol.ts';
import { refusal } from '../../../../../shared/db/client.ts';
import { answerWithin, payloads, request } from '../../../../../shared/requests.ts';
import { database } from '../../../database.ts';
import { acting } from '../../../identity.ts';

const asked = z.object({ task: z.string().regex(/^[1-9]\d*$/) });

const answerWaitMs = 2000;

export async function stopTask(_previous: StopState, form: FormData): Promise<StopState> {
  const { task } = asked.parse({ task: form.get('task') });
  const person = await acting();
  if (person === undefined) return { kind: 'pick-first' };
  const db = database();
  const id = randomUUID();
  try {
    const sent = await request(db, { id, person, at: new Date(), kind: 'stop', target: task, payload: payloads.stop.parse({}) });
    if ('refused' in sent) throw new Error(`The new request id ${id} was already taken.`);
  } catch (error) {
    const refused = refusal(error);
    if (refused?.kind === 'foreign_key' && refused.name === 'request_asked_by_person') return { kind: 'pick-first' };
    throw error;
  }
  return { kind: 'sent', request: id, answer: (await answerWithin(db, id, answerWaitMs)) ?? 'waiting' };
}
