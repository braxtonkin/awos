-- migrate:up
create type draft_leaves as enum ('when-green', 'at-once');

alter table repository
  add column ignorable_checks text[] not null default '{}',
  add column draft_leaves draft_leaves not null default 'when-green',
  add column ignored_reviewers text[] not null default '{}';

-- migrate:down
alter table repository drop column ignored_reviewers, drop column draft_leaves, drop column ignorable_checks;
drop type draft_leaves;
