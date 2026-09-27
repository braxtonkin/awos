import { z } from 'zod';
import type { Earlier } from '../../shared/agent-step.ts';
import type { Database } from '../../shared/db/client.ts';

const evidenceBody = z.record(z.string(), z.unknown());

export async function earlierOf(db: Database, task: string): Promise<readonly Earlier[]> {
  const rows = await db
    .selectFrom('attempt')
    .leftJoin('evidence', 'evidence.attempt_id', 'attempt.id')
    .select(['attempt.step', 'attempt.verdict', 'attempt.output', 'evidence.body'])
    .where('attempt.task_id', '=', task)
    .where('attempt.finished_at', 'is not', null)
    .orderBy('attempt.id')
    .execute();
  return rows.flatMap(row => {
    if (row.verdict === null) return [];
    const evidence = evidenceBody.safeParse(row.body);
    return [{ step: row.step, verdict: row.verdict, output: row.output, evidence: evidence.success ? evidence.data : null }];
  });
}
