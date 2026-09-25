-- migrate:up
alter table attempt rename column bridge_pid to bridge_process;
alter table attempt alter column bridge_process type uuid using null;

-- migrate:down
alter table attempt alter column bridge_process type int using null;
alter table attempt rename column bridge_process to bridge_pid;
