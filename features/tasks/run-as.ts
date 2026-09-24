import type { AliasableExpression, ExpressionBuilder } from 'kysely';
import type { DB } from '../../shared/db/types.ts';
import type { Instruction } from '../../shared/workflow.ts';

export type RunAsRule = (eb: ExpressionBuilder<DB, 'task'>) => AliasableExpression<string | null>;

export const runAs: RunAsRule = eb =>
  eb.fn.coalesce(
    eb.selectFrom('routine').select('routine.run_as_id').whereRef('routine.id', '=', 'task.routine_id').$asScalar(),
    eb.selectFrom('person').select('person.id').whereRef('person.jira_account_id', '=', 'task.assignee_account_id').$asScalar(),
  );

export const nobodyToRunAs: Instruction = "Nobody to run this task as. Assign the ticket to someone who has connected a login, or set the routine's run-as person, then press Retry.";
