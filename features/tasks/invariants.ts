import { expressionBuilder, sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import type { DB, Stage } from '../../shared/db/types.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { caps } from './claim.ts';
import { nobodyToRunAs, runAs } from './run-as.ts';

type Moment = 'each-step' | 'after-quiet-phase';

type Statement = RawBuilder<unknown>;

type Plant = { readonly setup: readonly Statement[]; readonly violation: Statement };

type Property = { readonly moment: Moment; readonly breaks: Statement; readonly plants: readonly [Plant, ...Plant[]] };

const t0 = sql`timestamptz '2026-01-01T00:00:00Z'`;

const world: readonly Statement[] = [
  sql`insert into person (email, name, jira_account_id) values ('ada@example.com', 'Ada', 'acc-ada')`,
  sql`insert into repository (github, branch) values ('example/sandbox', 'main')`,
  sql`insert into routine (creator_id, run_as_id) values (1, 1)`,
  sql`insert into human_action (id, at, person_id, kind, routine_id) values ('00000000-0000-4000-8000-000000000001', ${t0}, 1, 'edit_routine', 1)`,
  sql`insert into routine_version (routine_id, version, name, goal, schedule, repository_id, action_id)
      values (1, 1, 'Plants', 'Break one property at a time.', '0 0 * * *', 1, '00000000-0000-4000-8000-000000000001')`,
  sql`insert into task (routine_id, found_version, repository_id, key, title, found_at, assignee_account_id) values (1, 1, 1, 'PLANT-1', 'Plant', ${t0}, 'acc-ada')`,
];

const nobodyCanRunTheTask: readonly Statement[] = [
  sql`update routine set run_as_id = null where id = 1`,
  sql`update task set assignee_account_id = 'acc-nobody' where id = 1`,
];

const waitingForAPerson = sql.lit(nobodyToRunAs);

const liveAttempt = sql`insert into attempt (task_id, routine_id, routine_version, stage, run_as_id, started_at, lease_until)
  values (1, 1, 1, 'specify', 1, ${t0} + interval '1 second', ${t0} + interval '31 seconds')`;

const liveAttemptAsNobody = sql`insert into attempt (task_id, routine_id, routine_version, stage, run_as_id, started_at, lease_until)
  values (1, 1, 1, 'specify', null, ${t0} + interval '1 second', ${t0} + interval '31 seconds')`;

const finishedAttempt = (stage: Stage, verdict: 'pass' | 'lost') => sql`insert into attempt
  (task_id, routine_id, routine_version, stage, run_as_id, started_at, lease_until, finished_at, verdict, output)
  values (1, 1, 1, ${sql.lit(stage)}, 1, ${t0}, ${t0} + interval '30 seconds', ${t0} + interval '10 seconds', ${sql.lit(verdict)}, ${verdict === 'pass' ? sql`'{}'` : sql`null`})`;

const personActs = (kind: 'stop_task' | 'retry_task', id: string) =>
  sql`insert into human_action (id, at, person_id, kind, task_id) values (${sql.lit(id)}, ${t0} + interval '2 seconds', 1, ${sql.lit(kind)}, 1)`;

const record = sql`s.stage, s.state, s.rounds, s.reruns, s.lost, s.retries, s.outputs`;

const wasRecord = sql`s.was_stage, s.was_state, s.was_rounds, s.was_reruns, s.was_lost, s.was_retries, s.was_outputs`;

export const properties = {
  TypeOK: {
    moment: 'each-step',
    breaks: sql`select id, rounds, reruns, lost, retries from task where least(rounds, reruns, lost, retries) < 0`,
    plants: [{ setup: [], violation: sql`update task set lost = -1 where id = 1` }],
  },
  OneLiveAttempt: {
    moment: 'each-step',
    breaks: sql`select task_id, array_agg(id order by id) as live from attempt where finished_at is null group by task_id having count(*) > 1`,
    plants: [{ setup: [sql`drop index one_live_attempt_per_task`, liveAttempt], violation: liveAttempt }],
  },
  LiveAttemptMeansReady: {
    moment: 'each-step',
    breaks: sql`select a.id as attempt, a.task_id, t.state
      from attempt a join task t on t.id = a.task_id
      where a.finished_at is null and t.state <> 'ready'`,
    plants: [
      {
        setup: [sql`alter table attempt drop constraint live_attempt_matches_ready_task`, liveAttempt],
        violation: sql`update task set state = 'waiting', waiting_reason = 'Planted.' where id = 1`,
      },
    ],
  },
  LiveAttemptIsCurrent: {
    moment: 'each-step',
    breaks: sql`select a.id as attempt, h.id as action
      from attempt a join human_action h on h.task_id = a.task_id
      where a.finished_at is null and h.at > a.started_at`,
    plants: [{ setup: [liveAttempt], violation: personActs('retry_task', '00000000-0000-4000-8000-000000000002') }],
  },
  OutputsSurvive: {
    moment: 'each-step',
    breaks: sql`select t.id, s.stage as missing
      from task t cross join unnest(enum_range(null::stage)) as s(stage)
      where s.stage < t.stage
        and not exists (select 1 from attempt a where a.task_id = t.id and a.stage = s.stage and a.verdict = 'pass')`,
    plants: [{ setup: [], violation: sql`update task set stage = 'implement' where id = 1` }],
  },
  RoundsCapped: {
    moment: 'each-step',
    breaks: sql`select id, rounds from task where rounds > ${sql.lit(caps.rounds)}`,
    plants: [{ setup: [], violation: sql`update task set rounds = ${sql.lit(caps.rounds + 1)} where id = 1` }],
  },
  EnvRerunsCapped: {
    moment: 'each-step',
    breaks: sql`select id, reruns from task where reruns > ${sql.lit(caps.reruns)}`,
    plants: [{ setup: [], violation: sql`update task set reruns = ${sql.lit(caps.reruns + 1)} where id = 1` }],
  },
  LostAttemptsCapped: {
    moment: 'each-step',
    breaks: sql`select id, lost from task where lost > ${sql.lit(caps.lost)}`,
    plants: [{ setup: [], violation: sql`update task set lost = ${sql.lit(caps.lost + 1)} where id = 1` }],
  },
  StageRetriesCapped: {
    moment: 'each-step',
    breaks: sql`select id, retries from task where retries > ${sql.lit(caps.stageRetries)}`,
    plants: [{ setup: [], violation: sql`update task set retries = ${sql.lit(caps.stageRetries + 1)} where id = 1` }],
  },
  PassLeavesNoStageRetries: {
    moment: 'each-step',
    breaks: sql`select t.id, t.retries, latest.id as attempt
      from task t
      cross join lateral (
        select a.id, a.verdict from attempt a
        where a.task_id = t.id and a.finished_at is not null
        order by a.finished_at desc, a.id desc
        limit 1
      ) latest
      where t.retries > 0 and latest.verdict = 'pass'`,
    plants: [{ setup: [finishedAttempt('specify', 'pass')], violation: sql`update task set retries = 1 where id = 1` }],
  },
  AttemptRunsAsAPerson: {
    moment: 'each-step',
    breaks: sql`select id, task_id from attempt where run_as_id is null`,
    plants: [{ setup: [sql`alter table attempt drop constraint attempt_runs_as_a_person`], violation: liveAttemptAsNobody }],
  },
  LiveAttemptWorksTheTaskStage: {
    moment: 'each-step',
    breaks: sql`select a.id as attempt, a.task_id, a.stage as attempt_stage, t.stage
      from attempt a join task t on t.id = a.task_id
      where a.finished_at is null and a.stage <> t.stage`,
    plants: [
      {
        setup: [sql`alter table attempt drop constraint live_attempt_matches_ready_task`, liveAttempt],
        violation: sql`update task set stage = 'implement' where id = 1`,
      },
    ],
  },
  LateWriteChangesNothing: {
    moment: 'each-step',
    breaks: sql`select w.id, w.verdict, w.finished_at from written w, prior p where w.id <= p.max_attempt and w.id <> all(p.live)`,
    plants: [
      {
        setup: [sql`drop trigger finished_attempt_is_final on attempt`, finishedAttempt('specify', 'lost')],
        violation: sql`update attempt set verdict = 'pass', output = '{}' where id = 1`,
      },
    ],
  },
  TaskChangesOnlyWithItsAttempt: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_state, s.state, s.was_stage, s.stage from step s
      where (${record}) is distinct from (${wasRecord})
        and s.id not in (select task_id from ended)
        and s.id not in (select task_id from acted)
        and not (s.was_state = 'ready' and s.state = 'waiting' and s.waiting_reason = ${waitingForAPerson}
                 and not s.was_live and s.runs_as is null
                 and (s.stage, s.rounds, s.reruns, s.lost, s.retries, s.outputs)
                     = (s.was_stage, s.was_rounds, s.was_reruns, s.was_lost, s.was_retries, s.was_outputs))`,
    plants: [
      { setup: [], violation: sql`update task set state = 'waiting', waiting_reason = ${waitingForAPerson} where id = 1` },
      {
        setup: [sql`alter table attempt drop constraint live_attempt_matches_ready_task`, liveAttempt, ...nobodyCanRunTheTask],
        violation: sql`update task set state = 'waiting', waiting_reason = ${waitingForAPerson} where id = 1`,
      },
      {
        setup: [
          personActs('stop_task', '00000000-0000-4000-8000-000000000005'),
          sql`update task set state = 'stopped', stopped_by = '00000000-0000-4000-8000-000000000005' where id = 1`,
          ...nobodyCanRunTheTask,
        ],
        violation: sql`update task set state = 'waiting', waiting_reason = ${waitingForAPerson}, stopped_by = null where id = 1`,
      },
      { setup: nobodyCanRunTheTask, violation: sql`update task set state = 'waiting', waiting_reason = ${waitingForAPerson}, lost = 1 where id = 1` },
      { setup: nobodyCanRunTheTask, violation: sql`update task set state = 'waiting', waiting_reason = 'Planted.' where id = 1` },
    ],
  },
  AttemptEndsOnlyWithItsTask: {
    moment: 'each-step',
    breaks: sql`select e.id as attempt, e.task_id from ended e join step s on s.id = e.task_id
      where (${record}) is not distinct from (${wasRecord}) and e.task_id not in (select task_id from acted)`,
    plants: [{ setup: [liveAttempt], violation: sql`update attempt set finished_at = ${t0} + interval '5 seconds', verdict = 'fail' where id = 1` }],
  },
  FailedRoundReturnsToImplement: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_rounds, s.rounds, s.stage, s.state from step s
      where s.rounds > s.was_rounds and not (s.stage = 'implement' or s.state = 'waiting')`,
    plants: [{ setup: [], violation: sql`update task set rounds = 1 where id = 1` }],
  },
  OutputsOnlyGrow: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_outputs, s.outputs from step s where not (s.was_outputs <@ s.outputs)`,
    plants: [
      {
        setup: [sql`drop trigger finished_attempt_is_final on attempt`, finishedAttempt('specify', 'pass')],
        violation: sql`update attempt set verdict = 'lost', output = null where id = 1`,
      },
    ],
  },
  StageAdvancesOnlyOnPass: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_stage, s.stage, s.was_state, s.state from step s
      where (s.stage > s.was_stage or (s.state = 'done' and s.was_state <> 'done'))
        and not exists (select 1 from ended e where e.task_id = s.id and e.verdict = 'pass')`,
    plants: [{ setup: [finishedAttempt('specify', 'pass')], violation: sql`update task set stage = 'implement' where id = 1` }],
  },
  DoneIsFinal: {
    moment: 'each-step',
    breaks: sql`select s.id, s.stage, s.state from step s where s.was_state = 'done' and (${record}) is distinct from (${wasRecord})`,
    plants: [
      {
        setup: [
          finishedAttempt('specify', 'pass'),
          finishedAttempt('implement', 'pass'),
          finishedAttempt('verify', 'pass'),
          finishedAttempt('land', 'pass'),
          sql`update task set stage = 'land', state = 'done' where id = 1`,
        ],
        violation: sql`update task set state = 'ready' where id = 1`,
      },
    ],
  },
  StageMovesOneStep: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_stage, s.stage from step s
      where s.stage <> s.was_stage
        and not (array_position(enum_range(null::stage), s.stage) = array_position(enum_range(null::stage), s.was_stage) + 1
                 or (s.was_stage = 'verify' and s.stage = 'implement'))`,
    plants: [{ setup: [finishedAttempt('specify', 'pass'), finishedAttempt('implement', 'pass')], violation: sql`update task set stage = 'verify' where id = 1` }],
  },
  OnlyAPersonStops: {
    moment: 'each-step',
    breaks: sql`select s.id, s.was_state from step s
      where s.state = 'stopped' and s.was_state <> 'stopped' and s.id not in (select task_id from acted)`,
    plants: [
      {
        setup: [personActs('stop_task', '00000000-0000-4000-8000-000000000003')],
        violation: sql`update task set state = 'stopped', stopped_by = '00000000-0000-4000-8000-000000000003' where id = 1`,
      },
    ],
  },
  RetryLeavesNoStageRetries: {
    moment: 'each-step',
    breaks: sql`select s.id, s.retries from step s where s.id in (select task_id from acted) and s.state = 'ready' and s.retries > 0`,
    plants: [{ setup: [sql`update task set retries = 1 where id = 1`], violation: personActs('retry_task', '00000000-0000-4000-8000-000000000004') }],
  },
  EveryTaskSettles: {
    moment: 'after-quiet-phase',
    breaks: sql`select id, stage, state from task where state = 'ready'`,
    plants: [
      {
        setup: [sql`update task set state = 'waiting', waiting_reason = 'Planted.' where id = 1`],
        violation: sql`update task set state = 'ready', waiting_reason = null where id = 1`,
      },
    ],
  },
} satisfies Readonly<Record<string, Property>>;

export type PropertyName = keyof typeof properties;

export type Violation = { readonly property: PropertyName; readonly row: unknown };

export type Watch = {
  readonly atStart: readonly Violation[];
  readonly step: () => Promise<readonly Violation[]>;
  readonly settled: () => Promise<readonly Violation[]>;
};

export type PlantProof = {
  readonly property: PropertyName;
  readonly plant: number;
  readonly atStart: readonly PropertyName[];
  readonly reported: readonly PropertyName[];
};

const isPropertyName = (name: unknown): name is PropertyName => typeof name === 'string' && Object.hasOwn(properties, name);

const propertyNames = Object.keys(properties).filter(isPropertyName);

const branches = (moment: Moment) =>
  sql.join(
    propertyNames
      .filter(name => properties[name].moment === moment)
      .map(name => sql`select ${sql.lit(name)} as property, to_jsonb(v) as row from (${properties[name].breaks}) v`),
    sql` union all `,
  );

const helpers = sql`
  prior as (
    select (before->>'xid')::xid as xid, (before->>'maxAttempt')::bigint as max_attempt,
           array(select jsonb_array_elements_text(before->'live')::bigint) as live
    where before is not null),
  record as (
    select task.id, task.stage, task.state, task.rounds, task.reruns, task.lost, task.retries,
           array(select distinct a.stage from attempt a where a.task_id = task.id and a.verdict = 'pass' order by a.stage) as outputs,
           task.waiting_reason,
           ${runAs(expressionBuilder<DB, 'task'>())} as runs_as
    from task),
  was as (
    select * from jsonb_to_recordset(coalesce(before->'tasks', '[]'))
      as w(id bigint, stage stage, state task_state, rounds int, reruns int, lost int, retries int, outputs stage[])),
  written as (select a.* from attempt a, prior p where age(a.xmin) < age(p.xid)),
  ended as (select a.task_id, a.id, a.verdict from attempt a, prior p where a.finished_at is not null and a.id = any(p.live)),
  acted as (select h.task_id from human_action h, prior p where h.task_id is not null and age(h.xmin) < age(p.xid)),
  step as (
    select r.id, w.stage as was_stage, r.stage, w.state as was_state, r.state, w.rounds as was_rounds, r.rounds,
           w.reruns as was_reruns, r.reruns, w.lost as was_lost, r.lost, w.retries as was_retries, r.retries,
           w.outputs as was_outputs, r.outputs, r.waiting_reason,
           exists (select 1 from attempt a, prior p where a.task_id = r.id and a.id = any(p.live)) as was_live,
           r.runs_as
    from record r join was w on w.id = r.id)`;

const install = sql`
  create function check_step(before jsonb) returns jsonb language plpgsql as $check$
  declare
    own constant xid := pg_current_xact_id()::xid;
    deadline constant timestamptz := clock_timestamp() + interval '1 second';
  begin
    loop
      perform pg_stat_clear_snapshot();
      exit when not exists (select 1 from pg_stat_activity
                            where datname = current_database() and backend_type = 'client backend' and age(backend_xid) > age(own));
      if clock_timestamp() > deadline then
        raise exception 'check_step reads xmin, which is sound only when every transaction older than the check has ended, and one in this database was still open after a second';
      end if;
      perform pg_sleep(0.001);
    end loop;
    return (
      with ${helpers}
      select jsonb_build_object(
        'violations', coalesce((select jsonb_agg(v) from (${branches('each-step')}) v), '[]'::jsonb),
        'state', jsonb_build_object(
          'xid', own::text,
          'maxAttempt', (select max(id) from attempt),
          'live', coalesce((select jsonb_agg(id) from attempt where finished_at is null), '[]'::jsonb),
          'tasks', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'stage', stage, 'state', state, 'rounds', rounds,
            'reruns', reruns, 'lost', lost, 'retries', retries, 'outputs', outputs)) from record), '[]'::jsonb))));
  end
  $check$`;

const violations = z.array(z.object({ property: z.custom<PropertyName>(isPropertyName), row: z.unknown() }));

const answer = z.object({ violations, state: z.json() });

export async function watch(db: Database): Promise<Watch> {
  const compiled = install.compile(db);
  if (compiled.parameters.length > 0) {
    throw new Error(
      'check_step must compile without parameters, because a function body takes no bind parameters. Write each constant in a predicate or a run-as rule with sql.lit, since eb.lit refuses strings.',
    );
  }
  await db.executeQuery(compiled);
  let before: z.infer<typeof answer>['state'] = null;
  const step = async (): Promise<readonly Violation[]> => {
    const { rows } = await sql<{ result: unknown }>`select check_step(${before === null ? null : JSON.stringify(before)}::jsonb) as result`.execute(db);
    const checked = answer.parse(rows[0]?.result);
    before = checked.state;
    return checked.violations;
  };
  const atStart = await step();
  return {
    atStart,
    step,
    settled: async () => violations.parse((await sql`${branches('after-quiet-phase')}`.execute(db)).rows),
  };
}

const namesOf = (found: readonly Violation[]): readonly PropertyName[] => [...new Set(found.map(violation => violation.property))];

const checksAt: Readonly<Record<Moment, (watched: Watch) => Promise<readonly Violation[]>>> = {
  'each-step': watched => watched.step(),
  'after-quiet-phase': watched => watched.settled(),
};

async function provePlant(postgres: TestPostgres, moment: Moment, plant: Plant): Promise<Pick<PlantProof, 'atStart' | 'reported'>> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    for (const statement of [...world, ...plant.setup]) await statement.execute(db);
    const watched = await watch(db);
    const atStart = await checksAt[moment](watched);
    await plant.violation.execute(db);
    const reported = await checksAt[moment](watched);
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
