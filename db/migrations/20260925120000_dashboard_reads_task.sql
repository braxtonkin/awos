-- migrate:up
grant select (id, name, kind) on person to dashboard;
grant select (routine_id, version, name) on routine_version to dashboard;
grant select (id, github, branch) on repository to dashboard;
grant select (id, key, title, workflow, step, state, waiting_on, waiting_reason, stopped_by, routine_id, found_version, repository_id, found_at) on task to dashboard;
grant select (id, task_id, step, started_at, finished_at, verdict, run_as_id) on attempt to dashboard;
grant select (attempt_id, seq, kind, stored_at, body) on attempt_event to dashboard;
grant select (id, at, person_id, kind, task_id) on human_action to dashboard;

-- migrate:down
revoke select on human_action from dashboard;
revoke select on attempt_event from dashboard;
revoke select on attempt from dashboard;
revoke select on task from dashboard;
revoke select on repository from dashboard;
revoke select on routine_version from dashboard;
revoke select on person from dashboard;
