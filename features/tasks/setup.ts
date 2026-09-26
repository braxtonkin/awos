import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import { refusal, type Database } from '../../shared/db/client.ts';
import type { PersonKind, Repository as RepositoryRow } from '../../shared/db/types.ts';
import { everyMinutes, jiraSearch, slug, source, stepSettings, words, type RoutineDraft, type Source } from '../../shared/routine-draft.ts';
import { draftLeaves, github, imageByDigest, type RepositorySave } from '../../shared/repository-settings.ts';
import type { Transacting } from '../../shared/transaction.ts';
import type { Workflows } from './start.ts';

export type Count = { readonly added: number; readonly changed: number };

type Outcome = 'added' | 'changed' | 'same';

type Problem = { readonly path: readonly (string | number)[]; readonly message: string };

const email = z.string().trim().toLowerCase().pipe(z.email({ error: 'must be an email address' }));

const repositoryFields = { github, branch: words };

const repository = z.strictObject(repositoryFields);

const repositorySettings = z.strictObject({
  ...repositoryFields,
  image: imageByDigest.optional(),
  fastTestCommand: words.optional(),
  setupCommand: words.optional(),
  verifyProvider: slug.default('tests-only'),
  ignorableChecks: z.array(words).default([]),
  draftLeaves: draftLeaves.default('when-green'),
  ignoredReviewers: z.array(words).default([]),
});

