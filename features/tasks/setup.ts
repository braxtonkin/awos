import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import { refusal, type Database } from '../../shared/db/client.ts';
import type { PersonKind, Repository as RepositoryRow } from '../../shared/db/types.ts';
import type { Workflows } from './start.ts';

export type Count = { readonly added: number; readonly changed: number };

type Outcome = 'added' | 'changed' | 'same';

type Problem = { readonly path: readonly (string | number)[]; readonly message: string };

const words = z.string().trim().min(1, { error: 'must not be blank' });

const email = z.string().trim().toLowerCase().pipe(z.email({ error: 'must be an email address' }));

const slug = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, { error: 'must be lowercase letters, digits, and dashes, starting with a letter' });

const skill = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, { error: 'must be lowercase letters, digits, and dashes' });

const repositoryFields = {
  github: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { error: 'must name an owner and a repository, such as example/sandbox' }),
  branch: words,
};

const repository = z.strictObject(repositoryFields);

const imageByDigest = z.string().regex(/^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/, {
  error: 'must name the image by its sha256 digest, as name@sha256:<64 hex digits>, because a tag can move',
});

const repositorySettings = z.strictObject({
  ...repositoryFields,
  image: imageByDigest.optional(),
  fastTestCommand: words.optional(),
  verifyProvider: slug.default('tests-only'),
});

const jiraSearch = 'jira-search';

const onlyJiraSearch = `belongs only to a ${jiraSearch} source`;

const source = z
  .strictObject({ kind: slug, jql: words.optional(), pageSize: z.int().min(1).max(100).optional() })
  .superRefine(({ kind, jql, pageSize }, context) => {
    const problems = [
      ...(kind === jiraSearch && jql === undefined ? [{ field: 'jql', message: `must hold the JQL query a ${jiraSearch} source searches with` }] : []),
      ...(kind !== jiraSearch && jql !== undefined ? [{ field: 'jql', message: onlyJiraSearch }] : []),
      ...(kind !== jiraSearch && pageSize !== undefined ? [{ field: 'pageSize', message: onlyJiraSearch }] : []),
    ];
    for (const { field, message } of problems) context.issues.push({ code: 'custom', path: [field], message, input: undefined });
  });

const routine = z.strictObject({
  name: words,
  goal: words,
  workflow: slug,
  source,
  jiraStartStatus: words.optional(),
  jiraEndStatus: words.optional(),
  ignoreLaterReviews: z.boolean().default(false),
  everyMinutes: z.number().int().min(1).max(24 * 60).default(15),
  repository: repository.optional(),
  creator: email,
  runAs: email.optional(),
  gates: z.array(slug).default([]),
  lastStep: slug.optional(),
  steps: z.record(slug, z.strictObject({ instructions: z.string().default(''), skills: z.array(skill).default([]) })).default({}),
});

type Repository = z.output<typeof repository>;

type RepositorySettings = z.output<typeof repositorySettings>;

type Routine = z.output<typeof routine>;

function fileSchema<L>(logins: z.ZodType<L>) {
  return z.strictObject({
    admin: email,
    people: z.array(z.strictObject({ name: words, email, jiraAccountId: words.optional(), logins })),
    teamAccounts: z.array(z.strictObject({ name: words, email, logins })).default([]),
    repositories: z.array(repositorySettings).default([]),
    routines: z.array(routine).default([]),
  });
}

export type SetupFile<L> = z.output<ReturnType<typeof fileSchema<L>>>;

const repositoryName = ({ github, branch }: Repository): string => `${github} on ${branch}`;

const duplicates = (keys: readonly string[]): readonly number[] => keys.flatMap((key, index) => (keys.indexOf(key) === index ? [] : [index]));

