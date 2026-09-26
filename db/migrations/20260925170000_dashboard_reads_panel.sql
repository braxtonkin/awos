-- migrate:up
grant select (output) on attempt to dashboard;
grant select (review_attempt) on task to dashboard;
grant select (attempt_id, seq, kind, action_id, client_message_id, received_at, acted_at) on attempt_command to dashboard;

-- migrate:down
revoke select on attempt_command from dashboard;
revoke select (review_attempt) on task from dashboard;
revoke select (output) on attempt from dashboard;
