import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';

type Moment = 'each-step' | 'after-quiet-phase';

type Statement = RawBuilder<unknown>;

type Plant = { readonly setup: readonly Statement[]; readonly violation: Statement };

type Property = { readonly moment: Moment; readonly breaks: Statement; readonly plants: readonly [Plant, ...Plant[]] };

const t0 = sql`timestamptz '2026-01-01T00:00:00Z'`;

export const simTables: readonly Statement[] = [
  sql`create table sim_owing (token uuid primary key, task_id bigint not null)`,
  sql`create table sim_effect (id bigint generated always as identity primary key, marker text not null, at timestamptz not null)`,
  sql`create table sim_claim (id bigint generated always as identity primary key, row_id bigint not null, performer text not null,
                              claimed_at timestamptz not null, lease_until timestamptz not null, released_at timestamptz)`,
  sql`create table sim_review (attempt_id bigint primary key, task_id bigint not null, decided_at timestamptz)`,
];

export const worldOf = (tasks: number): readonly Statement[] => [
  ...simTables,
  sql`insert into person (email, name) values ('ada@example.com', 'Ada')`,
  sql`with saved as (
        insert into human_action (id, at, person_id, kind, repository_id) values ('00000000-0000-4000-8000-000000000009', ${t0}, 1, 'add_repository', 1) returning id)
      insert into repository (github, branch, saved_by) select 'example/sandbox', 'main', id from saved`,
  sql`insert into routine (creator_id, run_as_id) values (1, 1)`,
  sql`insert into human_action (id, at, person_id, kind, routine_id) values ('00000000-0000-4000-8000-000000000001', ${t0}, 1, 'edit_routine', 1)`,
  sql`insert into routine_version (routine_id, version, name, goal, repository_id, action_id, workflow, source, needs_repository)
      values (1, 1, 'Outbox', 'Owe actions and perform them.', 1, '00000000-0000-4000-8000-000000000001', 'code-change', '{"kind": "schedule"}', true)`,
  sql`insert into task (routine_id, found_version, repository_id, key, title, found_at, workflow, needs_repository, step)
      select 1, 1, 1, 'SIM-' || n, 'Simulated task ' || n, ${t0}, 'code-change', true, 's1' from generate_series(1, ${sql.lit(tasks)}) n`,
];

const owing = (token: number) => sql.lit(`00000000-0000-4000-8000-${String(token).padStart(12, '0')}`);

const plantedMarker = (position: number) => sql.lit(`planted-marker-for-row-${String(position)}`);

const owedRow = (position: number) =>
  sql`insert into outbox (task_id, position, kind, payload, acts_as, idempotency_key, owed_at)
      values (1, ${sql.lit(position)}, 'sim.unkeyed', jsonb_build_object('owing', ${owing(position)}::text, 'text', 'Planted.'), 1, ${plantedMarker(position)}, ${t0})`;

const owedWithState = (position: number): readonly Statement[] => [owedRow(position), sql`insert into sim_owing (token, task_id) values (${owing(position)}, 1)`];

const reviewOpen: readonly Statement[] = [
  sql`insert into attempt (task_id, routine_id, routine_version, step, epoch, run_as_id, started_at, lease_until, finished_at, verdict, output)
      values (1, 1, 1, 's1', 0, 1, ${t0}, ${t0} + interval '30 seconds', ${t0} + interval '1 second', 'pass', '{"outcome": "done", "summary": "Planted.", "blocks": []}')`,
  sql`update task set state = 'waiting', waiting_on = 'approval', waiting_reason = 'Approve s1 to go on.', review_attempt = 1 where id = 1`,
  sql`insert into sim_review (attempt_id, task_id) values (1, 1)`,
];

const effectOf = (position: number) => sql`insert into sim_effect (marker, at) values (${plantedMarker(position)}, ${t0} + interval '1 second')`;

