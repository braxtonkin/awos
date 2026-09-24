-- migrate:up
do $$
begin
  if exists (select 1 from repository) or exists (select 1 from routine_version) or exists (select 1 from task) then
    raise exception 'This migration reshapes repositories, routine versions, and tasks, so it runs only before any exist.';
  end if;
end
$$;

create domain workflow_name as text constraint workflow_name_is_a_slug check (value ~ '^[a-z][a-z0-9-]{0,63}$');
create domain step_name as text constraint step_name_is_a_slug check (value ~ '^[a-z][a-z0-9-]{0,63}$');
create domain skill_name as text constraint skill_name_is_a_slug check (value ~ '^[a-z0-9][a-z0-9-]{0,63}$');
create domain instruction as text constraint instruction_is_a_sentence check (value ~ '^[A-Z].*[.]$');
create type waiting_on as enum ('retry', 'approval', 'answer', 'outside_approval');

alter table attempt drop constraint live_attempt_matches_ready_task;
alter table task drop constraint live_attempt_target;
alter table task rename column stage to step;
alter table task rename constraint task_stage_not_null to task_step_not_null;
alter table task alter column step drop default, alter column step type step_name using step::text;
alter table attempt rename column stage to step;
alter table attempt rename constraint attempt_names_its_stage to attempt_names_its_step;
alter table attempt alter column step type step_name using step::text;
drop type stage;

alter table repository
  add column saved_by uuid constraint repository_names_its_saving_action not null,
  add constraint repository_saved_by_action foreign key (saved_by) references human_action deferrable initially deferred;

alter table routine_version
  add column workflow workflow_name constraint version_names_its_workflow not null,
  add column source jsonb constraint version_names_its_source not null,
  add column needs_repository boolean constraint version_records_its_repository_need not null,
  add column gates step_name[] constraint version_lists_its_gates not null default '{}',
  add column last_step step_name,
  add column ignore_later_reviews boolean constraint version_says_how_it_treats_later_reviews not null default false,
  alter column repository_id drop not null,
  add constraint source_names_its_kind check (jsonb_typeof(source -> 'kind') = 'string'),
  add constraint version_repository_when_needed check ((repository_id is not null) = needs_repository),
  add constraint version_workflow_rule unique (routine_id, version, workflow, needs_repository);

create table routine_step (
  routine_id bigint not null,
  version int not null,
  step step_name not null,
  instructions text not null default '',
  skills skill_name[] not null default '{}',
  primary key (routine_id, version, step),
  constraint setting_of_version foreign key (routine_id, version) references routine_version
);
create trigger routine_step_is_final before update or delete on routine_step for each row execute function refuse_change();

alter table task
  add column workflow workflow_name constraint task_names_its_workflow not null,
  add column needs_repository boolean constraint task_records_its_repository_need not null,
  add column approved step_name[] constraint task_lists_its_approvals not null default '{}',
  add column input_waits int not null default 0,
  add column counts jsonb constraint task_keeps_its_counts not null default '{}',
  add column waiting_on waiting_on,
  add column review_attempt bigint,
  add column epoch int not null default 0,
  drop column rounds,
  drop column reruns,
  alter column repository_id drop not null,
  alter column waiting_reason type instruction,
  add constraint counts_are_an_object check (jsonb_typeof(counts) = 'object'),
  add constraint task_repository_when_needed check ((repository_id is not null) = needs_repository),
  add constraint task_follows_its_version foreign key (routine_id, found_version, workflow, needs_repository)
    references routine_version (routine_id, version, workflow, needs_repository),
  add constraint waiting_says_on_what check ((state = 'waiting') = (waiting_on is not null)),
  add constraint review_wait_names_its_review check (coalesce(waiting_on in ('approval', 'answer'), false) = (review_attempt is not null)),
  add constraint live_attempt_target unique (id, routine_id, step, epoch, ready);

alter table attempt
  add column epoch int constraint attempt_names_its_epoch not null,
  add constraint live_attempt_matches_ready_task foreign key (task_id, routine_id, step, epoch, live) references task (id, routine_id, step, epoch, ready),
  add constraint attempt_key_within_task unique (task_id, id),
  drop constraint output_when_passed,
  add constraint review_when_judged check ((verdict is null or verdict in ('lost', 'stopped')) = (output is null));

alter table task add constraint task_waits_on_its_own_review foreign key (id, review_attempt) references attempt (task_id, id);

