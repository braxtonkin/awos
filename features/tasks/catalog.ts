import { sql } from 'kysely';
import { connect } from '../../shared/db/client.ts';
import type { DB } from '../../shared/db/types.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { mutants } from './simulate.ts';

const ownedTables = ['person', 'repository', 'routine', 'routine_version', 'routine_step', 'task', 'human_action', 'attempt'] as const satisfies readonly (keyof DB)[];

export const noMutantYet: Readonly<Record<string, readonly string[]>> = {
  'Postgres will not drop the key that live_attempt_matches_ready_task points at while that foreign key stands': ['live_attempt_target'],
  'live_attempt_matches_ready_task is MATCH SIMPLE, so a null in any of these would skip it, and the claim copies each from the task, where none can be null': [
    'attempt_names_its_task',
    'attempt_names_its_routine',
    'attempt_names_its_step',
    'attempt_names_its_epoch',
  ],
  "it speeds finding a task's attempts and refuses nothing": ['attempts_by_task'],
  'the task simulator launches no Job, so it never writes a token, a Job creation, or a not_launched verdict; npm run verify -- launch-faults runs the worker that writes them': ['job_created_after_its_token', 'not_launched_created_no_job'],
  "the task simulator never writes a repository's Job image, and npm run verify -- jobs plants a mutable tag that the column refuses": ['job_image_named_by_digest'],
  'the claim reads the task, its newest routine version, and the person it runs as from rows that exist, so no claim can name a missing row': [
    'attempt_of_task',
    'attempt_cites_goal_version',
    'attempt_run_as_is_a_person',
  ],
  'the paved advance, act, reap, and park statements write these columns together, and no simulator fault writes them apart': [
    'attempt_verdict_when_finished',
    'review_when_judged',
    'waiting_has_reason',
    'waiting_says_on_what',
    'review_wait_names_its_review',
    'counts_are_an_object',
    'stopped_has_stop_action',
  ],
  'every statement and fault passes the time it writes, so none leaves a time empty': [
    'task_records_when_it_was_found',
    'action_records_when_it_happened',
    'attempt_records_when_it_started',
    'attempt_holds_a_lease',
  ],
  'a person action names the review the task waits on, which is an attempt of the same task, and the review wait names the attempt that finished it, so no paved write names a foreign attempt': [
    'review_of_its_task',
    'task_waits_on_its_own_review',
    'attempt_key_within_task',
    'answer_names_its_review',
    'stop_names_its_action',
    'action_on_task',
    'human_action_is_final',
    'note_is_text',
  ],
  'routine edits arrive with the dashboard, and the simulator seeds each routine with one version, so every claim finds one': [
    'attempt_follows_a_goal_version',
    'version_of_routine',
    'version_works_in_a_repository',
    'version_names_one_repository',
    'version_saved_by_action',
    'routine_version_is_final',
    'goal_not_blank',
    'every_is_a_positive_span_without_months',
    'pause_names_its_action',
    'action_on_routine',
    'action_taken_by_person',
    'version_names_its_workflow',
    'version_names_its_source',
    'version_records_its_repository_need',
    'version_lists_its_gates',
    'version_says_how_it_treats_later_reviews',
    'source_names_its_kind',
    'jira_start_status_is_named',
    'jira_end_status_is_named',
    'version_repository_when_needed',
    'version_workflow_rule',
    'setting_of_version',
    'routine_step_is_final',
  ],
  'the claim names the branch from the task key and the count of its attempts and takes the start from continuation, and the simulated Job pushes only 40-character commits to its own branch, so no paved write reaches a row these refuse': [
    'attempt_branch_is_its_own',
    'start_is_a_commit',
    'push_is_a_commit',
    'branch_starts_somewhere',
    'push_needs_a_branch',
  ],
  'two claims of one task count the same attempt number only when they race, and one_live_attempt_per_task already refuses the second of those as busy, so dropping this index changes nothing a property can see while that one stands; the claim refuses a collision here as busy too': [
    'one_attempt_per_branch',
  ],
  'the routines simulator in features/routines records tasks and owns this guard, and its mutant drops it there': ['task_keeps_its_routine'],
  'the badName fault writes a bad skill, step, and workflow name and a waiting reason that is not a sentence, and its seed fails unless the domain refuses the write, but dropGuard drops only table constraints, indexes, and triggers, so a domain has no mutant yet': [
    'workflow_name_is_a_slug',
    'step_name_is_a_slug',
    'skill_name_is_a_slug',
    'instruction_is_a_sentence',
  ],
  'intake writes people, repositories, routines, and tasks, and the simulator only seeds them, apart from the task with no repository that its intake fault tries': [
    'one_person_per_email',
    'email_is_lowercase',
    'one_person_per_jira_account',
    'names_owner_and_repository',
    'branch_not_blank',
    'one_row_per_branch',
    'routine_has_a_creator',
    'creator_is_a_person',
    'run_as_is_a_person',
    'one_task_per_key',
    'task_works_where_its_routine_said',
    'task_follows_its_version',
    'task_names_its_workflow',
    'task_records_its_repository_need',
    'task_lists_its_approvals',
    'task_keeps_its_counts',
    'repository_names_its_saving_action',
    'repository_saved_by_action',
    'action_on_repository',
  ],
};

export type Catalog = { readonly guards: number; readonly unlisted: readonly string[]; readonly absent: readonly string[]; readonly listedTwice: readonly string[] };

export async function checkCatalog(postgres: TestPostgres): Promise<Catalog> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    const { rows } = await sql<{ name: string }>`
      with owned as (select unnest(${ownedTables}::regclass[]) as relation)
      select c.conname as name
      from pg_constraint c
      join owned o on o.relation = c.conrelid
      join pg_class t on t.oid = c.conrelid
      left join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where not (c.contype = 'p' and c.conname = t.relname || '_pkey')
        and not (c.contype = 'n' and c.conname = t.relname || '_' || a.attname || '_not_null')
      union all
      select i.relname
      from pg_index x
      join owned o on o.relation = x.indrelid
      join pg_class i on i.oid = x.indexrelid
      where not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))
      union all
      select g.tgname
      from pg_trigger g
      join owned o on o.relation = g.tgrelid
      where not g.tgisinternal
      union all
      select c.conname
      from pg_constraint c
      join pg_type d on d.oid = c.contypid
      where c.contypid <> 0 and d.typnamespace = 'public'::regnamespace`.execute(db);
    const guards = new Set(rows.map(row => row.name));
    const listed = [...Object.keys(mutants), ...Object.values(noMutantYet).flat()];
    return {
      guards: guards.size,
      unlisted: [...guards].filter(name => !listed.includes(name)).sort(),
      absent: listed.filter(name => !guards.has(name)).sort(),
      listedTwice: [...new Set(listed.filter((name, index) => listed.indexOf(name) !== index))].sort(),
    };
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}
