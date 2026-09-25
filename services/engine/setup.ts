import { parseArgs } from 'node:util';
import { z } from 'zod';
import { sealingKey } from '../../features/credentials/seal.ts';
import { applyLogins, logins } from '../../features/credentials/setup.ts';
import { applyPeople, applyRepositories, applyRoutines, readSetupFile } from '../../features/tasks/setup.ts';
import { connect } from '../../shared/db/client.ts';
import { providers } from './providers.ts';
import { workflows } from './workflows.ts';

const settings = z.object({ DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }) });

const usage =
  'Usage: node services/engine/setup.ts [--replace-logins] <setup file>, with DATABASE_URL, CREDENTIAL_KEY, and CREDENTIAL_KEY_VERSION set. Without --replace-logins, setup keeps a stored login that expires later than the one the file names, such as a Codex login the engine refreshed.\n';

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function setup(path: string, replacing: boolean): Promise<void> {
  const key = sealingKey(process.env);
  const given = settings.safeParse(process.env);
  if (!given.success) throw new Error(`DATABASE_URL must be a postgres:// URL. ${z.prettifyError(given.error)}`);
  const file = await readSetupFile(path, folder => logins(process.env, folder), { workflows, providers: [...providers.keys()] });
  const db = connect(given.data.DATABASE_URL, 1);
  try {
    const { people, teamAccounts } = await applyPeople(db, file);
    say(`people ${String(people.added)} added, ${String(people.changed)} changed`);
    say(`team accounts ${String(teamAccounts.added)} added, ${String(teamAccounts.changed)} changed`);
    const { sealed, kept } = await applyLogins(db, key, file.admin, [...file.people, ...file.teamAccounts], replacing);
    say(`logins ${String(sealed)} sealed`);
    if (kept > 0) say(`logins ${String(kept)} kept, because the stored login expires later than the one the file names. Run setup with --replace-logins to store the file's login anyway.`);
    const repositories = await applyRepositories(db, file);
    say(`repositories ${String(repositories.added)} added, ${String(repositories.changed)} changed`);
    const routines = await applyRoutines(db, file);
    say(`routines ${String(routines.added)} added, ${String(routines.changed)} changed`);
  } finally {
    await db.destroy();
  }
}

const parsed = (() => {
  try {
    return parseArgs({ args: process.argv.slice(2), options: { 'replace-logins': { type: 'boolean', default: false } }, allowPositionals: true, strict: true });
  } catch {
    return undefined;
  }
})();
const [path, ...rest] = parsed?.positionals ?? [];
if (parsed === undefined || path === undefined || rest.length > 0) {
  process.stderr.write(usage);
  process.exitCode = 2;
} else {
  await setup(path, parsed.values['replace-logins']).catch((error: unknown) => {
    process.stderr.write(`Setup stopped. ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
