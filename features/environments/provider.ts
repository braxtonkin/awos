import { sql } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import { testsOnly } from './tests-only.ts';

export const environment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), run: z.string().trim().min(1) }),
  z.object({ kind: z.literal('workspace-ci') }),
  z.object({ kind: z.literal('address'), url: z.url() }),
]);

export type Environment = z.infer<typeof environment>;

export type Repository = { readonly github: string; readonly branch: string; readonly fastTestCommand: string | null };

export type StartRequest = { readonly attemptId: string; readonly repository: Repository; readonly signal: AbortSignal };

export type Provider = {
  readonly name: string;
  readonly start: (request: StartRequest) => Promise<Environment>;
  readonly stop: (attemptId: string) => Promise<void>;
};

export type Providers = ReadonlyMap<string, Provider>;

const slug = /^[a-z][a-z0-9-]{0,63}$/;

export function providersByName(forks: readonly Provider[]): Providers {
  const list: readonly Provider[] = [testsOnly, ...forks];
  const names = list.map(provider => provider.name);
  const problems = [
    ...names.filter(name => !slug.test(name)).map(name => `The Verify provider ${name}: its name must match ${slug.source}.`),
    ...names
      .filter((name, index) => names.indexOf(name) !== index)
      .map(name => `Two Verify providers are named ${name}. Give each provider its own name${name === testsOnly.name ? `, because ${testsOnly.name} is always given` : ''}.`),
  ];
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return new Map(list.map(provider => [provider.name, provider]));
}

export async function publishProviders(db: Database, providers: Providers): Promise<void> {
  const given = [...providers.keys()];
  await db.transaction().execute(async tx => {
    await sql`lock table published_provider in share row exclusive mode`.execute(tx);
    const held = (await tx.selectFrom('published_provider').select('name').execute()).map(row => row.name);
    const stale = held.filter(name => !given.includes(name));
    const missing = given.filter(name => !held.includes(name));
    if (stale.length > 0) await tx.deleteFrom('published_provider').where('name', 'in', stale).execute();
    if (missing.length > 0) await tx.insertInto('published_provider').values(missing.map(name => ({ name }))).execute();
  });
}

export function describe(given: Environment): string {
  switch (given.kind) {
    case 'workspace':
      return `workspace, run: ${given.run}`;
    case 'workspace-ci':
      return "workspace, run the checks in the repository's CI config";
    case 'address':
      return `address: ${given.url}`;
  }
}
