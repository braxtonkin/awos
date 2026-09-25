-- migrate:up
alter trigger task_keeps_its_routine on task rename to routines_task_keeps_its_routine;

-- migrate:down
alter trigger routines_task_keeps_its_routine on task rename to task_keeps_its_routine;
