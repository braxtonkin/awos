import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import { jiraSearch, type RoutineDraft } from '../../shared/routine-draft.ts';
import { slotOrigin } from '../../shared/slots.ts';

export type RoutineSummary = {
  readonly id: string;
  readonly name: string;
  readonly workflow: string;
  readonly everyMinutes: number;
  readonly paused: boolean;
  readonly nextRun: string | null;
  readonly runNowWaits: boolean;
};

export type Choice = { readonly id: string; readonly name: string };

export type WorkflowChoice = { readonly name: string; readonly steps: readonly string[] };

export type Choices = {
  readonly workflows: readonly WorkflowChoice[];
  readonly people: readonly Choice[];
  readonly teamAccounts: readonly Choice[];
  readonly repositories: readonly Choice[];
};

export type Saved = { readonly version: number; readonly by: string; readonly at: string };

export type RoutineForm = {
  readonly id: string | null;
  readonly saved: Saved | null;
  readonly paused: boolean;
  readonly draft: RoutineDraft;
};

const newestVersion = sql<boolean>`version.version = (select max(newest.version) from routine_version newest where newest.routine_id = version.routine_id)`;

const minutesOf = sql<number>`(extract(epoch from version.every) / 60)::float8`;

export async function listRoutines(db: Database, now: Date): Promise<readonly RoutineSummary[]> {
  const rows = await db
    .selectFrom('routine')
    .innerJoin('routine_version as version', 'version.routine_id', 'routine.id')
    .select(eb => [
      'routine.id',
      'version.name',
      'version.workflow',
      minutesOf.as('everyMinutes'),
      'routine.paused_by',
      sql<Date>`date_bin(version.every, ${now}::timestamptz, ${slotOrigin}::timestamptz) + version.every`.as('nextSlot'),
      eb
        .exists(eb.selectFrom('routine_run as run').select('run.id').whereRef('run.routine_id', '=', 'routine.id').where('run.reason', '=', 'run_now').where('run.started_at', 'is', null))
        .as('runNowWaits'),
    ])
    .where(newestVersion)
    .orderBy('version.name')
    .orderBy('routine.id')
    .execute();
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    workflow: row.workflow,
    everyMinutes: row.everyMinutes,
    paused: row.paused_by !== null,
    nextRun: row.paused_by === null ? new Date(row.nextSlot).toISOString() : null,
    runNowWaits: row.runNowWaits === true,
  }));
}

export async function readChoices(db: Database): Promise<Choices> {
  const steps = await db.selectFrom('published_workflow_step').select(['workflow', 'name']).orderBy('workflow').orderBy('position').execute();
  const accounts = await db.selectFrom('person').select(['id', 'name', 'kind']).orderBy('name').execute();
  const repositories = await db.selectFrom('repository').select(['id', 'github', 'branch']).orderBy('github').orderBy('branch').execute();
  return {
    workflows: [...Map.groupBy(steps, row => row.workflow)].map(([name, rows]) => ({ name, steps: rows.map(row => row.name) })),
    people: accounts.filter(account => account.kind === 'person').map(({ id, name }) => ({ id, name })),
    teamAccounts: accounts.filter(account => account.kind !== 'person').map(({ id, name }) => ({ id, name })),
    repositories: repositories.map(({ id, github, branch }) => ({ id, name: `${github} on ${branch}` })),
  };
}

const storedSource = z.strictObject({ kind: z.string(), jql: z.string().optional(), pageSize: z.int().optional() });

export async function readRoutine(db: Database, id: string): Promise<RoutineForm | undefined> {
  if (!/^[1-9]\d{0,17}$/.test(id)) return undefined;
  const row = await db
    .selectFrom('routine')
    .innerJoin('routine_version as version', 'version.routine_id', 'routine.id')
    .innerJoin('human_action as saved', 'saved.id', 'version.action_id')
    .innerJoin('person as saver', 'saver.id', 'saved.person_id')
    .select([
      'routine.id',
      'routine.run_as_id',
      'routine.paused_by',
      'version.version',
      'version.name',
      'version.goal',
      'version.workflow',
      'version.source',
      'version.jira_start_status',
      'version.jira_end_status',
      'version.ignore_later_reviews',
      minutesOf.as('everyMinutes'),
      'version.repository_id',
      sql<string[]>`version.gates::text[]`.as('gates'),
      'version.last_step',
      'saver.name as savedBy',
      'saved.at as savedAt',
    ])
    .where('routine.id', '=', id)
    .where(newestVersion)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const steps = await db
    .selectFrom('routine_step')
    .select(['step', 'instructions', sql<string[]>`skills::text[]`.as('skills')])
    .where('routine_id', '=', id)
    .where('version', '=', row.version)
    .execute();
  return {
    id: row.id,
    saved: { version: row.version, by: row.savedBy, at: new Date(row.savedAt).toISOString() },
    paused: row.paused_by !== null,
    draft: {
      from: row.version,
      name: row.name,
      goal: row.goal,
      workflow: row.workflow,
      source: storedSource.parse(row.source),
      jiraStartStatus: row.jira_start_status,
      jiraEndStatus: row.jira_end_status,
      ignoreLaterReviews: row.ignore_later_reviews,
      everyMinutes: row.everyMinutes,
      repository: row.repository_id,
      runAs: row.run_as_id,
      gates: row.gates,
      lastStep: row.last_step,
      steps: Object.fromEntries(steps.map(step => [step.step, { instructions: step.instructions, skills: step.skills }])),
    },
  };
}

const defaultEveryMinutes = 15;

export const newRoutine = (choices: Choices): RoutineForm => ({
  id: null,
  saved: null,
  paused: false,
  draft: {
    from: null,
    name: '',
    goal: '',
    workflow: choices.workflows[0]?.name ?? '',
    source: { kind: jiraSearch, jql: '' },
    jiraStartStatus: null,
    jiraEndStatus: null,
    ignoreLaterReviews: false,
    everyMinutes: defaultEveryMinutes,
    repository: choices.repositories[0]?.id ?? null,
    runAs: null,
    gates: [],
    lastStep: null,
    steps: {},
  },
});

export async function savedVersion(db: Database, action: string): Promise<{ readonly routine: string; readonly version: number } | undefined> {
  const row = await db.selectFrom('routine_version').select(['routine_id', 'version']).where('action_id', '=', action).executeTakeFirst();
  return row === undefined ? undefined : { routine: row.routine_id, version: row.version };
}
