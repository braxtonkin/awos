-- migrate:up
alter table attempt
  add constraint bridge_token_is_a_hash check (length(bridge_token_hash) = 32),
  add constraint bridge_process_follows_its_token check (bridge_process is null or bridge_token_hash is not null),
  add constraint bridge_high_water_counts_lines check (high_water >= 0),
  add constraint bridge_received_counts_commands check (commands_received >= 0);

-- migrate:down
alter table attempt
  drop constraint bridge_received_counts_commands,
  drop constraint bridge_high_water_counts_lines,
  drop constraint bridge_process_follows_its_token,
  drop constraint bridge_token_is_a_hash;
