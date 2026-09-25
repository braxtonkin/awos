import { sql } from 'kysely';
import type { Database } from '../../shared/db/client.ts';
import type { Verdict } from '../../shared/db/types.ts';

export type TaskRecord = { readonly id: string; readonly key: string; readonly state: string; readonly step: string };

export type AttemptRecord = {
  readonly id: string;
  readonly step: string;
  readonly verdict: Verdict | null;
  readonly runAs: string;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
};

export type AttemptBranch = { readonly attempt: string; readonly branch: string; readonly startCommit: string; readonly lastPushed: string | null };

export type EvidenceRow = { readonly attempt: string; readonly step: string; readonly body: unknown; readonly recordedAt: Date };

export async function taskFor(db: Database, ticket: string): Promise<TaskRecord | undefined> {
  return db.selectFrom('task').select(['id', 'key', 'state', 'step']).where('key', '=', ticket).executeTakeFirst();
}

export async function attemptsInOrder(db: Database, task: string): Promise<readonly AttemptRecord[]> {
  const rows = await db
    .selectFrom('attempt')
    .innerJoin('person', 'person.id', 'attempt.run_as_id')
    .select(['attempt.id', 'attempt.step', 'attempt.verdict', 'person.email', 'attempt.started_at', 'attempt.finished_at'])
    .where('attempt.task_id', '=', task)
    .orderBy('attempt.started_at')
    .orderBy('attempt.id')
    .execute();
  return rows.map(row => ({ id: row.id, step: row.step, verdict: row.verdict, runAs: row.email, startedAt: row.started_at, finishedAt: row.finished_at }));
}

export async function attemptBranches(db: Database, task: string): Promise<readonly AttemptBranch[]> {
  const rows = await db
    .selectFrom('attempt')
    .select(['attempt.id', 'attempt.branch', 'attempt.start_commit', 'attempt.last_pushed'])
    .where('attempt.task_id', '=', task)
    .where('attempt.branch', 'is not', null)
    .orderBy('attempt.id')
    .execute();
  return rows.flatMap(row => (row.branch === null || row.start_commit === null ? [] : [{ attempt: row.id, branch: row.branch, startCommit: row.start_commit, lastPushed: row.last_pushed }]));
}

export async function pullRequestBranches(db: Database, task: string): Promise<readonly string[]> {
  const rows = await db
    .selectFrom('outbox')
    .select(sql<string | null>`outbox.payload ->> 'head'`.as('head'))
    .where('outbox.task_id', '=', task)
    .where('outbox.kind', '=', 'pr.open-draft')
    .orderBy('outbox.position')
    .execute();
  return [...new Set(rows.flatMap(row => (row.head === null ? [] : [row.head])))];
}

export async function evidenceRows(db: Database, task: string): Promise<readonly EvidenceRow[]> {
  const rows = await db
    .selectFrom('evidence')
    .innerJoin('attempt', 'attempt.id', 'evidence.attempt_id')
    .select(['evidence.attempt_id', 'attempt.step', 'evidence.body', 'evidence.recorded_at'])
    .where('evidence.task_id', '=', task)
    .orderBy('evidence.attempt_id')
    .execute();
  return rows.map(row => ({ attempt: row.attempt_id, step: row.step, body: row.body, recordedAt: row.recorded_at }));
}
