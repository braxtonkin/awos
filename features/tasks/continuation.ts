import { sql } from 'kysely';
import { actionKinds } from '../../shared/actions.ts';
import type { Database } from '../../shared/db/client.ts';

export type Continuation =
  | { readonly from: 'lost'; readonly commit: string }
  | { readonly from: 'task'; readonly commit: string }
  | { readonly from: 'repository'; readonly github: string; readonly branch: string }
  | { readonly from: 'nowhere' };

export const taskBranch = (key: string): string => `autoworker/${key}`;

export async function taskBranchHead(db: Database, task: string): Promise<string | null> {
  const row = await db
    .selectFrom('outbox')
    .select(sql<string>`outbox.payload ->> 'to'`.as('head'))
    .where('outbox.task_id', '=', task)
    .where('outbox.kind', '=', actionKinds.branchAdvance.kind)
    .where('outbox.state', '=', 'done')
    .orderBy('outbox.position', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.head ?? null;
}

export async function continuation(db: Database, task: string): Promise<Continuation> {
  const row = await db
    .selectFrom('task')
    .leftJoin('repository', 'repository.id', 'task.repository_id')
    .select(['task.id', 'task.step', 'repository.github', 'repository.branch'])
    .where('task.id', '=', task)
    .executeTakeFirst();
  if (row === undefined) return { from: 'nowhere' };
  const previous = await db
    .selectFrom('attempt')
    .select(['attempt.id', 'attempt.verdict', 'attempt.last_pushed'])
    .where('attempt.task_id', '=', task)
    .where('attempt.step', '=', row.step)
    .orderBy('attempt.id', 'desc')
    .execute();
  const kept = previous.findIndex(attempt => attempt.verdict !== 'lost' && attempt.verdict !== 'not_launched');
  const pushed = (kept < 0 ? previous : previous.slice(0, kept)).find(attempt => attempt.last_pushed !== null);
  if (pushed?.last_pushed != null) return { from: 'lost', commit: pushed.last_pushed };
  const head = await taskBranchHead(db, task);
  if (head !== null) return { from: 'task', commit: head };
  if (row.github === null || row.branch === null) return { from: 'nowhere' };
  return { from: 'repository', github: row.github, branch: row.branch };
}
