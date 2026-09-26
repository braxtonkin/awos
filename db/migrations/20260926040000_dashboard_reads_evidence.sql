-- migrate:up
grant select (attempt_id, body, recorded_at, task_id) on evidence to dashboard;
grant select (kind, state, task_id) on outbox to dashboard;
grant select (gates) on routine_version to dashboard;

-- migrate:down
revoke select (gates) on routine_version from dashboard;
revoke select on outbox from dashboard;
revoke select on evidence from dashboard;