function routineProblems(planned: Routine, workflows: Workflows, people: readonly string[], accounts: readonly string[], repositories: readonly string[]): readonly Problem[] {
  const workflow = workflows.get(planned.workflow);
  if (workflow === undefined) {
    return [{ path: ['workflow'], message: `names the workflow ${planned.workflow}, which this engine does not run. Use one of: ${[...workflows.keys()].join(', ')}` }];
  }
  const names = workflow.steps.map(kind => kind.name);
  const end = planned.lastStep ?? names.at(-1) ?? '';
  const needsRepository = workflow.steps.some(kind => kind.needsRepository);
  const where = planned.repository === undefined ? undefined : repositoryName(planned.repository);
  const ending = workflow.steps.filter(kind => kind.canEnd).map(kind => kind.name);
  return [
    ...(people.includes(planned.creator) ? [] : [{ path: ['creator'], message: `names ${planned.creator}, whom people does not list` }]),
    ...(planned.runAs === undefined || accounts.includes(planned.runAs) ? [] : [{ path: ['runAs'], message: `names ${planned.runAs}, whom neither people nor teamAccounts lists` }]),
    ...(needsRepository && where === undefined ? [{ path: ['repository'], message: `must name a repository from repositories, because ${workflow.name} works in one` }] : []),
    ...(!needsRepository && where !== undefined ? [{ path: ['repository'], message: `must be left out, because ${workflow.name} works in no repository` }] : []),
    ...(where === undefined || repositories.includes(where) ? [] : [{ path: ['repository'], message: `names ${where}, which repositories does not list` }]),
    ...(planned.source.kind === jiraSearch || (planned.jiraStartStatus === undefined && planned.jiraEndStatus === undefined)
      ? []
      : [{ path: ['source', 'kind'], message: `names ${planned.source.kind}, but jiraStartStatus and jiraEndStatus move Jira tickets, which only a ${jiraSearch} source finds` }]),
    ...(ending.includes(end) ? [] : [{ path: ['lastStep'], message: `names ${end}, where ${workflow.name} cannot end. Use one of: ${ending.join(', ')}` }]),
    ...planned.gates.flatMap((gate, index) =>
      names.includes(gate) && names.indexOf(gate) < names.indexOf(end) ? [] : [{ path: ['gates', index], message: `names ${gate}, which is not a step of ${workflow.name} before its last step, ${end}` }],
    ),
    ...Object.keys(planned.steps).flatMap(step => (names.includes(step) ? [] : [{ path: ['steps', step], message: `is not a step of ${workflow.name}. Use one of: ${names.join(', ')}` }])),
  ];
}

function problemsIn<L>(file: SetupFile<L>, workflows: Workflows): readonly Problem[] {
  const people = file.people.map(person => person.email);
  const accounts = [...people, ...file.teamAccounts.map(account => account.email)];
  const accountPath = (index: number): Problem['path'] => (index < people.length ? ['people', index, 'email'] : ['teamAccounts', index - people.length, 'email']);
  const repositories = file.repositories.map(repositoryName);
  const routineKeys = file.routines.map(planned => JSON.stringify([planned.workflow, planned.repository === undefined ? null : repositoryName(planned.repository), planned.goal]));
  return [
    ...(people.includes(file.admin) ? [] : [{ path: ['admin'], message: `names ${file.admin}, whom people does not list. Name the person who runs setup` }]),
    ...duplicates(accounts).map(index => ({ path: accountPath(index), message: `lists ${accounts[index] ?? ''} a second time` })),
    ...duplicates(repositories).map(index => ({ path: ['repositories', index], message: `lists ${repositories[index] ?? ''} a second time` })),
    ...duplicates(routineKeys).map(index => ({ path: ['routines', index, 'goal'], message: 'repeats the workflow, repository, and goal of an earlier routine, which is how setup tells routines apart' })),
    ...file.routines.flatMap((planned, index) =>
      routineProblems(planned, workflows, people, accounts, repositories).map(problem => ({ path: ['routines', index, ...problem.path], message: problem.message })),
    ),
  ];
}

const json = z.string().transform((text, context): unknown => {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    context.issues.push({ code: 'custom', message: 'The file is not JSON. Check its brackets, commas, and quotes.', input: undefined });
    return z.NEVER;
  }
});

