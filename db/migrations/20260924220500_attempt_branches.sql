-- migrate:up
alter table attempt
  add column branch text constraint attempt_branch_is_its_own check (branch ~ '^autoworker/[A-Za-z0-9._/-]+-attempt-[1-9][0-9]*$'),
  add column start_commit text constraint start_is_a_commit check (start_commit ~ '^[0-9a-f]{40}$'),
  add column last_pushed text constraint push_is_a_commit check (last_pushed ~ '^[0-9a-f]{40}$'),
  add constraint branch_starts_somewhere check ((branch is null) = (start_commit is null)),
  add constraint push_needs_a_branch check (last_pushed is null or branch is not null);

create unique index one_attempt_per_branch on attempt (branch);

create table evidence (
  attempt_id bigint constraint evidence_of_attempt references attempt constraint one_evidence_per_attempt primary key,
  task_id bigint constraint evidence_names_its_task not null constraint evidence_of_task references task,
  body jsonb constraint evidence_holds_a_body not null constraint evidence_is_an_object check (jsonb_typeof(body) = 'object'),
  recorded_at timestamptz constraint evidence_records_when not null
);
create index evidence_by_task on evidence (task_id);
create trigger evidence_is_final before update on evidence for each row execute function refuse_change();

-- migrate:down
drop table evidence;
drop index one_attempt_per_branch;
alter table attempt
  drop constraint push_needs_a_branch,
  drop constraint branch_starts_somewhere,
  drop column last_pushed,
  drop column start_commit,
  drop column branch;
