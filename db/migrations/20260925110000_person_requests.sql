-- migrate:up
create type request_answer as enum ('recorded', 'refused');

create table person_request (
  id uuid primary key,
  person_id bigint not null constraint request_asked_by_person references person,
  at timestamptz not null,
  kind text not null,
  payload jsonb not null,
  task_id bigint constraint request_on_task references task,
  routine_id bigint constraint request_on_routine references routine,
  target text generated always as (case when task_id is not null then 'task ' || task_id else 'routine ' || routine_id end) stored,
  position int not null default 0,
  answer request_answer,
  answered_at timestamptz,
  reason text,
  action_id uuid generated always as (case when answer = 'recorded' then id end) stored constraint answer_names_its_action references human_action,
  constraint request_names_one_target check (num_nonnulls(task_id, routine_id) = 1),
  constraint request_kind_fits_target check (case
    when kind in ('stop', 'retry', 'approve', 'send_back', 'answer') then task_id is not null
    when kind in ('pause', 'resume', 'run_now') then routine_id is not null
    else false
  end),
  constraint payload_is_an_object check (jsonb_typeof(payload) = 'object'),
  constraint position_counts_from_one check (position >= 1),
  constraint one_request_per_position unique (target, position),
  constraint answer_says_when check ((answer is null) = (answered_at is null)),
  constraint refusal_says_why check ((answer is not distinct from 'refused') = (reason is not null) and btrim(coalesce(reason, 'x')) <> '')
);

create index open_requests on person_request (target, position) where answer is null;

create function take_next_place() returns trigger language plpgsql as $$
begin
  new.position := coalesce((
    select max(position) from person_request
    where target = case when new.task_id is not null then 'task ' || new.task_id else 'routine ' || new.routine_id end
  ), 0) + 1;
  return new;
end
$$;

create trigger request_takes_next_place before insert on person_request for each row execute function take_next_place();

create trigger answer_is_final before update or delete on person_request for each row when (old.answer is not null) execute function refuse_change();

grant select, insert (id, person_id, at, kind, payload, task_id, routine_id) on person_request to dashboard;

-- migrate:down
revoke all on person_request from dashboard;
drop table person_request;
drop function take_next_place();
drop type request_answer;
