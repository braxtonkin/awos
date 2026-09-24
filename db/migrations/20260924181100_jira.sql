-- migrate:up
insert into connector (kind, scope) values ('jira', 'personal');

alter table routine_version
  add column jira_start_status text constraint jira_start_status_is_named check (btrim(jira_start_status) <> ''),
  add column jira_end_status text constraint jira_end_status_is_named check (btrim(jira_end_status) <> '');

-- migrate:down
alter table routine_version drop column jira_end_status, drop column jira_start_status;
delete from credential where connector = 'jira';
delete from human_action where connector = 'jira';
delete from connector where kind = 'jira';
