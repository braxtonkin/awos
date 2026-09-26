-- migrate:up
alter type human_action_kind add value 'steer_task';

-- migrate:down
create temporary table enum_checks on commit drop as
  select c.conrelid::regclass::text as relation, c.conname as name, pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.contype = 'c' and c.connamespace = 'public'::regnamespace
    and a.atttypid = 'human_action_kind'::regtype;
create temporary table enum_indexes on commit drop as
  select pg_get_indexdef(x.indexrelid) as definition, i.relname as name
  from pg_index x join pg_class i on i.oid = x.indexrelid
  where x.indrelid = 'human_action'::regclass and pg_get_indexdef(x.indexrelid) ~ '\mkind\M'
    and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid);
do $$
declare
  kept record;
begin
  for kept in select distinct relation, name from enum_checks loop
    execute format('alter table %s drop constraint %I', kept.relation, kept.name);
  end loop;
  for kept in select name from enum_indexes loop
    execute format('drop index %I', kept.name);
  end loop;
end
$$;
alter type human_action_kind rename to human_action_kind_with_steers;
do $$
begin
  execute (
    select format('create type human_action_kind as enum (%s)', string_agg(quote_literal(enumlabel), ', ' order by enumsortorder))
    from pg_enum
    where enumtypid = 'human_action_kind_with_steers'::regtype and enumlabel <> 'steer_task'
  );
end
$$;
alter table human_action alter column kind type human_action_kind using kind::text::human_action_kind;
drop type human_action_kind_with_steers;
do $$
declare
  kept record;
begin
  for kept in select distinct relation, name, definition from enum_checks loop
    execute format('alter table %s add constraint %I %s', kept.relation, kept.name, kept.definition);
  end loop;
  for kept in select definition from enum_indexes loop
    execute kept.definition;
  end loop;
end
$$;
