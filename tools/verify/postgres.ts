import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { resolveBinary } from 'dbmate';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { z } from 'zod';
import { docker } from './docker.ts';

export type Postgres = {
  readonly url: (database: string) => string;
  readonly stop: () => Promise<void>;
};

export type Scratch = { readonly url: string; readonly drop: () => Promise<void> };

export type TestPostgres = { readonly readyInMs: number; readonly scratch: () => Promise<Scratch> };

const template = 'migrated';
const image = 'postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
const ownerLabel = 'autoworker.verify.owner';
const settings = ['fsync=off', 'synchronous_commit=off', 'full_page_writes=off', 'max_connections=250'];
export const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const outsideVerifyContainer = 'Postgres for verification starts beside the verify container. Run the command inside it: docker compose run --rm verify <command>';

const inspected = z.object({ Id: z.string(), NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()) }) });
const labeled = z.array(z.object({ Id: z.string(), Labels: z.record(z.string(), z.string()) }));

async function verifyContainer(): Promise<{ readonly id: string; readonly network: string }> {
  const reply = await docker('GET', `/containers/${hostname()}/json`).catch(() => undefined);
  const parsed = inspected.safeParse(reply?.body);
  const network = parsed.success ? Object.keys(parsed.data.NetworkSettings.Networks)[0] : undefined;
  if (reply?.status !== 200 || !parsed.success || network === undefined) throw new Error(outsideVerifyContainer);
  return { id: parsed.data.Id, network };
}

async function removeOrphans(): Promise<void> {
  const filters = encodeURIComponent(JSON.stringify({ label: [ownerLabel] }));
  for (const container of labeled.parse((await docker('GET', `/containers/json?all=true&filters=${filters}`)).body)) {
    const owner = container.Labels[ownerLabel];
    if (owner !== undefined && (await docker('GET', `/containers/${owner}/json`)).status === 404) {
      await docker('DELETE', `/containers/${container.Id}?force=true&v=true`);
    }
  }
}

export async function startPostgres(): Promise<Postgres> {
  const self = await verifyContainer();
  await removeOrphans();
  const container = await new PostgreSqlContainer(image)
    .withPassword(randomUUID())
    .withNetworkMode(self.network)
    .withLabels({ [ownerLabel]: self.id })
    .withCommand(['postgres', ...settings.flatMap(setting => ['-c', setting])])
    .start();
  const stop = async (): Promise<void> => {
    await container.stop();
  };
  try {
    const address = container.getIpAddress(self.network);
    return { url: database => `postgres://${container.getUsername()}:${container.getPassword()}@${address}:5432/${database}?sslmode=disable`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function dbmate(url: string, command: 'up' | 'rollback', folder = migrationsFolder): void {
  const result = spawnSync(resolveBinary(), ['--url', url, '--migrations-dir', folder, '--no-dump-schema', command], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`dbmate ${command} failed: ${result.error?.message ?? result.stderr.trim()}`);
}

export function migrate(url: string): void {
  dbmate(url, 'up');
}

export const adminClient = (url: string): Kysely<unknown> => new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 1 }) }) });

export async function withPostgres<T>(work: (postgres: TestPostgres) => Promise<T>): Promise<T> {
  const started = performance.now();
  const postgres = await startPostgres();
  try {
    migrate(postgres.url(template));
    const readyInMs = performance.now() - started;
    const admin = adminClient(postgres.url('postgres'));
    try {
      let made = 0;
      return await work({
        readyInMs,
        scratch: async () => {
          made += 1;
          const name = `scratch_${String(made)}`;
          await sql`create database ${sql.id(name)} template ${sql.id(template)}`.execute(admin);
          return {
            url: postgres.url(name),
            drop: async () => {
              await sql`drop database ${sql.id(name)}`.execute(admin);
            },
          };
        },
      });
    } finally {
      await admin.destroy();
    }
  } finally {
    await postgres.stop();
  }
}
