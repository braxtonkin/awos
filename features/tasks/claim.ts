import { sql, type ExpressionBuilder } from 'kysely';
import { owesAction } from '../../shared/actions.ts';
import { refusal, type Database, type Refusal } from '../../shared/db/client.ts';
import type { DB, TaskState } from '../../shared/db/types.ts';
import type { Instruction, StepKind } from '../../shared/workflow.ts';
import { nobodyToRunAs } from './run-as.ts';
import type { Workflows } from './start.ts';

export const caps = { lost: 3, stageRetries: 2, inputWaits: 3 } as const;

export const lostTooOften: Instruction = `Its last ${String(caps.lost)} attempts were lost before they finished. Read their logs on this page, fix what stopped them, then press Retry to run this step again.`;

export type Claim =
  | { readonly attempt: string }
  | { readonly refused: 'busy' | 'not-ready' }
  | { readonly refused: 'nobody-to-run-as'; readonly parked: boolean };

type Refused = Extract<Claim, { readonly refused: string }>['refused'];

export type Reaped = { readonly attempt: string; readonly task: string; readonly key: string; readonly expiredForMs: number; readonly parked: boolean };

const claimRefusals: readonly { readonly refused: Refused; readonly is: (refusal: Refusal) => boolean }[] = [
  { refused: 'nobody-to-run-as', is: found => found.kind === 'not_null' && found.table === 'attempt' && found.column === 'run_as_id' },
  { refused: 'busy', is: found => found.kind === 'unique' && found.name === 'one_live_attempt_per_task' },
  { refused: 'not-ready', is: found => found.kind === 'foreign_key' && found.name === 'live_attempt_matches_ready_task' },
];

const later = (now: Date, ms: number): Date => new Date(now.getTime() + ms);

const hasLiveAttempt = (eb: ExpressionBuilder<DB, 'task'>) =>
  eb.exists(eb.selectFrom('attempt').select('attempt.id').whereRef('attempt.task_id', '=', 'task.id').where('attempt.finished_at', 'is', null));

export type Start = { readonly commit: string };

export async function claim(db: Database, task: string, now: Date, leaseMs: number, runAs: string | null, start: Start | null): Promise<Claim> {
  try {
    const inserted = await db
      .insertInto('attempt')
      .columns(['task_id', 'routine_id', 'routine_version', 'step', 'epoch', 'run_as_id', 'started_at', 'lease_until', 'branch', 'start_commit'])
      .expression(
        db
          .selectFrom('task')
          .select(eb => [
            'task.id',
            'task.routine_id',
            eb
              .selectFrom('routine_version')
              .select(version => version.fn.max('routine_version.version').as('newest'))
              .whereRef('routine_version.routine_id', '=', 'task.routine_id')
              .whereRef('routine_version.workflow', '=', 'task.workflow')
              .as('routine_version'),
            'task.step',
            'task.epoch',
            eb.cast<string | null>(eb.val(runAs), 'bigint').as('run_as_id'),
            eb.cast<Date>(eb.val(now), 'timestamptz').as('started_at'),
            eb.cast<Date>(eb.val(later(now, leaseMs)), 'timestamptz').as('lease_until'),
            (start === null
              ? sql<string | null>`null::text`
              : sql<string>`'autoworker/' || task.key || '-attempt-' || (select count(*) + 1 from attempt where attempt.task_id = task.id)`
            ).as('branch'),
            eb.cast<string | null>(eb.val(start?.commit ?? null), 'text').as('start_commit'),
          ])
          .where('task.id', '=', task),
      )
      .returning('id')
      .executeTakeFirst();
    if (inserted === undefined) throw new Error(`task ${task} does not exist`);
    return { attempt: inserted.id };
  } catch (error) {
    const found = refusal(error);
    const refused = found === undefined ? undefined : claimRefusals.find(entry => entry.is(found))?.refused;
    if (refused === undefined) throw error;
    return refused === 'nobody-to-run-as' ? { refused, parked: await parkForPerson(db, task) } : { refused };
  }
}

async function parkForPerson(db: Database, task: string): Promise<boolean> {
  try {
    const { numUpdatedRows } = await db
      .updateTable('task')
      .set({ state: 'waiting', waiting_on: 'retry', waiting_reason: nobodyToRunAs })
      .where('task.id', '=', task)
      .where('task.state', '=', 'ready')
      .where(eb => eb.not(hasLiveAttempt(eb)))
      .executeTakeFirst();
    return numUpdatedRows === 1n;
  } catch (error) {
    const found = refusal(error);
    if (found?.kind === 'foreign_key' && found.name === 'live_attempt_matches_ready_task') return false;
    throw error;
  }
}

export async function renew(db: Database, attempt: string, now: Date, leaseMs: number): Promise<'renewed' | 'lost'> {
  const { numUpdatedRows } = await db
    .updateTable('attempt')
    .set({ lease_until: later(now, leaseMs) })
    .where('id', '=', attempt)
    .where('finished_at', 'is', null)
    .executeTakeFirst();
  return numUpdatedRows === 1n ? 'renewed' : 'lost';
}

export async function reap(db: Database, now: Date): Promise<readonly Reaped[]> {
  const rows = await db
    .with('reaped', query =>
      query
        .updateTable('attempt')
        .set({ finished_at: now, verdict: 'lost' })
        .where('finished_at', 'is', null)
        .where('lease_until', '<', now)
        .returning(['id', 'task_id', 'lease_until']),
    )
    .with('counted', query =>
      query
        .updateTable('task')
        .from('reaped')
        .set(eb => {
          const parks = eb(eb('task.lost', '+', 1), '>=', caps.lost);
          return {
            lost: eb('task.lost', '+', 1),
            state: eb.case().when(parks).then<TaskState>('waiting').elseRef('task.state').end(),
            waiting_on: eb.case().when(parks).then(eb.val('retry' as const)).elseRef('task.waiting_on').end(),
            waiting_reason: eb.case().when(parks).then(lostTooOften).elseRef('task.waiting_reason').end(),
          };
        })
        .whereRef('task.id', '=', 'reaped.task_id')
        .returning(['task.id', 'task.key', 'task.state']),
    )
    .selectFrom('reaped')
    .innerJoin('counted', 'counted.id', 'reaped.task_id')
    .select(['reaped.id', 'reaped.lease_until', 'counted.id as task', 'counted.key', 'counted.state'])
    .orderBy('reaped.id')
    .execute();
  return rows.map(row => ({ attempt: row.id, task: row.task, key: row.key, expiredForMs: now.getTime() - row.lease_until.getTime(), parked: row.state === 'waiting' }));
}

export type RunBy = StepKind['runBy'];

export async function claimable(db: Database, workflows: Workflows, runBy: readonly RunBy[] = ['agent', 'engine']): Promise<readonly string[]> {
  const pairs = [...workflows.values()].flatMap(workflow => workflow.steps.filter(kind => runBy.includes(kind.runBy)).map(kind => [workflow.name, kind.name] as const));
  if (pairs.length === 0) return [];
  const rows = await db
    .selectFrom('task')
    .select('task.id')
    .where('task.state', '=', 'ready')
    .where(eb => eb.or(pairs.map(([workflow, step]) => eb.and([eb('task.workflow', '=', workflow), eb('task.step', '=', step)]))))
    .where(eb => eb.not(owesAction(eb)))
    .where(eb => eb.not(hasLiveAttempt(eb)))
    .orderBy('task.id')
    .execute();
  return rows.map(row => row.id);
}
