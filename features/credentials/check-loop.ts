import { sql, type Expression, type ExpressionBuilder, type SqlBool } from 'kysely';
import { refusal, type Database } from '../../shared/db/client.ts';
import type { ConnectorKind, DB } from '../../shared/db/types.ts';
import type { Loop } from '../../shared/loop.ts';
import type { Checks } from './checks.ts';
import { accessOnly, type AccessOnlyLogin, type Check, type Checked } from './kinds.ts';
import type { SealingKey } from './seal.ts';
import { open, type Held, type WriteBack } from './store.ts';

export type CheckLoopSettings = {
  readonly everyMs: number;
  readonly leaseMs: number;
  readonly key: SealingKey;
  readonly checks: Checks;
  readonly checker: string;
  readonly now: () => Date;
  readonly writeBack: WriteBack;
};

type Stored = { readonly id: string; readonly connector: ConnectorKind; readonly person_id: string | null };

export type JobLogin =
  | { readonly login: AccessOnlyLogin; readonly expiresAt: Date }
  | { readonly refused: 'missing' | 'unreadable' | 'not-valid' | 'expires-too-soon'; readonly reason: string };

type Claim = { readonly check: string } | { readonly refused: 'busy' | 'not-due' | 'refresh-used' };

type Due = (eb: ExpressionBuilder<DB, 'credential'>, now: Date) => Expression<SqlBool>;

export const refreshWindowMs = 5 * 60_000;

export const triesInWindow = 3;

export const checkLeaseMarginMs = 60_000;

const checkedForJobWithinMs = 6 * 3_600_000;

const refreshUsed =
  'A check that may have refreshed this login stopped before it saved the new tokens, and a refresh token works only once, so the engine will not refresh it again. Store a new Codex login made for AutoWorker.';

const later = (at: Date, ms: number): Date => new Date(at.getTime() + ms);

const whose = (row: Stored): string => `the ${row.connector} credential ${row.id}${row.person_id === null ? '' : ` of person ${row.person_id}`}`;

async function reapChecks(db: Database, now: Date): Promise<readonly string[]> {
  const reaped = await db
    .updateTable('credential_check')
    .set({ finished_at: now, outcome: 'lost', cause: 'The checker stopped answering before its lease ended.' })
    .where('finished_at', 'is', null)
    .where('lease_until', '<=', now)
    .returning(['id', 'credential_id', 'checker', 'refreshes'])
    .execute();
  return reaped.map(
    row => `released check ${row.id} of credential ${row.credential_id} by ${row.checker}, whose lease ended${row.refreshes ? '; its login may have been refreshed, so it is not refreshed again' : ''}`,
  );
}

const windowOpen = sql<Date>`credential.expires_at - make_interval(secs => ${refreshWindowMs / 1000})`;

const checksInWindow = (eb: ExpressionBuilder<DB, 'credential'>) =>
  eb
    .selectFrom('credential_check')
    .whereRef('credential_check.credential_id', '=', 'credential.id')
    .whereRef('credential_check.replacement', '=', 'credential.action_id')
    .where(sql<SqlBool>`credential_check.opened_expires_at is not distinct from credential.expires_at`)
    .where('credential_check.claimed_at', '>=', windowOpen);

const dueForLoop: Due = (eb, now) =>
  eb.or([
    eb('credential.state', 'is', null),
    eb.and([
      eb('credential.connector', '=', 'codex'),
      eb(windowOpen, '<=', now),
      eb.not(eb.exists(checksInWindow(eb).select('credential_check.id').where('credential_check.outcome', 'in', ['valid', 'invalid']))),
      eb(checksInWindow(eb).select(inner => inner.fn.countAll<string>().as('tries')), '<', String(triesInWindow)),
    ]),
  ]);

const dueForJob: Due = (eb, now) => eb.or([eb('credential.checked_at', 'is', null), eb('credential.checked_at', '<', later(now, -checkedForJobWithinMs))]);

async function dueCredentials(db: Database, now: Date): Promise<readonly Stored[]> {
  return db
    .selectFrom('credential')
    .select(['credential.id', 'credential.connector', 'credential.person_id'])
    .where(eb => dueForLoop(eb, now))
    .where(eb => eb.not(eb.exists(eb.selectFrom('credential_check').select('credential_check.id').whereRef('credential_check.credential_id', '=', 'credential.id').where('credential_check.finished_at', 'is', null))))
    .orderBy('credential.id')
    .execute();
}

async function lockCredential(tx: Database, credential: string): Promise<void> {
  await tx.selectFrom('credential').select('id').where('id', '=', credential).forUpdate().execute();
}

