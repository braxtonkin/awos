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
  sql`create table sim_sent (row uuid primary key, request uuid not null, fate text not null)`,
  sql`create table sim_handled (row uuid not null, engine int not null)`,
];

export const world: readonly Statement[] = [
  ...simTables,
  sql`insert into person (email, name) values ('ada@example.com', 'Ada')`,
  sql`insert into routine (creator_id) values (1), (1)`,
  sql`insert into human_action (id, at, person_id, kind, routine_id) values
      ('00000000-0000-4000-8000-000000000001', ${t0}, 1, 'edit_routine', 1),
      ('00000000-0000-4000-8000-000000000002', ${t0}, 1, 'edit_routine', 2)`,
  sql`insert into routine_version (routine_id, version, name, goal, every, action_id, workflow, source, needs_repository)
      values (1, 1, 'First', 'Hold requests.', interval '1 minute', '00000000-0000-4000-8000-000000000001', 'post', '{"kind": "tickets"}', false),
             (2, 1, 'Second', 'Hold requests.', interval '1 minute', '00000000-0000-4000-8000-000000000002', 'post', '{"kind": "tickets"}', false)`,
  sql`insert into task (routine_id, found_version, key, title, found_at, assignee_account_id, workflow, needs_repository, step)
      values (1, 1, 'T-1', 'First', ${t0}, null, 'post', false, 'post'), (2, 1, 'T-2', 'Second', ${t0}, null, 'post', false, 'post')`,
  sql`with saved as (insert into human_action (id, at, person_id, kind, repository_id) values ('00000000-0000-4000-8000-000000000003', ${t0}, 1, 'add_repository', 1) returning id)
      insert into repository (github, branch, saved_by) select 'example/sandbox', 'main', id from saved`,
];

const asked = (id: string, position: number) =>
  sql`insert into person_request (id, person_id, at, kind, payload, task_id, position) values (${sql.lit(id)}, 1, ${t0}, 'stop', '{}', 1, ${sql.lit(position)})`;

const refused = (id: string) => sql`update person_request set answer = 'refused', answered_at = ${t0}, reason = 'Planted.' where id = ${sql.lit(id)}`;

const keepPlaces = sql`drop trigger request_takes_next_place on person_request`;

const first = '00000000-0000-4000-8000-0000000000a1';

const second = '00000000-0000-4000-8000-0000000000a2';

export const properties = {
  TypeOK: {
    moment: 'each-step',
    breaks: sql`select id, position from person_request where position < 1`,
    plants: [{ setup: [sql`alter table person_request drop constraint position_counts_from_one`, keepPlaces], violation: asked(first, 0) }],
  },
  RequestAppliedOnce: {
    moment: 'each-step',
    breaks: sql`select s.request, count(*) as runs from sim_handled h join sim_sent s on s.row = h.row group by s.request having count(*) > 1`,
    plants: [
      {
        setup: [asked(first, 1), sql`insert into sim_sent values (${sql.lit(first)}, ${sql.lit(first)}, 'record')`, sql`insert into sim_handled values (${sql.lit(first)}, 1)`],
        violation: sql`insert into sim_handled values (${sql.lit(first)}, 2)`,
      },
    ],
  },
  RequestsApplyInOrder: {
    moment: 'each-step',
    breaks: sql`select r.target, r.position, o.position as open_below from person_request r
        join person_request o on o.target = r.target and o.position < r.position
        where r.answer is not null and o.answer is null`,
    plants: [{ setup: [asked(first, 1), asked(second, 2)], violation: refused(second) }],
  },
  OnePlacePerRequest: {
    moment: 'each-step',
    breaks: sql`select target, position, count(*) as requests from person_request group by target, position having count(*) > 1`,
    plants: [{ setup: [sql`alter table person_request drop constraint one_request_per_position`, keepPlaces, asked(first, 1)], violation: asked(second, 1) }],
  },
  AnswerIsFinal: {
    moment: 'each-step',
    breaks: sql`select r.id, p.answer as was, r.answer as now, p.reason as said, r.reason as says from person_request r join prior_answers p on p.id = r.id
      where (r.answer, r.reason, r.answered_at) is distinct from (p.answer, p.reason, p.answered_at)`,
    plants: [
      {
        setup: [sql`drop trigger answer_is_final on person_request`, asked(first, 1), refused(first)],
        violation: sql`update person_request set reason = 'Changed.' where id = ${sql.lit(first)}`,
      },
    ],
  },
  EveryRequestAnswered: {
    moment: 'after-quiet-phase',
    breaks: sql`select id, kind, target, position from person_request where answer is null`,
    plants: [{ setup: [], violation: asked(first, 1) }],
  },
} satisfies Readonly<Record<string, Property>>;

export type PropertyName = keyof typeof properties;

export type Violation = { readonly property: PropertyName; readonly row: unknown };

export type Watch = {
  readonly atStart: readonly Violation[];
  readonly step: () => Promise<readonly Violation[]>;
  readonly settled: () => Promise<readonly Violation[]>;
};

export type PlantProof = { readonly property: PropertyName; readonly plant: number; readonly atStart: readonly PropertyName[]; readonly reported: readonly PropertyName[] };

const isPropertyName = (name: unknown): name is PropertyName => typeof name === 'string' && Object.hasOwn(properties, name);

const propertyNames = Object.keys(properties).filter(isPropertyName);

const violations = z.array(z.object({ property: z.custom<PropertyName>(isPropertyName), row: z.unknown() }));

const answers = z.array(z.object({ id: z.string(), answer: z.string(), reason: z.string().nullable(), answered_at: z.date() }));

type Answers = z.infer<typeof answers>;

const branches = (moment: Moment) =>
  sql.join(
    propertyNames.filter(name => properties[name].moment === moment).map(name => sql`select ${sql.lit(name)} as property, to_jsonb(v) as row from (${properties[name].breaks}) v`),
    sql` union all `,
  );

async function check(db: Database, moment: Moment, before: Answers): Promise<readonly Violation[]> {
  const { rows } = await sql`with prior_answers as (select * from jsonb_to_recordset(${JSON.stringify(before)}::jsonb) as p(id uuid, answer request_answer, reason text, answered_at timestamptz))
    ${branches(moment)}`.execute(db);
  return violations.parse(rows);
}

async function answersOf(db: Database): Promise<Answers> {
  const rows = await db.selectFrom('person_request').select(['id', 'answer', 'reason', 'answered_at']).where('answer', 'is not', null).execute();
  return answers.parse(rows);
}

export async function watch(db: Database): Promise<Watch> {
  let before: Answers = [];
  const step = async (): Promise<readonly Violation[]> => {
    const found = await check(db, 'each-step', before);
    before = await answersOf(db);
    return found;
  };
  const atStart = await step();
  return { atStart, step, settled: () => check(db, 'after-quiet-phase', before) };
}

const namesOf = (found: readonly Violation[]): readonly PropertyName[] => [...new Set(found.map(violation => violation.property))];

async function provePlant(postgres: TestPostgres, moment: Moment, plant: Plant): Promise<Pick<PlantProof, 'atStart' | 'reported'>> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    for (const statement of [...world, ...plant.setup]) await statement.execute(db);
    const watched = await watch(db);
    const atStart = moment === 'each-step' ? watched.atStart : await watched.settled();
    await plant.violation.execute(db);
    const reported = moment === 'each-step' ? await watched.step() : await watched.settled();
    return { atStart: namesOf(atStart), reported: namesOf(reported) };
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
