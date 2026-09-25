import { sql } from 'kysely';
import type { Transacting } from '../../shared/transaction.ts';
import type { Instruction } from '../../shared/workflow.ts';

export const resumeToRun: Instruction = 'Resume to run.';

export type RoutineAction = { readonly id: string; readonly person: string; readonly at: Date };

export type Pressed = 'pressed' | 'already-waiting' | { readonly refused: Instruction };

const pausedBy = (tx: Transacting, routine: string): Promise<string | null> =>
  tx
    .selectFrom('routine')
    .select('paused_by')
    .where('id', '=', routine)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow()
    .then(found => found.paused_by);

export async function pauseWithin(tx: Transacting, routine: string, action: RoutineAction): Promise<'paused' | 'already-paused'> {
  if ((await pausedBy(tx, routine)) !== null) return 'already-paused';
  await tx.insertInto('human_action').values({ id: action.id, at: action.at, person_id: action.person, kind: 'pause_routine', routine_id: routine }).execute();
  await tx.updateTable('routine').set({ paused_by: action.id }).where('id', '=', routine).execute();
  return 'paused';
}

export async function resumeWithin(tx: Transacting, routine: string, action: RoutineAction): Promise<'resumed' | 'not-paused'> {
  if ((await pausedBy(tx, routine)) === null) return 'not-paused';
  await tx.updateTable('routine').set({ paused_by: null }).where('id', '=', routine).execute();
  await tx.insertInto('human_action').values({ id: action.id, at: action.at, person_id: action.person, kind: 'resume_routine', routine_id: routine }).execute();
  return 'resumed';
}

export async function runNowWithin(tx: Transacting, routine: string, action: RoutineAction): Promise<Pressed> {
  if ((await pausedBy(tx, routine)) !== null) return { refused: resumeToRun };
  const recorded = await tx
    .with('pressed', query =>
      query
        .insertInto('routine_run')
        .columns(['routine_id', 'version', 'reason', 'pressed_by'])
        .expression(eb =>
          eb
            .selectFrom('routine_version')
            .select(inner => [
              inner.cast<string>(inner.val(routine), 'bigint').as('routine_id'),
              inner.fn.max('version').as('version'),
              sql<'run_now'>`'run_now'::run_reason`.as('reason'),
              inner.cast<string>(inner.val(action.id), 'uuid').as('pressed_by'),
            ])
            .where('routine_id', '=', routine),
        )
        .onConflict(conflict => conflict.doNothing())
        .returning('pressed_by'),
    )
    .insertInto('human_action')
    .columns(['id', 'at', 'person_id', 'kind', 'routine_id'])
    .expression(eb =>
      eb
        .selectFrom('pressed')
        .select(inner => [
          inner.cast<string>(inner.val(action.id), 'uuid').as('id'),
          inner.cast<Date>(inner.val(action.at), 'timestamptz').as('at'),
          inner.cast<string>(inner.val(action.person), 'bigint').as('person_id'),
          sql<'run_now'>`'run_now'::human_action_kind`.as('kind'),
          inner.cast<string>(inner.val(routine), 'bigint').as('routine_id'),
        ]),
    )
    .returning('id')
    .executeTakeFirst();
  return recorded === undefined ? 'already-waiting' : 'pressed';
}
