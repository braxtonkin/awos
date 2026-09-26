import type { Database } from './db/client.ts';

export type Person = { readonly id: string; readonly name: string };

export const people = (db: Database): Promise<readonly Person[]> => db.selectFrom('person').select(['person.id', 'person.name']).where('person.kind', '=', 'person').orderBy('person.name').execute();

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(word => word !== '')
    .map(word => word.charAt(0).toUpperCase())
    .slice(0, 2)
    .join('');
