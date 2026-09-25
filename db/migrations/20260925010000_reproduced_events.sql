-- migrate:up
alter type attempt_event_kind add value 'reproduced' before 'end';

-- migrate:down
delete from attempt_event where kind = 'reproduced';
alter type attempt_event_kind rename to attempt_event_kind_old;
create type attempt_event_kind as enum ('app', 'pushed', 'end');
alter table attempt_event alter column kind type attempt_event_kind using kind::text::attempt_event_kind;
drop type attempt_event_kind_old;
