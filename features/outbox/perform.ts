import { randomUUID } from 'node:crypto';
import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import { marker, type Limits, type Owed, type Performer, type Refusal } from '../../shared/actions.ts';
import type { Database } from '../../shared/db/client.ts';
import type { DB, OutboxState } from '../../shared/db/types.ts';
import type { Clock, Loop } from '../../shared/loop.ts';

export type Guards = {
  readonly ClaimIsExclusive: boolean;
  readonly MarkerCheckedBeforeWrite: boolean;
  readonly LeaseExpires: boolean;
  readonly InOrderPerTask: boolean;
  readonly DoneFollowsEffect: boolean;
  readonly EffectWithinLease: boolean;
  readonly FailedCallKeepsClaim: boolean;
  readonly RetriesAreCapped: boolean;
  readonly RetryReowesFailedRows: boolean;
};

export const guarded: Guards = {
  ClaimIsExclusive: true,
  MarkerCheckedBeforeWrite: true,
  LeaseExpires: true,
  InOrderPerTask: true,
  DoneFollowsEffect: true,
  EffectWithinLease: true,
  FailedCallKeepsClaim: true,
  RetriesAreCapped: true,
  RetryReowesFailedRows: true,
};

export type Lease = { readonly leaseMs: number; readonly marginMs: number; readonly maxTries: number };

export type Registry = ReadonlyMap<string, Performer>;

export const registryOf = (performers: Readonly<Record<string, Performer>>): Registry => new Map(Object.values(performers).map(performer => [performer.kind, performer]));

export type Claimed = Owed<unknown> & { readonly claim: string; readonly leaseUntil: Date };

export type Claim = { readonly claimed: Claimed | undefined; readonly dropped: number };

export type Lapsed = { readonly row: string; readonly kind: string; readonly task: string; readonly tries: number; readonly state: OutboxState };

export type Performed = 'done' | 'found' | 'refused' | 'failed' | 'released' | 'abandoned' | 'lost';

type Rows = ExpressionBuilder<DB, 'outbox' | 'task'>;

const unsettled: readonly OutboxState[] = ['owed', 'failed'];

const noLease = 'The lease ran out before the action was marked done.';

const later = (now: Date, ms: number): Date => new Date(now.getTime() + ms);

const standing = (registry: Registry) => (eb: Rows) =>
  eb.and([
    eb('task.state', '!=', 'stopped'),
    ...[...registry.values()].flatMap(performer => (performer.stands === null ? [] : [eb.or([eb('outbox.kind', '!=', performer.kind), performer.stands(eb)])])),
  ]);

function claimable(guards: Guards, eb: Rows): Expression<SqlBool> {
  const reowed = eb.and([eb('outbox.state', '=', 'failed'), eb('task.state', '=', 'ready')]);
  const earlier = eb
    .selectFrom('outbox as earlier')
    .select('earlier.id')
    .whereRef('earlier.task_id', '=', 'outbox.task_id')
    .whereRef('earlier.position', '<', 'outbox.position')
    .where('earlier.state', 'in', unsettled);
  return eb.and([
    guards.RetryReowesFailedRows ? eb.or([eb('outbox.state', '=', 'owed'), reowed]) : eb('outbox.state', '=', 'owed'),
    ...(guards.ClaimIsExclusive ? [eb('outbox.claim', 'is', null)] : []),
    ...(guards.InOrderPerTask ? [eb.not(eb.exists(earlier))] : []),
  ]);
}

