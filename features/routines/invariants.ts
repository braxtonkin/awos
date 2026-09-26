import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { slotOrigin } from '../../shared/slots.ts';

type Moment = 'each-step' | 'after-quiet-phase';

type Statement = RawBuilder<unknown>;

type Plant = { readonly setup: readonly Statement[]; readonly violation: Statement };

type Property = { readonly moment: Moment; readonly breaks: Statement; readonly plants: readonly [Plant, ...Plant[]] };

const t0 = sql`timestamptz '2026-01-01T00:00:00Z'`;

const plantedAt = new Date('2026-01-01T00:00:30.000Z');

const plantedSlackMs = 10_000;

const since = sql`${sql.lit(slotOrigin.toISOString())}::timestamptz`;

export const ticketTable = sql`create table sim_ticket (key text primary key, assignee text, changed_at timestamptz not null, routines bigint[] not null)`;

const world: readonly Statement[] = [
  ticketTable,
  sql`insert into person (email, name, jira_account_id) values ('ada@example.com', 'Ada', 'acc-ada')`,
  sql`insert into routine (creator_id) values (1), (1)`,
  sql`insert into human_action (id, at, person_id, kind, routine_id) values
      ('00000000-0000-4000-8000-000000000001', ${t0}, 1, 'edit_routine', 1),
      ('00000000-0000-4000-8000-000000000002', ${t0}, 1, 'edit_routine', 2)`,
  sql`insert into routine_version (routine_id, version, name, goal, every, action_id, workflow, source, needs_repository)
      values (1, 1, 'First', 'Plant one property at a time.', interval '1 minute', '00000000-0000-4000-8000-000000000001', 'post', '{"kind": "tickets"}', false),
             (2, 1, 'Second', 'Plant one property at a time.', interval '1 minute', '00000000-0000-4000-8000-000000000002', 'post', '{"kind": "tickets"}', false)`,
];

const doneRun = (routine: number, slotSeconds: number, claim = '00000000-0000-4000-8000-00000000aaaa') =>
  sql`insert into routine_run (routine_id, version, reason, slot, claim, claimed_at, started_at, lease_until, finished_at, finished_by, outcome)
      values (${sql.lit(routine)}, 1, 'schedule', ${t0} + ${sql.lit(`${String(slotSeconds)} seconds`)}::interval, ${sql.lit(claim)}, ${t0}, ${t0}, ${t0} + interval '1 minute',
              ${t0} + interval '1 second', ${sql.lit(claim)}, 'done')`;

const liveRun = (slotSeconds: number) =>
  sql`insert into routine_run (routine_id, version, reason, slot, claim, claimed_at, started_at, lease_until)
      values (1, 1, 'schedule', ${t0} + ${sql.lit(`${String(slotSeconds)} seconds`)}::interval, gen_random_uuid(), ${t0} + interval '30 seconds', ${t0} + interval '30 seconds', ${t0} + interval '90 seconds')`;

const press = (id: string, seconds: number) => [
  sql`insert into human_action (id, at, person_id, kind, routine_id) values (${sql.lit(id)}, ${t0} + ${sql.lit(`${String(seconds)} seconds`)}::interval, 1, 'run_now', 1)`,
  sql`insert into routine_run (routine_id, version, reason, pressed_by) values (1, 1, 'run_now', ${sql.lit(id)})`,
];

const task = (routine: number) =>
  sql`insert into task (routine_id, found_version, key, title, found_at, assignee_account_id, workflow, needs_repository, step)
      values (${sql.lit(routine)}, 1, 'T-1', 'Planted', ${t0}, 'acc-ada', 'post', false, 'post')`;

