-- migrate:up
alter table attempt disable trigger finished_attempt_is_final;
update attempt set obligation = obligation || jsonb_build_object('branch', repository.branch, 'base', obligation -> 'head')
  from task join repository on repository.id = task.repository_id
  where task.id = attempt.task_id and attempt.obligation ->> 'kind' = 'check';
alter table attempt enable trigger finished_attempt_is_final;

alter table attempt
  drop constraint obligation_names_its_kind,
  add constraint obligation_names_its_kind check (
    obligation is null
    or (jsonb_typeof(obligation) = 'object'
        and case obligation ->> 'kind'
              when 'conflict' then coalesce(obligation ->> 'head' ~ '^[0-9a-f]{40}$', false)
              when 'check' then coalesce(obligation ->> 'head' ~ '^[0-9a-f]{40}$' and obligation ->> 'base' ~ '^[0-9a-f]{40}$' and obligation ->> 'branch' <> '', false)
              else obligation ->> 'kind' in ('behavior', 'review', 'note')
            end));

-- migrate:down
alter table attempt
  drop constraint obligation_names_its_kind,
  add constraint obligation_names_its_kind check (
    obligation is null
    or (jsonb_typeof(obligation) = 'object'
        and case obligation ->> 'kind'
              when 'conflict' then coalesce(obligation ->> 'head' ~ '^[0-9a-f]{40}$', false)
              when 'check' then coalesce(obligation ->> 'head' ~ '^[0-9a-f]{40}$', false)
              else obligation ->> 'kind' in ('behavior', 'review', 'note')
            end));

alter table attempt disable trigger finished_attempt_is_final;
update attempt set obligation = obligation - 'branch' - 'base' where obligation ->> 'kind' = 'check';
alter table attempt enable trigger finished_attempt_is_final;