export const properties = {
  TypeOK: {
    moment: 'each-step',
    breaks: sql`select o.id, o.tries as count from outbox o where o.tries < 0
                union all select t.id, t.owed_actions from task t where t.owed_actions < 0`,
    plants: [{ setup: owedWithState(1), violation: sql`update outbox set tries = -1` }],
  },
  EffectAtMostOnce: {
    moment: 'each-step',
    breaks: sql`select e.marker, count(*) as effects from sim_effect e group by e.marker having count(*) > 1`,
    plants: [{ setup: [...owedWithState(1), effectOf(1)], violation: effectOf(1) }],
  },
  DoneMeansEffect: {
    moment: 'each-step',
    breaks: sql`select o.id, o.idempotency_key from outbox o
                where o.state = 'done' and not exists (select 1 from sim_effect e where e.marker = o.idempotency_key)`,
    plants: [{ setup: owedWithState(1), violation: sql`update outbox set state = 'done', result = '{}', settled_at = ${t0}` }],
  },
  NoEffectWithoutOwingState: {
    moment: 'each-step',
    breaks: sql`select e.id, e.marker from sim_effect e left join outbox o on o.idempotency_key = e.marker
                where o.id is null or not exists (select 1 from sim_owing w where w.token::text = o.payload ->> 'owing')`,
    plants: [
      { setup: [owedRow(1)], violation: effectOf(1) },
      { setup: owedWithState(1), violation: sql`insert into sim_effect (marker, at) values ('a-marker-no-row-holds-at-all', ${t0})` },
    ],
  },
  ActionsInOrderPerTask: {
    moment: 'each-step',
    breaks: sql`select o.id, earlier.id as earlier from outbox o
                join outbox earlier on earlier.task_id = o.task_id and earlier.position < o.position
                where exists (select 1 from sim_effect e where e.marker = o.idempotency_key)
                  and not exists (select 1 from sim_effect e where e.marker = earlier.idempotency_key)
                  and not (earlier.state in ('dropped', 'refused') and earlier.settled_at < o.owed_at)`,
    plants: [{ setup: [...owedWithState(1), ...owedWithState(2)], violation: effectOf(2) }],
  },
  NextStageWaitsForOwedActions: {
    moment: 'each-step',
    breaks: sql`select a.id as attempt, o.id as row from attempt a join outbox o on o.task_id = a.task_id
                where a.finished_at is null and o.owed_at < a.started_at and o.state in ('owed', 'failed')`,
    plants: [
      {
        setup: [...owedWithState(1), sql`update task set owed_actions = 0`],
        violation: sql`insert into attempt (task_id, routine_id, routine_version, step, epoch, run_as_id, started_at, lease_until)
                       values (1, 1, 1, 's1', 0, 1, ${t0} + interval '1 second', ${t0} + interval '31 seconds')`,
      },
    ],
  },
  OneLivePerformerPerRow: {
    moment: 'each-step',
    breaks: sql`select a.row_id, a.performer, b.performer as other from sim_claim a
                join sim_claim b on b.row_id = a.row_id and b.id > a.id
                where b.claimed_at < least(a.lease_until, coalesce(a.released_at, 'infinity'))`,
    plants: [
      {
        setup: [...owedWithState(1), sql`insert into sim_claim (row_id, performer, claimed_at, lease_until) values (1, 'p1', ${t0}, ${t0} + interval '5 seconds')`],
        violation: sql`insert into sim_claim (row_id, performer, claimed_at, lease_until) values (1, 'p2', ${t0} + interval '1 second', ${t0} + interval '6 seconds')`,
      },
    ],
  },
  ReviewKeptUntilDecided: {
    moment: 'each-step',
    breaks: sql`select r.attempt_id, r.task_id, t.state, t.waiting_on from sim_review r join task t on t.id = r.task_id
                where r.decided_at is null
                  and not (t.state = 'waiting' and t.waiting_on = 'approval' and t.review_attempt = r.attempt_id)`,
    plants: [{ setup: reviewOpen, violation: sql`update task set waiting_on = 'retry', review_attempt = null where id = 1` }],
  },
  EveryOwedActionSettles: {
    moment: 'after-quiet-phase',
    breaks: sql`select o.id, o.state, t.state as task from outbox o join task t on t.id = o.task_id
                where (o.state = 'owed' or (o.state = 'failed' and t.state = 'ready')) and t.state <> 'waiting'`,
    plants: [
      { setup: [], violation: owedRow(1) },
      {
        setup: [...owedWithState(1), sql`update outbox set state = 'failed', last_error = 'Planted.', settled_at = ${t0}`],
        violation: sql`update task set state = 'ready', waiting_on = null, waiting_reason = null`,
      },
    ],
  },
} satisfies Readonly<Record<string, Property>>;

export type PropertyName = keyof typeof properties;

export type Violation = { readonly property: PropertyName; readonly row: unknown };

export type PlantProof = { readonly property: PropertyName; readonly plant: number; readonly atStart: readonly PropertyName[]; readonly reported: readonly PropertyName[] };

const isPropertyName = (name: unknown): name is PropertyName => typeof name === 'string' && Object.hasOwn(properties, name);

const propertyNames = Object.keys(properties).filter(isPropertyName);

const violations = z.array(z.object({ property: z.custom<PropertyName>(isPropertyName), row: z.unknown() }));

const checkAt = (moment: Moment) =>
  sql.join(
    propertyNames
      .filter(name => properties[name].moment === moment)
      .map(name => sql`select ${sql.lit(name)} as property, to_jsonb(v) as row from (${properties[name].breaks}) v`),
    sql` union all `,
  );

export async function check(db: Database, moment: Moment): Promise<readonly Violation[]> {
  return violations.parse((await sql`${checkAt(moment)}`.execute(db)).rows);
}

const namesOf = (found: readonly Violation[]): readonly PropertyName[] => [...new Set(found.map(violation => violation.property))];

async function provePlant(postgres: TestPostgres, moment: Moment, plant: Plant): Promise<Pick<PlantProof, 'atStart' | 'reported'>> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    for (const statement of [...worldOf(1), ...plant.setup]) await statement.execute(db);
    const atStart = await check(db, moment);
    await plant.violation.execute(db);
    return { atStart: namesOf(atStart), reported: namesOf(await check(db, moment)) };
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

export async function provePlants(postgres: TestPostgres): Promise<readonly PlantProof[]> {
  const proofs: PlantProof[] = [];
  for (const property of propertyNames) {
    const { moment, plants } = properties[property];
    for (const [index, plant] of plants.entries()) proofs.push({ property, plant: index + 1, ...(await provePlant(postgres, moment, plant)) });
  }
  return proofs;
}
