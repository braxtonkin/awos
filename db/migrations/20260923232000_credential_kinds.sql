-- migrate:up
alter type human_action_kind add value 'replace_credential';

-- migrate:down
do $$
declare
  fits text := (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'human_action'::regclass and conname = 'target_fits_kind');
begin
  alter table human_action drop constraint target_fits_kind;
  alter type human_action_kind rename to human_action_kind_with_credentials;
  execute (
    select format('create type human_action_kind as enum (%s)', string_agg(quote_literal(enumlabel), ', ' order by enumsortorder))
    from pg_enum
    where enumtypid = 'human_action_kind_with_credentials'::regtype
      and enumlabel <> 'replace_credential'
  );
  alter table human_action alter column kind type human_action_kind using kind::text::human_action_kind;
  drop type human_action_kind_with_credentials;
  execute format('alter table human_action add constraint target_fits_kind %s', fits);
end
$$;
