-- migrate:up
alter table repository
  add constraint github_ignorable_checks_are_named check (array_position(ignorable_checks, '') is null and array_position(ignorable_checks, null) is null),
  add constraint github_ignored_reviewers_are_named check (array_position(ignored_reviewers, '') is null and array_position(ignored_reviewers, null) is null);

-- migrate:down
alter table repository
  drop constraint github_ignored_reviewers_are_named,
  drop constraint github_ignorable_checks_are_named;
