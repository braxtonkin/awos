-- migrate:up
alter table person_request drop constraint request_names_one_target;
alter table person_request add constraint request_names_one_target check (num_nonnulls(task_id, routine_id) = 1 or (kind = 'save_routine' and num_nonnulls(task_id, routine_id) = 0));

alter table person_request drop constraint request_kind_fits_target;
alter table person_request add constraint request_kind_fits_target check (case
  when kind in ('stop', 'retry', 'approve', 'send_back', 'answer', 'steer') then task_id is not null
  when kind in ('pause', 'resume', 'run_now') then routine_id is not null
  when kind = 'save_routine' then task_id is null
  else false
end);

alter table person_request alter column target set expression as (case
  when task_id is not null then 'task ' || task_id
  when routine_id is not null then 'routine ' || routine_id
  else 'new ' || id
end);

create or replace function take_next_place() returns trigger language plpgsql as $$
begin
  new.position := coalesce((
    select max(position) from person_request
    where target = case
      when new.task_id is not null then 'task ' || new.task_id
      when new.routine_id is not null then 'routine ' || new.routine_id
      else 'new ' || new.id
    end
  ), 0) + 1;
  return new;
end
$$;

-- migrate:down
do $$
begin
  if exists (select 1 from person_request where kind = 'save_routine') then
    raise exception 'This migration lets a person save a routine through a request, so it rolls back only while no save_routine request exists.';
  end if;
end
$$;

create or replace function take_next_place() returns trigger language plpgsql as $$
begin
  new.position := coalesce((
    select max(position) from person_request
    where target = case when new.task_id is not null then 'task ' || new.task_id else 'routine ' || new.routine_id end
  ), 0) + 1;
  return new;
end
$$;

alter table person_request alter column target set expression as (case when task_id is not null then 'task ' || task_id else 'routine ' || routine_id end);

alter table person_request drop constraint request_kind_fits_target;
alter table person_request add constraint request_kind_fits_target check (case
  when kind in ('stop', 'retry', 'approve', 'send_back', 'answer', 'steer') then task_id is not null
  when kind in ('pause', 'resume', 'run_now') then routine_id is not null
  else false
end);

alter table person_request drop constraint request_names_one_target;
alter table person_request add constraint request_names_one_target check (num_nonnulls(task_id, routine_id) = 1);
