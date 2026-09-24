import type { Transaction } from 'kysely';
import type { Database } from './db/client.ts';
import type { DB } from './db/types.ts';

const transacting = Symbol('transacting');

export type Transacting = Transaction<DB> & { readonly [transacting]: true };

export function inTransaction<T>(db: Database, work: (tx: Transacting) => Promise<T>): Promise<T> {
  return db.transaction().execute(tx => work(Object.assign(tx, { [transacting]: true as const })));
}
