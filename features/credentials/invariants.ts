import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';

type Statement = RawBuilder<unknown>;

type Plant = { readonly setup: readonly Statement[]; readonly violation: Statement };

type Property = { readonly breaks: Statement; readonly plants: readonly [Plant, ...Plant[]] };

export const simulatorSchema: readonly Statement[] = [
  sql`create table sim_refresh (id bigint generated always as identity primary key, token text not null, by_actor text not null)`,
  sql`create table sim_history (id bigint generated always as identity primary key, credential_id bigint not null, action_id uuid not null, expires_at timestamptz)`,
  sql`create function sim_remember() returns trigger language plpgsql as $$
      begin
        insert into sim_history (credential_id, action_id, expires_at) values (new.id, new.action_id, new.expires_at);
        return new;
      end
      $$`,
  sql`create trigger sim_remember after insert or update of ciphertext, action_id, expires_at on credential for each row execute function sim_remember()`,
];

const world: readonly Statement[] = [
  sql`insert into person (email, name, kind) values ('ada@example.com', 'Ada', 'person')`,
  sql`insert into human_action (id, at, person_id, kind, connector) values ('00000000-0000-4000-8000-000000000001', timestamptz '2026-01-01T00:00:00Z', 1, 'replace_credential', 'codex')`,
  sql`insert into credential (connector, scope, person_id, ciphertext, key_version, expires_at, action_id)
      values ('codex', 'personal', 1, decode(repeat('ab', 44), 'hex'), 1, timestamptz '2026-01-01T01:00:00Z', '00000000-0000-4000-8000-000000000001')`,
];

const liveCheck = sql`insert into credential_check (credential_id, replacement, opened_expires_at, refreshes, checker, claimed_at, lease_until)
  values (1, '00000000-0000-4000-8000-000000000001', timestamptz '2026-01-01T01:00:00Z', false, 'planted', timestamptz '2026-01-01T00:00:00Z', timestamptz '2026-01-01T00:05:00Z')`;

export const properties = {
  TypeOK: {
    breaks: sql`select c.id, c.finished_at, c.outcome from credential_check c where (c.finished_at is null) <> (c.outcome is null)`,
    plants: [
      {
        setup: [sql`alter table credential_check drop constraint finished_check_has_outcome`],
        violation: sql`insert into credential_check (credential_id, replacement, opened_expires_at, refreshes, checker, claimed_at, lease_until, outcome)
          values (1, '00000000-0000-4000-8000-000000000001', null, false, 'planted', timestamptz '2026-01-01T00:00:00Z', timestamptz '2026-01-01T00:05:00Z', 'valid')`,
      },
    ],
  },
  OneLiveCheck: {
    breaks: sql`select c.credential_id, count(*) as live from credential_check c where c.finished_at is null group by c.credential_id having count(*) > 1`,
    plants: [{ setup: [sql`drop index one_live_check_per_credential`, liveCheck], violation: liveCheck }],
  },
  NoRefreshTokenReused: {
    breaks: sql`select r.token, count(*) as presented from sim_refresh r group by r.token having count(*) > 1`,
    plants: [
      {
        setup: [sql`insert into sim_refresh (token, by_actor) values ('rt-1-0', 'engine')`],
        violation: sql`insert into sim_refresh (token, by_actor) values ('rt-1-0', 'engine')`,
      },
    ],
  },
  StoredLoginIsNewest: {
    breaks: sql`select c.id, c.action_id, c.expires_at, newer.expires_at as held_before
      from credential c
      join lateral (select max(h.expires_at) as expires_at from sim_history h where h.credential_id = c.id and h.action_id = c.action_id) newer on true
      where newer.expires_at > c.expires_at`,
    plants: [
      {
        setup: [sql`update credential set expires_at = timestamptz '2026-01-01T02:00:00Z' where id = 1`],
        violation: sql`update credential set expires_at = timestamptz '2026-01-01T01:30:00Z' where id = 1`,
      },
    ],
  },
  JobsNeverRefresh: {
    breaks: sql`select r.token, r.by_actor from sim_refresh r where r.by_actor like 'job%'`,
    plants: [{ setup: [], violation: sql`insert into sim_refresh (token, by_actor) values ('rt-1-0', 'job 1')` }],
  },
} satisfies Readonly<Record<string, Property>>;

export type PropertyName = keyof typeof properties;

export type Violation = { readonly property: PropertyName; readonly row: unknown };

export type PlantProof = { readonly property: PropertyName; readonly plant: number; readonly atStart: readonly PropertyName[]; readonly reported: readonly PropertyName[] };

const isPropertyName = (name: unknown): name is PropertyName => typeof name === 'string' && Object.hasOwn(properties, name);

export const propertyNames: readonly PropertyName[] = Object.keys(properties).filter(isPropertyName);

const found = z.array(z.object({ property: z.custom<PropertyName>(isPropertyName), row: z.unknown() }));

const everyProperty = sql.join(
  propertyNames.map(name => sql`select ${sql.lit(name)} as property, to_jsonb(v) as row from (${properties[name].breaks}) v`),
  sql` union all `,
);

export async function violations(db: Database): Promise<readonly Violation[]> {
  return found.parse((await sql`${everyProperty}`.execute(db)).rows);
}

const namesOf = (list: readonly Violation[]): readonly PropertyName[] => [...new Set(list.map(violation => violation.property))];

async function provePlant(postgres: TestPostgres, plant: Plant): Promise<Pick<PlantProof, 'atStart' | 'reported'>> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    for (const statement of [...simulatorSchema, ...world, ...plant.setup]) await statement.execute(db);
    const atStart = namesOf(await violations(db));
    await plant.violation.execute(db);
    return { atStart, reported: namesOf(await violations(db)) };
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

export async function provePlants(postgres: TestPostgres): Promise<readonly PlantProof[]> {
  const proofs: PlantProof[] = [];
  for (const property of propertyNames) {
    for (const [index, plant] of properties[property].plants.entries()) proofs.push({ property, plant: index + 1, ...(await provePlant(postgres, plant)) });
  }
  return proofs;
}