export const properties = {
  TypeOK: {
    moment: 'each-step',
    breaks: sql`select id, covers, found from routine_run where covers < 1 or found < 0`,
    plants: [{ setup: [sql`alter table routine_run drop constraint counts_are_whole`, liveRun(0)], violation: sql`update routine_run set covers = 0 where id = 1` }],
  },
  OneRunPerSlot: {
    moment: 'each-step',
    breaks: sql`select 'two runs of one slot' as why, routine_id, slot from routine_run where slot is not null group by routine_id, slot having count(*) > 1
      union all
      select 'two live runs of one routine', r.routine_id, null::timestamptz from routine_run r, checked
      where r.finished_at is null and r.claim is not null and r.lease_until >= checked.at group by r.routine_id having count(*) > 1
      union all
      select 'finished under a claim it no longer held', routine_id, slot from routine_run where finished_at is not null and finished_by is distinct from claim`,
    plants: [
      { setup: [sql`alter table routine_run drop constraint one_run_per_slot`, doneRun(1, 0)], violation: doneRun(1, 0) },
      { setup: [sql`drop index one_live_run_per_routine`, liveRun(0)], violation: liveRun(60) },
      {
        setup: [sql`alter table routine_run drop constraint run_finishes_under_its_claim`, liveRun(0)],
        violation: sql`update routine_run set finished_at = ${t0} + interval '31 seconds', finished_by = gen_random_uuid(), outcome = 'done' where id = 1`,
      },
    ],
  },
  RunNowRunsOnce: {
    moment: 'each-step',
    breaks: sql`select first.routine_id, first.id as first, second.id as second
      from routine_run first join human_action first_press on first_press.id = first.pressed_by
      join routine_run second on second.routine_id = first.routine_id and second.id <> first.id
      join human_action second_press on second_press.id = second.pressed_by
      where first_press.at <= second_press.at and second_press.at < coalesce(first.started_at, 'infinity')`,
    plants: [
      {
        setup: [sql`drop index one_waiting_press_per_routine`, ...press('00000000-0000-4000-8000-0000000000a1', 1)],
        violation: sql`with pressed as (insert into human_action (id, at, person_id, kind, routine_id) values ('00000000-0000-4000-8000-0000000000a2', ${t0} + interval '2 seconds', 1, 'run_now', 1) returning id)
          insert into routine_run (routine_id, version, reason, pressed_by) select 1, 1, 'run_now', id from pressed`,
      },
    ],
  },
  OneTaskPerTicket: {
    moment: 'each-step',
    breaks: sql`select 'two tasks for one ticket' as why, key, null::bigint as was, null::bigint as now from task group by key having count(*) > 1
      union all
      select 'a task moved to another routine', t.key, p.routine_id, t.routine_id from task t join prior_tasks p on p.id = t.id where p.routine_id <> t.routine_id`,
    plants: [
      { setup: [sql`alter table task drop constraint one_task_per_key`, task(1)], violation: task(2) },
      { setup: [sql`drop trigger routines_task_keeps_its_routine on task`, task(1)], violation: sql`update task set routine_id = 2 where key = 'T-1'` },
    ],
  },
  AssigneeFollowsTicket: {
    moment: 'each-step',
    breaks: sql`select t.key, t.routine_id, t.assignee_account_id as shown, k.assignee as current
      from task t join sim_ticket k on k.key = t.key
      where t.assignee_account_id is distinct from k.assignee and t.routine_id = any (k.routines)
        and exists (select 1 from routine_run r where r.routine_id = t.routine_id and r.outcome = 'done' and r.finished_at >= k.changed_at)`,
    plants: [
      {
        setup: [task(1), sql`insert into sim_ticket values ('T-1', 'acc-ada', ${t0}, '{1, 2}')`, doneRun(1, 0)],
        violation: sql`update sim_ticket set assignee = 'acc-bo' where key = 'T-1'`,
      },
    ],
  },
  PausedRoutineStartsNoRun: {
    moment: 'each-step',
    breaks: sql`select s.id, s.routine_id, pause.at as paused_at, s.claimed_at from started s join routine on routine.id = s.routine_id join human_action pause on pause.id = routine.paused_by where pause.at <= s.claimed_at`,
    plants: [
      {
        setup: [
          sql`drop trigger run_claims_an_active_routine on routine_run`,
          sql`insert into human_action (id, at, person_id, kind, routine_id) values ('00000000-0000-4000-8000-0000000000b1', ${t0}, 1, 'pause_routine', 1)`,
          sql`update routine set paused_by = '00000000-0000-4000-8000-0000000000b1' where id = 1`,
        ],
        violation: liveRun(0),
      },
    ],
  },
  MissedSlotsCollapse: {
    moment: 'each-step',
    breaks: sql`select s.id, s.routine_id, s.slot from started s
      join routine_version v on v.routine_id = s.routine_id and v.version = s.version, checked
      where s.slot < date_bin(v.every, checked.before, ${since})`,
    plants: [{ setup: [], violation: liveRun(-60) }],
  },
  DueSlotsRun: {
    moment: 'after-quiet-phase',
    breaks: sql`select r.id as routine_id, due.slot from routine r, checked,
        lateral (select date_bin(v.every, checked.at - checked.slack, ${since}) as slot from routine_version v where v.routine_id = r.id order by v.version desc limit 1) due
      where r.paused_by is null
        and (not exists (select 1 from routine_run x where x.routine_id = r.id and x.slot = due.slot and x.outcome in ('done', 'failed'))
             or exists (select 1 from routine_run x where x.routine_id = r.id and x.finished_at is null))`,
    plants: [{ setup: [doneRun(1, 0), doneRun(2, 0, '00000000-0000-4000-8000-00000000bbbb')], violation: liveRun(60) }],
  },
  RunFinishesWithinItsLease: {
    moment: 'each-step',
    breaks: sql`select id, routine_id, outcome, lease_until, finished_at from routine_run where outcome <> 'lost' and finished_at > lease_until`,
    plants: [
      {
        setup: [sql`alter table routine_run drop constraint run_finishes_within_its_lease`, liveRun(0)],
        violation: sql`update routine_run set finished_at = ${t0} + interval '91 seconds', finished_by = claim, outcome = 'done' where id = 1`,
      },
    ],
  },
} satisfies Readonly<Record<string, Property>>;

