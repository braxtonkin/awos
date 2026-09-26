import type { Database } from '../../shared/db/client.ts';
import type { DraftLeaves } from '../../shared/repository-settings.ts';

export type Listed = { readonly id: string; readonly github: string; readonly branch: string; readonly routines: readonly string[] };

export type Settings = {
  readonly id: string;
  readonly github: string;
  readonly branch: string;
  readonly image: string | null;
  readonly fastTestCommand: string | null;
  readonly setupCommand: string | null;
  readonly verifyProvider: string;
  readonly ignorableChecks: readonly string[];
  readonly draftLeaves: DraftLeaves;
  readonly ignoredReviewers: readonly string[];
  readonly savedBy: string;
  readonly savedAt: string;
  readonly saving: string;
};

export type Editing = { readonly settings: Settings | undefined; readonly providers: readonly string[] };

const newestVersions = (db: Database) =>
  db
    .selectFrom('routine_version as version')
    .select(['version.routine_id', 'version.name', 'version.repository_id'])
    .where(eb => eb('version.version', '=', eb.selectFrom('routine_version as newest').select(newest => newest.fn.max('newest.version').as('newest')).whereRef('newest.routine_id', '=', 'version.routine_id')));

export async function readRepositories(db: Database): Promise<readonly Listed[]> {
  const [repositories, versions] = await Promise.all([db.selectFrom('repository').select(['id', 'github', 'branch']).orderBy('github').orderBy('branch').execute(), newestVersions(db).orderBy('version.name').execute()]);
  return repositories.map(repository => ({ ...repository, routines: versions.filter(version => version.repository_id === repository.id).map(version => version.name) }));
}

export async function readProviders(db: Database): Promise<readonly string[]> {
  return (await db.selectFrom('published_provider').select('name').orderBy('name').execute()).map(row => row.name);
}

export async function readRepository(db: Database, id: string): Promise<Editing> {
  const [row, providers] = await Promise.all([
    /^[1-9]\d*$/.test(id)
      ? db
          .selectFrom('repository')
          .innerJoin('human_action as saved', 'saved.id', 'repository.saved_by')
          .innerJoin('person', 'person.id', 'saved.person_id')
          .select([
            'repository.id',
            'repository.github',
            'repository.branch',
            'repository.job_image',
            'repository.fast_test_command',
            'repository.setup_command',
            'repository.verify_provider',
            'repository.ignorable_checks',
            'repository.draft_leaves',
            'repository.ignored_reviewers',
            'repository.saved_by',
            'person.name',
            'saved.at',
          ])
          .where('repository.id', '=', id)
          .executeTakeFirst()
      : undefined,
    readProviders(db),
  ]);
  const settings: Settings | undefined =
    row === undefined
      ? undefined
      : {
          id: row.id,
          github: row.github,
          branch: row.branch,
          image: row.job_image,
          fastTestCommand: row.fast_test_command,
          setupCommand: row.setup_command,
          verifyProvider: row.verify_provider,
          ignorableChecks: row.ignorable_checks,
          draftLeaves: row.draft_leaves,
          ignoredReviewers: row.ignored_reviewers,
          savedBy: row.name,
          savedAt: new Date(row.at).toISOString(),
          saving: row.saved_by,
        };
  return { settings, providers };
}

export async function savedRepository(db: Database, action: string): Promise<string | undefined> {
  return (await db.selectFrom('repository').select('id').where('saved_by', '=', action).executeTakeFirst())?.id;
}
