-- migrate:up
grant select (id, creator_id, run_as_id, paused_by) on routine to dashboard;
grant select (every, goal, workflow, source, jira_start_status, jira_end_status, ignore_later_reviews, repository_id, gates, last_step, action_id) on routine_version to dashboard;
grant select (routine_id, version, step, instructions, skills) on routine_step to dashboard;
grant select (id, routine_id, version, reason, slot, pressed_by, started_at, finished_at, outcome) on routine_run to dashboard;

-- migrate:down
revoke select on routine_run from dashboard;
revoke select on routine_step from dashboard;
revoke select (every, goal, workflow, source, jira_start_status, jira_end_status, ignore_later_reviews, repository_id, gates, last_step, action_id) on routine_version from dashboard;
revoke select on routine from dashboard;
