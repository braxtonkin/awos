-- migrate:up
alter type human_action_kind add value 'run_now';

do $$
begin
  if exists (select 1 from routine_version where schedule !~ '^\*/[1-9][0-9]* \* \* \* \*$') then
    raise exception 'This migration turns each routine schedule into an interval, so it runs only while every schedule reads */N * * * *.';
  end if;
end
$$;

alter table routine_version drop constraint schedule_is_five_cron_fields;
alter table routine_version alter column schedule type interval using make_interval(mins => substring(schedule from '^\*/([0-9]+)')::int);
alter table routine_version rename column schedule to every;
alter table routine_version rename constraint routine_version_schedule_not_null to routine_version_every_not_null;
alter table routine_version
  alter column every set default interval '15 minutes',
  add constraint every_is_a_positive_span_without_months check (every > interval '0' and extract(year from every) = 0 and extract(month from every) = 0);

create function keep_routine() returns trigger language plpgsql as $$
begin
  return null;
end
$$;

create trigger task_keeps_its_routine before update of routine_id on task for each row
  when (old.routine_id is distinct from new.routine_id)
  execute function keep_routine();

create type run_reason as enum ('schedule', 'run_now');
create type run_outcome as enum ('done', 'failed', 'paused', 'lost');

create table routine_run (
  id bigint generated always as identity primary key,
  routine_id bigint not null constraint run_of_routine references routine,
  version int constraint run_follows_a_version not null,
  reason run_reason not null,
  slot timestamptz,
  pressed_by uuid constraint run_now_names_its_press references human_action,
  claim uuid,
  claimed_at timestamptz,
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  finished_by uuid,
  outcome run_outcome,
  covers int not null default 1,
  found int not null default 0,
  note text,
  constraint run_cites_its_version foreign key (routine_id, version) references routine_version,
  constraint run_is_keyed_by_its_reason check ((slot is not null) = (reason = 'schedule') and (pressed_by is not null) = (reason = 'run_now')),
  constraint one_run_per_slot unique (routine_id, slot),
  constraint one_run_per_press unique (pressed_by),
  constraint claim_holds_a_lease check (num_nonnulls(claim, claimed_at, lease_until, started_at) in (0, 4)),
  constraint outcome_when_finished check ((finished_at is null) = (outcome is null)),
  constraint run_finishes_under_its_claim check (finished_at is null or finished_by is not distinct from claim),
  constraint run_finishes_within_its_lease check (outcome is null or outcome = 'lost' or finished_at <= lease_until),
  constraint note_when_failed check ((outcome = 'failed') = (note is not null)),
  constraint counts_are_whole check (covers >= 1 and found >= 0)
);
create unique index one_live_run_per_routine on routine_run (routine_id) where finished_at is null and claim is not null;
create unique index one_waiting_press_per_routine on routine_run (routine_id) where finished_at is null and claim is null;
create index runs_by_routine on routine_run (routine_id, id);

create function refuse_claim_on_paused_routine() returns trigger language plpgsql as $$
begin
  if exists (select 1 from routine where id = new.routine_id and paused_by is not null for share) then
    raise exception 'routine % is paused', new.routine_id using errcode = 'restrict_violation', constraint = tg_name;
  end if;
  return new;
end
$$;

create trigger run_claims_an_active_routine before insert or update of claim on routine_run for each row
  when (new.claim is not null and new.finished_at is null)
  execute function refuse_claim_on_paused_routine();
create trigger finished_run_is_final before update on routine_run for each row when (old.finished_at is not null) execute function refuse_change();

create table routine_overlap (
  task_id bigint not null constraint overlap_of_task references task,
  routine_id bigint not null constraint overlap_found_by_routine references routine,
  run_id bigint not null constraint overlap_seen_in_run references routine_run,
  primary key (task_id, routine_id)
);

-- migrate:down
drop table routine_overlap, routine_run;
drop function refuse_claim_on_paused_routine();
drop type run_outcome, run_reason;
drop trigger task_keeps_its_routine on task;
drop function keep_routine();

do $$
begin
  if exists (select 1 from routine_version where extract(epoch from every) % 60 <> 0 or every < interval '1 minute' or every >= interval '1 hour') then
    raise exception 'This rollback turns each routine interval back into */N * * * *, so it runs only while every interval is whole minutes under an hour.';
  end if;
end
$$;

alter table routine_version drop constraint every_is_a_positive_span_without_months, alter column every drop default;
alter table routine_version rename constraint routine_version_every_not_null to routine_version_schedule_not_null;
alter table routine_version rename column every to schedule;
alter table routine_version alter column schedule type text using '*/' || (extract(epoch from schedule)::int / 60)::text || ' * * * *';
alter table routine_version add constraint schedule_is_five_cron_fields check (schedule ~ '^\S+( \S+){4}$');

delete from human_action where kind = 'run_now';
create temporary table enum_checks on commit drop as
  select c.conrelid::regclass::text as relation, c.conname as name, pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.contype = 'c' and c.connamespace = 'public'::regnamespace
    and a.atttypid = 'human_action_kind'::regtype;
create temporary table enum_indexes on commit drop as
  select pg_get_indexdef(x.indexrelid) as definition, i.relname as name
  from pg_index x join pg_class i on i.oid = x.indexrelid
  where x.indrelid = 'human_action'::regclass and pg_get_indexdef(x.indexrelid) ~ '\mkind\M'
    and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid);
do $$
declare
  kept record;
begin
  for kept in select distinct relation, name from enum_checks loop
    execute format('alter table %s drop constraint %I', kept.relation, kept.name);
  end loop;
  for kept in select name from enum_indexes loop
    execute format('drop index %I', kept.name);
  end loop;
end
$$;
alter type human_action_kind rename to human_action_kind_with_run_now;
do $$
begin
  execute (
    select format('create type human_action_kind as enum (%s)', string_agg(quote_literal(enumlabel), ', ' order by enumsortorder))
    from pg_enum
    where enumtypid = 'human_action_kind_with_run_now'::regtype and enumlabel <> 'run_now'
  );
end
$$;
alter table human_action alter column kind type human_action_kind using kind::text::human_action_kind;
drop type human_action_kind_with_run_now;
do $$
declare
  kept record;
begin
  for kept in select distinct relation, name, definition from enum_checks loop
    execute format('alter table %s add constraint %I %s', kept.relation, kept.name, kept.definition);
  end loop;
  for kept in select definition from enum_indexes loop
    execute kept.definition;
  end loop;
end
$$;
