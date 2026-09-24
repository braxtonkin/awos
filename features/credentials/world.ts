import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import type { PersonKind } from '../../shared/db/types.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import type { Secret } from './kinds.ts';
import { sealingKey, type SealingKey } from './seal.ts';
import { open, replace, type Replacement, type Slot } from './store.ts';

export type World = {
  readonly engine: Database;
  readonly dashboard: Database;
  readonly key: SealingKey;
  readonly ada: string;
  readonly bo: string;
  readonly team: string;
  readonly url: string;
};

export type Outcome = { readonly problems: readonly string[]; readonly detail: string };

export type Entry = { readonly name: string; readonly run: (postgres: TestPostgres) => Promise<Outcome> };

export type Login = { readonly text: string; readonly tokens: readonly string[] };

export type Stored = { readonly id: string; readonly action: string; readonly slot: Slot; readonly text: string; readonly ciphertext: Buffer };

export type Probe = { readonly name: string; readonly run: (world: World, stored: Stored) => Promise<boolean> };

export type Reading = { readonly name: string; readonly outcome: 'refused' | 'through' | 'missed' };

export const epoch = Date.parse('2026-01-01T00:00:00.000Z');

const dayMs = 86_400_000;

const thrown = z.object({ message: z.string() });

const insufficientPrivilege = z.object({ code: z.literal('42501') });

export const day = (days: number): Date => new Date(epoch + days * dayMs);

export const messageOf = (error: unknown): string => thrown.safeParse(error).data?.message ?? 'an error with no message';

export const newKey = (version: number): SealingKey => sealingKey({ CREDENTIAL_KEY: randomBytes(32).toString('base64'), CREDENTIAL_KEY_VERSION: String(version) });

const segment = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

const fakeJwt = (claims: object): string => [segment({ alg: 'RS256', typ: 'JWT' }), segment(claims), randomBytes(256).toString('base64url')].join('.');

export const fakeRefreshToken = (): string => `rt_${randomBytes(48).toString('base64url')}`;

export const fakeGithubToken = (): string => `ghp_${randomBytes(18).toString('hex')}`;

export function fakeLogin(expiresAt: Date, refreshToken: string, changes: Readonly<Record<string, unknown>> = {}): Login {
  const exp = Math.floor(expiresAt.getTime() / 1000);
  const claims = { exp, iat: exp - 864_000, iss: 'https://auth.example.com', aud: ['https://api.example.com/v1'], session: randomBytes(720).toString('base64url') };
  const accessToken = fakeJwt({ ...claims, scp: ['openid', 'profile', 'email', 'offline_access'] });
  const idToken = fakeJwt({ ...claims, email: 'ada@example.com', email_verified: true });
  const auth = {
    OPENAI_API_KEY: null,
    tokens: { id_token: idToken, access_token: accessToken, refresh_token: refreshToken, account_id: randomUUID(), ...changes },
    last_refresh: new Date((exp - 864_000) * 1000).toISOString(),
  };
  return { text: `${JSON.stringify(auth, null, 2)}\n`, tokens: [accessToken, idToken, refreshToken].filter(token => token.trim() !== '') };
}

export const codex = (login: Login, madeForAutoWorker: boolean): Secret => ({ connector: 'codex', login: login.text, madeForAutoWorker });

export const github = (token: string): Secret => ({ connector: 'github', token });

export const replacementOf = (world: World, owner: string | null, secret: Secret): Replacement => ({ action: randomUUID(), by: world.ada, at: new Date(epoch), owner, secret });

async function addPerson(db: Database, email: string, name: string, kind: PersonKind): Promise<string> {
  const { id } = await db.insertInto('person').values({ email, name, kind }).returning('id').executeTakeFirstOrThrow();
  return id;
}

export async function inWorld<T>(postgres: TestPostgres, work: (world: World) => Promise<T>): Promise<T> {
  const scratch = await postgres.scratch();
  const engine = connect(scratch.url, 1);
  const login = `dashboard_${randomBytes(6).toString('hex')}`;
  const password = randomBytes(18).toString('hex');
  const address = new URL(scratch.url);
  address.username = login;
  address.password = password;
  const dashboard = connect(address.toString(), 1);
  try {
    await sql`create role ${sql.id(login)} login password ${sql.lit(password)} in role dashboard`.execute(engine);
    const [session] = (await sql<{ login: string; member: boolean }>`select current_user as login, pg_has_role(current_user, 'dashboard', 'member') as member`.execute(dashboard)).rows;
    if (session?.login !== login || !session.member) throw new Error(`the dashboard client connected as ${session?.login ?? 'nobody'}, not as ${login}, a member of dashboard`);
    const ada = await addPerson(engine, 'ada@example.com', 'Ada', 'person');
    const bo = await addPerson(engine, 'bo@example.com', 'Bo', 'person');
    const team = await addPerson(engine, 'release-team@example.com', 'Release team', 'shared');
    return await work({ engine, dashboard, key: newKey(1), ada, bo, team, url: scratch.url });
  } finally {
    await dashboard.destroy();
    await sql`drop role if exists ${sql.id(login)}`.execute(engine);
    await engine.destroy();
    await scratch.drop();
  }
}

