-- migrate:up
alter table attempt_command alter column output_schema type json using output_schema::json;

-- migrate:down
alter table attempt_command alter column output_schema type jsonb using output_schema::jsonb;
