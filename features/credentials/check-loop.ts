import { sql } from 'kysely';
import { refusal, type Database } from '../../shared/db/client.ts';
import type { ConnectorKind } from '../../shared/db/types.ts';
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

export type JobLogin = { readonly login: AccessOnlyLogin; readonly expiresAt: Date } | { readonly refused: 'missing' | 'unreadable' | 'not-valid'; readonly reason: string };

type Claim = { readonly check: string } | { readonly refused: 'busy' | 'refresh-used' };

export const refreshWindowMs = 5 * 60_000;

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

async function dueCredentials(db: Database, now: Date): Promise<readonly Stored[]> {
  const windowOpen = sql<Date>`credential.expires_at - make_interval(secs => ${refreshWindowMs / 1000})`;
  return db
    .selectFrom('credential')
    .select(['credential.id', 'credential.connector', 'credential.person_id'])
    .where(eb =>
      eb.or([
        eb('credential.state', 'is', null),
        eb.and([
          eb('credential.connector', '=', 'codex'),
          eb(windowOpen, '<=', now),
          eb.or([eb('credential.checked_at', 'is', null), eb('credential.checked_at', '<', windowOpen)]),
        ]),
      ]),
    )
    .where(eb => eb.not(eb.exists(eb.selectFrom('credential_check').select('credential_check.id').whereRef('credential_check.credential_id', '=', 'credential.id').where('credential_check.finished_at', 'is', null))))
    .orderBy('credential.id')
    .execute();
}

async function claim(db: Database, settings: CheckLoopSettings, held: Held, refreshes: boolean, now: Date): Promise<Claim> {
  try {
    const { id } = await db
      .insertInto('credential_check')
      .values({
        credential_id: held.credential,
        replacement: held.replacement,
        opened_expires_at: held.expiresAt,
        refreshes,
        checker: settings.checker,
        claimed_at: now,
        lease_until: later(now, settings.leaseMs),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { check: id };
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

async function recordRefreshUsed(db: Database, settings: CheckLoopSettings, held: Held, now: Date): Promise<void> {
  await db.transaction().execute(async tx => {
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
    await tx
      .updateTable('credential')
      .set({ state: 'invalid', checked_at: now })
      .where('id', '=', held.credential)
      .where('action_id', '=', held.replacement)
      .where('expires_at', 'is not distinct from', held.expiresAt)
      .execute();
  });
}

async function runSafely(check: Check, secret: string, now: Date): Promise<Checked> {
  try {
    return await check.run(secret, now);
  } catch (error) {
    return { verdict: 'unknown', cause: `The check failed before it reached a verdict: ${error instanceof Error ? error.message : String(error)}`, expiresAt: null };
  }
}

async function finish(db: Database, settings: CheckLoopSettings, check: string, held: Held, checked: Checked): Promise<string> {
  const now = settings.now();
  return db.transaction().execute(async tx => {
    const back = checked.rotated === undefined ? undefined : await settings.writeBack(tx, settings.key, held, checked.rotated);
    await tx
      .updateTable('credential_check')
      .set(eb => ({
        refreshes: checked.rotated !== undefined,
        finished_at: eb.fn.coalesce('finished_at', eb.val(now)),
        outcome: eb.fn.coalesce('outcome', eb.val(checked.verdict)),
        cause: eb.fn.coalesce('cause', eb.val(checked.cause)),
      }))
      .where('id', '=', check)
      .execute();
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

async function checkOne(db: Database, settings: CheckLoopSettings, row: Stored, now: Date): Promise<string> {
  const opened = await open(db, settings.key, { connector: row.connector, owner: row.person_id });
  if (!('secret' in opened)) return `could not open ${whose(row)}: ${opened.reason}`;
  const held: Held = { credential: opened.credential, replacement: opened.replacement, expiresAt: opened.expiresAt, slot: { connector: row.connector, owner: row.person_id } };
  const check = settings.checks[row.connector];
  const claimed = await claim(db, settings, held, check.rotates(opened.secret), now);
  if ('refused' in claimed) {
    if (claimed.refused === 'busy') return `left ${whose(row)} to the checker that holds it`;
    await recordRefreshUsed(db, settings, held, now);
    return `marked ${whose(row)} invalid. ${refreshUsed}`;
  }
  const checked = await runSafely(check, opened.secret, now);
  return `checked ${whose(row)}: ${await finish(db, settings, claimed.check, held, checked)}`;
}

export function checkLoop(settings: CheckLoopSettings): Loop {
  return {
    name: 'checks',
    everyMs: settings.everyMs,
    pass: async (db, { now }) => {
      const released = await reapChecks(db, now);
      const lines: string[] = [];
      for (const row of await dueCredentials(db, now)) lines.push(await checkOne(db, settings, row, settings.now()));
      return [...released, ...lines];
    },
  };
}

export async function loginForJob(db: Database, settings: CheckLoopSettings, owner: string): Promise<JobLogin> {
  const row = await db
    .selectFrom('credential')
    .select(['id', 'connector', 'person_id', 'state', 'checked_at'])
    .where('connector', '=', 'codex')
    .where('person_id', '=', owner)
    .executeTakeFirst();
  if (row === undefined) return { refused: 'missing', reason: `Person ${owner} has stored no Codex login. Store one from the dashboard.` };
  const now = settings.now();
  if (row.checked_at === null || row.checked_at.getTime() < now.getTime() - checkedForJobWithinMs) await checkOne(db, settings, row, now);
  const opened = await open(db, settings.key, { connector: 'codex', owner });
  if (!('secret' in opened)) return { refused: 'unreadable', reason: opened.reason };
  const { state } = await db.selectFrom('credential').select('state').where('id', '=', opened.credential).executeTakeFirstOrThrow();
  if (state !== 'valid') return { refused: 'not-valid', reason: `The last check of the Codex login of person ${owner} found it ${state ?? 'unchecked'}, so no Job gets it.` };
  const copy = accessOnly(opened.secret);
  return 'refused' in copy ? { refused: 'unreadable', reason: copy.reason } : copy;
}
