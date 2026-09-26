import type { Database } from './db/client.ts';

export type Person = { readonly id: string; readonly name: string };

const actors = (db: Database) => db.selectFrom('person').select(['person.id', 'person.name']).where('person.kind', '=', 'person');

export const people = (db: Database): Promise<readonly Person[]> => actors(db).orderBy('person.name').execute();

export const actor = (db: Database, id: string): Promise<Person | undefined> => actors(db).where('person.id', '=', id).executeTakeFirst();

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(word => word !== '')
    .map(word => word.charAt(0).toUpperCase())
    .slice(0, 2)
    .join('');