export async function readSetupFile<L>(path: string, loginsIn: (folder: string) => z.ZodType<L>, workflows: Workflows): Promise<SetupFile<L>> {
  const schema = json.pipe(
    fileSchema(loginsIn(dirname(path))).superRefine((file, context) => {
      for (const { path: at, message } of problemsIn(file, workflows)) context.issues.push({ code: 'custom', path: [...at], message, input: undefined });
    }),
  );
  const parsed = await schema.safeParseAsync(await readFile(path, 'utf8'));
  if (!parsed.success) throw new Error(`The setup file ${path} does not fit, so setup wrote nothing.\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

const tally = (outcomes: readonly Outcome[]): Count => ({
  added: outcomes.filter(outcome => outcome === 'added').length,
  changed: outcomes.filter(outcome => outcome === 'changed').length,
});

async function personId(db: Database, address: string): Promise<string> {
  const row = await db.selectFrom('person').select('id').where('email', '=', address).executeTakeFirst();
  if (row === undefined) throw new Error(`No person has the email ${address}. Run setup again with a file that lists them.`);
  return row.id;
}

type Account = { readonly name: string; readonly email: string; readonly jiraAccountId?: string | undefined };

async function applyAccount(trx: Database, kind: PersonKind, account: Account): Promise<Outcome> {
  const wanted = { name: account.name, kind, jira_account_id: account.jiraAccountId ?? null };
  const found = await trx.selectFrom('person').select(['id', 'name', 'kind', 'jira_account_id']).where('email', '=', account.email).executeTakeFirst();
  if (found !== undefined && isDeepStrictEqual({ name: found.name, kind: found.kind, jira_account_id: found.jira_account_id }, wanted)) return 'same';
  try {
    if (found === undefined) await trx.insertInto('person').values({ email: account.email, ...wanted }).execute();
    else await trx.updateTable('person').set(wanted).where('id', '=', found.id).execute();
  } catch (error) {
    const refused = refusal(error);
    if (refused?.kind !== 'unique' || refused.name !== 'one_person_per_jira_account') throw error;
    throw new Error(
      `Postgres refused ${account.email} under ${refused.name}, because another person already has the Jira account id ${wanted.jira_account_id ?? ''}. Give each person their own Jira account id. Nothing in this section was written.`,
      { cause: error },
    );
  }
  return found === undefined ? 'added' : 'changed';
}

function applyAccounts(db: Database, kind: PersonKind, accounts: readonly Account[]): Promise<Count> {
  return db.transaction().execute(async trx => {
    const outcomes: Outcome[] = [];
    for (const account of accounts) outcomes.push(await applyAccount(trx, kind, account));
    return tally(outcomes);
  });
}

export async function applyPeople<L>(db: Database, file: SetupFile<L>): Promise<{ readonly people: Count; readonly teamAccounts: Count }> {
  const people = await applyAccounts(db, 'person', file.people);
  const teamAccounts = await applyAccounts(db, 'shared', file.teamAccounts);
  return { people, teamAccounts };
}

const settingColumns = ['job_image', 'fast_test_command', 'verify_provider'] as const;

type SettingColumns = { readonly [Column in (typeof settingColumns)[number]]: Selectable<RepositoryRow>[Column] };

const settingsOf = (planned: RepositorySettings): SettingColumns => ({
  job_image: planned.image ?? null,
  fast_test_command: planned.fastTestCommand ?? null,
  verify_provider: planned.verifyProvider,
});

async function applyRepository(trx: Database, admin: string, planned: RepositorySettings): Promise<Outcome> {
  const { github, branch } = planned;
  const wanted = settingsOf(planned);
  const found = await trx
    .selectFrom('repository')
    .select(['id', ...settingColumns])
    .where('github', '=', github)
    .where('branch', '=', branch)
    .executeTakeFirst();
  const saved = randomUUID();
  if (found === undefined) {
    const { id } = await trx.insertInto('repository').values({ github, branch, ...wanted, saved_by: saved }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('human_action').values({ id: saved, at: new Date(), person_id: admin, kind: 'add_repository', repository_id: id }).execute();
    return 'added';
  }
  const { id, ...stored } = found;
  if (isDeepStrictEqual(stored, wanted)) return 'same';
  await trx.insertInto('human_action').values({ id: saved, at: new Date(), person_id: admin, kind: 'edit_repository', repository_id: id }).execute();
  await trx.updateTable('repository').set({ ...wanted, saved_by: saved }).where('id', '=', id).execute();
  return 'changed';
}

export function applyRepositories<L>(db: Database, file: SetupFile<L>): Promise<Count> {
  return db.transaction().execute(async trx => {
    const admin = await personId(trx, file.admin);
    const outcomes: Outcome[] = [];
    for (const planned of file.repositories) outcomes.push(await applyRepository(trx, admin, planned));
    return tally(outcomes);
  });
}

type Version = {
  readonly name: string;
  readonly everyMinutes: number;
  readonly source: unknown;
  readonly jiraStartStatus: string | null;
  readonly jiraEndStatus: string | null;
  readonly ignoreLaterReviews: boolean;
  readonly gates: readonly string[];
  readonly lastStep: string | null;
  readonly steps: Readonly<Record<string, { readonly instructions: string; readonly skills: readonly string[] }>>;
};

async function saveVersion(trx: Database, routineId: string, version: number, admin: string, planned: Routine, repositoryId: string | null): Promise<void> {
  const action = randomUUID();
  await trx.insertInto('human_action').values({ id: action, at: new Date(), person_id: admin, kind: 'edit_routine', routine_id: routineId }).execute();
  await trx
    .insertInto('routine_version')
    .values({
      routine_id: routineId,
      version,
      name: planned.name,
      goal: planned.goal,
      every: `${String(planned.everyMinutes)} minutes`,
      repository_id: repositoryId,
      action_id: action,
      workflow: planned.workflow,
      source: JSON.stringify(planned.source),
      jira_start_status: planned.jiraStartStatus ?? null,
      jira_end_status: planned.jiraEndStatus ?? null,
      ignore_later_reviews: planned.ignoreLaterReviews,
      needs_repository: repositoryId !== null,
      gates: planned.gates,
      last_step: planned.lastStep ?? null,
    })
    .execute();
  const steps = Object.entries(planned.steps).map(([step, { instructions, skills }]) => ({ routine_id: routineId, version, step, instructions, skills }));
  if (steps.length > 0) await trx.insertInto('routine_step').values(steps).execute();
}

async function applyRoutine(trx: Database, admin: string, planned: Routine): Promise<Outcome> {
  const creator = await personId(trx, planned.creator);
  const runAs = planned.runAs === undefined ? null : await personId(trx, planned.runAs);
  const repositoryId =
    planned.repository === undefined
      ? null
      : (await trx.selectFrom('repository').select('id').where('github', '=', planned.repository.github).where('branch', '=', planned.repository.branch).executeTakeFirstOrThrow()).id;
  const found = await trx
    .selectFrom('routine_version as version')
    .innerJoin('routine', 'routine.id', 'version.routine_id')
    .select([
      'routine.id',
      'routine.creator_id',
      'routine.run_as_id',
      'version.version',
      'version.name',
      sql<number>`(extract(epoch from version.every) / 60)::float8`.as('everyMinutes'),
      'version.source',
      'version.jira_start_status',
      'version.jira_end_status',
      'version.ignore_later_reviews',
      sql<string[]>`version.gates::text[]`.as('gates'),
      'version.last_step',
    ])
    .where('version.workflow', '=', planned.workflow)
    .where('version.goal', '=', planned.goal)
    .where('version.repository_id', 'is not distinct from', repositoryId)
    .where(eb =>
      eb('version.version', '=', eb.selectFrom('routine_version as newest').select(newest => newest.fn.max('newest.version').as('newest')).whereRef('newest.routine_id', '=', 'version.routine_id')),
    )
    .executeTakeFirst();
  if (found === undefined) {
    const { id } = await trx.insertInto('routine').values({ creator_id: creator, run_as_id: runAs }).returning('id').executeTakeFirstOrThrow();
    await saveVersion(trx, id, 1, admin, planned, repositoryId);
    return 'added';
  }
  const stepRows = await trx
    .selectFrom('routine_step')
    .select(['step', 'instructions', sql<string[]>`skills::text[]`.as('skills')])
    .where('routine_id', '=', found.id)
    .where('version', '=', found.version)
    .execute();
  const stored: Version = {
    name: found.name,
    everyMinutes: found.everyMinutes,
    source: found.source,
    jiraStartStatus: found.jira_start_status,
    jiraEndStatus: found.jira_end_status,
    ignoreLaterReviews: found.ignore_later_reviews,
    gates: found.gates,
    lastStep: found.last_step,
    steps: Object.fromEntries(stepRows.map(row => [row.step, { instructions: row.instructions, skills: row.skills }])),
  };
  const wanted: Version = {
    name: planned.name,
    everyMinutes: planned.everyMinutes,
    source: planned.source,
    jiraStartStatus: planned.jiraStartStatus ?? null,
    jiraEndStatus: planned.jiraEndStatus ?? null,
    ignoreLaterReviews: planned.ignoreLaterReviews,
    gates: planned.gates,
    lastStep: planned.lastStep ?? null,
    steps: planned.steps,
  };
  const routineChanged = found.creator_id !== creator || found.run_as_id !== runAs;
  const versionChanged = !isDeepStrictEqual(stored, wanted);
  if (routineChanged) await trx.updateTable('routine').set({ creator_id: creator, run_as_id: runAs }).where('id', '=', found.id).execute();
  if (versionChanged) await saveVersion(trx, found.id, found.version + 1, admin, planned, repositoryId);
  return routineChanged || versionChanged ? 'changed' : 'same';
}

export function applyRoutines<L>(db: Database, file: SetupFile<L>): Promise<Count> {
  return db.transaction().execute(async trx => {
    const admin = await personId(trx, file.admin);
    const outcomes: Outcome[] = [];
    for (const planned of file.routines) outcomes.push(await applyRoutine(trx, admin, planned));
    return tally(outcomes);
  });
}
