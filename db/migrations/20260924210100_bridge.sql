-- migrate:up
create domain bridge_token_hash as bytea constraint bridge_token_is_a_hash check (length(value) = 32);
create domain bridge_process as int constraint bridge_pid_is_a_process check (value > 0);
create domain line_count as bigint constraint high_water_counts_lines check (value >= 0);
create domain command_count as bigint constraint received_counts_commands check (value >= 0);

alter table attempt
  add column bridge_token_hash bridge_token_hash,
  add column bridge_pid bridge_process,
  add column high_water line_count not null default 0,
  add column commands_received command_count not null default 0;

create type attempt_event_kind as enum ('app', 'pushed', 'end');

create function refuse_after_end() returns trigger language plpgsql as $$
begin
  if exists (select 1 from attempt where attempt.id = new.attempt_id and attempt.finished_at is not null) then
    raise exception 'attempt % has ended, so it takes no more %', new.attempt_id, tg_table_name using errcode = 'restrict_violation', constraint = tg_name;
  end if;
  return new;
end
$$;

create table attempt_event (
  attempt_id bigint not null constraint event_of_attempt references attempt,
  seq bigint not null,
  kind attempt_event_kind not null,
  method text,
  item_id text,
  fragment boolean not null,
  body jsonb not null,
  stored_at timestamptz not null,
  constraint one_event_per_number primary key (attempt_id, seq),
  constraint event_numbers_count_from_one check (seq > 0),
  constraint fragment_names_its_item check (not fragment or (kind = 'app' and item_id is not null))
);
create index fragments_by_item on attempt_event (attempt_id, item_id) where fragment;
create trigger event_needs_live_attempt before insert on attempt_event for each row execute function refuse_after_end();

create type attempt_command_kind as enum ('turn.start', 'turn.steer', 'turn.stop');

create table attempt_command (
  attempt_id bigint not null constraint command_of_attempt references attempt,
  seq bigint not null,
  kind attempt_command_kind not null,
  input text,
  output_schema jsonb,
  client_message_id uuid,
  sent_at timestamptz not null,
  received_at timestamptz,
  acted_at timestamptz,
  constraint one_command_per_number primary key (attempt_id, seq),
  constraint command_numbers_count_from_one check (seq > 0),
  constraint command_carries_its_message check ((kind = 'turn.stop') = (input is null and client_message_id is null)),
  constraint only_a_start_has_a_schema check (kind = 'turn.start' or output_schema is null),
  constraint acted_on_after_received check (acted_at is null or received_at is not null),
  constraint one_command_per_message unique (client_message_id)
);
create trigger command_needs_live_attempt before insert on attempt_command for each row execute function refuse_after_end();

-- migrate:down
drop table attempt_command, attempt_event;
drop function refuse_after_end();
drop type attempt_command_kind, attempt_event_kind;
alter table attempt
  drop column bridge_token_hash,
  drop column bridge_pid,
  drop column high_water,
  drop column commands_received;
drop domain bridge_token_hash, bridge_process, line_count, command_count;
