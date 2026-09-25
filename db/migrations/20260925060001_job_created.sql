-- migrate:up
alter table attempt
  add column job_created_at timestamptz,
  add constraint job_created_after_its_token check (job_created_at is null or bridge_token_hash is not null),
  add constraint not_launched_created_no_job check (verdict is distinct from 'not_launched' or job_created_at is null),
  drop constraint review_when_judged,
  add constraint review_when_judged check ((verdict is null or verdict in ('lost', 'stopped', 'not_launched')) = (output is null));

-- migrate:down
alter table attempt
  drop constraint review_when_judged,
  add constraint review_when_judged check ((verdict is null or verdict in ('lost', 'stopped')) = (output is null)),
  drop constraint not_launched_created_no_job,
  drop constraint job_created_after_its_token,
  drop column job_created_at;
