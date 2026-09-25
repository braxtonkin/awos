import type { V1ObjectMeta } from '@kubernetes/client-node';
import type { Database } from '../../shared/db/client.ts';
import type { Loop } from '../../shared/loop.ts';
import { labels, type Cluster } from '../../shared/cluster.ts';
import { missing } from './launch.ts';

export type SweepSettings = { readonly everyMs: number; readonly cluster: Cluster };

type Labeled = { readonly kind: 'Job' | 'Secret'; readonly name: string; readonly attempt: string; readonly detail: string };

const attemptId = /^[1-9][0-9]{0,18}$/;

const labeled = (kind: Labeled['kind'], metadata: V1ObjectMeta | undefined, detail: string): readonly Labeled[] => {
  const name = metadata?.name;
  return name === undefined ? [] : [{ kind, name, attempt: metadata?.labels?.[labels.attempt] ?? '', detail }];
};

async function why(db: Database, attempts: readonly string[]): Promise<ReadonlyMap<string, string | undefined>> {
  const ids = [...new Set(attempts.filter(id => attemptId.test(id)))];
  const rows = ids.length === 0 ? [] : await db.selectFrom('attempt').select(['id', 'verdict']).where('id', 'in', ids).execute();
  const found = new Map(rows.map(row => [row.id, row.verdict]));
  return new Map(attempts.map(id => [id, found.has(id) ? (found.get(id) === null ? undefined : `finished ${String(found.get(id))}`) : 'has no attempt row']));
}

export async function sweepOnce(db: Database, cluster: Cluster): Promise<readonly string[]> {
  const { namespace } = cluster;
  const labelSelector = labels.attempt;
  const [jobs, secrets] = await Promise.all([cluster.batch.listNamespacedJob({ namespace, labelSelector }), cluster.core.listNamespacedSecret({ namespace, labelSelector })]);
  const found = [
    ...jobs.items.flatMap(job => labeled('Job', job.metadata, `, which ran ${job.spec?.template.spec?.containers[0]?.image ?? 'an unnamed image'}`)),
    ...secrets.items.flatMap(secret => labeled('Secret', secret.metadata, '')),
  ];
  const reasons = await why(
    db,
    found.map(entry => entry.attempt),
  );
  const lines: string[] = [];
  for (const entry of found) {
    const reason = reasons.get(entry.attempt);
    if (reason === undefined) continue;
    try {
      if (entry.kind === 'Job') await cluster.batch.deleteNamespacedJob({ name: entry.name, namespace, propagationPolicy: 'Background' });
      else await cluster.core.deleteNamespacedSecret({ name: entry.name, namespace });
      lines.push(`deleted ${entry.kind} ${entry.name}${entry.detail}, because attempt ${entry.attempt || '(none)'} ${reason}`);
    } catch (error) {
      if (!missing(error)) lines.push(`did not delete ${entry.kind} ${entry.name}, so the next pass tries again: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return lines;
}

export const sweep = ({ everyMs, cluster }: SweepSettings): Loop => ({ name: 'sweep', everyMs, pass: db => sweepOnce(db, cluster) });
