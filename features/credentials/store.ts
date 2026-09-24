import { refusal, type Database } from '../../shared/db/client.ts';
import type { ConnectorKind } from '../../shared/db/types.ts';
import { read, type Secret, type Unread } from './kinds.ts';
import { seal, unseal, type Sealed, type SealingKey } from './seal.ts';

export type Slot = { readonly connector: ConnectorKind; readonly owner: string | null };

export type Replacement = { readonly action: string; readonly by: string; readonly at: Date; readonly owner: string | null; readonly secret: Secret };

export type Replaced =
  | { readonly credential: string; readonly expiresAt: Date | null }
  | { readonly refused: Unread | 'already-recorded' | 'person-does-not-fit-connector'; readonly reason: string };

export type Opened =
  | { readonly credential: string; readonly replacement: string; readonly secret: string; readonly expiresAt: Date | null }
  | { readonly unreadable: 'missing' | 'key-version' | 'unauthenticated'; readonly reason: string };

export type Expiring = { readonly credential: string; readonly connector: ConnectorKind; readonly owner: string | null; readonly expiresAt: Date };

const canonical = ({ connector, owner }: Slot): Slot => ({ connector, owner: owner === null ? null : BigInt(owner).toString() });

const context = ({ connector, owner }: Slot): string => `autoworker credential v1 ${connector} ${owner ?? 'team'}`;

const described = ({ connector, owner }: Slot): string => `the ${connector} credential of ${owner === null ? 'the team' : `person ${owner}`}`;

const personDoesNotFit = (slot: Slot): Replaced => ({
  refused: 'person-does-not-fit-connector',
  reason:
    slot.owner === null
      ? `Each person keeps their own ${slot.connector} credential. Choose whose credential this is, then save it again.`
      : `The team shares one ${slot.connector} credential. Save it again without choosing a person.`,
});

async function replayed(db: Database, action: string, slot: Slot): Promise<Replaced> {
  const row = await db.selectFrom('credential').select(['id', 'expires_at']).where('action_id', '=', action).executeTakeFirst();
  if (row !== undefined) return { credential: row.id, expiresAt: row.expires_at };
  return {
    refused: 'already-recorded',
    reason: `Action ${action} is already recorded, and a later replacement has since changed ${described(slot)}, so this replacement wrote nothing. To store another token, replace the credential again.`,
  };
}

export async function replace(db: Database, key: SealingKey, replacement: Replacement): Promise<Replaced> {
  const found = read(replacement.secret);
  if ('refused' in found) return found;
  const slot = canonical({ connector: replacement.secret.connector, owner: replacement.owner });
  const sealed = seal(key, found.text, context(slot));
  try {
    const { credential } = await db
      .selectNoFrom(eb =>
        eb
          .fn<string | null>('replace_credential', [
            eb.val(replacement.action),
            eb.val(replacement.at),
            eb.val(replacement.by),
            eb.val(slot.connector),
            eb.val(slot.owner),
            eb.val(sealed.ciphertext),
            eb.val(sealed.keyVersion),
            eb.val(found.expiresAt),
            eb.val({ owner: slot.owner, ...found.audit }),
          ])
          .as('credential'),
      )
      .executeTakeFirstOrThrow();
    if (credential !== null) return { credential, expiresAt: found.expiresAt };
  } catch (error) {
    const refused = refusal(error);
    if (refused?.kind === 'check' && refused.name === 'personal_credential_has_person') return personDoesNotFit(slot);
    if (refused?.kind === 'not_null' && refused.table === 'credential' && refused.column === 'scope') {
      throw new Error(`The ${slot.connector} connector kind has no row in the connector table, so it cannot store credentials. Add its row in a migration.`, { cause: error });
    }
    throw error;
  }
  return replayed(db, replacement.action, slot);
}

export async function open(db: Database, key: SealingKey, slot: Slot): Promise<Opened> {
  const owned = canonical(slot);
  const row = await db
    .selectFrom('credential')
    .select(['id', 'action_id', 'ciphertext', 'key_version', 'expires_at'])
    .where('connector', '=', owned.connector)
    .where('person_id', 'is not distinct from', owned.owner)
    .executeTakeFirst();
  if (row === undefined) {
    return { unreadable: 'missing', reason: `No one has stored ${described(owned)}. Store it from the dashboard, and the engine opens it on the next attempt.` };
  }
  const unsealed = unseal(key, { ciphertext: row.ciphertext, keyVersion: row.key_version }, context(owned));
  return 'secret' in unsealed ? { credential: row.id, replacement: row.action_id, secret: unsealed.secret, expiresAt: row.expires_at } : unsealed;
}

export const sealFor = (key: SealingKey, slot: Slot, text: string): Sealed => seal(key, text, context(canonical(slot)));

export type Held = { readonly credential: string; readonly replacement: string; readonly expiresAt: Date | null; readonly slot: Slot };

export type WrittenBack =
  | { readonly written: true; readonly expiresAt: Date }
  | { readonly written: false; readonly reason: string };

export type WriteBack = (db: Database, key: SealingKey, held: Held, login: string) => Promise<WrittenBack>;

export const writeBack: WriteBack = async (db, key, held, login) => {
  const found = read({ connector: 'codex', login, madeForAutoWorker: true });
  if ('refused' in found) return { written: false, reason: `Codex rewrote the login into one the store refuses: ${found.reason}` };
  if (found.expiresAt === null || (held.expiresAt !== null && found.expiresAt <= held.expiresAt)) {
    return { written: false, reason: 'Codex rewrote the login, but its access token expires no later than the stored one, so the stored login stays.' };
  }
  const slot = canonical(held.slot);
  const sealed = sealFor(key, slot, found.text);
  const { numUpdatedRows } = await db
    .updateTable('credential')
    .set({ ciphertext: sealed.ciphertext, key_version: sealed.keyVersion, expires_at: found.expiresAt })
    .where('id', '=', held.credential)
    .where('action_id', '=', held.replacement)
    .where('expires_at', 'is not distinct from', held.expiresAt)
    .executeTakeFirst();
  return numUpdatedRows === 1n
    ? { written: true, expiresAt: found.expiresAt }
    : { written: false, reason: `Someone replaced ${described(slot)}, or another check refreshed it, since this check opened it, so the stored login stays.` };
};

export async function expiring(db: Database, until: Date): Promise<readonly Expiring[]> {
  const rows = await db
    .selectFrom('credential')
    .select(['id', 'connector', 'person_id', 'expires_at'])
    .where('expires_at', '<=', until)
    .orderBy('expires_at')
    .orderBy('id')
    .execute();
  return rows.flatMap(row => (row.expires_at === null ? [] : [{ credential: row.id, connector: row.connector, owner: row.person_id, expiresAt: row.expires_at }]));
}
