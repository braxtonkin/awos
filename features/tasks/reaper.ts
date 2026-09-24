import { sql } from 'kysely';
import type { Database } from '../../shared/db/client.ts';
import type { Loop } from '../../shared/loop.ts';
import { caps, reap, type Reaped } from './claim.ts';

export type ReaperSettings = { readonly everyMs: number; readonly leaseMs: number };

export async function freshenLeases(db: Database, now: Date, leaseMs: number): Promise<number> {
  const until = new Date(now.getTime() + leaseMs);
  const { numUpdatedRows } = await db
    .updateTable('attempt')
    .set({ lease_until: sql<Date>`greatest(lease_until, ${until})` })
    .where('finished_at', 'is', null)
    .executeTakeFirst();
  return Number(numUpdatedRows);
}

const released = (entry: Reaped): string =>
  `released attempt ${entry.attempt} of task ${entry.key} ${String(entry.expiredForMs)} ms after its lease expired${entry.parked ? `, and parked the task after ${String(caps.lost)} lost attempts in a row` : ''}`;

export function reaper({ everyMs, leaseMs }: ReaperSettings): Loop {
  let postgresStarted: string | undefined;
  return {
    name: 'reaper',
    everyMs,
    resume: async (db, now) => {
      const freshened = await freshenLeases(db, now, leaseMs);
      return [`gave ${String(freshened)} live attempts a lease of at least ${String(leaseMs)} ms from ${now.toISOString()} before its next pass`];
    },
    pass: (db, { now, late }) =>
      db.transaction().execute(async tx => {
        const { rows } = await sql<{ started: string }>`select pg_postmaster_start_time()::text as started`.execute(tx);
        const started = rows[0]?.started;
        const before = postgresStarted;
        postgresStarted = started;
        if (before !== undefined && started !== before) throw new Error(`Postgres restarted at ${started ?? 'an unknown time'} since the last pass, so the pass released nothing.`);
        const reaped = await reap(tx, now);
        if (late()) throw new Error(`Postgres answered more than ${String(everyMs)} ms after the pass began, so the pass rolled back rather than release attempts that could not renew while Postgres was away.`);
        return reaped.map(released);
      }),
  };
}
