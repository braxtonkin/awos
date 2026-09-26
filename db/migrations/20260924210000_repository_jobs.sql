-- migrate:up
alter table repository
  add column job_image text constraint job_image_named_by_digest check (job_image ~ '^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$');

-- migrate:down
alter table repository drop column job_image;
