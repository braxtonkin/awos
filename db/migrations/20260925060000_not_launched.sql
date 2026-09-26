-- migrate:up
alter type verdict add value 'not_launched';

-- migrate:down
do $$
begin
  if exists (select 1 from attempt where verdict = 'not_launched') then
    raise exception 'Some attempts ended not launched, and a finished attempt is final, so this migration cannot roll back.';
  end if;
end
$$;
create temporary table enum_checks on commit drop as
  select c.conrelid::regclass::text as relation, c.conname as name, pg_get_constraintdef(c.oid) as definition
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
  where c.contype = 'c' and c.connamespace = 'public'::regnamespace
    and a.atttypid = 'verdict'::regtype;
do $$
declare
  kept record;
begin
  for kept in select distinct relation, name from enum_checks loop
    execute format('alter table %s drop constraint %I', kept.relation, kept.name);
  end loop;
end
$$;
alter type verdict rename to verdict_with_not_launched;
do $$
begin
  execute (
    select format('create type verdict as enum (%s)', string_agg(quote_literal(enumlabel), ', ' order by enumsortorder))
    from pg_enum
    where enumtypid = 'verdict_with_not_launched'::regtype
      and enumlabel <> 'not_launched'
  );
end
$$;
alter table attempt alter column verdict type verdict using verdict::text::verdict;
drop type verdict_with_not_launched;
do $$
declare
  kept record;
begin
  for kept in select distinct relation, name, definition from enum_checks loop
    execute format('alter table %s add constraint %I %s', kept.relation, kept.name, kept.definition);
  end loop;
end
$$;
