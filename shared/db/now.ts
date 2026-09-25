import { sql } from 'kysely';
import type { Database } from './client.ts';

export type Now = (db: Database) => Promise<Date>;

export const postgresNow: Now = async db => {
  const { rows } = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db);
  const now = rows[0]?.now;
  if (now === undefined) throw new Error('Postgres did not tell the time');
  return now;
};
