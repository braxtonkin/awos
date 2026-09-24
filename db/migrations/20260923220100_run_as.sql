-- migrate:up
create type person_kind as enum ('person', 'shared');
alter table person
  add column kind person_kind not null default 'person',
  add column jira_account_id text constraint one_person_per_jira_account unique;
alter table routine
  add column creator_id bigint constraint routine_has_a_creator not null constraint creator_is_a_person references person,
  add column run_as_id bigint constraint run_as_is_a_person references person;
alter table task add column assignee_account_id text;
alter table attempt add column run_as_id bigint constraint attempt_runs_as_a_person not null constraint attempt_run_as_is_a_person references person;

-- migrate:down
alter table attempt drop column run_as_id;
alter table task drop column assignee_account_id;
alter table routine drop column run_as_id, drop column creator_id;
alter table person drop column jira_account_id, drop column kind;
drop type person_kind;
