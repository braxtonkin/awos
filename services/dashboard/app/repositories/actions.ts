'use server';

import { randomUUID } from 'node:crypto';
import { saveFrom } from '../../../../features/repository-settings/form.ts';
import type { SaveState } from '../../../../features/repository-settings/protocol.ts';
import { savedRepository } from '../../../../features/repository-settings/read.ts';
import { refusal } from '../../../../shared/db/client.ts';
import { answerWithin, request } from '../../../../shared/requests.ts';
import { database } from '../../database.ts';
import { acting } from '../../identity.ts';

const answerWaitMs = 2000;

export async function saveRepositorySettings(_previous: SaveState, form: FormData): Promise<SaveState> {
  const parsed = saveFrom(form);
  if ('problems' in parsed) return { kind: 'invalid', problems: parsed.problems };
  const person = await acting();
  if (person === undefined) return { kind: 'pick-first' };
  const db = database();
  const id = randomUUID();
  try {
    const sent = await request(db, { id, person, at: new Date(), kind: 'save_repository', target: parsed.saving.target, payload: parsed.saving.save });
    if ('refused' in sent) throw new Error(`The new request id ${id} was already taken.`);
  } catch (error) {
    const refused = refusal(error);
    if (refused?.kind === 'foreign_key' && refused.name === 'request_asked_by_person') return { kind: 'pick-first' };
    throw error;
  }
  const answer = (await answerWithin(db, id, answerWaitMs)) ?? 'waiting';
  const repository = typeof answer === 'object' && 'recorded' in answer ? ((await savedRepository(db, answer.recorded)) ?? null) : null;
  return { kind: 'sent', request: id, answer, repository };
}
