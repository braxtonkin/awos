-- migrate:up
alter table repository add column setup_command text;

-- migrate:down
alter table repository drop column setup_command;
