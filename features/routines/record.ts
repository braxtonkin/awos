import { sql } from 'kysely';
import { refusal, type Database } from '../../shared/db/client.ts';
import type { Claimed, WorkItem } from './source.ts';

export type Search = { readonly found: readonly WorkItem[] } | { readonly failed: string };

export type Recorded =
  | { readonly outcome: 'done'; readonly found: number; readonly added: number; readonly refreshed: number; readonly overlaps: number }
  | { readonly outcome: 'failed'; readonly note: string }
  | { readonly outcome: 'paused' }
  | { readonly outcome: 'refused'; readonly because: string };

const finishRefusals: Readonly<Record<string, string>> = {
  run_finishes_under_its_claim: 'another engine claimed the run after its lease lapsed',
  run_finishes_within_its_lease: 'its lease lapsed before it finished',
  finished_run_is_final: 'another engine closed the run after its lease lapsed',
};

class Refused extends Error {}

const unique = (items: readonly WorkItem[]): readonly WorkItem[] => [...new Map(items.map(item => [item.key, item])).values()];

async function recordTasks(tx: Database, run: Claimed, items: readonly WorkItem[], firstStep: string, now: Date): Promise<Omit<Extract<Recorded, { outcome: 'done' }>, 'outcome' | 'found'>> {
  if (items.length === 0) return { added: 0, refreshed: 0, overlaps: 0 };
  const written = await tx
    .insertInto('task')
    .values(
      items.map(item => ({
        routine_id: run.routine,
        found_version: run.version,
        repository_id: run.needsRepository ? run.repository : null,
        key: item.key,
        title: item.title,
        found_at: now,
        assignee_account_id: item.assignee,
        workflow: run.workflow,
        needs_repository: run.needsRepository,
        step: firstStep,
      })),
    )
    .onConflict(conflict =>
      conflict.constraint('one_task_per_key').doUpdateSet(eb => ({ routine_id: eb.ref('excluded.routine_id'), assignee_account_id: eb.ref('excluded.assignee_account_id') })),
    )
    .returning(['key', sql<boolean>`xmax = 0`.as('added')])
    .execute();
  const recorded = new Set(written.map(row => row.key));
  const others = items.map(item => item.key).filter(key => !recorded.has(key));
  if (others.length > 0) {
    await tx
      .insertInto('routine_overlap')
      .columns(['task_id', 'routine_id', 'run_id'])
      .expression(eb => eb.selectFrom('task').select(inner => ['task.id', inner.cast<string>(inner.val(run.routine), 'bigint').as('routine_id'), inner.cast<string>(inner.val(run.run), 'bigint').as('run_id')]).where('task.key', 'in', others))
      .onConflict(conflict => conflict.doNothing())
      .execute();
  }
  const added = written.filter(row => row.added).length;
  return { added, refreshed: written.length - added, overlaps: others.length };
}

export async function record(db: Database, run: Claimed, search: Search, firstStep: string, now: Date): Promise<Recorded> {
  try {
    return await db.transaction().execute(async tx => {
      const routine = await tx.selectFrom('routine').select('paused_by').where('id', '=', run.routine).forShare().executeTakeFirstOrThrow();
      const items = 'found' in search ? unique(search.found) : [];
      const outcome = 'failed' in search ? 'failed' : routine.paused_by === null ? 'done' : 'paused';
      try {
        await tx
          .updateTable('routine_run')
          .set({ finished_at: now, finished_by: run.claim, outcome, found: items.length, note: 'failed' in search ? search.failed : null })
          .where('id', '=', run.run)
          .execute();
      } catch (error) {
        const found = refusal(error);
        const because = found === undefined || found.kind === 'not_null' ? undefined : finishRefusals[found.name];
        if (because === undefined) throw error;
        throw new Refused(because);
      }
      if ('failed' in search) return { outcome: 'failed', note: search.failed };
      if (outcome === 'paused') return { outcome: 'paused' };
      return { outcome: 'done', found: items.length, ...(await recordTasks(tx, run, items, firstStep, now)) };
    });
  } catch (error) {
    if (error instanceof Refused) return { outcome: 'refused', because: error.message };
    throw error;
  }
}
