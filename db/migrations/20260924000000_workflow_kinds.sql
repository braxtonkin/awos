-- migrate:up
alter type human_action_kind add value 'approve';
alter type human_action_kind add value 'send_back';
alter type human_action_kind add value 'pick_choice';
alter type human_action_kind add value 'untick_items';
alter type human_action_kind add value 'edit_draft';
alter type human_action_kind add value 'add_repository';
alter type human_action_kind add value 'edit_repository';
alter type verdict add value 'needs_input';
alter type verdict add value 'red_check';
alter type verdict add value 'changes_requested';
alter type verdict add value 'review_required';

-- migrate:down
create temporary table enum_checks on commit drop as
  select c.conrelid::regclass::text as relation, c.conname as name, pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.contype = 'c' and c.connamespace = 'public'::regnamespace
    and a.atttypid in ('human_action_kind'::regtype, 'verdict'::regtype);
do $$
declare
  kept record;
begin
  for kept in select distinct relation, name from enum_checks loop
    execute format('alter table %s drop constraint %I', kept.relation, kept.name);
  end loop;
end
$$;
alter type human_action_kind rename to human_action_kind_with_workflows;
do $$
begin
  execute (
    select format('create type human_action_kind as enum (%s)', string_agg(quote_literal(enumlabel), ', ' order by enumsortorder))
    from pg_enum
    where enumtypid = 'human_action_kind_with_workflows'::regtype
      and enumlabel not in ('approve', 'send_back', 'pick_choice', 'untick_items', 'edit_draft', 'add_repository', 'edit_repository')
  );
end
$$;
alter table human_action alter column kind type human_action_kind using kind::text::human_action_kind;
drop type human_action_kind_with_workflows;
alter type verdict rename to verdict_with_workflows;
do $$
begin
  execute (
    select format('create type verdict as enum (%s)', string_agg(quote_literal(enumlabel), ', ' order by enumsortorder))
    from pg_enum
    where enumtypid = 'verdict_with_workflows'::regtype
      and enumlabel not in ('needs_input', 'red_check', 'changes_requested', 'review_required')
  );
end
$$;
alter table attempt alter column verdict type verdict using verdict::text::verdict;
drop type verdict_with_workflows;
do $$
declare
  kept record;
begin
  for kept in select distinct relation, name, definition from enum_checks loop
    execute format('alter table %s add constraint %I %s', kept.relation, kept.name, kept.definition);
  end loop;
end
$$;