export async function claimNext(db: Database, guards: Guards, registry: Registry, now: Date, lease: Lease): Promise<Claim> {
  if (registry.size === 0) return { claimed: undefined, dropped: 0 };
  const claim = randomUUID();
  const stands = standing(registry);
  const row = await db
    .with('dropped', query =>
      query
        .updateTable('outbox')
        .from('task')
        .set({ state: 'dropped', settled_at: now })
        .whereRef('task.id', '=', 'outbox.task_id')
        .where('outbox.state', '=', 'owed')
        .where('outbox.claim', 'is', null)
        .where(eb => eb.not(stands(eb)))
        .returning(['outbox.id', 'outbox.task_id', 'outbox.position']),
    )
    .with('behind', query =>
      query
        .updateTable('outbox')
        .from('dropped')
        .innerJoin('task', 'task.id', 'dropped.task_id')
        .set({ state: 'dropped', settled_at: now })
        .whereRef('outbox.task_id', '=', 'dropped.task_id')
        .whereRef('outbox.position', '>', 'dropped.position')
        .where('outbox.state', '=', 'owed')
        .where('outbox.claim', 'is', null)
        .where(stands)
        .returning('outbox.id'),
    )
    .with('candidate', query =>
      query
        .selectFrom('outbox')
        .innerJoin('task', 'task.id', 'outbox.task_id')
        .select('outbox.id')
        .where('outbox.kind', 'in', [...registry.keys()])
        .where(eb => claimable(guards, eb))
        .where(stands)
        .orderBy('outbox.owed_at')
        .orderBy('outbox.id')
        .limit(1)
        .forUpdate('outbox')
        .skipLocked(),
    )
    .with('claimed', query =>
      query
        .updateTable('outbox')
        .from('candidate')
        .set(eb => ({
          state: 'owed',
          claim,
          lease_until: later(now, lease.leaseMs),
          tries: eb.case().when('outbox.state', '=', 'failed').then(0).else(eb.ref('outbox.tries')).end(),
          last_error: null,
          settled_at: null,
        }))
        .whereRef('outbox.id', '=', 'candidate.id')
        .returning(['outbox.id', 'outbox.task_id', 'outbox.kind', 'outbox.payload', 'outbox.idempotency_key', 'outbox.acts_as', 'outbox.lease_until']),
    )
    .selectFrom(eb => eb.selectFrom('dropped').select(eb.fn.countAll<string>().as('count')).as('dropped'))
    .innerJoin(eb => eb.selectFrom('behind').select(eb.fn.countAll<string>().as('count')).as('behind'), join => join.onTrue())
    .leftJoin('claimed', join => join.onTrue())
    .select(['dropped.count as dropped', 'behind.count as behind', 'claimed.id', 'claimed.task_id', 'claimed.kind', 'claimed.payload', 'claimed.idempotency_key', 'claimed.acts_as', 'claimed.lease_until'])
    .executeTakeFirstOrThrow();
  const { id, task_id, kind, payload, idempotency_key, acts_as, lease_until } = row;
  const claimed =
    id === null || task_id === null || kind === null || idempotency_key === null || acts_as === null || lease_until === null
      ? undefined
      : { row: id, task: task_id, kind, payload, marker: marker.parse(idempotency_key), actsAs: acts_as, claim, leaseUntil: lease_until };
  if (claimed !== undefined && !guards.DoneFollowsEffect) await settle(db, claimed, 'done', {}, now);
  return { claimed, dropped: Number(row.dropped) + Number(row.behind) };
}

const lapse = (guards: Guards, lease: Lease, now: Date, error: string | null) => {
  const fails = guards.RetriesAreCapped ? sql<boolean>`outbox.tries + 1 >= ${lease.maxTries}::int` : sql<boolean>`false`;
  return {
    claim: null,
    lease_until: null,
    tries: sql<number>`least(outbox.tries + 1, ${lease.maxTries}::int)`,
    state: sql<OutboxState>`case when ${fails} then 'failed'::outbox_state else 'owed'::outbox_state end`,
    settled_at: sql<Date | null>`case when ${fails} then ${now}::timestamptz end`,
    last_error: error === null ? sql<string>`coalesce(outbox.last_error, ${noLease}::text)` : sql<string>`${error}::text`,
  };
};

export async function expire(db: Database, guards: Guards, now: Date, lease: Lease): Promise<readonly Lapsed[]> {
  if (!guards.LeaseExpires) return [];
  const rows = await db
    .with('lapsed', query =>
      query
        .selectFrom('outbox')
        .select('outbox.id')
        .where('outbox.state', '=', 'owed')
        .where('outbox.claim', 'is not', null)
        .where('outbox.lease_until', '<=', now)
        .orderBy('outbox.id')
        .forUpdate()
        .skipLocked(),
    )
    .updateTable('outbox')
    .from('lapsed')
    .set(lapse(guards, lease, now, null))
    .whereRef('outbox.id', '=', 'lapsed.id')
    .returning(['outbox.id', 'outbox.kind', 'outbox.task_id', 'outbox.tries', 'outbox.state'])
    .execute();
  return rows.map(row => ({ row: row.id, kind: row.kind, task: row.task_id, tries: row.tries, state: row.state }));
}

async function settle(db: Database, claimed: Claimed, state: 'done' | 'refused', result: unknown, now: Date): Promise<boolean> {
  const { numUpdatedRows } = await db
    .updateTable('outbox')
    .set({ state, result: JSON.stringify(result), settled_at: now, claim: null, lease_until: null })
    .where('outbox.id', '=', claimed.row)
    .where('outbox.claim', '=', claimed.claim)
    .where('outbox.state', '=', 'owed')
    .executeTakeFirst();
  return numUpdatedRows === 1n;
}

async function refuse(db: Database, claimed: Claimed, refusal: Refusal, now: Date): Promise<boolean> {
  const rows = await db
    .with('refused', query =>
      query
        .updateTable('outbox')
        .set({ state: 'refused', result: JSON.stringify({ refused: refusal }), settled_at: now, claim: null, lease_until: null })
        .where('outbox.id', '=', claimed.row)
        .where('outbox.claim', '=', claimed.claim)
        .where('outbox.state', '=', 'owed')
        .returning(['outbox.task_id', 'outbox.position']),
    )
    .with('behind', query =>
      query
        .updateTable('outbox')
        .from('refused')
        .set({ state: 'dropped', settled_at: now, claim: null, lease_until: null })
        .whereRef('outbox.task_id', '=', 'refused.task_id')
        .whereRef('outbox.position', '>', 'refused.position')
        .where('outbox.state', 'in', unsettled)
        .returning('outbox.id'),
    )
    .selectFrom('refused')
    .select('refused.task_id')
    .execute();
  return rows.length === 1;
}

