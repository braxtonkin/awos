-- migrate:up
alter table human_action drop constraint target_fits_kind;
alter table human_action add constraint target_fits_kind check (case
  when kind in ('stop_task', 'retry_task', 'approve', 'send_back', 'pick_choice', 'untick_items', 'edit_draft', 'steer_task') then task_id is not null
  when kind in ('add_repository', 'edit_repository') then repository_id is not null
  when kind = 'replace_credential' then connector is not null
  else routine_id is not null
end);

alter table attempt_command
  add column action_id uuid constraint steer_cites_its_action references human_action deferrable initially deferred,
  add constraint steer_names_its_person check (kind <> 'turn.steer' or action_id is not null);

alter table person_request drop constraint request_kind_fits_target;
alter table person_request add constraint request_kind_fits_target check (case
  when kind in ('stop', 'retry', 'approve', 'send_back', 'answer', 'steer') then task_id is not null
  when kind in ('pause', 'resume', 'run_now') then routine_id is not null
  else false
end);

-- migrate:down
do $$
begin
  if exists (select 1 from person_request where kind = 'steer') or exists (select 1 from human_action where kind = 'steer_task') then
    raise exception 'This migration records each steer as a person action, so it rolls back only while no steer request or steer action exists.';
  end if;
end
$$;

alter table person_request drop constraint request_kind_fits_target;
alter table person_request add constraint request_kind_fits_target check (case
  when kind in ('stop', 'retry', 'approve', 'send_back', 'answer') then task_id is not null
  when kind in ('pause', 'resume', 'run_now') then routine_id is not null
  else false
end);

alter table attempt_command drop constraint steer_names_its_person, drop column action_id;

alter table human_action drop constraint target_fits_kind;
alter table human_action add constraint target_fits_kind check (case
  when kind in ('stop_task', 'retry_task', 'approve', 'send_back', 'pick_choice', 'untick_items', 'edit_draft') then task_id is not null
  when kind in ('add_repository', 'edit_repository') then repository_id is not null
  when kind = 'replace_credential' then connector is not null
  else routine_id is not null
end);
