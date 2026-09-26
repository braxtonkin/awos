import { randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { numberCommand, type Sent, type Unsent } from './engine.ts';
import type { AttemptId } from './protocol.ts';

export type Moment = 'each-step' | 'after-quiet-phase';

type Statement = RawBuilder<unknown>;

type Plant = { readonly setup: readonly Statement[]; readonly violation: Statement };

type Property = { readonly moment: Moment; readonly breaks: Statement; readonly plants: readonly [Plant, ...Plant[]] };

export const simulatorSchema: readonly Statement[] = [
  sql`create table sim_history (
        id bigint generated always as identity primary key,
        attempt_id bigint not null,
        what text not null,
        seq bigint,
        method text,
        item_id text,
        fragment boolean,
        verdict text)`,
  sql`create index sim_history_by_number on sim_history (attempt_id, what, seq)`,
  sql`create function sim_event() returns trigger language plpgsql as $$
      begin
        if tg_op = 'INSERT' then
          insert into sim_history (attempt_id, what, seq, method, item_id, fragment) values (new.attempt_id, 'event', new.seq, new.method, new.item_id, new.fragment);
          return new;
        end if;
        insert into sim_history (attempt_id, what, seq, method, item_id, fragment) values (old.attempt_id, 'prune', old.seq, old.method, old.item_id, old.fragment);
        return old;
      end
      $$`,
  sql`create trigger sim_event after insert or delete on attempt_event for each row execute function sim_event()`,
  sql`create function sim_command() returns trigger language plpgsql as $$
      begin
        insert into sim_history (attempt_id, what, seq) values (new.attempt_id, 'command', new.seq);
        return new;
      end
      $$`,
  sql`create trigger sim_command after insert on attempt_command for each row execute function sim_command()`,
  sql`create function sim_end() returns trigger language plpgsql as $$
      begin
        insert into sim_history (attempt_id, what, verdict) values (new.id, 'end', new.verdict::text);
        return new;
      end
      $$`,
  sql`create trigger sim_end after update of finished_at on attempt for each row when (old.finished_at is null and new.finished_at is not null) execute function sim_end()`,
  sql`create table sim_ack (id bigint generated always as identity primary key, attempt_id bigint not null, stored bigint not null)`,
  sql`create table sim_applied (id bigint generated always as identity primary key, attempt_id bigint not null, seq bigint not null)`,
  sql`create function sim_apply() returns trigger language plpgsql as $$
      begin
        insert into sim_history (attempt_id, what, seq) values (new.attempt_id, 'applied', new.seq);
        return new;
      end
      $$`,
  sql`create trigger sim_apply after insert on sim_applied for each row execute function sim_apply()`,
  sql`create table sim_bridge (attempt_id bigint primary key, state text not null, emitted bigint not null)`,
  sql`create table sim_outage (id bigint generated always as identity primary key, down_at timestamptz not null, up_at timestamptz)`,
  sql`create table sim_lease (id bigint generated always as identity primary key, attempt_id bigint not null, was timestamptz not null, renewed_to timestamptz not null)`,
  sql`create function sim_lease() returns trigger language plpgsql as $$
      begin
        insert into sim_lease (attempt_id, was, renewed_to) values (new.id, old.lease_until, new.lease_until);
        return new;
      end
      $$`,
  sql`create trigger sim_lease after update of lease_until on attempt for each row when (new.lease_until > old.lease_until) execute function sim_lease()`,
];

export const worldStartsAt = Date.parse('2026-01-01T00:00:00.000Z');

export const worldLeaseMs = 30_000;

const t0 = sql`timestamptz '2026-01-01T00:00:00Z'`;

const firstAction = sql.lit('00000000-0000-4000-8000-000000000001');

export const world: readonly Statement[] = [
  sql`insert into person (email, name, jira_account_id) values ('ada@example.com', 'Ada', 'acc-ada')`,
  sql`with saved as (
        insert into human_action (id, at, person_id, kind, repository_id) values ('00000000-0000-4000-8000-000000000009', ${t0}, 1, 'add_repository', 1) returning id)
      insert into repository (github, branch, saved_by) select 'example/sandbox', 'main', id from saved`,
  sql`insert into routine (creator_id, run_as_id) values (1, 1)`,
  sql`insert into human_action (id, at, person_id, kind, routine_id) values (${firstAction}, ${t0}, 1, 'edit_routine', 1)`,
  sql`insert into routine_version (routine_id, version, name, goal, repository_id, action_id, workflow, source, needs_repository, gates)
      values (1, 1, 'Bridge', 'Deliver every line once.', 1, ${firstAction}, 'code-change', '{"kind": "jira-search"}', true, '{}')`,
  sql`insert into task (routine_id, found_version, repository_id, key, title, found_at, assignee_account_id, workflow, needs_repository, step)
      values (1, 1, 1, 'SIM-1', 'First', ${t0}, 'acc-ada', 'code-change', true, 'implement'),
             (1, 1, 1, 'SIM-2', 'Second', ${t0}, 'acc-ada', 'code-change', true, 'implement')`,
  sql`insert into attempt (task_id, routine_id, routine_version, step, epoch, run_as_id, started_at, lease_until)
      values (1, 1, 1, 'implement', 0, 1, ${t0}, ${t0} + interval '30 seconds'),
             (2, 1, 1, 'implement', 0, 1, ${t0}, ${t0} + interval '30 seconds')`,
];

const event = (seq: number, method: string | null, item: string | null, fragment: boolean): Statement =>
  sql`insert into attempt_event (attempt_id, seq, kind, method, item_id, fragment, body, stored_at)
      values (1, ${sql.lit(seq)}, 'app', ${method === null ? sql`null` : sql.lit(method)}, ${item === null ? sql`null` : sql.lit(item)}, ${sql.lit(fragment)}, '{}', ${t0})`;

const highWater = (seq: number): Statement => sql`update attempt set high_water = ${sql.lit(seq)} where id = 1`;

const stopCommand = (seq: number): Statement =>
  sql`insert into attempt_command (attempt_id, seq, kind, sent_at) values (1, ${sql.lit(seq)}, 'turn.stop', ${t0})`;

const steerCommand = (seq: number): Statement =>
  sql`with steer as (insert into human_action (id, at, person_id, kind, task_id) values (gen_random_uuid(), ${t0}, 1, 'steer_task', 1) returning id)
      insert into attempt_command (attempt_id, seq, kind, input, client_message_id, action_id, sent_at)
      select 1, ${sql.lit(seq)}, 'turn.steer', 'Also check the edge case.', gen_random_uuid(), id, ${t0} from steer`;

const steerCiting = (action: RawBuilder<unknown>): Statement =>
  sql`insert into attempt_command (attempt_id, seq, kind, input, client_message_id, action_id, sent_at) values (1, 1, 'turn.steer', 'Also check the edge case.', gen_random_uuid(), ${action}, ${t0})`;

export const worldPerson = '1';

export async function personSteers(db: Database, attempt: AttemptId, message: string, now: Date): Promise<Sent | Unsent> {
  return db.transaction().execute(async writer => {
    const action = randomUUID();
    const sent = await numberCommand(writer, attempt, { kind: 'turn.steer', message, action }, now);
    if (typeof sent === 'string') return sent;
    const { task_id } = await writer.selectFrom('attempt').select('task_id').where('id', '=', attempt).executeTakeFirstOrThrow();
    await writer.insertInto('human_action').values({ id: action, at: now, person_id: worldPerson, kind: 'steer_task', task_id }).execute();
    return sent;
  });
}

const applied = (seq: number): Statement => sql`insert into sim_applied (attempt_id, seq) values (1, ${sql.lit(seq)})`;

const eventsOf = sql`select h.attempt_id, h.seq from sim_history h where h.what = 'event'`;

export const properties = {
  TypeOK: {
    moment: 'each-step',
    breaks: sql`select a.id as attempt, a.high_water, a.commands_received, e.top_event, c.top_command
      from attempt a
      cross join lateral (select coalesce(max(seq), 0) as top_event from attempt_event where attempt_id = a.id) e
      cross join lateral (select coalesce(max(seq), 0) as top_command from attempt_command where attempt_id = a.id) c
      where a.high_water < e.top_event or a.commands_received > c.top_command`,
    plants: [
      { setup: [], violation: event(1, 'turn/started', null, false) },
      { setup: [], violation: sql`update attempt set commands_received = 1 where id = 1` },
    ],
  },
  NoEventStoredTwice: {
    moment: 'each-step',
    breaks: sql`select s.attempt_id, s.seq, count(*) as times from (${eventsOf}) s group by s.attempt_id, s.seq having count(*) > 1`,
    plants: [
      {
        setup: [event(1, 'item/agentMessage/delta', 'item-1', true), highWater(1), sql`delete from attempt_event where attempt_id = 1 and seq = 1`],
        violation: event(1, 'item/agentMessage/delta', 'item-1', true),
      },
    ],
  },
  EventsStoredInOrder: {
    moment: 'each-step',
    breaks: sql`select h.attempt_id, h.seq from sim_history h
      where h.what = 'event' and h.seq > 1
        and not exists (select 1 from sim_history p where p.attempt_id = h.attempt_id and p.what = 'event' and p.seq = h.seq - 1 and p.id < h.id)`,
    plants: [{ setup: [event(1, 'turn/started', null, false), highWater(1)], violation: event(3, 'turn/started', null, false) }],
  },
  AckedMeansStored: {
    moment: 'each-step',
    breaks: sql`select k.attempt_id, k.stored, n as missing
      from (select attempt_id, max(stored) as stored from sim_ack group by attempt_id) k
      cross join generate_series(1, k.stored) n
      where not exists (select 1 from sim_history h where h.attempt_id = k.attempt_id and h.what = 'event' and h.seq = n)`,
    plants: [
      { setup: [event(1, 'turn/started', null, false), highWater(1), sql`insert into sim_ack (attempt_id, stored) values (1, 1)`], violation: sql`insert into sim_ack (attempt_id, stored) values (1, 2)` },
    ],
  },
  EveryEventStored: {
    moment: 'after-quiet-phase',
    breaks: sql`select b.attempt_id, b.state, a.verdict, n as missing
      from sim_bridge b
      join attempt a on a.id = b.attempt_id
      cross join generate_series(1, b.emitted) n
      where not (coalesce(a.verdict in ('stopped', 'lost'), false) or (a.finished_at is null and b.state <> 'up'))
        and not exists (select 1 from sim_history h where h.attempt_id = b.attempt_id and h.what = 'event' and h.seq = n)`,
    plants: [
      { setup: [], violation: sql`insert into sim_bridge (attempt_id, state, emitted) values (1, 'up', 1)` },
      {
        setup: [event(1, 'turn/started', null, false), highWater(1), sql`insert into sim_bridge (attempt_id, state, emitted) values (1, 'down', 2)`],
        violation: sql`update attempt set finished_at = ${t0} + interval '5 seconds', verdict = 'pass', output = '{}' where id = 1`,
      },
    ],
  },
  CommandAppliedOnce: {
    moment: 'each-step',
    breaks: sql`select p.attempt_id, p.seq, count(*) as times from sim_applied p group by p.attempt_id, p.seq having count(*) > 1`,
    plants: [{ setup: [stopCommand(1), sql`insert into sim_applied (attempt_id, seq) values (1, 1)`], violation: sql`insert into sim_applied (attempt_id, seq) values (1, 1)` }],
  },
  CommandsAppliedInOrder: {
    moment: 'each-step',
    breaks: sql`select p.attempt_id, p.seq, coalesce(before.seq, 0) as after_seq
      from sim_applied p
      left join lateral (select b.seq from sim_applied b where b.attempt_id = p.attempt_id and b.id < p.id order by b.id desc limit 1) before on true
      where p.seq <> coalesce(before.seq, 0) + 1`,
    plants: [
      { setup: [stopCommand(1), stopCommand(2)], violation: sql`insert into sim_applied (attempt_id, seq) values (1, 2)` },
      { setup: [stopCommand(1), stopCommand(2), sql`insert into sim_applied (attempt_id, seq) values (1, 1)`, sql`insert into sim_applied (attempt_id, seq) values (1, 2)`], violation: sql`insert into sim_applied (attempt_id, seq) values (1, 1)` },
    ],
  },
  EveryCommandApplied: {
    moment: 'after-quiet-phase',
    breaks: sql`select c.attempt_id, c.seq, b.state
      from attempt_command c
      join attempt a on a.id = c.attempt_id
      join sim_bridge b on b.attempt_id = c.attempt_id
      where a.finished_at is null and b.state = 'up'
        and not exists (select 1 from sim_applied p where p.attempt_id = c.attempt_id and p.seq = c.seq)`,
    plants: [{ setup: [stopCommand(1)], violation: sql`insert into sim_bridge (attempt_id, state, emitted) values (1, 'up', 0)` }],
  },
  FinishedStepKeepsItsText: {
    moment: 'each-step',
    breaks: sql`select h.attempt_id, h.seq, h.item_id, 'the finishing line is gone' as broken from sim_history h
        where h.what = 'event' and h.method = 'item/completed'
          and not exists (select 1 from attempt_event e where e.attempt_id = h.attempt_id and e.seq = h.seq)
      union all
      select e.attempt_id, e.seq, e.item_id, 'a fragment outlived its step' from attempt_event e
        where e.fragment and exists (select 1 from attempt_event c where c.attempt_id = e.attempt_id and c.item_id = e.item_id and c.method = 'item/completed')`,
    plants: [
      {
        setup: [event(1, 'item/started', 'item-1', false), event(2, 'item/agentMessage/delta', 'item-1', true), event(3, 'item/completed', 'item-1', false), sql`delete from attempt_event where attempt_id = 1 and fragment`, highWater(3)],
        violation: sql`delete from attempt_event where attempt_id = 1 and seq = 3`,
      },
      {
        setup: [event(1, 'item/started', 'item-1', false), event(2, 'item/completed', 'item-1', false), highWater(2)],
        violation: event(3, 'item/agentMessage/delta', 'item-1', true),
      },
    ],
  },
  LostAttemptChangesNothing: {
    moment: 'each-step',
    breaks: sql`select h.attempt_id, h.what, h.seq from sim_history h
      join sim_history e on e.attempt_id = h.attempt_id and e.what = 'end' and e.id < h.id
      where h.what in ('event', 'prune', 'command')
        or (h.what = 'applied' and exists (select 1 from attempt_command c where c.attempt_id = h.attempt_id and c.seq = h.seq and c.kind <> 'turn.stop'))`,
    plants: [
      {
        setup: [sql`drop trigger event_needs_live_attempt on attempt_event`, sql`update attempt set finished_at = ${t0} + interval '40 seconds', verdict = 'lost' where id = 1`],
        violation: event(1, 'turn/started', null, false),
      },
      {
        setup: [sql`drop trigger command_needs_live_attempt on attempt_command`, sql`update attempt set finished_at = ${t0} + interval '40 seconds', verdict = 'stopped' where id = 1`],
        violation: stopCommand(1),
      },
      {
        setup: [steerCommand(1), applied(1), stopCommand(2), sql`update attempt set finished_at = ${t0} + interval '40 seconds', verdict = 'stopped' where id = 1`, applied(2)],
        violation: applied(1),
      },
    ],
  },
  ReconnectedBridgeKeepsItsAttempt: {
    moment: 'each-step',
    breaks: sql`select a.id as attempt, a.lease_until, o.down_at, o.up_at
      from attempt a
      join sim_outage o on a.lease_until >= o.down_at and (o.up_at is null or a.lease_until < o.up_at)
      where a.verdict = 'lost'`,
    plants: [
      {
        setup: [sql`insert into sim_outage (down_at, up_at) values (${t0} + interval '10 seconds', ${t0} + interval '100 seconds')`],
        violation: sql`update attempt set finished_at = ${t0} + interval '101 seconds', verdict = 'lost' where id = 1`,
      },
    ],
  },
  LapsedLeaseNeverRenews: {
    moment: 'each-step',
    breaks: sql`select l.attempt_id, l.was, l.renewed_to from sim_lease l
      where l.was < l.renewed_to - make_interval(secs => ${sql.lit(worldLeaseMs / 1000)})
        and not exists (select 1 from sim_outage o where o.up_at = l.renewed_to - make_interval(secs => ${sql.lit(worldLeaseMs / 1000)}))`,
    plants: [{ setup: [], violation: sql`update attempt set lease_until = ${t0} + interval '100 seconds' where id = 1` }],
  },
  SteerNamesItsPerson: {
    moment: 'each-step',
    breaks: sql`select c.attempt_id, c.seq, h.kind as action_kind from attempt_command c
      join attempt a on a.id = c.attempt_id
      left join human_action h on h.id = c.action_id
      where c.kind = 'turn.steer' and (h.id is null or h.kind <> 'steer_task' or h.task_id is distinct from a.task_id)`,
    plants: [
      { setup: [sql`alter table attempt_command drop constraint steer_names_its_person`], violation: steerCiting(sql`null`) },
      { setup: [], violation: steerCiting(firstAction) },
    ],
  },
  TokenIsAHash: {
    moment: 'each-step',
    breaks: sql`select id as attempt, length(bridge_token_hash) as bytes from attempt where length(bridge_token_hash) <> 32`,
    plants: [{ setup: [sql`alter table attempt drop constraint bridge_token_is_a_hash`], violation: sql`update attempt set bridge_token_hash = decode('00', 'hex') where id = 1` }],
  },
  ProcessFollowsItsToken: {
    moment: 'each-step',
    breaks: sql`select id as attempt, bridge_process from attempt where bridge_process is not null and bridge_token_hash is null`,
    plants: [
      {
        setup: [sql`alter table attempt drop constraint bridge_process_follows_its_token`],
        violation: sql`update attempt set bridge_process = '00000000-0000-4000-8000-000000007001' where id = 1`,
      },
    ],
  },
  CountersStayWhole: {
    moment: 'each-step',
    breaks: sql`select id as attempt, high_water, commands_received from attempt where high_water < 0 or commands_received < 0`,
    plants: [
      { setup: [sql`alter table attempt drop constraint bridge_high_water_counts_lines`], violation: sql`update attempt set high_water = -1 where id = 1` },
      { setup: [sql`alter table attempt drop constraint bridge_received_counts_commands`], violation: sql`update attempt set commands_received = -1 where id = 1` },
    ],
  },
} satisfies Readonly<Record<string, Property>>;

export type PropertyName = keyof typeof properties;

export type Violation = { readonly property: PropertyName; readonly row: unknown };

export type PlantProof = { readonly property: PropertyName; readonly plant: number; readonly atStart: readonly PropertyName[]; readonly reported: readonly PropertyName[] };

const isPropertyName = (name: unknown): name is PropertyName => typeof name === 'string' && Object.hasOwn(properties, name);

export const propertyNames: readonly PropertyName[] = Object.keys(properties).filter(isPropertyName);

const found = z.array(z.object({ property: z.custom<PropertyName>(isPropertyName), row: z.unknown() }));

const checkedAt = (moments: readonly Moment[]): RawBuilder<unknown> =>
  sql.join(
    propertyNames
      .filter(name => moments.includes(properties[name].moment))
      .map(name => sql`select ${sql.lit(name)} as property, to_jsonb(v) as row from (${properties[name].breaks}) v`),
    sql` union all `,
  );

const eachStep = checkedAt(['each-step']);

const everyMoment = checkedAt(['each-step', 'after-quiet-phase']);

export async function violations(db: Database, moment: 'each-step' | 'every'): Promise<readonly Violation[]> {
  return found.parse((await sql`${moment === 'each-step' ? eachStep : everyMoment}`.execute(db)).rows);
}

const namesOf = (list: readonly Violation[]): readonly PropertyName[] => [...new Set(list.map(violation => violation.property))];

async function provePlant(postgres: TestPostgres, plant: Plant): Promise<Pick<PlantProof, 'atStart' | 'reported'>> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    for (const statement of [...simulatorSchema, ...world, ...plant.setup]) await statement.execute(db);
    const atStart = namesOf(await violations(db, 'every'));
    await plant.violation.execute(db);
    return { atStart, reported: namesOf(await violations(db, 'every')) };
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