async function claim(db: Database, settings: CheckLoopSettings, held: Held, refreshes: boolean, due: Due, now: Date): Promise<Claim> {
  try {
    const inserted = await db.transaction().execute(async tx => {
      await lockCredential(tx, held.credential);
      return tx
        .insertInto('credential_check')
        .columns(['credential_id', 'replacement', 'opened_expires_at', 'refreshes', 'checker', 'claimed_at', 'lease_until'])
        .expression(eb =>
          eb
            .selectFrom('credential')
            .select([
              'credential.id',
              'credential.action_id',
              'credential.expires_at',
              sql<boolean>`cast(${refreshes} as boolean)`.as('refreshes'),
              sql<string>`cast(${settings.checker} as text)`.as('checker'),
              sql<Date>`cast(${now} as timestamptz)`.as('claimed_at'),
              sql<Date>`cast(${later(now, settings.leaseMs)} as timestamptz)`.as('lease_until'),
            ])
            .where('credential.id', '=', held.credential)
            .where('credential.action_id', '=', held.replacement)
            .where('credential.expires_at', 'is not distinct from', held.expiresAt)
            .where(inner => due(inner, now)),
        )
        .returning('id')
        .executeTakeFirst();
    });
    return inserted === undefined ? { refused: 'not-due' } : { check: inserted.id };
  } catch (error) {
    const found = refusal(error);
    if (found?.kind === 'unique' && found.name === 'one_live_check_per_credential') return { refused: 'busy' };
    if (found?.kind !== 'unique' || found.name !== 'one_refresh_per_login') throw error;
    const holder = await db
      .selectFrom('credential_check')
      .select('finished_at')
      .where('credential_id', '=', held.credential)
      .where('replacement', '=', held.replacement)
      .where('opened_expires_at', 'is not distinct from', held.expiresAt)
      .where('refreshes', '=', true)
      .executeTakeFirst();
    return { refused: holder === undefined || holder.finished_at === null ? 'busy' : 'refresh-used' };
  }
}

async function recordRefreshUsed(db: Database, settings: CheckLoopSettings, held: Held, due: Due, now: Date): Promise<boolean> {
  return db.transaction().execute(async tx => {
    await lockCredential(tx, held.credential);
    const { numUpdatedRows } = await tx
      .updateTable('credential')
      .set({ state: 'invalid', checked_at: now })
      .where('id', '=', held.credential)
      .where('action_id', '=', held.replacement)
      .where('expires_at', 'is not distinct from', held.expiresAt)
      .where(eb => due(eb, now))
      .executeTakeFirst();
    if (numUpdatedRows !== 1n) return false;
    await tx
      .insertInto('credential_check')
      .values({
        credential_id: held.credential,
        replacement: held.replacement,
        opened_expires_at: held.expiresAt,
        refreshes: false,
        checker: settings.checker,
        claimed_at: now,
        lease_until: now,
        finished_at: now,
        outcome: 'invalid',
        cause: refreshUsed,
      })
      .execute();
    return true;
  });
}

async function runSafely(check: Check, secret: string, now: Date): Promise<Checked> {
  try {
    return await check.run(secret, now);
  } catch (error) {
    return { verdict: 'unknown', cause: `The check failed before it reached a verdict: ${error instanceof Error ? error.message : String(error)}`, expiresAt: null, refresh: { kind: 'maybe-used' } };
  }
}

async function finish(db: Database, settings: CheckLoopSettings, check: string, held: Held, checked: Checked): Promise<string> {
  try {
    return await recordFinish(db, settings, check, held, checked);
  } catch (error) {
    const found = refusal(error);
    if (found?.kind !== 'final' || found.name !== 'finished_check_is_final') throw error;
    return `${checked.verdict}, but its lease ended first and the check was released, so nothing is recorded${checked.refresh.kind === 'rotated' ? ' and the refreshed login is dropped' : ''}. ${checked.cause}`;
  }
}

async function recordFinish(db: Database, settings: CheckLoopSettings, check: string, held: Held, checked: Checked): Promise<string> {
  const now = settings.now();
  return db.transaction().execute(async tx => {
    await lockCredential(tx, held.credential);
    await tx
      .updateTable('credential_check')
      .set({ finished_at: now, outcome: checked.verdict, cause: checked.cause, ...(checked.refresh.kind === 'unused' ? { refreshes: false } : {}) })
      .where('id', '=', check)
      .execute();
    const back = checked.refresh.kind === 'rotated' ? await settings.writeBack(tx, settings.key, held, checked.refresh.login) : undefined;
    const stored = back?.written === true ? back.expiresAt : held.expiresAt;
    const learned = held.slot.connector === 'github' && checked.expiresAt !== null ? { expires_at: checked.expiresAt } : {};
    const { numUpdatedRows } = await tx
      .updateTable('credential')
      .set({ state: checked.verdict, checked_at: now, ...learned })
      .where('id', '=', held.credential)
      .where('action_id', '=', held.replacement)
      .where('expires_at', 'is not distinct from', stored)
      .executeTakeFirst();
    const refreshed = back === undefined ? '' : back.written ? `, refreshed until ${back.expiresAt.toISOString()}` : `, not refreshed: ${back.reason}`;
    const recorded = numUpdatedRows === 1n ? '' : ', but the credential changed meanwhile, so its state stays';
    return `${checked.verdict}${refreshed}${recorded}. ${checked.cause}`;
  });
}

