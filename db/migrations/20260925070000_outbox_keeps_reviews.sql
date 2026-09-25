-- migrate:up
create or replace function park_for_failed_row() returns trigger language plpgsql as $$
declare
  failure text := format('The %s action failed %s times, last with: %s.', new.kind, new.tries, left(regexp_replace(new.last_error, '\s+', ' ', 'g'), 1000));
begin
  update task
  set state = 'waiting',
      waiting_on = 'retry',
      review_attempt = null,
      waiting_reason = failure || ' Fix what it needs, then press Retry to perform it again.'
  where id = new.task_id and (state = 'ready' or (state = 'waiting' and waiting_on not in ('approval', 'answer')));
  update task
  set waiting_reason = waiting_reason || ' ' || failure || ' AutoWorker performs it again once this review is decided.'
  where id = new.task_id and state = 'waiting' and waiting_on in ('approval', 'answer');
  return null;
end
$$;

-- migrate:down
create or replace function park_for_failed_row() returns trigger language plpgsql as $$
begin
  update task
  set state = 'waiting',
      waiting_on = 'retry',
      review_attempt = null,
      waiting_reason = format('The %s action failed %s times, last with: %s. Fix what it needs, then press Retry to perform it again.',
                              new.kind, new.tries, left(regexp_replace(new.last_error, '\s+', ' ', 'g'), 1000))
  where id = new.task_id and state in ('ready', 'waiting');
  return null;
end
$$;
