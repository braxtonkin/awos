import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { refusal, type Database } from '../../shared/db/client.ts';
import type { RunReason } from '../../shared/db/types.ts';
import type { Loop } from '../../shared/loop.ts';
import type { Workflow } from '../../shared/workflow.ts';
import { record, type Recorded, type Search } from './record.ts';
import type { Claimed, Sources } from './source.ts';

type Now = (db: Database) => Promise<Date>;

export type SchedulerSettings = {
  readonly everyMs: number;
  readonly leaseMs: number;
  readonly sources: Sources;
  readonly workflows: ReadonlyMap<string, Workflow>;
  readonly now: Now;
};

type Claim = { readonly run: Claimed | undefined; readonly closed: number };

export const origin = new Date('2000-01-01T00:00:00.000Z');

export const postgresNow: Now = async db => {
  const { rows } = await sql<{ now: Date }>`select clock_timestamp() as now`.execute(db);
  const now = rows[0]?.now;
  if (now === undefined) throw new Error('Postgres did not tell the time');
  return now;
};

const later = (now: Date, ms: number): Date => new Date(now.getTime() + ms);

const isPauseRefusal = (error: unknown): boolean => {
  const found = refusal(error);
  return found?.kind === 'final' && found.name === 'run_claims_an_active_routine';
};

const newest = (db: Database, routine: string) =>
  db
    .selectFrom('routine_version')
    .select(['version', 'every'])
    .where('routine_id', '=', routine)
    .orderBy('version', 'desc')
    .limit(1);

const dueSlot = (now: Date) => sql<Date>`date_bin(due.every, ${now}::timestamptz, ${origin}::timestamptz)`;

async function closeCollapsed(db: Database, routine: string, now: Date): Promise<number> {
  const { numUpdatedRows } = await db
    .with('due', () => newest(db, routine))
    .updateTable('routine_run')
    .from('due')
    .set(eb => ({ finished_at: now, finished_by: eb.ref('routine_run.claim'), outcome: 'lost' as const }))
    .where('routine_run.routine_id', '=', routine)
    .where('routine_run.finished_at', 'is', null)
    .where('routine_run.claim', 'is not', null)
    .where('routine_run.lease_until', '<', now)
    .where('routine_run.slot', '<', dueSlot(now))
    .executeTakeFirst();
  return Number(numUpdatedRows);
}

async function retryExpired(db: Database, routine: string, now: Date, leaseMs: number, claim: string): Promise<string | undefined> {
  const row = await db
    .updateTable('routine_run')
    .set({ claim, claimed_at: now, lease_until: later(now, leaseMs) })
    .where('routine_id', '=', routine)
    .where('finished_at', 'is', null)
    .where('claim', 'is not', null)
    .where('lease_until', '<', now)
    .returning('id')
    .executeTakeFirst();
  return row?.id;
}

async function claimSlot(db: Database, routine: string, now: Date, leaseMs: number, claim: string): Promise<string | undefined> {
  const row = await db
    .with('due', () => newest(db, routine))
    .insertInto('routine_run')
    .columns(['routine_id', 'version', 'reason', 'slot', 'claim', 'claimed_at', 'started_at', 'lease_until', 'covers'])
    .expression(eb =>
      eb
        .selectFrom('due')
        .select(inner => [
          inner.cast<string>(inner.val(routine), 'bigint').as('routine_id'),
          'due.version',
          sql<RunReason>`'schedule'::run_reason`.as('reason'),
          dueSlot(now).as('slot'),
          inner.cast<string>(inner.val(claim), 'uuid').as('claim'),
          inner.cast<Date>(inner.val(now), 'timestamptz').as('claimed_at'),
          inner.cast<Date>(inner.val(now), 'timestamptz').as('started_at'),
          inner.cast<Date>(inner.val(later(now, leaseMs)), 'timestamptz').as('lease_until'),
          sql<number>`coalesce((select greatest(1, round(extract(epoch from ${dueSlot(now)} - max(r.slot)) / extract(epoch from due.every))::int)
            from routine_run r where r.routine_id = ${routine} and r.slot is not null), 1)`.as('covers'),
        ]),
    )
    .onConflict(conflict => conflict.doNothing())
    .returning('id')
    .executeTakeFirst();
  return row?.id;
}

async function claimPress(db: Database, routine: string, now: Date, leaseMs: number, claim: string): Promise<string | undefined> {
  try {
    const row = await db
      .updateTable('routine_run')
      .set({ claim, claimed_at: now, started_at: now, lease_until: later(now, leaseMs) })
      .where('routine_id', '=', routine)
      .where('finished_at', 'is', null)
      .where('claim', 'is', null)
      .returning('id')
      .executeTakeFirst();
    return row?.id;
  } catch (error) {
    const found = refusal(error);
    if (found?.kind === 'unique' && found.name === 'one_live_run_per_routine') return undefined;
    throw error;
  }
}

