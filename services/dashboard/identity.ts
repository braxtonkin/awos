import { cookies, headers } from 'next/headers';
import { actor } from '../../shared/people.ts';
import { database } from './database.ts';

export type Asking = {
  readonly cookies: { get(name: string): { readonly value: string } | undefined };
  readonly headers: { get(name: string): string | null };
};

export type Identity = { readonly who: (asking: Asking) => string | undefined; readonly choose: (person: string) => Promise<void> };

const picked = 'autoworker-person';

const yearSeconds = 365 * 24 * 60 * 60;

export const identity: Identity = {
  who: asking => {
    const value = asking.cookies.get(picked)?.value;
    return value !== undefined && /^[1-9]\d*$/.test(value) ? value : undefined;
  },
  choose: async person => {
    (await cookies()).set(picked, person, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: yearSeconds });
  },
};

export const acting = async (): Promise<string | undefined> => {
  const named = identity.who({ cookies: await cookies(), headers: await headers() });
  return named === undefined ? undefined : (await actor(database(), named))?.id;
};
