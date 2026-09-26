-- migrate:up
alter table task
  drop constraint waiting_says_on_what,
  add constraint waiting_says_on_what check (state <> 'waiting' or waiting_on is not null),
  add constraint only_a_gate_stop_keeps_its_wait check (waiting_on is null or state = 'waiting' or (state = 'stopped' and waiting_on = 'approval'));

-- migrate:down
alter table task
  drop constraint only_a_gate_stop_keeps_its_wait,
  drop constraint waiting_says_on_what,
  add constraint waiting_says_on_what check ((state = 'waiting') = (waiting_on is not null));
