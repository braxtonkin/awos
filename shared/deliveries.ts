import type { Database } from './db/client.ts';
import type { AttemptCommandKind } from './db/types.ts';

export type DeliveryState = 'sent' | 'received' | 'acted on';

export type Delivery = {
  readonly seq: number;
  readonly kind: AttemptCommandKind;
  readonly action: string | null;
  readonly state: DeliveryState;
  readonly sentAt: Date;
  readonly receivedAt: Date | null;
  readonly actedAt: Date | null;
};

export async function deliveries(db: Database, attempt: string): Promise<readonly Delivery[]> {
  const rows = await db
    .selectFrom('attempt_command')
    .select(['seq', 'kind', 'action_id', 'sent_at', 'received_at', 'acted_at'])
    .where('attempt_id', '=', attempt)
    .orderBy('seq')
    .execute();
  return rows.map(row => ({
    seq: Number(row.seq),
    kind: row.kind,
    action: row.action_id,
    state: row.acted_at !== null ? 'acted on' : row.received_at !== null ? 'received' : 'sent',
    sentAt: row.sent_at,
    receivedAt: row.received_at,
    actedAt: row.acted_at,
  }));
}
