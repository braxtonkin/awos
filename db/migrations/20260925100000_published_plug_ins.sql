-- migrate:up
create table published_workflow_step (
  workflow workflow_name not null,
  position int not null constraint published_step_counts_from_one check (position >= 1),
  name step_name not null,
  run_by text not null constraint published_step_run_by_agent_or_engine check (run_by in ('agent', 'engine')),
  requires text[] not null,
  failures jsonb not null constraint published_failures_are_an_object check (jsonb_typeof(failures) = 'object'),
  primary key (workflow, position),
  constraint published_step_named_once unique (workflow, name)
);

create table published_provider (
  name text primary key constraint published_provider_name_is_a_slug check (name ~ '^[a-z][a-z0-9-]{0,63}$')
);

grant select on published_workflow_step to dashboard;
grant select on published_provider to dashboard;

-- migrate:down
drop table published_provider;
drop table published_workflow_step;
