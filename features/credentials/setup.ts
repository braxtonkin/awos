import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import { read, type Secret } from './kinds.ts';
import type { SealingKey } from './seal.ts';
import { open, replace } from './store.ts';

export type Owner = { readonly email: string; readonly logins: readonly Secret[] };

type Source = { readonly env: string } | { readonly file: string };

const neverInline = 'must name an environment variable, as {"env": "NAME"}, or a file, as {"file": "path"}. Never write a login into the setup file';

const sourceError =
  (fields: string) =>
  (issue: { readonly input?: unknown }): string =>
    typeof issue.input === 'object' && issue.input !== null ? `must hold ${fields}, and no other field` : neverInline;

const variable = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { error: 'must be an environment variable name' });

const file = z.string().min(1, { error: 'must name a file' });

const madeForAutoWorker = z.boolean().default(false);

const githubSource = z.union([z.strictObject({ env: variable }), z.strictObject({ file })], { error: sourceError('either env or file') });

const codexSource = z.union([z.strictObject({ env: variable, madeForAutoWorker }), z.strictObject({ file, madeForAutoWorker })], {
  error: sourceError('either env or file, and madeForAutoWorker when the login was made for AutoWorker'),
});

async function reveal(source: Source, env: NodeJS.ProcessEnv, folder: string): Promise<{ readonly text: string } | { readonly problem: string }> {
  if ('env' in source) {
    const value = env[source.env];
    return value === undefined || value.trim() === '' ? { problem: `names the environment variable ${source.env}, which is not set` } : { text: value };
  }
  const path = resolve(folder, source.file);
  return readFile(path, 'utf8').then(
    text => ({ text }),
    () => ({ problem: `names the file ${path}, which setup could not read` }),
  );
}

export function logins(env: NodeJS.ProcessEnv, folder: string) {
  return z.strictObject({ github: githubSource, codex: codexSource }).transform(async (named, context): Promise<readonly Secret[]> => {
    const github = await reveal(named.github, env, folder);
    const codex = await reveal(named.codex, env, folder);
    const secrets: readonly (readonly [string, Secret | string])[] = [
      ['github', 'text' in github ? { connector: 'github', token: github.text.trim() } : github.problem],
      ['codex', 'text' in codex ? { connector: 'codex', login: codex.text, madeForAutoWorker: named.codex.madeForAutoWorker } : codex.problem],
    ];
    const problems = secrets.flatMap(([field, secret]) => {
      if (typeof secret === 'string') return [{ field, message: secret }];
      const found = read(secret);
      return 'refused' in found ? [{ field, message: found.reason }] : [];
    });
    for (const { field, message } of problems) context.issues.push({ code: 'custom', path: [field], message, input: undefined });
    return problems.length > 0 ? z.NEVER : secrets.flatMap(([, secret]) => (typeof secret === 'string' ? [] : [secret]));
  });
}

const textOf = (secret: Secret): string => {
  switch (secret.connector) {
    case 'codex':
      return secret.login;
    case 'github':
      return secret.token;
  }
};

export function applyLogins(db: Database, key: SealingKey, admin: string, owners: readonly Owner[]): Promise<{ readonly sealed: number }> {
  return db.transaction().execute(async trx => {
    const person = async (address: string): Promise<string> => (await trx.selectFrom('person').select('id').where('email', '=', address).executeTakeFirstOrThrow()).id;
    const by = await person(admin);
    let sealed = 0;
    for (const { email, logins: secrets } of owners) {
      const owner = await person(email);
      for (const secret of secrets) {
        const opened = await open(trx, key, { connector: secret.connector, owner });
        if ('secret' in opened && opened.secret === textOf(secret)) continue;
        const replaced = await replace(trx, key, { action: randomUUID(), by, at: new Date(), owner, secret });
        if ('refused' in replaced) throw new Error(`The ${secret.connector} login of ${email} was refused, so no login was sealed. ${replaced.reason}`);
        sealed += 1;
      }
    }
    return { sealed };
  });
}
