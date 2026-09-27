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
import { ownerLabel } from './owner-label.ts';

export type Pause = () => Promise<() => Promise<void>>;

export type Postgres = {
  readonly url: (database: string) => string;
  readonly stableUrl: (database: string) => string;
  readonly pause: Pause;
  readonly restart: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

export type Scratch = { readonly url: string; readonly stableUrl: string; readonly drop: () => Promise<void> };

export type TestPostgres = { readonly readyInMs: number; readonly scratch: () => Promise<Scratch>; readonly pause: Pause; readonly restart: () => Promise<void> };

const template = 'migrated';
const image = 'postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';
const settings = ['fsync=off', 'synchronous_commit=off', 'full_page_writes=off', 'max_connections=250'];
export const migrationsFolder = fileURLToPath(new URL('../../db/migrations', import.meta.url));
const outsideVerifyContainer = 'Postgres for verification starts beside the verify container. Run the command inside it: docker compose run --rm verify <command>';

const cores = z.object({ HostConfig: z.object({ CpusetCpus: z.string().regex(/^(?:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)?$/u) }) });
const inspected = cores.extend({ Id: z.string(), NetworkSettings: z.object({ Networks: z.record(z.string(), z.unknown()) }) });
const labeled = z.array(z.object({ Id: z.string(), Labels: z.record(z.string(), z.string()) }));

async function verifyContainer(): Promise<{ readonly id: string; readonly network: string; readonly cpus: string }> {
  const reply = await docker('GET', `/containers/${hostname()}/json`).catch(() => undefined);
  const parsed = inspected.safeParse(reply?.body);
  const network = parsed.success ? Object.keys(parsed.data.NetworkSettings.Networks)[0] : undefined;
  if (reply?.status !== 200 || !parsed.success || network === undefined) throw new Error(outsideVerifyContainer);
  return { id: parsed.data.Id, network, cpus: parsed.data.HostConfig.CpusetCpus };
}

class PostgresOnCpus extends PostgreSqlContainer {
  withCpus(cpus: string): this {
    this.hostConfig.CpusetCpus = cpus;
    return this;
  }
}

async function requireCpus(id: string, cpus: string): Promise<void> {
  const actual = cores.parse((await docker('GET', `/containers/${id}/json`)).body).HostConfig.CpusetCpus;
  if (actual !== cpus) {
    throw new Error(`The Postgres container runs on cores "${actual}", but the verify container that started it runs on cores "${cpus}". Postgres for verification must run on the verify container's cores.`);
  }
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

function pausing(id: string): Pause {
  let holders = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };
  const call = async (action: 'pause' | 'unpause'): Promise<void> => {
    const reply = await docker('POST', `/containers/${id}/${action}`);
    if (reply.status !== 204) throw new Error(`docker ${action} of the Postgres container answered ${String(reply.status)}`);
  };
  return () =>
    serial(async () => {
      if (holders === 0) await call('pause');
      holders += 1;
      let held = true;
      return () =>
        serial(async () => {
          if (!held) return;
          if (holders === 1) await call('unpause');
          holders -= 1;
          held = false;
        });
    });
}

const keptDatabase = 'autoworker';
const keptStopMs = 10_000;
const passwordLabel = 'autoworker.verify.password';
const labeledVolume = z.object({ Labels: z.record(z.string(), z.string()).nullable() });

type Volume = { readonly name: string; readonly password: string };

const keptContainer = (volume: string): string => `${volume}-postgres`;

export async function startPostgres(kept?: Volume): Promise<Postgres> {
  const self = await verifyContainer();
  await removeOrphans();
  const alias = `postgres-${randomUUID()}`;
  const placed = new PostgresOnCpus(image).withCpus(self.cpus).withNetworkMode(self.network).withNetworkAliases(alias).withLabels({ [ownerLabel]: self.id });
  const container = await (
    kept === undefined
      ? placed.withPassword(randomUUID()).withCommand(['postgres', ...settings.flatMap(setting => ['-c', setting])])
      : placed.withName(keptContainer(kept.name)).withPassword(kept.password).withDatabase(keptDatabase).withBindMounts([{ source: kept.name, target: '/var/lib/postgresql' }])
  ).start();
  try {
    await requireCpus(container.getId(), self.cpus);
  } catch (error) {
    await container.stop();
    throw error;
  }
  const at = (host: string, database: string): string => `postgres://${container.getUsername()}:${container.getPassword()}@${host}:5432/${database}?sslmode=disable`;
  const address = container.getIpAddress(self.network);
  return {
    url: database => at(address, database),
    stableUrl: database => at(alias, database),
    pause: pausing(container.getId()),
    restart: () => container.restart(),
    stop: async () => {
      await container.stop(kept === undefined ? {} : { timeout: keptStopMs });
    },
  };
}

export type Kept = { readonly url: string; readonly made: boolean; readonly applied: number; readonly stop: () => Promise<void> };

async function keptVolume(name: string, fresh: boolean): Promise<Volume & { readonly made: boolean }> {
  const holder = await docker('GET', `/containers/${keptContainer(name)}/json`);
  if (holder.status !== 404) throw new Error(`${keptContainer(name)} still serves the database in the volume ${name}, so another run holds it`);
  const removed = fresh ? await docker('DELETE', `/volumes/${name}`) : undefined;
  if (removed !== undefined && removed.status !== 204 && removed.status !== 404) throw new Error(`removing the volume ${name} answered ${String(removed.status)}`);
  const found = await docker('GET', `/volumes/${name}`);
  const volume = found.status === 404 ? await docker('POST', '/volumes/create', { Name: name, Labels: { [passwordLabel]: randomUUID() } }) : found;
  const password = labeledVolume.safeParse(volume.body).data?.Labels?.[passwordLabel];
  if (password === undefined) throw new Error(`the volume ${name} has no ${passwordLabel} label, so its Postgres password is unknown`);
  return { name, password, made: found.status === 404 };
}

export async function keptPostgres(name: string, fresh: boolean): Promise<Kept> {
  await removeOrphans();
  const volume = await keptVolume(name, fresh);
  const postgres = await startPostgres(volume);
  const url = postgres.url(keptDatabase);
  try {
    const applied = dbmate(url, 'up').split('\n').filter(line => line.startsWith('Applying: ')).length;
    return { url, made: volume.made, applied, stop: postgres.stop };
  } catch (error) {
    await postgres.stop();
    throw error;
  }
}

export function dbmate(url: string, command: 'up' | 'rollback', folder = migrationsFolder): string {
  const result = spawnSync(resolveBinary(), ['--url', url, '--migrations-dir', folder, '--no-dump-schema', command], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`dbmate ${command} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result.stdout;
}

export function migrate(url: string): void {
  dbmate(url, 'up');
}

export function adminClient(url: string): Kysely<unknown> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  pool.on('error', error => {
    process.stderr.write(`The admin connection to the test Postgres failed, and the pool dropped it: ${error.message}\n`);
  });
  return new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });
}

export async function withPostgres<T>(work: (postgres: TestPostgres) => Promise<T>): Promise<T> {
  const started = performance.now();
  const postgres = await startPostgres();
  try {
    migrate(postgres.stableUrl(template));
    const readyInMs = performance.now() - started;
    const admin = adminClient(postgres.stableUrl('postgres'));
    try {
      let made = 0;
      return await work({
        readyInMs,
        pause: postgres.pause,
        restart: postgres.restart,
        scratch: async () => {
          made += 1;
          const name = `scratch_${String(made)}`;
          await sql`create database ${sql.id(name)} template ${sql.id(template)}`.execute(admin);
          return {
            url: postgres.url(name),
            stableUrl: postgres.stableUrl(name),
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