async function claimed(db: Database, run: string): Promise<Claimed> {
  const row = await db
    .selectFrom('routine_run as run')
    .innerJoin('routine', 'routine.id', 'run.routine_id')
    .innerJoin('routine_version as version', join => join.onRef('version.routine_id', '=', 'run.routine_id').onRef('version.version', '=', 'run.version'))
    .select(eb => [
      'run.id',
      'run.routine_id',
      'run.reason',
      'run.claim',
      'run.version',
      eb.fn.coalesce('run.slot', 'run.started_at').as('occurrence'),
      eb.fn.coalesce('routine.run_as_id', 'routine.creator_id').as('run_as'),
      'version.name',
      'version.source',
      sql<string>`version.source ->> 'kind'`.as('source_kind'),
      'version.workflow',
      'version.needs_repository',
      'version.repository_id',
    ])
    .where('run.id', '=', run)
    .executeTakeFirstOrThrow();
  if (row.claim === null || row.occurrence === null) throw new Error(`run ${run} has no claim`);
  return {
    run: row.id,
    routine: row.routine_id,
    name: row.name,
    reason: row.reason,
    occurrence: row.occurrence,
    runAs: row.run_as,
    source: row.source,
    claim: row.claim,
    version: row.version,
    workflow: row.workflow,
    needsRepository: row.needs_repository,
    repository: row.repository_id,
    sourceKind: row.source_kind,
  };
}

async function claimNext(db: Database, routine: string, now: Date, leaseMs: number): Promise<Claim> {
  const closed = await closeCollapsed(db, routine, now);
  const claim = randomUUID();
  try {
    const run =
      (await retryExpired(db, routine, now, leaseMs, claim)) ?? (await claimSlot(db, routine, now, leaseMs, claim)) ?? (await claimPress(db, routine, now, leaseMs, claim));
    return { run: run === undefined ? undefined : await claimed(db, run), closed };
  } catch (error) {
    if (isPauseRefusal(error)) return { run: undefined, closed };
    throw error;
  }
}

async function search(sources: Sources, run: Claimed): Promise<Search> {
  const source = sources.get(run.sourceKind);
  if (source === undefined) return { failed: `This engine has no source of kind ${run.sourceKind}, so the run searched nothing. Give the routine a source this engine runs.` };
  try {
    return { found: await source.find(run) };
  } catch (error) {
    return { failed: `The ${run.sourceKind} search failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const said = (run: Claimed, recorded: Recorded): string => {
  const what = `routine ${run.routine} run ${run.run} for ${run.reason === 'schedule' ? `the slot at ${run.occurrence.toISOString()}` : 'Run now'}`;
  switch (recorded.outcome) {
    case 'done':
      return `${what} found ${String(recorded.found)}, added ${String(recorded.added)} tasks, refreshed ${String(recorded.refreshed)}, and saw ${String(recorded.overlaps)} tickets another routine owns`;
    case 'failed':
      return `${what} failed and recorded why: ${recorded.note}`;
    case 'paused':
      return `${what} recorded nothing, because the routine was paused while it ran`;
    case 'refused':
      return `${what} recorded nothing, because ${recorded.because}`;
  }
};

async function runClaimed(db: Database, run: Claimed, settings: Pick<SchedulerSettings, 'sources' | 'workflows' | 'now'>): Promise<string> {
  const found = await search(settings.sources, run);
  const firstStep = settings.workflows.get(run.workflow)?.steps[0].name;
  const searched: Search =
    firstStep === undefined && 'found' in found ? { failed: `This engine does not run the workflow ${run.workflow}, so the run recorded no task. Give the routine a workflow this engine runs.` } : found;
  return said(run, await record(db, run, searched, firstStep ?? '', await settings.now(db)));
}

export function scheduler(settings: SchedulerSettings): Loop {
  return {
    name: 'scheduler',
    everyMs: settings.everyMs,
    pass: async db => {
      const lines: string[] = [];
      const routines = await db.selectFrom('routine').select('id').orderBy('id').execute();
      for (const { id } of routines) {
        const claim = await claimNext(db, id, await settings.now(db), settings.leaseMs);
        if (claim.closed > 0) lines.push(`routine ${id} closed ${String(claim.closed)} expired runs of slots a newer slot replaced, as lost`);
        if (claim.run !== undefined) lines.push(await runClaimed(db, claim.run, settings));
      }
      return lines;
    },
  };
}
