-- migrate:up
create type outbox_state as enum ('owed', 'done', 'refused', 'failed', 'dropped');

alter table task add column owed_actions int not null default 0;
alter table task alter column ready set expression as (case when state = 'ready' and owed_actions = 0 then true end);

create table outbox (
  id bigint generated always as identity primary key,
  task_id bigint not null constraint row_of_task references task,
  position int not null,
  kind text not null,
  payload jsonb not null,
  acts_as bigint not null constraint row_acts_as_a_person references person,
  idempotency_key text not null,
  owed_at timestamptz not null,
  state outbox_state not null default 'owed',
  claim uuid,
  lease_until timestamptz,
  tries int not null default 0,
  last_error text,
  result jsonb,
  settled_at timestamptz,
  constraint idempotency_key_is_unique unique (idempotency_key),
  constraint one_row_per_place_in_its_task unique (task_id, position),
  constraint marker_cannot_be_guessed check (idempotency_key ~ '^[A-Za-z0-9_-]{22,}$'),
  constraint claim_holds_a_lease check ((claim is null) = (lease_until is null)),
  constraint only_owed_rows_are_claimed check (state = 'owed' or claim is null),
  constraint settled_row_says_when check ((state = 'owed') = (settled_at is null)),
  constraint performed_row_keeps_its_result check ((state in ('done', 'refused')) = (result is not null)),
  constraint failed_row_keeps_its_error check (state <> 'failed' or last_error is not null)
);
create index unsettled_rows_by_task on outbox (task_id, position) where state in ('owed', 'failed');

create function count_owed_actions() returns trigger language plpgsql as $$
declare
  delta int := (case when tg_op <> 'DELETE' and new.state in ('owed', 'failed') then 1 else 0 end)
             - (case when tg_op <> 'INSERT' and old.state in ('owed', 'failed') then 1 else 0 end);
begin
  if delta <> 0 then
    update task set owed_actions = owed_actions + delta where id = coalesce(new.task_id, old.task_id);
  end if;
  return null;
end
$$;
create trigger task_counts_its_owed_actions after insert or update of state or delete on outbox
  for each row execute function count_owed_actions();

create function park_for_failed_row() returns trigger language plpgsql as $$
begin
  update task
  set state = 'waiting',
      waiting_on = 'retry',
      review_attempt = null,
      waiting_reason = format('The %s action failed %s times, last with: %s. Fix what it needs, then press Retry to perform it again.',
                              new.kind, new.tries, left(regexp_replace(new.last_error, '\s+', ' ', 'g'), 1000))
  where id = new.task_id and state in ('ready', 'waiting');
  return null;
end
$$;
create trigger failed_row_parks_its_task after update of state on outbox
  for each row when (old.state = 'owed' and new.state = 'failed') execute function park_for_failed_row();

create function drop_rows_behind_failure() returns trigger language plpgsql as $$
begin
  update outbox
  set state = 'dropped', settled_at = new.settled_at
  where task_id = new.task_id and position > new.position and state = 'owed' and claim is null
    and exists (select 1 from task where id = new.task_id and state = 'done');
  return null;
end
$$;
create trigger done_task_drops_rows_behind_a_failure after update of state on outbox
  for each row when (old.state = 'owed' and new.state = 'failed') execute function drop_rows_behind_failure();

-- migrate:down
drop table outbox;
drop function drop_rows_behind_failure();
drop function park_for_failed_row();
drop function count_owed_actions();
alter table task alter column ready set expression as (case when state = 'ready' then true end);
alter table task drop column owed_actions;
drop type outbox_state;