async function recordFailure(db: Database, guards: Guards, claimed: Claimed, error: string, now: Date, lease: Lease): Promise<Performed> {
  const { numUpdatedRows } = guards.FailedCallKeepsClaim
    ? await db.updateTable('outbox').set({ last_error: error }).where('outbox.id', '=', claimed.row).where('outbox.claim', '=', claimed.claim).executeTakeFirst()
    : await db.updateTable('outbox').set(lapse(guards, lease, now, error)).where('outbox.id', '=', claimed.row).where('outbox.claim', '=', claimed.claim).executeTakeFirst();
  if (numUpdatedRows !== 1n) return 'lost';
  return guards.FailedCallKeepsClaim ? 'failed' : 'released';
}

const neverAborts = new AbortController().signal;

const farFuture = new Date(8.64e15);

function limitsWithin(guards: Guards, claimed: Claimed, now: Date, lease: Lease): Limits | undefined {
  if (!guards.EffectWithinLease) return { deadline: farFuture, signal: neverAborts };
  const deadline = new Date(claimed.leaseUntil.getTime() - lease.marginMs);
  const left = deadline.getTime() - now.getTime();
  return left > 0 ? { deadline, signal: AbortSignal.timeout(left) } : undefined;
}

export async function performClaimed(db: Database, guards: Guards, performer: Performer, claimed: Claimed, clock: Clock, lease: Lease): Promise<Performed> {
  const checking = limitsWithin(guards, claimed, clock.now(), lease);
  if (checking === undefined) return 'abandoned';
  if (guards.MarkerCheckedBeforeWrite && performer.find !== null) {
    const lookup = await performer.find(claimed, checking);
    if ('failed' in lookup) return recordFailure(db, guards, claimed, lookup.failed, clock.now(), lease);
    if ('found' in lookup) return (await settle(db, claimed, 'done', lookup.found, clock.now())) ? 'found' : 'lost';
  }
  const limits = limitsWithin(guards, claimed, clock.now(), lease);
  if (limits === undefined) return 'abandoned';
  const outcome = await performer.call(claimed, limits);
  if ('failed' in outcome) return recordFailure(db, guards, claimed, outcome.failed, clock.now(), lease);
  if ('refused' in outcome) return (await refuse(db, claimed, outcome.refused, clock.now())) ? 'refused' : 'lost';
  return (await settle(db, claimed, 'done', outcome.done, clock.now())) ? 'done' : 'lost';
}

export type OutboxSettings = Lease & { readonly everyMs: number; readonly clock: Clock; readonly registry: Registry };

const lapsedLine = (entry: Lapsed): string =>
  entry.state === 'failed'
    ? `row ${entry.row} (${entry.kind}) of task ${entry.task} failed after ${String(entry.tries)} tries, and its task waits for a person if it was ready`
    : `the lease on row ${entry.row} (${entry.kind}) of task ${entry.task} ran out, which counts as try ${String(entry.tries)}`;

export function outbox({ everyMs, clock, registry, ...lease }: OutboxSettings, guards: Guards = guarded): Loop {
  if (lease.marginMs >= lease.leaseMs) throw new Error(`The outbox's call margin of ${String(lease.marginMs)} ms must be shorter than its lease of ${String(lease.leaseMs)} ms, or no call would have time to run.`);
  return {
    name: 'outbox',
    everyMs,
    pass: async (db, { late }) => {
      const lines = (await expire(db, guards, clock.now(), lease)).map(lapsedLine);
      while (!late()) {
        const { claimed, dropped } = await claimNext(db, guards, registry, clock.now(), lease);
        if (dropped > 0) lines.push(`dropped ${String(dropped)} rows, because their tasks no longer stand where the rows were owed`);
        if (claimed === undefined) {
          if (dropped === 0) break;
          continue;
        }
        const performer = registry.get(claimed.kind);
        if (performer === undefined) throw new Error(`Row ${claimed.row} was claimed for ${claimed.kind}, which no connector registers.`);
        const performed = await performClaimed(db, guards, performer, claimed, clock, lease);
        lines.push(`row ${claimed.row} (${claimed.kind}) of task ${claimed.task}: ${performed}`);
      }
      return lines;
    },
  };
}

export const outboxLoops = (settings: OutboxSettings): readonly Loop[] => (settings.registry.size === 0 ? [] : [outbox(settings)]);
