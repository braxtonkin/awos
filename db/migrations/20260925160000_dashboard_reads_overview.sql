-- migrate:up
grant select (jira_account_id) on person to dashboard;
grant select (assignee_account_id) on task to dashboard;
grant select (id, creator_id, paused_by) on routine to dashboard;
grant select (every) on routine_version to dashboard;

-- migrate:down
revoke select (every) on routine_version from dashboard;
revoke select (id, creator_id, paused_by) on routine from dashboard;
revoke select (assignee_account_id) on task from dashboard;
revoke select (jira_account_id) on person from dashboard;
