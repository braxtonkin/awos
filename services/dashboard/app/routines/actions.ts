'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { draftFrom, fields } from '../../../../features/routine-editor/form.ts';
import { presses, type Press, type PressState, type SaveState } from '../../../../features/routine-editor/protocol.ts';
import { savedVersion } from '../../../../features/routine-editor/read.ts';
import { refusal } from '../../../../shared/db/client.ts';
import { answerWithin, request, type Asked, type Sent } from '../../../../shared/requests.ts';
import { database } from '../../database.ts';
import { acting } from '../../identity.ts';

const id = z.string().regex(/^[1-9]\d*$/);

const answerWaitMs = 2000;

const pressed = z.object({ routine: id, press: z.enum(presses) });

const saving = z.object({ routine: z.union([z.literal(''), id]), request: z.uuid() });

type Outcome = Sent | 'pick-first' | 'no-routine';

async function send(asked: Asked): Promise<Outcome> {
  try {
    return await request(database(), asked);
  } catch (error) {
    const refused = refusal(error);
    if (refused?.kind === 'foreign_key' && refused.name === 'request_asked_by_person') return 'pick-first';
    if (refused?.kind === 'foreign_key' && refused.name === 'request_on_routine') return 'no-routine';
    throw error;
  }
}

const pressOf = (press: Press, base: { readonly id: string; readonly person: string; readonly at: Date; readonly target: string }): Asked => {
  switch (press) {
    case 'pause':
      return { ...base, kind: press, payload: {} };
    case 'resume':
      return { ...base, kind: press, payload: {} };
    case 'run_now':
      return { ...base, kind: press, payload: {} };
  }
};

const refreshed = (routine: string): void => {
  revalidatePath('/routines');
  revalidatePath(`/routines/${routine}`);
};

export async function pressRoutine(_previous: PressState, form: FormData): Promise<PressState> {
  const { routine, press } = pressed.parse({ routine: form.get('routine'), press: form.get('press') });
  const person = await acting();
  if (person === undefined) return { kind: 'pick-first' };
  const asked = pressOf(press, { id: randomUUID(), person, at: new Date(), target: routine });
  const sent = await send(asked);
  if (sent === 'pick-first') return { kind: 'pick-first' };
  if (sent === 'no-routine' || 'refused' in sent) throw new Error(`The ${press} request ${asked.id} was not sent: ${typeof sent === 'string' ? sent : sent.refused}`);
  const answer = (await answerWithin(database(), asked.id, answerWaitMs)) ?? 'waiting';
  refreshed(routine);
  return { kind: 'sent', press, answer };
}

export async function saveRoutine(_previous: SaveState, form: FormData): Promise<SaveState> {
  const { routine, request: asked } = saving.parse({ routine: form.get(fields.routine), request: form.get(fields.request) });
  const person = await acting();
  if (person === undefined) return { kind: 'pick-first', request: asked };
  const parsed = draftFrom(form);
  if ('problems' in parsed) return { kind: 'invalid', problems: parsed.problems, request: asked };
  const sent = await send({ id: asked, person, at: new Date(), kind: 'save_routine', target: routine === '' ? null : routine, payload: parsed.draft });
  if (sent === 'pick-first') return { kind: 'pick-first', request: asked };
  if (sent === 'no-routine') return { kind: 'refused', reason: 'No routine has this id. Open the routine again from the list.', request: randomUUID() };
  if ('refused' in sent) return { kind: 'refused', reason: 'This save was sent before with other details, so AutoWorker kept the first one. Save again.', request: randomUUID() };
  const answer = (await answerWithin(database(), asked, answerWaitMs)) ?? 'waiting';
  if (answer === 'waiting') return { kind: 'waiting', request: asked };
  if ('refused' in answer) return { kind: 'refused', reason: answer.refused, request: randomUUID() };
  const saved = await savedVersion(database(), asked);
  if (saved === undefined) throw new Error(`The engine recorded the save ${asked} but wrote no routine version for it.`);
  refreshed(saved.routine);
  if (routine === '') redirect(`/routines/${saved.routine}?saved=${String(saved.version)}`);
  return { kind: 'saved', version: saved.version, request: randomUUID() };
}
