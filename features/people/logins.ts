import type { Database } from '../../shared/db/client.ts';
import type { ConnectorKind, CredentialState } from '../../shared/db/types.ts';
import { initials } from '../../shared/people.ts';

export const loginNames: Readonly<Record<ConnectorKind, string>> = { github: 'GitHub', codex: 'Codex', jira: 'Jira' };

export const connectorsShown = Object.keys(loginNames) as readonly ConnectorKind[];

export type Checked = { readonly at: string; readonly state: CredentialState; readonly cause: string | null };

export type Stored = { readonly replacedAt: string; readonly replacedBy: string; readonly expiresAt: string | null; readonly checked: Checked | null };

export type Login = { readonly owner: string; readonly connector: ConnectorKind; readonly stored: Stored | null };

export type Replacing =
  | { readonly kind: 'ready' }
  | { readonly kind: 'pick-first' }
  | { readonly kind: 'off' }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'saved'; readonly at: string };

export const notReplacing: Replacing = { kind: 'ready' };

export type ReplaceLogin = (previous: Replacing, form: FormData) => Promise<Replacing>;

export type Tone = 'plain' | 'quiet' | 'attn';

export type Said = { readonly tone: Tone; readonly text: string; readonly cause: string | null };

const expiringWithinMs = 7 * 24 * 60 * 60_000;

const fixes: Readonly<Record<ConnectorKind, string>> = {
  github: 'Make a new token on GitHub and paste it under Replace.',
  codex: 'Run codex login --device-auth in a fresh CODEX_HOME made for AutoWorker, then paste its auth.json under Replace.',
  jira: 'Make a new API token for the Jira account and paste it under Replace as email:token.',
};

const at = (iso: string, zone: string): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(new Date(iso));

const on = (iso: string, zone: string): string => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: zone }).format(new Date(iso));

const when = (iso: string, now: string, zone: string): string => (on(iso, zone) === on(now, zone) ? at(iso, zone) : `${on(iso, zone)} at ${at(iso, zone)}`);

export function sayLogin(login: Login, now: string, zone: string): Said {
  const { stored } = login;
  const fix = fixes[login.connector];
  if (stored === null) return { tone: 'quiet', text: 'Not stored.', cause: null };
  const { checked, expiresAt } = stored;
  if (checked === null) return { tone: 'plain', text: `Replaced by ${initials(stored.replacedBy)} at ${when(stored.replacedAt, now, zone)}. Checking.`, cause: null };
  const checkedAt = when(checked.at, now, zone);
  if (checked.state === 'invalid') return { tone: 'attn', text: `${loginNames[login.connector]} refused it. Checked ${checkedAt}. ${fix}`, cause: checked.cause };
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(now)) return { tone: 'attn', text: `Expired ${when(expiresAt, now, zone)}. ${fix}`, cause: null };
  if (expiresAt !== null && Date.parse(expiresAt) - Date.parse(now) < expiringWithinMs) return { tone: 'attn', text: `Works, but expires ${when(expiresAt, now, zone)}. ${fix}`, cause: null };
  const expiry = expiresAt === null ? '' : ` Expires ${on(expiresAt, zone)}.`;
  if (checked.state === 'unknown') return { tone: 'plain', text: `Could not check it at ${checkedAt}, so the engine tries again.${expiry}`, cause: checked.cause };
  return { tone: 'plain', text: `Works. Checked ${checkedAt}.${expiry}`, cause: null };
}

export type LoginsOf = (owner: string) => readonly Login[];

export async function readLogins(db: Database): Promise<LoginsOf> {
  const rows = await db
    .selectFrom('credential')
    .innerJoin('human_action', 'human_action.id', 'credential.action_id')
    .innerJoin('person as replacer', 'replacer.id', 'human_action.person_id')
    .select(eb => [
      'credential.person_id as owner',
      'credential.connector',
      'credential.state',
      'credential.checked_at as checkedAt',
      'credential.expires_at as expiresAt',
      'human_action.at as replacedAt',
      'replacer.name as replacedBy',
      eb
        .selectFrom('credential_check')
        .select('credential_check.cause')
        .whereRef('credential_check.credential_id', '=', 'credential.id')
        .whereRef('credential_check.replacement', '=', 'credential.action_id')
        .where('credential_check.finished_at', 'is not', null)
        .orderBy('credential_check.finished_at', 'desc')
        .limit(1)
        .as('cause'),
    ])
    .where('credential.person_id', 'is not', null)
    .execute();
  const stored = new Map(
    rows.map(row => [
      `${row.owner ?? ''} ${row.connector}`,
      {
        replacedAt: row.replacedAt.toISOString(),
        replacedBy: row.replacedBy,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        checked: row.state === null || row.checkedAt === null ? null : { at: row.checkedAt.toISOString(), state: row.state, cause: row.cause },
      } satisfies Stored,
    ]),
  );
  return owner => connectorsShown.map((connector): Login => ({ owner, connector, stored: stored.get(`${owner} ${connector}`) ?? null }));
}
