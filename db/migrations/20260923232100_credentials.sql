-- migrate:up
create type connector_kind as enum ('codex', 'github');
create type connector_scope as enum ('team', 'personal');

create table connector (
  kind connector_kind primary key,
  scope connector_scope not null,
  constraint credential_scope_target unique (kind, scope)
);
insert into connector (kind, scope) values ('codex', 'personal'), ('github', 'personal');

alter table human_action add column connector connector_kind;
alter table human_action drop constraint one_target, drop constraint target_fits_kind;
alter table human_action
  add constraint one_target check (num_nonnulls(routine_id, task_id, connector) = 1),
  add constraint target_fits_kind check (case
    when kind in ('stop_task', 'retry_task') then task_id is not null
    when kind = 'replace_credential' then connector is not null
    else routine_id is not null
  end);

create table credential (
  id bigint generated always as identity primary key,
  connector connector_kind constraint credential_names_its_connector not null,
  scope connector_scope constraint credential_states_its_scope not null,
  person_id bigint constraint credential_of_person references person,
  ciphertext bytea constraint credential_holds_a_seal not null constraint ciphertext_holds_nonce_and_tag check (octet_length(ciphertext) > 28),
  key_version int not null,
  expires_at timestamptz,
  action_id uuid constraint credential_cites_its_action not null constraint credential_written_by_action references human_action,
  constraint credential_scope_matches_connector foreign key (connector, scope) references connector (kind, scope),
  constraint one_credential_per_connector_and_person unique nulls not distinct (connector, person_id),
  constraint personal_credential_has_person check ((scope = 'personal') = (person_id is not null))
);

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
  on conflict (connector, person_id) do update set ciphertext = sealed, key_version = sealed_with, expires_at = expires, action_id = replacement
  returning credential.id
$$;
revoke all on function replace_credential(uuid, timestamptz, bigint, connector_kind, bigint, bytea, int, timestamptz, jsonb) from public;

create role dashboard nologin;
grant select on connector to dashboard;
grant select (id, connector, scope, person_id, key_version, expires_at, action_id) on credential to dashboard;
grant execute on function replace_credential(uuid, timestamptz, bigint, connector_kind, bigint, bytea, int, timestamptz, jsonb) to dashboard;

-- migrate:down
drop function replace_credential(uuid, timestamptz, bigint, connector_kind, bigint, bytea, int, timestamptz, jsonb);
drop table credential;
drop table connector;
drop role dashboard;
delete from human_action where kind = 'replace_credential';
alter table human_action drop constraint one_target, drop constraint target_fits_kind;
alter table human_action drop column connector;
alter table human_action
  add constraint one_target check (num_nonnulls(routine_id, task_id) = 1),
  add constraint target_fits_kind check (case when kind in ('stop_task', 'retry_task') then task_id is not null else routine_id is not null end);
drop type connector_scope, connector_kind;
