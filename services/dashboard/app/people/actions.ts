'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { Secret } from '../../../../features/credentials/kinds.ts';
import { replace } from '../../../../features/credentials/store.ts';
import type { Replacing } from '../../../../features/people/logins.ts';
import { credentialKey } from '../../credential-key.ts';
import { database } from '../../database.ts';
import { acting } from '../../identity.ts';

const owner = z.string().regex(/^[1-9]\d*$/);

const asked = z.discriminatedUnion('connector', [
  z.object({ connector: z.literal('github'), owner, secret: z.string() }).transform(({ owner: of, secret }) => ({ owner: of, secret: { connector: 'github', token: secret } satisfies Secret })),
  z.object({ connector: z.literal('jira'), owner, secret: z.string() }).transform(({ owner: of, secret }) => ({ owner: of, secret: { connector: 'jira', login: secret } satisfies Secret })),
  z
    .object({ connector: z.literal('codex'), owner, secret: z.string(), made: z.literal('yes').nullable() })
    .transform(({ owner: of, secret, made }) => ({ owner: of, secret: { connector: 'codex', login: secret, madeForAutoWorker: made === 'yes' } satisfies Secret })),
]);

export async function replaceLogin(_previous: Replacing, form: FormData): Promise<Replacing> {
  const person = await acting();
  if (person === undefined) return { kind: 'pick-first' };
  const keyed = credentialKey();
  if ('off' in keyed) return { kind: 'off' };
  const given = asked.safeParse({ connector: form.get('connector'), owner: form.get('owner'), secret: form.get('secret'), made: form.get('made') });
  if (!given.success) return { kind: 'refused', reason: 'The form was incomplete, so nothing was saved. Reload the page and try again.' };
  const at = new Date();
  const replaced = await replace(database(), keyed.key, { action: randomUUID(), by: person, at, owner: given.data.owner, secret: given.data.secret });
  if ('refused' in replaced) return { kind: 'refused', reason: replaced.reason };
  revalidatePath('/people');
  return { kind: 'saved', at: at.toISOString() };
}
