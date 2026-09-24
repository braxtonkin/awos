-- migrate:up
alter type connector_kind add value 'jira';

-- migrate:down
drop function replace_credential(uuid, timestamptz, bigint, connector_kind, bigint, bytea, int, timestamptz, jsonb);
alter table credential drop constraint credential_scope_matches_connector;
alter type connector_kind rename to connector_kind_with_jira;
create type connector_kind as enum ('codex', 'github');
alter table connector alter column kind type connector_kind using kind::text::connector_kind;
alter table credential alter column connector type connector_kind using connector::text::connector_kind;
alter table human_action alter column connector type connector_kind using connector::text::connector_kind;
drop type connector_kind_with_jira;
alter table credential add constraint credential_scope_matches_connector foreign key (connector, scope) references connector (kind, scope);

create function replace_credential(replacement uuid, replaced_at timestamptz, replaced_by bigint, of_connector connector_kind, of_person bigint, sealed bytea, sealed_with int, expires timestamptz, audit jsonb)
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$
  with recorded as (
    insert into human_action (id, at, person_id, kind, connector, detail)
    values (replacement, replaced_at, replaced_by, 'replace_credential', of_connector, audit)
    on conflict (id) do nothing
    returning id
  )
  insert into credential (connector, scope, person_id, ciphertext, key_version, expires_at, action_id)
  select of_connector, (select connector.scope from connector where connector.kind = of_connector), of_person, sealed, sealed_with, expires, recorded.id
  from recorded
  on conflict (connector, person_id) do update set ciphertext = sealed, key_version = sealed_with, expires_at = expires, action_id = replacement, state = null, checked_at = null
  returning credential.id
$$;
revoke all on function replace_credential(uuid, timestamptz, bigint, connector_kind, bigint, bytea, int, timestamptz, jsonb) from public;
grant execute on function replace_credential(uuid, timestamptz, bigint, connector_kind, bigint, bytea, int, timestamptz, jsonb) to dashboard;
