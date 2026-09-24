import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { marker, type Enqueue, type Marker } from '../../shared/actions.ts';
import { refusal } from '../../shared/db/client.ts';

const newMarker = (): Marker => marker.parse(randomBytes(18).toString('base64url'));

export const enqueue: Enqueue = async (tx, { task, actsAs, now }, actions) => {
  if (actions.length === 0) return [];
  const held = await tx.selectFrom('task').select('task.id').where('task.id', '=', task).forUpdate().executeTakeFirst();
  if (held === undefined) throw new Error(`Task ${task} does not exist, so it cannot owe an action.`);
  const { last } = await tx
    .selectFrom('outbox')
    .select(eb => eb.fn.coalesce(eb.fn.max('outbox.position'), sql.lit(0)).as('last'))
    .where('outbox.task_id', '=', task)
    .executeTakeFirstOrThrow();
  try {
    const rows = await tx
      .insertInto('outbox')
      .values(
        actions.map((action, index) => ({
          task_id: task,
          position: last + index + 1,
          kind: action.kind,
          payload: JSON.stringify(action.payload),
          acts_as: actsAs,
          idempotency_key: newMarker(),
          owed_at: now,
        })),
      )
      .returning('outbox.id')
      .execute();
    return rows.map(row => row.id);
  } catch (error) {
    const found = refusal(error);
    if (found?.kind === 'foreign_key' && found.name === 'live_attempt_matches_ready_task') {
      throw new Error(`Task ${task} still has a live attempt, so it cannot owe an action yet. Finish the attempt in the same transaction before owing its actions.`, { cause: error });
    }
    throw error;
  }
};