create trigger done_task_is_final before update on task for each row
  when (old.state = 'done' and (new.state, new.step, new.retries, new.lost, new.input_waits, new.counts, new.approved)
        is distinct from (old.state, old.step, old.retries, old.lost, old.input_waits, old.counts, old.approved))
  execute function refuse_change();

alter table human_action drop constraint one_target, drop constraint target_fits_kind;
alter table human_action
  add column repository_id bigint constraint action_on_repository references repository,
  add column attempt_id bigint,
  add constraint one_target check (num_nonnulls(routine_id, task_id, repository_id, connector) = 1),
  add constraint target_fits_kind check (case
    when kind in ('stop_task', 'retry_task', 'approve', 'send_back', 'pick_choice', 'untick_items', 'edit_draft') then task_id is not null
    when kind in ('add_repository', 'edit_repository') then repository_id is not null
    when kind = 'replace_credential' then connector is not null
    else routine_id is not null
  end),
  add constraint answer_names_its_review check ((kind in ('approve', 'send_back', 'pick_choice', 'untick_items', 'edit_draft')) = (attempt_id is not null)),
  add constraint review_of_its_task foreign key (task_id, attempt_id) references attempt (task_id, id),
  add constraint send_back_has_a_note check (kind <> 'send_back' or btrim(coalesce(detail ->> 'note', '')) <> ''),
  add constraint note_is_text check (detail -> 'note' is null or (jsonb_typeof(detail -> 'note') = 'string' and btrim(detail ->> 'note') <> ''));
create unique index one_decision_per_review on human_action (attempt_id) where kind in ('approve', 'send_back');

-- migrate:down
do $$
begin
  if exists (select 1 from repository) or exists (select 1 from routine_version) or exists (select 1 from task) then
    raise exception 'This migration reshapes repositories, routine versions, and tasks, so it rolls back only while none exist.';
  end if;
end
$$;

drop index one_decision_per_review;
alter table human_action
  drop constraint note_is_text,
  drop constraint send_back_has_a_note,
  drop constraint review_of_its_task,
  drop constraint answer_names_its_review,
  drop constraint target_fits_kind,
  drop constraint one_target,
  drop column attempt_id,
  drop column repository_id;
alter table human_action
  add constraint one_target check (num_nonnulls(routine_id, task_id, connector) = 1),
  add constraint target_fits_kind check (case
    when kind in ('stop_task', 'retry_task') then task_id is not null
    when kind = 'replace_credential' then connector is not null
    else routine_id is not null
  end);

drop trigger done_task_is_final on task;
alter table task drop constraint task_waits_on_its_own_review;

alter table attempt
  drop constraint review_when_judged,
  add constraint output_when_passed check ((verdict is not distinct from 'pass') = (output is not null)),
  drop constraint attempt_key_within_task,
  drop constraint live_attempt_matches_ready_task,
  drop column epoch;

alter table task
  drop constraint live_attempt_target,
  drop constraint review_wait_names_its_review,
  drop constraint waiting_says_on_what,
  drop constraint task_follows_its_version,
  drop constraint task_repository_when_needed,
  drop constraint counts_are_an_object,
  alter column waiting_reason type text,
  alter column repository_id set not null,
  add column rounds int not null default 0,
  add column reruns int not null default 0,
  drop column review_attempt,
  drop column epoch,
  drop column waiting_on,
  drop column counts,
  drop column input_waits,
  drop column approved,
  drop column needs_repository,
  drop column workflow;

drop trigger routine_step_is_final on routine_step;
drop table routine_step;

alter table routine_version
  drop constraint version_workflow_rule,
  drop constraint version_repository_when_needed,
  drop constraint source_names_its_kind,
  alter column repository_id set not null,
  drop column ignore_later_reviews,
  drop column last_step,
  drop column gates,
  drop column needs_repository,
  drop column source,
  drop column workflow;

alter table repository drop constraint repository_saved_by_action, drop column saved_by;

create type stage as enum ('specify', 'implement', 'verify', 'land');
alter table attempt alter column step type stage using step::text::stage;
alter table attempt rename constraint attempt_names_its_step to attempt_names_its_stage;
alter table attempt rename column step to stage;
alter table task alter column step type stage using step::text::stage, alter column step set default 'specify';
alter table task rename column step to stage;
alter table task rename constraint task_step_not_null to task_stage_not_null;
alter table task add constraint live_attempt_target unique (id, routine_id, stage, ready);
alter table attempt add constraint live_attempt_matches_ready_task foreign key (task_id, routine_id, stage, live) references task (id, routine_id, stage, ready);

drop type waiting_on;
drop domain instruction;
drop domain skill_name;
drop domain step_name;
drop domain workflow_name;
