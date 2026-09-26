import { sql, type RawBuilder } from 'kysely';
import { connect, refusal, type Database } from '../../shared/db/client.ts';
import { fail, pass, type Check } from '../../tools/verify/check.ts';
import { auditCatalog, catalogProblems } from '../../tools/verify/catalog.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';

const guards = ['github_ignorable_checks_are_named', 'github_ignored_reviewers_are_named'] as const;

type Guard = (typeof guards)[number];

export const noMutantYet: Readonly<Record<string, readonly string[]>> = {
  "the GitHub simulator runs in memory against a fake GitHub and takes each task's rules from its own record, so it never writes a repository row, and setup's zod schema refuses a blank name before it reaches one; schemaChecks plants a blank name against each check": guards,
};

export async function catalogCheck(postgres: TestPostgres): Promise<Check> {
  const audit = await auditCatalog(postgres, { tables: [], owner: 'github' }, { mutated: [], reasoned: Object.values(noMutantYet).flat() });
  const problems = catalogProblems(audit);
  const name = 'every constraint, index, and trigger named github_ on any table has a mutant or a reason in noMutantYet';
  return problems.length === 0 ? pass(name, audit.guards.join(', ')) : fail(name, problems.join('; '));
}

const world: readonly RawBuilder<unknown>[] = [
  sql`insert into person (email, name) values ('ada@example.com', 'Ada')`,
  sql`with saved as (
        insert into human_action (id, at, person_id, kind, repository_id) values ('00000000-0000-4000-8000-000000000009', timestamptz '2026-01-01T00:00:00Z', 1, 'add_repository', 1) returning id)
      insert into repository (github, branch, saved_by) select 'example/sandbox', 'main', id from saved`,
];

const plants: Readonly<Record<Guard, RawBuilder<unknown>>> = {
  github_ignorable_checks_are_named: sql`update repository set ignorable_checks = '{lint, ""}' where id = 1`,
  github_ignored_reviewers_are_named: sql`update repository set ignored_reviewers = '{bot, ""}' where id = 1`,
};

async function outcome(db: Database, write: RawBuilder<unknown>): Promise<string> {
  try {
    await write.execute(db);
    return 'accepted';
  } catch (error) {
    const found = refusal(error);
    if (found === undefined || found.kind === 'not_null') throw error;
    return `refused by ${found.name}`;
  }
}

async function plantCheck(postgres: TestPostgres, guard: Guard): Promise<Check> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    for (const statement of world) await statement.execute(db);
    const guarded = await outcome(db, plants[guard]);
    await sql`alter table repository drop constraint ${sql.ref(guard)}`.execute(db);
    const unguarded = await outcome(db, plants[guard]);
    const name = `a repository row that lists a blank name is refused by ${guard}, and accepted once it is dropped`;
    return guarded === `refused by ${guard}` && unguarded === 'accepted' ? pass(name, `${guarded}, then ${unguarded}`) : fail(name, `with the check: ${guarded}; without it: ${unguarded}`);
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

export async function schemaChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  const checks: Check[] = [await catalogCheck(postgres)];
  for (const guard of guards) checks.push(await plantCheck(postgres, guard));
  return checks;
}
