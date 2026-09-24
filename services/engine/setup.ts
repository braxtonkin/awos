import { sealingKey } from '../../features/credentials/seal.ts';
import { applyLogins, logins } from '../../features/credentials/setup.ts';
import { applyPeople, applyRepositories, applyRoutines, readSetupFile } from '../../features/tasks/setup.ts';
import { connect, databaseUrl } from '../../shared/db/client.ts';
import { workflows } from './workflows.ts';

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function setup(path: string): Promise<void> {
  const key = sealingKey(process.env);
  const url = databaseUrl(process.env);
  const file = await readSetupFile(path, folder => logins(process.env, folder), workflows);
  const db = connect(url, 1);
  try {
    const { people, teamAccounts } = await applyPeople(db, file);
    say(`people ${String(people.added)} added, ${String(people.changed)} changed`);
    say(`team accounts ${String(teamAccounts.added)} added, ${String(teamAccounts.changed)} changed`);
    const { sealed } = await applyLogins(db, key, file.admin, [...file.people, ...file.teamAccounts]);
    say(`logins ${String(sealed)} sealed`);
    const repositories = await applyRepositories(db, file);
    say(`repositories ${String(repositories.added)} added`);
    const routines = await applyRoutines(db, file);
    say(`routines ${String(routines.added)} added, ${String(routines.changed)} changed`);
  } finally {
    await db.destroy();
  }
}

const [path, ...rest] = process.argv.slice(2);
if (path === undefined || rest.length > 0) {
  process.stderr.write('Usage: node services/engine/setup.ts <setup file>, with DATABASE_URL, CREDENTIAL_KEY, and CREDENTIAL_KEY_VERSION set.\n');
  process.exitCode = 2;
} else {
  await setup(path).catch((error: unknown) => {
    process.stderr.write(`Setup stopped. ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
