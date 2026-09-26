'use server';

import { z } from 'zod';
import { people } from '../../../shared/people.ts';
import { database } from '../database.ts';
import { identity } from '../identity.ts';

const picked = z.object({ person: z.string().regex(/^[1-9]\d*$/) });

export async function pick(form: FormData): Promise<void> {
  const { person } = picked.parse({ person: form.get('person') });
  const known = await people(database());
  if (known.some(each => each.id === person)) await identity.choose(person);
}