export type PropertyName = keyof typeof properties;

export type Violation = { readonly property: PropertyName; readonly row: unknown };

export type Watch = {
  readonly atStart: readonly Violation[];
  readonly step: (checkedAt: Date) => Promise<readonly Violation[]>;
  readonly settled: (checkedAt: Date) => Promise<readonly Violation[]>;
};

export type PlantProof = { readonly property: PropertyName; readonly plant: number; readonly atStart: readonly PropertyName[]; readonly reported: readonly PropertyName[] };

const isPropertyName = (name: unknown): name is PropertyName => typeof name === 'string' && Object.hasOwn(properties, name);

const propertyNames = Object.keys(properties).filter(isPropertyName);

const violations = z.array(z.object({ property: z.custom<PropertyName>(isPropertyName), row: z.unknown() }));

const snapshot = z.object({ runs: z.array(z.object({ id: z.string(), claim: z.string() })), tasks: z.array(z.object({ id: z.string(), routine_id: z.string() })), checkedAt: z.iso.datetime().nullable() });

type Snapshot = z.infer<typeof snapshot>;

const empty: Snapshot = { runs: [], tasks: [], checkedAt: null };

const helpers = (before: Snapshot, checkedAt: Date, slackMs: number) => sql`
  checked (at, slack, before) as (select ${checkedAt}::timestamptz, make_interval(secs => ${slackMs / 1000}), coalesce(${before.checkedAt}::timestamptz, '-infinity')),
  prior_runs as (select * from jsonb_to_recordset(${JSON.stringify(before.runs)}::jsonb) as p(id bigint, claim uuid)),
  prior_tasks as (select * from jsonb_to_recordset(${JSON.stringify(before.tasks)}::jsonb) as p(id bigint, routine_id bigint)),
  started as (
    select r.* from routine_run r left join prior_runs p on p.id = r.id
    where r.claim is not null and p.claim is distinct from r.claim)`;

const branches = (moment: Moment) =>
  sql.join(
    propertyNames.filter(name => properties[name].moment === moment).map(name => sql`select ${sql.lit(name)} as property, to_jsonb(v) as row from (${properties[name].breaks}) v`),
    sql` union all `,
  );

async function check(db: Database, moment: Moment, before: Snapshot, checkedAt: Date, slackMs: number): Promise<readonly Violation[]> {
  const { rows } = await sql`with ${helpers(before, checkedAt, slackMs)} ${branches(moment)}`.execute(db);
  return violations.parse(rows);
}

async function snapshotOf(db: Database): Promise<Omit<Snapshot, 'checkedAt'>> {
  const { rows } = await sql<{ state: unknown }>`select jsonb_build_object(
      'runs', coalesce((select jsonb_agg(jsonb_build_object('id', id::text, 'claim', claim)) from routine_run where claim is not null), '[]'),
      'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', id::text, 'routine_id', routine_id::text)) from task), '[]')) as state`.execute(db);
  return snapshot.omit({ checkedAt: true }).parse(rows[0]?.state);
}

export async function watch(db: Database, startedAt: Date, slackMs: number): Promise<Watch> {
  let before = empty;
  const step = async (checkedAt: Date): Promise<readonly Violation[]> => {
    const found = await check(db, 'each-step', before, checkedAt, slackMs);
    before = { ...(await snapshotOf(db)), checkedAt: checkedAt.toISOString() };
    return found;
  };
  const atStart = await step(startedAt);
  return { atStart, step, settled: checkedAt => check(db, 'after-quiet-phase', before, checkedAt, slackMs) };
}

const namesOf = (found: readonly Violation[]): readonly PropertyName[] => [...new Set(found.map(violation => violation.property))];

async function provePlant(postgres: TestPostgres, moment: Moment, plant: Plant): Promise<Pick<PlantProof, 'atStart' | 'reported'>> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    for (const statement of [...world, ...plant.setup]) await statement.execute(db);
    const watched = await watch(db, plantedAt, plantedSlackMs);
    const atStart = moment === 'each-step' ? watched.atStart : await watched.settled(plantedAt);
    await plant.violation.execute(db);
    const reported = moment === 'each-step' ? await watched.step(plantedAt) : await watched.settled(plantedAt);
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
