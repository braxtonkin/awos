-- migrate:up
create function refuse_older_login() returns trigger language plpgsql as $$
begin
  raise exception 'credential % already holds a login under action % that expires at %, so it cannot go back to one that expires at %', old.id, old.action_id, old.expires_at, new.expires_at
    using errcode = 'check_violation', constraint = tg_name;
end
$$;
revoke execute on function refuse_older_login() from public;

create trigger stored_login_is_newest before update of action_id, expires_at on credential for each row
  when (new.action_id = old.action_id and old.expires_at is not null and (new.expires_at is null or new.expires_at < old.expires_at))
  execute function refuse_older_login();

create trigger finished_check_is_final before update on credential_check for each row
  when (old.finished_at is not null)
  execute function refuse_change();

-- migrate:down
drop trigger finished_check_is_final on credential_check;
drop trigger stored_login_is_newest on credential;
drop function refuse_older_login();