export const inScratch =
  (check: (world: World) => Promise<Outcome>) =>
  (postgres: TestPostgres): Promise<Outcome> =>
    inWorld(postgres, check);

export const offline =
  (check: () => Outcome) =>
  (): Promise<Outcome> =>
    Promise.resolve(check());

export async function storeAll(world: World, replacements: readonly Replacement[]): Promise<void> {
  for (const replacement of replacements) {
    const replaced = await replace(world.dashboard, world.key, replacement);
    if ('refused' in replaced) throw new Error(`storing a ${replacement.secret.connector} credential was refused: ${replaced.reason}`);
  }
}

export async function storeToken(world: World, owner: string): Promise<Stored> {
  const token = fakeGithubToken();
  const replacement = replacementOf(world, owner, github(token));
  const replaced = await replace(world.dashboard, world.key, replacement);
  if ('refused' in replaced) throw new Error(`storing a GitHub token was refused: ${replaced.reason}`);
  const { ciphertext } = await world.engine.selectFrom('credential').select('ciphertext').where('id', '=', replaced.credential).executeTakeFirstOrThrow();
  return { id: replaced.credential, action: replacement.action, slot: { connector: 'github', owner }, text: token, ciphertext };
}

export const tokenReads: readonly Probe[] = [
  {
    name: 'open',
    run: async (world, stored) => {
      const opened = await open(world.dashboard, world.key, stored.slot);
      return 'secret' in opened && opened.secret === stored.text;
    },
  },
  {
    name: 'select ciphertext',
    run: async (world, stored) => (await world.dashboard.selectFrom('credential').select('ciphertext').execute()).some(row => row.ciphertext.equals(stored.ciphertext)),
  },
  {
    name: 'select *',
    run: async (world, stored) => (await world.dashboard.selectFrom('credential').selectAll().execute()).some(row => row.ciphertext.equals(stored.ciphertext)),
  },
  {
    name: 'a where on ciphertext',
    run: async (world, stored) => (await world.dashboard.selectFrom('credential').select('id').where('ciphertext', '=', stored.ciphertext).execute()).length === 1,
  },
];

export const writeCiphertext: Probe = {
  name: 'update credential set ciphertext',
  run: async (world, stored) => {
    const { numUpdatedRows } = await world.dashboard.updateTable('credential').set({ ciphertext: randomBytes(44) }).where('id', '=', stored.id).executeTakeFirst();
    return numUpdatedRows === 1n;
  },
};

export const writeCredential: Probe = {
  name: 'insert into credential',
  run: async (world, stored) => {
    const { numInsertedOrUpdatedRows } = await world.dashboard
      .insertInto('credential')
      .values({ connector: 'codex', scope: 'personal', person_id: world.bo, ciphertext: randomBytes(44), key_version: 1, action_id: stored.action })
      .executeTakeFirst();
    return numInsertedOrUpdatedRows === 1n;
  },
};

export const writeAction: Probe = {
  name: 'insert into human_action',
  run: async world => {
    const { numInsertedOrUpdatedRows } = await world.dashboard
      .insertInto('human_action')
      .values({ id: randomUUID(), at: new Date(epoch), person_id: world.ada, kind: 'replace_credential', connector: 'github' })
      .executeTakeFirst();
    return numInsertedOrUpdatedRows === 1n;
  },
};

export const tokenWrites: readonly Probe[] = [writeCiphertext, writeCredential, writeAction];

export async function accessProblems(world: World): Promise<readonly string[]> {
  const relations = await sql<{ name: string }>`
    select distinct dependent.oid::regclass::text as name
    from pg_depend d
    join pg_rewrite r on r.oid = d.objid
    join pg_class dependent on dependent.oid = r.ev_class
    join pg_attribute a on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
    where d.classid = 'pg_rewrite'::regclass
      and d.refobjid = 'credential'::regclass
      and a.attname = 'ciphertext'
      and has_any_column_privilege('dashboard', dependent.oid, 'select')
    order by name`.execute(world.engine);
  const functions = await sql<{ name: string }>`
    select p.proname::text as name
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and position('credential' in p.prosrc) > 0
      and has_function_privilege('dashboard', p.oid, 'execute')
    order by name`.execute(world.engine);
  const executable = functions.rows.map(row => row.name);
  return [
    ...relations.rows.map(row => `the dashboard can select ${row.name}, which reads credential.ciphertext`),
    ...executable.filter(name => name !== 'replace_credential').map(name => `the dashboard can execute ${name}, which touches credential`),
    ...(executable.includes('replace_credential') ? [] : ['the dashboard cannot execute replace_credential']),
  ];
}

export async function probe(world: World, stored: Stored, probes: readonly Probe[]): Promise<readonly Reading[]> {
  const readings: Reading[] = [];
  for (const { name, run } of probes) {
    try {
      readings.push({ name, outcome: (await run(world, stored)) ? 'through' : 'missed' });
    } catch (error) {
      if (!insufficientPrivilege.safeParse(error).success) throw error;
      readings.push({ name, outcome: 'refused' });
    }
  }
  return readings;
}
