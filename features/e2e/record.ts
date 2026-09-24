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

export type AttemptBranch = { readonly attempt: string; readonly branch: string; readonly startCommit: string; readonly pushed: readonly string[] };

export type EvidenceRow = { readonly attempt: string; readonly body: unknown; readonly recordedAt: Date };

export class WaitsForP3 extends Error {
  override readonly name = 'WaitsForP3';
}

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

export const attemptBranches: (db: Database, task: string) => Promise<readonly AttemptBranch[]> = () =>
  Promise.reject(new WaitsForP3("attemptBranches reads each attempt's branch, start commit, and pushed commits from the columns P3 adds to attempt. P7 writes it once P3 lands."));

export const evidenceRows: (db: Database, task: string) => Promise<readonly EvidenceRow[]> = () =>
  Promise.reject(new WaitsForP3("evidenceRows reads Verify's evidence from the table P3 adds. P7 writes it once P3 lands."));