async function checkOne(db: Database, settings: CheckLoopSettings, row: Stored, due: Due, now: Date): Promise<string> {
  const opened = await open(db, settings.key, { connector: row.connector, owner: row.person_id });
  if (!('secret' in opened)) return `could not open ${whose(row)}: ${opened.reason}`;
  const held: Held = { credential: opened.credential, replacement: opened.replacement, expiresAt: opened.expiresAt, slot: { connector: row.connector, owner: row.person_id } };
  const check = settings.checks[row.connector];
  const claimed = await claim(db, settings, held, check.rotates(opened.secret), due, now);
  if ('refused' in claimed) {
    switch (claimed.refused) {
      case 'busy':
        return `left ${whose(row)} to the checker that holds it`;
      case 'not-due':
        return `left ${whose(row)}, which another check finished or someone replaced since this pass listed it`;
      case 'refresh-used':
        return (await recordRefreshUsed(db, settings, held, due, now))
          ? `marked ${whose(row)} invalid. ${refreshUsed}`
          : `left ${whose(row)}, which another check finished or someone replaced since this pass listed it`;
    }
  }
  const checked = await runSafely(check, opened.secret, now);
  return `checked ${whose(row)}: ${await finish(db, settings, claimed.check, held, checked)}`;
}

export function checkLoop(settings: CheckLoopSettings): Loop {
  return {
    name: 'checks',
    everyMs: settings.everyMs,
    pass: async (db, { now, stop }) => {
      const released = await reapChecks(db, now);
      const due = await dueCredentials(db, now);
      const lines: string[] = [];
      for (const [index, row] of due.entries()) {
        if (stop.aborted) {
          lines.push(`stopped before checking ${String(due.length - index)} due credentials, because the engine is stopping`);
          break;
        }
        lines.push(await checkOne(db, settings, row, dueForLoop, settings.now()));
      }
      return [...released, ...lines];
    },
  };
}

const lastsTheJob = (expiresAt: Date | null, jobLimitMs: number, now: Date): boolean => expiresAt !== null && expiresAt > later(now, jobLimitMs);

const tooSoon = (owner: string, expiresAt: Date | null, jobLimitMs: number, now: Date): JobLogin => ({
  refused: 'expires-too-soon',
  reason: `The Codex login of person ${owner} ${expiresAt === null ? 'has no known expiry' : `expires at ${expiresAt.toISOString()}`}, before a Job that starts now reaches its time limit of ${String(jobLimitMs / 1000)} s at ${later(now, jobLimitMs).toISOString()}, so no Job gets it. The engine refreshes the login in its last 5 minutes, or the person can store a new one.`,
});

export async function loginForJob(db: Database, settings: CheckLoopSettings, owner: string, jobLimitMs: number): Promise<JobLogin> {
  const row = await db
    .selectFrom('credential')
    .select(['id', 'connector', 'person_id', 'state', 'checked_at', 'expires_at'])
    .where('connector', '=', 'codex')
    .where('person_id', '=', owner)
    .executeTakeFirst();
  if (row === undefined) return { refused: 'missing', reason: `Person ${owner} has stored no Codex login. Store one from the dashboard.` };
  const now = settings.now();
  if (!lastsTheJob(row.expires_at, jobLimitMs, now)) return tooSoon(owner, row.expires_at, jobLimitMs, now);
  if (row.checked_at === null || row.checked_at.getTime() < now.getTime() - checkedForJobWithinMs) await checkOne(db, settings, row, dueForJob, now);
  const opened = await open(db, settings.key, { connector: 'codex', owner });
  if (!('secret' in opened)) return { refused: 'unreadable', reason: opened.reason };
  const { state } = await db.selectFrom('credential').select('state').where('id', '=', opened.credential).executeTakeFirstOrThrow();
  if (state !== 'valid') return { refused: 'not-valid', reason: `The last check of the Codex login of person ${owner} found it ${state ?? 'unchecked'}, so no Job gets it.` };
  const copy = accessOnly(opened.secret);
  if ('refused' in copy) return { refused: 'unreadable', reason: copy.reason };
  return lastsTheJob(copy.expiresAt, jobLimitMs, now) ? copy : tooSoon(owner, copy.expiresAt, jobLimitMs, now);
}
