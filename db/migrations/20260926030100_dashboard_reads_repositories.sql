-- migrate:up
grant select (job_image, fast_test_command, setup_command, verify_provider, ignorable_checks, draft_leaves, ignored_reviewers, saved_by) on repository to dashboard;

-- migrate:down
revoke select (job_image, fast_test_command, setup_command, verify_provider, ignorable_checks, draft_leaves, ignored_reviewers, saved_by) on repository from dashboard;
