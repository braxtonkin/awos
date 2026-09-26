import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import type { Loop } from '../../shared/loop.ts';
import { payloads, requestKind, requestKinds, targets, type PayloadOf, type RequestKind, type TargetOf } from '../../shared/requests.ts';
import { inTransaction, type Transacting } from '../../shared/transaction.ts';

export type Applied = 'recorded' | { readonly refused: string };

export type Applying<K extends RequestKind> = { readonly action: string; readonly person: string; readonly at: Date; readonly target: TargetOf<K>; readonly payload: PayloadOf<K> };

export type Handler<K extends RequestKind> = (tx: Transacting, request: Applying<K>) => Promise<Applied>;

export type Handlers<K extends RequestKind> = { readonly [Kind in K]: Handler<Kind> };

export type RequestSettings = { readonly everyMs: number; readonly timeoutMs: number; readonly handlers: Handlers<RequestKind>; readonly now: () => Date };

export type Claimed = { readonly id: string; readonly kind: string; readonly person: string; readonly target: string | null; readonly payload: unknown };

export type Claim = (tx: Transacting) => Promise<Claimed | undefined>;

export type Refuse = (db: Database, id: string, reason: string, now: Date, timeoutMs: number) => Promise<boolean>;

export type Parts = { readonly claim: Claim; readonly refuse: Refuse };

const passing = z.object({ code: z.union([z.string().regex(/^(08|40)/), z.literal('57P01'), z.literal('57P02'), z.literal('57P03')]) });

const timedOut = z.object({ code: z.union([z.literal('57014'), z.literal('25P03')]) });

export async function limitTime(tx: Transacting, timeoutMs: number): Promise<void> {
  const ms = String(timeoutMs);
  await sql`select set_config('statement_timeout', ${ms}, true), set_config('idle_in_transaction_session_timeout', ${ms}, true)`.execute(tx);
}

export const claimOldest: Claim = tx =>
  tx
    .selectFrom('person_request as request')
    .select(eb => [
      'request.id',
      'request.kind',
      'request.person_id as person',
      eb.fn.coalesce('request.task_id', 'request.routine_id').$castTo<string | null>().as('target'),
      'request.payload',
    ])
    .where('request.answer', 'is', null)
    .where(eb =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('person_request as older')
            .select('older.id')
            .whereRef('older.target', '=', 'request.target')
            .whereRef('older.position', '<', 'request.position')
            .where('older.answer', 'is', null),
        ),
      ),
    )
    .orderBy('request.position')
    .orderBy('request.id')
    .limit(1)
    .forUpdate('request')
    .skipLocked()
    .executeTakeFirst();

function handle<K extends RequestKind>(tx: Transacting, handlers: Handlers<K>, kind: K, claimed: Claimed, now: Date): Promise<Applied> {
  const schema: z.ZodType<PayloadOf<K>> = payloads[kind];
  const payload = schema.safeParse(claimed.payload);
  if (!payload.success) return Promise.resolve({ refused: `The request's details do not fit a ${kind} request, so AutoWorker cannot apply it.` });
  const targetSchema: z.ZodType<TargetOf<K>> = targets[kind];
  const target = targetSchema.safeParse(claimed.target);
  if (!target.success) return Promise.resolve({ refused: `A ${kind} request must name its ${requestKinds[kind].on}, so AutoWorker cannot apply this one.` });
  const handler: Handler<K> = handlers[kind];
  return handler(tx, { action: claimed.id, person: claimed.person, at: now, target: target.data, payload: payload.data });
}

export function applyClaimed(tx: Transacting, handlers: Handlers<RequestKind>, claimed: Claimed, now: Date): Promise<Applied> {
  const kind = requestKind.safeParse(claimed.kind);
  return kind.success ? handle(tx, handlers, kind.data, claimed, now) : Promise.resolve({ refused: `AutoWorker does not know the request kind ${claimed.kind}.` });
}

export async function writeAnswer(tx: Transacting, id: string, applied: Applied, now: Date): Promise<void> {
  const { numUpdatedRows } = await tx
    .updateTable('person_request')
    .set(applied === 'recorded' ? { answer: 'recorded', answered_at: now } : { answer: 'refused', answered_at: now, reason: applied.refused })
    .where('id', '=', id)
    .where('answer', 'is', null)
    .executeTakeFirst();
  if (numUpdatedRows !== 1n) throw new Error(`The request ${id} was answered while this engine held it.`);
}

export const refuseOpen: Refuse = (db, id, reason, now, timeoutMs) =>
  inTransaction(db, async tx => {
    await limitTime(tx, timeoutMs);
    const { numUpdatedRows } = await tx
      .updateTable('person_request')
      .set({ answer: 'refused', answered_at: now, reason })
      .where('id', '=', id)
      .where('answer', 'is', null)
      .executeTakeFirst();
    return numUpdatedRows === 1n;
  });

export const coreParts: Parts = { claim: claimOldest, refuse: refuseOpen };

const detailOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const targetOf = (claimed: Claimed): string => {
  const kind = requestKind.safeParse(claimed.kind);
  const on = kind.success ? requestKinds[kind.data].on : 'target';
  return claimed.target === null ? `a new ${on}` : `${on} ${claimed.target}`;
};

const said = (claimed: Claimed, applied: Applied): string =>
  applied === 'recorded' ? `recorded ${claimed.kind} on ${targetOf(claimed)} as action ${claimed.id}` : `refused ${claimed.kind} on ${targetOf(claimed)}: ${applied.refused}`;

const refusalFor = (error: unknown, timeoutMs: number): string =>
  timedOut.safeParse(error).success
    ? `AutoWorker could not apply the request within ${String(timeoutMs / 1000)} s, so it refused it. Send it again.`
    : 'AutoWorker could not apply the request, so it refused it. The engine log says why.';

export async function applyNext(db: Database, settings: RequestSettings, parts: Parts = coreParts): Promise<string | undefined> {
  const now = settings.now();
  let claimed: Claimed | undefined;
  try {
    return await inTransaction(db, async tx => {
      await limitTime(tx, settings.timeoutMs);
      claimed = await parts.claim(tx);
      if (claimed === undefined) return undefined;
      const applied = await applyClaimed(tx, settings.handlers, claimed, now);
      await writeAnswer(tx, claimed.id, applied, now);
      return said(claimed, applied);
    });
  } catch (error) {
    if (claimed === undefined || passing.safeParse(error).success) throw error;
    const reason = refusalFor(error, settings.timeoutMs);
    const refused = await parts.refuse(db, claimed.id, reason, now, settings.timeoutMs);
    return `${refused ? said(claimed, { refused: reason }) : `left ${claimed.kind} on ${targetOf(claimed)} to the answer another engine wrote`}, after its apply failed: ${detailOf(error)}`;
  }
}

export const requests = (settings: RequestSettings, parts: Parts = coreParts): Loop => ({
  name: 'requests',
  everyMs: settings.everyMs,
  pass: async (db, pass) => {
    const lines: string[] = [];
    while (!pass.late() && !pass.stop.aborted) {
      const line = await applyNext(db, settings, parts);
      if (line === undefined) break;
      lines.push(line);
    }
    return lines;
  },
});
