import { sql, type RawBuilder } from 'kysely';
import { connect, type Database } from '../../shared/db/client.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';

type Statement = RawBuilder<unknown>;

export type CheckedAt = { readonly now: Date; readonly everyMs: number; readonly startDeadlineMs: number };

type Plant = { readonly setup: readonly Statement[]; readonly violation: Statement };

type Property = { readonly breaks: (at: CheckedAt) => Statement; readonly plants: readonly [Plant, ...Plant[]] };

export const t0 = Date.parse('2026-01-01T00:00:00.000Z');

const at0 = sql`timestamptz '2026-01-01T00:00:00Z'`;

const firstAction = sql.lit('00000000-0000-4000-8000-000000000001');

export const world: readonly Statement[] = [
  sql`insert into person (email, name, jira_account_id) values ('ada@example.com', 'Ada', 'acc-ada')`,
  sql`with saved as (
        insert into human_action (id, at, person_id, kind, repository_id) values ('00000000-0000-4000-8000-000000000009', ${at0}, 1, 'add_repository', 1) returning id)
      insert into repository (github, branch, saved_by, fast_test_command) select 'example/sandbox', 'main', id, 'npm ci && npm test' from saved`,
  sql`insert into routine (creator_id, run_as_id) values (1, 1)`,
  sql`insert into human_action (id, at, person_id, kind, routine_id) values (${firstAction}, ${at0}, 1, 'edit_routine', 1)`,
  sql`insert into routine_version (routine_id, version, name, goal, repository_id, action_id, workflow, source, needs_repository)
      values (1, 1, 'Environments', 'Start and stop Verify environments.', 1, ${firstAction}, 'code-change', '{"kind": "jira-search"}', true)`,
];

export const openAttempt = (key: string, startedAt: Date): readonly Statement[] => [
  sql`insert into task (routine_id, found_version, repository_id, key, title, found_at, assignee_account_id, workflow, needs_repository, step)
      values (1, 1, 1, ${key}, 'Verify it', ${startedAt}, 'acc-ada', 'code-change', true, 'verify')`,
  sql`insert into attempt (task_id, routine_id, routine_version, step, epoch, run_as_id, started_at, lease_until)
      select id, 1, 1, 'verify', 0, 1, ${startedAt}, ${startedAt}::timestamptz + interval '1 hour' from task where key = ${key}`,
];

const plantedAttempt = openAttempt('PLANT-1', new Date(t0));

const plantedEnvironment = sql`insert into verify_environment (attempt_id, provider, recorded_at, called_at) values (1, 'tests-only', ${at0}, ${at0})`;

export const properties = {
  OneEnvironmentPerAttempt: {
    breaks: () => sql`select attempt_id, array_agg(id order by id) as environments from verify_environment group by attempt_id having count(*) > 1`,
    plants: [{ setup: [...plantedAttempt, sql`alter table verify_environment drop constraint one_environment_per_attempt`, plantedEnvironment], violation: plantedEnvironment }],
  },
  NoEnvironmentOutlivesItsAttempt: {
    breaks: ({ now, everyMs, startDeadlineMs }) => sql`select e.id, e.attempt_id, e.provider, a.finished_at
      from verify_environment e join attempt a on a.id = e.attempt_id
      where e.stopped_at is null and a.finished_at < ${now}::timestamptz - make_interval(secs => ${(everyMs * 1.1 + startDeadlineMs) / 1000})`,
    plants: [
      { setup: [...plantedAttempt, plantedEnvironment], violation: sql`update attempt set finished_at = ${at0} + interval '10 seconds', verdict = 'lost' where id = 1` },
      {
        setup: [...plantedAttempt, plantedEnvironment, sql`update verify_environment set starting = 1`],
        violation: sql`update attempt set finished_at = ${at0} + interval '10 seconds', verdict = 'stopped' where id = 1`,
      },
    ],
  },
} satisfies Readonly<Record<string, Property>>;

export type PropertyName = keyof typeof properties;

export type Violation = { readonly property: PropertyName; readonly row: unknown };

const propertyNames = Object.keys(properties).filter((name): name is PropertyName => Object.hasOwn(properties, name));

export async function violations(db: Database, at: CheckedAt): Promise<readonly Violation[]> {
  const found: Violation[] = [];
  for (const property of propertyNames) {
    const { rows } = await properties[property].breaks(at).execute(db);
    found.push(...rows.map(row => ({ property, row })));
  }
  return found;
}

export type PlantProof = { readonly property: PropertyName; readonly plant: number; readonly atStart: readonly PropertyName[]; readonly reported: readonly PropertyName[] };

const plantCheckedAt: CheckedAt = { now: new Date(t0 + 60_000), everyMs: 1_000, startDeadlineMs: 2_000 };

const namesOf = (found: readonly Violation[]): readonly PropertyName[] => [...new Set(found.map(violation => violation.property))];

async function provePlant(postgres: TestPostgres, plant: Plant): Promise<Pick<PlantProof, 'atStart' | 'reported'>> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    for (const statement of [...world, ...plant.setup]) await statement.execute(db);
    const atStart = await violations(db, plantCheckedAt);
    await plant.violation.execute(db);
    return { atStart: namesOf(atStart), reported: namesOf(await violations(db, plantCheckedAt)) };
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
