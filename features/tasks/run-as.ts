import type { Database } from '../../shared/db/client.ts';
import type { Instruction } from '../../shared/workflow.ts';

export type RunAsRule = (db: Database, task: string) => Promise<string | null>;

export type ReadAssignee = (ticket: string, actsAs: string) => Promise<string | null>;

export const nobodyToRunAs: Instruction = "Nobody to run this task as. Assign the ticket to someone who has connected a login, or set the routine's run-as person, then press Retry.";

export const coreRunAs =
  (readAssignee: ReadAssignee | null): RunAsRule =>
  async (db, task) => {
    const row = await db
      .selectFrom('task')
      .innerJoin('routine', 'routine.id', 'task.routine_id')
      .select(['task.key', 'task.assignee_account_id', 'routine.run_as_id', 'routine.creator_id'])
      .where('task.id', '=', task)
      .executeTakeFirst();
    if (row === undefined) return null;
    if (row.run_as_id !== null) return row.run_as_id;
    const account = readAssignee === null ? row.assignee_account_id : await readAssignee(row.key, row.creator_id);
    if (account === null) return null;
    const person = await db.selectFrom('person').select('person.id').where('person.jira_account_id', '=', account).executeTakeFirst();
    return person?.id ?? null;
  };
