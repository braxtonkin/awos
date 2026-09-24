import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Database } from '../../shared/db/client.ts';
import type { Instruction } from '../../shared/workflow.ts';

export const resumeToRun: Instruction = 'Resume to run.';

export type Pressed = 'pressed' | 'already-waiting' | { readonly refused: Instruction };

class Unchanged extends Error {}

async function unlessUnchanged<T>(work: () => Promise<T>, unchanged: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Unchanged) return unchanged;
    throw error;
  }
}

export function pause(db: Database, routine: string, person: string, at: Date): Promise<'paused' | 'already-paused'> {
  return unlessUnchanged(
    () =>
      db.transaction().execute(async tx => {
        const id = randomUUID();
        await tx.insertInto('human_action').values({ id, at, person_id: person, kind: 'pause_routine', routine_id: routine }).execute();
        const { numUpdatedRows } = await tx.updateTable('routine').set({ paused_by: id }).where('id', '=', routine).where('paused_by', 'is', null).executeTakeFirst();
        if (numUpdatedRows === 0n) throw new Unchanged();
        return 'paused' as const;
      }),
    'already-paused',
  );
}

export function resume(db: Database, routine: string, person: string, at: Date): Promise<'resumed' | 'not-paused'> {
  return unlessUnchanged(
    () =>
      db.transaction().execute(async tx => {
        const { numUpdatedRows } = await tx.updateTable('routine').set({ paused_by: null }).where('id', '=', routine).where('paused_by', 'is not', null).executeTakeFirst();
        if (numUpdatedRows === 0n) throw new Unchanged();
        await tx.insertInto('human_action').values({ id: randomUUID(), at, person_id: person, kind: 'resume_routine', routine_id: routine }).execute();
        return 'resumed' as const;
      }),
    'not-paused',
  );
}

export function runNow(db: Database, routine: string, person: string, at: Date): Promise<Pressed> {
  return unlessUnchanged<Pressed>(
    () =>
      db.transaction().execute(async tx => {
        const found = await tx.selectFrom('routine').select('paused_by').where('id', '=', routine).forShare().executeTakeFirstOrThrow();
        if (found.paused_by !== null) return { refused: resumeToRun };
        const id = randomUUID();
        await tx.insertInto('human_action').values({ id, at, person_id: person, kind: 'run_now', routine_id: routine }).execute();
        const pressed = await tx
          .insertInto('routine_run')
          .columns(['routine_id', 'version', 'reason', 'pressed_by'])
          .expression(eb =>
            eb
              .selectFrom('routine_version')
              .select(inner => [inner.cast<string>(inner.val(routine), 'bigint').as('routine_id'), inner.fn.max('version').as('version'), sql<'run_now'>`'run_now'::run_reason`.as('reason'), inner.cast<string>(inner.val(id), 'uuid').as('pressed_by')])
              .where('routine_id', '=', routine),
          )
          .onConflict(conflict => conflict.doNothing())
          .returning('id')
          .executeTakeFirst();
        if (pressed === undefined) throw new Unchanged();
        return 'pressed' as const;
      }),
    'already-waiting',
  );
}
