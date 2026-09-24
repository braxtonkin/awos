-- migrate:up
create type credential_state as enum ('valid', 'invalid', 'unknown');
create type check_outcome as enum ('valid', 'invalid', 'unknown', 'lost');

alter table credential
  add column state credential_state,
  add column checked_at timestamptz,
  add constraint checked_credential_has_time check ((state is null) = (checked_at is null));

create table credential_check (
  id bigint generated always as identity primary key,
  credential_id bigint not null constraint check_of_credential references credential on delete cascade,
  replacement uuid not null,
  opened_expires_at timestamptz,
  refreshes boolean not null,
  checker text not null,
  claimed_at timestamptz not null,
  lease_until timestamptz not null,
  finished_at timestamptz,
  outcome check_outcome,
  cause text,
  constraint finished_check_has_outcome check ((finished_at is null) = (outcome is null))
);
create unique index one_live_check_per_credential on credential_check (credential_id) where finished_at is null;
create unique index one_refresh_per_login on credential_check (credential_id, replacement, opened_expires_at) nulls not distinct where refreshes;

create or replace function replace_credential(replacement uuid, replaced_at timestamptz, replaced_by bigint, of_connector connector_kind, of_person bigint, sealed bytea, sealed_with int, expires timestamptz, audit jsonb)
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

grant select (state, checked_at) on credential to dashboard;
grant select on credential_check to dashboard;

-- migrate:down
revoke select on credential_check from dashboard;
revoke select (state, checked_at) on credential from dashboard;

create or replace function replace_credential(replacement uuid, replaced_at timestamptz, replaced_by bigint, of_connector connector_kind, of_person bigint, sealed bytea, sealed_with int, expires timestamptz, audit jsonb)
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

drop table credential_check;
alter table credential drop constraint checked_credential_has_time, drop column checked_at, drop column state;
drop type check_outcome, credential_state;
