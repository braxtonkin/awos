'use server';

import { z } from 'zod';
import { actor } from '../../../shared/people.ts';
import { database } from '../database.ts';
import { identity } from '../identity.ts';

const picked = z.object({ person: z.string().regex(/^[1-9]\d*$/) });

export async function pick(form: FormData): Promise<void> {
  const { person } = picked.parse({ person: form.get('person') });
  if ((await actor(database(), person)) !== undefined) await identity.choose(person);
}