const routine = z.strictObject({
  name: words,
  goal: words,
  workflow: slug,
  source,
  jiraStartStatus: words.optional(),
  jiraEndStatus: words.optional(),
  ignoreLaterReviews: z.boolean().default(false),
  everyMinutes: everyMinutes.default(15),
  repository: repository.optional(),
  creator: email,
  runAs: email.optional(),
  gates: z.array(slug).default([]),
  lastStep: slug.optional(),
  steps: stepSettings.default({}),
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

type Fit = {
  readonly workflow: string;
  readonly hasRepository: boolean;
  readonly source: Source;
  readonly movesJira: boolean;
  readonly gates: readonly string[];
  readonly lastStep: string | null;
  readonly steps: readonly string[];
};

function fitProblems(planned: Fit, workflows: Workflows): readonly Problem[] {
  const workflow = workflows.get(planned.workflow);
  if (workflow === undefined) {
    return [{ path: ['workflow'], message: `names ${planned.workflow}, which this engine does not run. Use one of: ${[...workflows.keys()].join(', ')}` }];
  }
  const names = workflow.steps.map(kind => kind.name);
  const end = planned.lastStep ?? names.at(-1) ?? '';
  const needsRepository = workflow.steps.some(kind => kind.needsRepository);
  const ending = workflow.steps.filter(kind => kind.canEnd).map(kind => kind.name);
  return [
    ...(needsRepository && !planned.hasRepository ? [{ path: ['repository'], message: `must name a repository, because ${workflow.name} works in one` }] : []),
    ...(!needsRepository && planned.hasRepository ? [{ path: ['repository'], message: `must be left out, because ${workflow.name} works in no repository` }] : []),
    ...(planned.source.kind === jiraSearch || !planned.movesJira
      ? []
      : [{ path: ['source', 'kind'], message: `names ${planned.source.kind}, but the Jira statuses move Jira tickets, which only a ${jiraSearch} source finds` }]),
    ...(ending.includes(end) ? [] : [{ path: ['lastStep'], message: `names ${end}, where ${workflow.name} cannot end. Use one of: ${ending.join(', ')}` }]),
    ...planned.gates.flatMap((gate, index) =>
      names.includes(gate) && names.indexOf(gate) < names.indexOf(end) ? [] : [{ path: ['gates', index], message: `names ${gate}, which is not a step of ${workflow.name} before its last step, ${end}` }],
    ),
    ...planned.steps.flatMap(step => (names.includes(step) ? [] : [{ path: ['steps', step], message: `is not a step of ${workflow.name}. Use one of: ${names.join(', ')}` }])),
  ];
}

function routineProblems(planned: Routine, workflows: Workflows, people: readonly string[], accounts: readonly string[], repositories: readonly string[]): readonly Problem[] {
  const where = planned.repository === undefined ? undefined : repositoryName(planned.repository);
  return [
    ...(people.includes(planned.creator) ? [] : [{ path: ['creator'], message: `names ${planned.creator}, whom people does not list` }]),
    ...(planned.runAs === undefined || accounts.includes(planned.runAs) ? [] : [{ path: ['runAs'], message: `names ${planned.runAs}, whom neither people nor teamAccounts lists` }]),
    ...(where === undefined || repositories.includes(where) ? [] : [{ path: ['repository'], message: `names ${where}, which repositories does not list` }]),
    ...fitProblems(
      {
        workflow: planned.workflow,
        hasRepository: where !== undefined,
        source: planned.source,
        movesJira: planned.jiraStartStatus !== undefined || planned.jiraEndStatus !== undefined,
        gates: planned.gates,
        lastStep: planned.lastStep ?? null,
        steps: Object.keys(planned.steps),
      },
      workflows,
    ),
  ];
}

export type Engine = { readonly workflows: Workflows; readonly providers: readonly string[] };

function problemsIn<L>(file: SetupFile<L>, { workflows, providers }: Engine): readonly Problem[] {
  const people = file.people.map(person => person.email);
  const accounts = [...people, ...file.teamAccounts.map(account => account.email)];
  const accountPath = (index: number): Problem['path'] => (index < people.length ? ['people', index, 'email'] : ['teamAccounts', index - people.length, 'email']);
  const repositories = file.repositories.map(repositoryName);
  const routineKeys = file.routines.map(planned => JSON.stringify([planned.workflow, planned.repository === undefined ? null : repositoryName(planned.repository), planned.goal]));
  return [
    ...(people.includes(file.admin) ? [] : [{ path: ['admin'], message: `names ${file.admin}, whom people does not list. Name the person who runs setup` }]),
    ...duplicates(accounts).map(index => ({ path: accountPath(index), message: `lists ${accounts[index] ?? ''} a second time` })),
    ...duplicates(repositories).map(index => ({ path: ['repositories', index], message: `lists ${repositories[index] ?? ''} a second time` })),
    ...file.repositories.flatMap(({ verifyProvider }, index) =>
      providers.includes(verifyProvider)
        ? []
        : [{ path: ['repositories', index, 'verifyProvider'], message: `names the Verify provider ${verifyProvider}, which this engine was not given. Use one of: ${providers.join(', ')}` }],
    ),
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

export async function readSetupFile<L>(path: string, loginsIn: (folder: string) => z.ZodType<L>, engine: Engine): Promise<SetupFile<L>> {
  const schema = json.pipe(
    fileSchema(loginsIn(dirname(path))).superRefine((file, context) => {
      for (const { path: at, message } of problemsIn(file, engine)) context.issues.push({ code: 'custom', path: [...at], message, input: undefined });
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

const settingColumns = ['job_image', 'fast_test_command', 'setup_command', 'verify_provider', 'ignorable_checks', 'draft_leaves', 'ignored_reviewers'] as const;

type SettingColumns = { readonly [Column in (typeof settingColumns)[number]]: Selectable<RepositoryRow>[Column] };

const settingsOf = (planned: RepositorySettings): SettingColumns => ({
  job_image: planned.image ?? null,
  fast_test_command: planned.fastTestCommand ?? null,
  setup_command: planned.setupCommand ?? null,
  verify_provider: planned.verifyProvider,
  ignorable_checks: [...planned.ignorableChecks],
  draft_leaves: planned.draftLeaves,
  ignored_reviewers: [...planned.ignoredReviewers],
});

type Acting = { readonly id: string; readonly person: string; readonly at: Date };

type Wanted = { readonly branch: string } & SettingColumns;

type Stored = { readonly id: string } & Wanted;

const storedColumns = ['id', 'branch', ...settingColumns] as const;

async function writeRepository(trx: Database, by: Acting, named: string, found: Stored | undefined, wanted: Wanted): Promise<Outcome> {
  if (found === undefined) {
    const { id } = await trx.insertInto('repository').values({ github: named, ...wanted, saved_by: by.id }).returning('id').executeTakeFirstOrThrow();
    await trx.insertInto('human_action').values({ id: by.id, at: by.at, person_id: by.person, kind: 'add_repository', repository_id: id }).execute();
    return 'added';
  }
  const { id, ...stored } = found;
  if (isDeepStrictEqual(stored, wanted)) return 'same';
  await trx.insertInto('human_action').values({ id: by.id, at: by.at, person_id: by.person, kind: 'edit_repository', repository_id: id }).execute();
  await trx.updateTable('repository').set({ ...wanted, saved_by: by.id }).where('id', '=', id).execute();
  return 'changed';
}

async function applyRepository(trx: Database, admin: string, planned: RepositorySettings): Promise<Outcome> {
  const { github: named, branch } = planned;
  const found = await trx.selectFrom('repository').select(storedColumns).where('github', '=', named).where('branch', '=', branch).executeTakeFirst();
  return writeRepository(trx, { id: randomUUID(), person: admin, at: new Date() }, named, found, { branch, ...settingsOf(planned) });
}

export type RepositorySaved = 'recorded' | { readonly refused: string };

const wantedFrom = (save: RepositorySave): Wanted => ({
  branch: save.branch,
  job_image: save.image,
  fast_test_command: save.fastTestCommand,
  setup_command: save.setupCommand,
  verify_provider: save.verifyProvider,
  ignorable_checks: [...save.ignorableChecks],
  draft_leaves: save.draftLeaves,
  ignored_reviewers: [...save.ignoredReviewers],
});

async function savedOver(tx: Transacting, target: string | null, save: RepositorySave): Promise<{ readonly named: string; readonly found: Stored | undefined } | { readonly refused: string }> {
  if (target === null) return save.github === null ? { refused: 'A new repository must name its owner and repository, such as example/sandbox.' } : { named: save.github, found: undefined };
  if (save.github !== null) return { refused: 'A save to a listed repository keeps its owner and repository, so it must not name them.' };
  const row = await tx.selectFrom('repository').select(['github', ...storedColumns]).where('id', '=', target).executeTakeFirst();
  if (row === undefined) return { refused: `No listed repository has the id ${target}.` };
  const { github: named, ...found } = row;
  return { named, found };
}

export async function saveRepository(tx: Transacting, by: Acting, target: string | null, save: RepositorySave): Promise<RepositorySaved> {
  const providers = (await tx.selectFrom('published_provider').select('name').orderBy('name').execute()).map(row => row.name);
  if (!providers.includes(save.verifyProvider)) return { refused: `This engine does not publish the Verify provider ${save.verifyProvider}. Pick one of: ${providers.join(', ')}.` };
  const over = await savedOver(tx, target, save);
  if ('refused' in over) return over;
  const { named, found } = over;
  const listed = tx.selectFrom('repository').select('id').where('github', '=', named).where('branch', '=', save.branch);
  const clash = await (found === undefined ? listed : listed.where('id', '<>', found.id)).executeTakeFirst();
  if (clash !== undefined) return { refused: `${named} on ${save.branch} is already listed.` };
  const outcome = await writeRepository(tx, by, named, found, wantedFrom(save));
  return outcome === 'same' ? { refused: 'Nothing changed, so nothing was saved.' } : 'recorded';
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
  readonly goal: string;
  readonly workflow: string;
  readonly repository: string | null;
  readonly everyMinutes: number;
  readonly source: unknown;
  readonly jiraStartStatus: string | null;
  readonly jiraEndStatus: string | null;
  readonly ignoreLaterReviews: boolean;
  readonly gates: readonly string[];
  readonly lastStep: string | null;
  readonly steps: Readonly<Record<string, { readonly instructions: string; readonly skills: readonly string[] }>>;
};

type Act = { readonly id: string; readonly person: string; readonly at: Date };

async function readVersion(trx: Database, routineId: string, version: number): Promise<Version> {
  const found = await trx
    .selectFrom('routine_version')
    .select([
      'name',
      'goal',
      'workflow',
      'repository_id',
      sql<number>`(extract(epoch from every) / 60)::float8`.as('everyMinutes'),
      'source',
      'jira_start_status',
      'jira_end_status',
      'ignore_later_reviews',
      sql<string[]>`gates::text[]`.as('gates'),
      'last_step',
    ])
    .where('routine_id', '=', routineId)
    .where('version', '=', version)
    .executeTakeFirstOrThrow();
  const stepRows = await trx.selectFrom('routine_step').select(['step', 'instructions', sql<string[]>`skills::text[]`.as('skills')]).where('routine_id', '=', routineId).where('version', '=', version).execute();
  return {
    name: found.name,
    goal: found.goal,
    workflow: found.workflow,
    repository: found.repository_id,
    everyMinutes: found.everyMinutes,
    source: found.source,
    jiraStartStatus: found.jira_start_status,
    jiraEndStatus: found.jira_end_status,
    ignoreLaterReviews: found.ignore_later_reviews,
    gates: found.gates,
    lastStep: found.last_step,
    steps: Object.fromEntries(stepRows.map(row => [row.step, { instructions: row.instructions, skills: row.skills }])),
  };
}

async function saveVersion(trx: Database, routineId: string, version: number, action: Act, planned: Version): Promise<void> {
  await trx.insertInto('human_action').values({ id: action.id, at: action.at, person_id: action.person, kind: 'edit_routine', routine_id: routineId }).execute();
  await trx
    .insertInto('routine_version')
    .values({
      routine_id: routineId,
      version,
      name: planned.name,
      goal: planned.goal,
      every: `${String(planned.everyMinutes)} minutes`,
      repository_id: planned.repository,
      action_id: action.id,
      workflow: planned.workflow,
      source: JSON.stringify(planned.source),
      jira_start_status: planned.jiraStartStatus,
      jira_end_status: planned.jiraEndStatus,
      ignore_later_reviews: planned.ignoreLaterReviews,
      needs_repository: planned.repository !== null,
      gates: [...planned.gates],
      last_step: planned.lastStep,
    })
    .execute();
  const steps = Object.entries(planned.steps).map(([step, { instructions, skills }]) => ({ routine_id: routineId, version, step, instructions, skills: [...skills] }));
  if (steps.length > 0) await trx.insertInto('routine_step').values(steps).execute();
}

const versionOf = (planned: Routine, repositoryId: string | null): Version => ({
  name: planned.name,
  goal: planned.goal,
  workflow: planned.workflow,
  repository: repositoryId,
  everyMinutes: planned.everyMinutes,
  source: planned.source,
  jiraStartStatus: planned.jiraStartStatus ?? null,
  jiraEndStatus: planned.jiraEndStatus ?? null,
  ignoreLaterReviews: planned.ignoreLaterReviews,
  gates: planned.gates,
  lastStep: planned.lastStep ?? null,
  steps: planned.steps,
});

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
    .select(['routine.id', 'routine.creator_id', 'routine.run_as_id', 'version.version'])
    .where('version.workflow', '=', planned.workflow)
    .where('version.goal', '=', planned.goal)
    .where('version.repository_id', 'is not distinct from', repositoryId)
    .where(eb =>
      eb('version.version', '=', eb.selectFrom('routine_version as newest').select(newest => newest.fn.max('newest.version').as('newest')).whereRef('newest.routine_id', '=', 'version.routine_id')),
    )
    .executeTakeFirst();
  const wanted = versionOf(planned, repositoryId);
  const byAdmin = (): Act => ({ id: randomUUID(), person: admin, at: new Date() });
  if (found === undefined) {
    const { id } = await trx.insertInto('routine').values({ creator_id: creator, run_as_id: runAs }).returning('id').executeTakeFirstOrThrow();
    await saveVersion(trx, id, 1, byAdmin(), wanted);
    return 'added';
  }
  const routineChanged = found.creator_id !== creator || found.run_as_id !== runAs;
  const versionChanged = !isDeepStrictEqual(await readVersion(trx, found.id, found.version), wanted);
  if (routineChanged) await trx.updateTable('routine').set({ creator_id: creator, run_as_id: runAs }).where('id', '=', found.id).execute();
  if (versionChanged) await saveVersion(trx, found.id, found.version + 1, byAdmin(), wanted);
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

export type Saving = { readonly action: string; readonly person: string; readonly at: Date; readonly routine: string | null; readonly draft: RoutineDraft };

export type Saved = { readonly version: number } | { readonly refused: string };

const fieldWords: Readonly<Record<string, string>> = {
  workflow: 'The workflow',
  repository: 'The repository',
  runAs: 'Run as',
  source: 'The source',
  lastStep: 'The last step',
  gates: 'A gate',
};

const sentence = ({ path, message }: Problem): string => {
  const [field, detail] = path;
  if (field === 'steps') return `Instructions are set for ${String(detail)}, which ${message}.`;
  return `${fieldWords[String(field)] ?? 'The routine'} ${message}.`;
};

const draftVersion = (draft: RoutineDraft): Version => ({
  name: draft.name,
  goal: draft.goal,
  workflow: draft.workflow,
  repository: draft.repository,
  everyMinutes: draft.everyMinutes,
  source: draft.source,
  jiraStartStatus: draft.jiraStartStatus,
  jiraEndStatus: draft.jiraEndStatus,
  ignoreLaterReviews: draft.ignoreLaterReviews,
  gates: draft.gates,
  lastStep: draft.lastStep,
  steps: draft.steps,
});

async function unknownChoices(tx: Transacting, draft: RoutineDraft): Promise<readonly Problem[]> {
  const person = draft.runAs === null ? null : await tx.selectFrom('person').select('id').where('id', '=', draft.runAs).executeTakeFirst();
  const repository = draft.repository === null ? null : await tx.selectFrom('repository').select('id').where('id', '=', draft.repository).executeTakeFirst();
  return [
    ...(person === undefined ? [{ path: ['runAs'], message: 'names a person AutoWorker does not know' }] : []),
    ...(repository === undefined ? [{ path: ['repository'], message: 'names a repository AutoWorker does not know' }] : []),
  ];
}

export async function saveRoutine(tx: Transacting, workflows: Workflows, saving: Saving): Promise<Saved> {
  const { draft, routine } = saving;
  const problems = [
    ...(await unknownChoices(tx, draft)),
    ...fitProblems(
      {
        workflow: draft.workflow,
        hasRepository: draft.repository !== null,
        source: draft.source,
        movesJira: draft.jiraStartStatus !== null || draft.jiraEndStatus !== null,
        gates: draft.gates,
        lastStep: draft.lastStep,
        steps: Object.keys(draft.steps),
      },
      workflows,
    ),
  ];
  if (problems.length > 0) return { refused: problems.map(sentence).join(' ') };
  const act: Act = { id: saving.action, person: saving.person, at: saving.at };
  const wanted = draftVersion(draft);
  if (routine === null) {
    if (draft.from !== null) return { refused: `A new routine starts at version 1, so it cannot follow version ${String(draft.from)}.` };
    const { id } = await tx.insertInto('routine').values({ creator_id: saving.person, run_as_id: draft.runAs }).returning('id').executeTakeFirstOrThrow();
    await saveVersion(tx, id, 1, act, wanted);
    return { version: 1 };
  }
  const found = await tx.selectFrom('routine').select('run_as_id').where('id', '=', routine).forNoKeyUpdate().executeTakeFirst();
  if (found === undefined) return { refused: `No routine has the id ${routine}.` };
  const { newest } = await tx.selectFrom('routine_version').select(eb => eb.fn.max<number>('version').as('newest')).where('routine_id', '=', routine).executeTakeFirstOrThrow();
  if (draft.from !== newest) return { refused: `Someone saved version ${String(newest)} after you opened version ${String(draft.from ?? 0)}. Reload the routine to see it, then make your change again.` };
  if (found.run_as_id === draft.runAs && isDeepStrictEqual(await readVersion(tx, routine, newest), wanted)) return { refused: `Nothing changed since version ${String(newest)}, so there is nothing to save.` };
  if (found.run_as_id !== draft.runAs) await tx.updateTable('routine').set({ run_as_id: draft.runAs }).where('id', '=', routine).execute();
  await saveVersion(tx, routine, newest + 1, act, wanted);
  return { version: newest + 1 };
}
