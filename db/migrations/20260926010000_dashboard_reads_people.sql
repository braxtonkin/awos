-- migrate:up
grant select (email, jira_account_id) on person to dashboard;

-- migrate:down
revoke select (email, jira_account_id) on person from dashboard;
