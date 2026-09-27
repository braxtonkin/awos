-- migrate:up
alter table attempt
  add column obligation jsonb,
  add constraint obligation_names_its_kind check (
    obligation is null
    or (jsonb_typeof(obligation) = 'object'
        and case obligation ->> 'kind'
              when 'conflict' then coalesce(obligation ->> 'head' ~ '^[0-9a-f]{40}$', false)
              when 'check' then coalesce(obligation ->> 'head' ~ '^[0-9a-f]{40}$', false)
              else obligation ->> 'kind' in ('behavior', 'review', 'note')
            end));

alter table attempt disable trigger finished_attempt_is_final;
update attempt set obligation = jsonb_build_object('kind', 'conflict', 'branch', repository.branch, 'head', attempt.merge_head, 'notes', '[]'::jsonb)
  from task join repository on repository.id = task.repository_id
  where task.id = attempt.task_id and attempt.merge_head is not null;
alter table attempt enable trigger finished_attempt_is_final;

alter table attempt drop column merge_head;
grant select (obligation) on attempt to dashboard;

-- migrate:down
revoke select (obligation) on attempt from dashboard;
alter table attempt add column merge_head text constraint merge_head_is_a_commit check (merge_head ~ '^[0-9a-f]{40}$');

alter table attempt disable trigger finished_attempt_is_final;
update attempt set merge_head = obligation ->> 'head' where obligation ->> 'kind' = 'conflict';
alter table attempt enable trigger finished_attempt_is_final;

alter table attempt drop column obligation;
