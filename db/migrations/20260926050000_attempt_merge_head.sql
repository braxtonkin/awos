-- migrate:up
alter table attempt add column merge_head text constraint merge_head_is_a_commit check (merge_head ~ '^[0-9a-f]{40}$');

-- migrate:down
alter table attempt drop column merge_head;
