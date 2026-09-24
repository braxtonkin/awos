import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { z } from 'zod';
import type { DB } from './types.ts';

export type Database = Kysely<DB>;

export type Refusal =
  | { readonly kind: 'unique' | 'foreign_key' | 'check' | 'final'; readonly name: string }
  | { readonly kind: 'not_null'; readonly table: string; readonly column: string };

const namedKinds = { '23505': 'unique', '23503': 'foreign_key', '23514': 'check', '23001': 'final' } as const;

const refusals = z.union([
  z
    .object({ code: z.enum(['23505', '23503', '23514', '23001']), constraint: z.string() })
    .transform(({ code, constraint }): Refusal => ({ kind: namedKinds[code], name: constraint })),
  z.object({ code: z.literal('23502'), table: z.string(), column: z.string() }).transform(({ table, column }): Refusal => ({ kind: 'not_null', table, column })),
]);

export function connect(url: string, connections: number, connectTimeoutMs?: number): Database {
  const pool = new pg.Pool({ connectionString: url, max: connections, ...(connectTimeoutMs === undefined ? {} : { connectionTimeoutMillis: connectTimeoutMs }) });
  pool.on('error', error => {
    process.stderr.write(`An idle Postgres connection failed, and the pool dropped it: ${error.message}\n`);
  });
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}

export function refusal(error: unknown): Refusal | undefined {
  const parsed = refusals.safeParse(error);
  return parsed.success ? parsed.data : undefined;
}
