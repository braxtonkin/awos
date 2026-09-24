-- migrate:up
create type stage as enum ('specify', 'implement', 'verify', 'land');
create type task_state as enum ('ready', 'waiting', 'stopped', 'done');
create type verdict as enum ('pass', 'fail', 'behavior_fail', 'environment_fail', 'lost', 'stopped');
create type human_action_kind as enum ('edit_routine', 'pause_routine', 'resume_routine', 'stop_task', 'retry_task');

create function refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'this % row is final', tg_table_name using errcode = 'restrict_violation', constraint = tg_name;
end
$$;

create table person (
  id bigint generated always as identity primary key,
  email text not null constraint one_person_per_email unique constraint email_is_lowercase check (email = lower(email)),
  name text not null
);

create table repository (
  id bigint generated always as identity primary key,
  github text not null constraint names_owner_and_repository check (github ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  branch text not null constraint branch_not_blank check (btrim(branch) <> ''),
  constraint one_row_per_branch unique (github, branch)
);

create table routine (
  id bigint generated always as identity primary key,
  paused_by uuid
);

create table routine_version (
  routine_id bigint not null constraint version_of_routine references routine,
  version int not null,
  name text not null,
  goal text not null constraint goal_not_blank check (btrim(goal) <> ''),
  schedule text not null constraint schedule_is_five_cron_fields check (schedule ~ '^\S+( \S+){4}$'),
  repository_id bigint not null constraint version_works_in_a_repository references repository,
  action_id uuid not null,
  primary key (routine_id, version),
  constraint version_names_one_repository unique (routine_id, version, repository_id)
);

create table task (
  id bigint generated always as identity primary key,
  routine_id bigint not null,
  found_version int not null,
  repository_id bigint not null,
  key text not null constraint one_task_per_key unique,
  title text not null,
  stage stage not null default 'specify',
  state task_state not null default 'ready',
  rounds int not null default 0,
  reruns int not null default 0,
  lost int not null default 0,
  retries int not null default 0,
  waiting_reason text,
  stopped_by uuid,
  found_at timestamptz constraint task_records_when_it_was_found not null,
  ready boolean generated always as (case when state = 'ready' then true end) stored,
  constraint task_works_where_its_routine_said foreign key (routine_id, found_version, repository_id) references routine_version (routine_id, version, repository_id),
  constraint live_attempt_target unique (id, routine_id, stage, ready),
  constraint waiting_has_reason check ((state = 'waiting') = (waiting_reason is not null)),
  constraint stopped_has_stop_action check ((state = 'stopped') = (stopped_by is not null))
);

create table human_action (
  id uuid primary key,
  at timestamptz constraint action_records_when_it_happened not null,
  person_id bigint not null constraint action_taken_by_person references person,
  kind human_action_kind not null,
  routine_id bigint constraint action_on_routine references routine,
  task_id bigint constraint action_on_task references task,
  detail jsonb not null default '{}',
  constraint one_target check (num_nonnulls(routine_id, task_id) = 1),
  constraint target_fits_kind check (case when kind in ('stop_task', 'retry_task') then task_id is not null else routine_id is not null end)
);

alter table routine add constraint pause_names_its_action foreign key (paused_by) references human_action;
alter table routine_version add constraint version_saved_by_action foreign key (action_id) references human_action;
alter table task add constraint stop_names_its_action foreign key (stopped_by) references human_action;

create table attempt (
  id bigint generated always as identity primary key,
  task_id bigint constraint attempt_names_its_task not null constraint attempt_of_task references task,
  routine_id bigint constraint attempt_names_its_routine not null,
  routine_version int constraint attempt_follows_a_goal_version not null,
  stage stage constraint attempt_names_its_stage not null,
  started_at timestamptz constraint attempt_records_when_it_started not null,
  lease_until timestamptz constraint attempt_holds_a_lease not null,
  finished_at timestamptz,
  verdict verdict,
  output jsonb,
  live boolean generated always as (case when finished_at is null then true end) stored,
  constraint attempt_cites_goal_version foreign key (routine_id, routine_version) references routine_version,
  constraint live_attempt_matches_ready_task foreign key (task_id, routine_id, stage, live) references task (id, routine_id, stage, ready),
  constraint attempt_verdict_when_finished check ((finished_at is null) = (verdict is null)),
  constraint output_when_passed check ((verdict is not distinct from 'pass') = (output is not null))
);
create unique index one_live_attempt_per_task on attempt (task_id) where finished_at is null;
create index attempts_by_task on attempt (task_id);

create trigger routine_version_is_final before update on routine_version for each row execute function refuse_change();
create trigger human_action_is_final before update on human_action for each row execute function refuse_change();
create trigger finished_attempt_is_final before update on attempt for each row when (old.finished_at is not null) execute function refuse_change();

-- migrate:down
drop table attempt, human_action, task, routine_version, routine, repository, person;
drop function refuse_change();
drop type human_action_kind, verdict, task_state, stage;
