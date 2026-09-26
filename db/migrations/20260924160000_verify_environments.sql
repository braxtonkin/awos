-- migrate:up
alter table repository
  add column verify_provider text not null default 'tests-only',
  add column fast_test_command text;

create table verify_environment (
  id bigint generated always as identity primary key,
  attempt_id bigint not null constraint environment_of_attempt references attempt,
  provider text not null,
  recorded_at timestamptz not null,
  called_at timestamptz not null,
  starting int not null default 0 constraint starting_is_not_negative check (starting >= 0),
  result jsonb,
  returned_at timestamptz,
  stopped_at timestamptz,
  constraint one_environment_per_attempt unique (attempt_id),
  constraint result_has_its_time check ((result is null) = (returned_at is null))
);

-- migrate:down
drop table verify_environment;
alter table repository drop column fast_test_command, drop column verify_provider;
