import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { sql, type Kysely } from 'kysely';
import type { Browser } from 'playwright-core';
import { withBrowser } from './browser.ts';
import { fail, info, type Line, type Scenario } from './check.ts';
import { adminClient } from './postgres.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dashboardFolder = 'services/dashboard';
const next = join(root, 'node_modules/next/dist/bin/next');
const engineReadyMs = 10 * 60_000;
const dashboardReadyMs = 60_000;
const childStopMs = 4 * 60_000;
const probeMs = 250;
const commandMs = 60_000;
const loginRole = 'dashboard_web';

export type Child = { readonly said: () => string; readonly send: (line: string) => void; readonly exited: Promise<number | null>; readonly stop: () => Promise<number | null> };

function startChild(command: readonly string[], env: Readonly<Record<string, string>>, echo: (line: string) => void): Child {
  const [executable = process.execPath, ...args] = command;
  const child: ChildProcess = spawn(executable, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let said = '';
  const heard = (chunk: string): void => {
    said += chunk;
    for (const line of chunk.split('\n').filter(each => each.trim() !== '')) echo(line);
  };
  child.stdout?.setEncoding('utf8').on('data', heard);
  child.stderr?.setEncoding('utf8').on('data', heard);
  const exited = once(child, 'exit').then(() => child.exitCode);
  return {
    said: () => said,
    exited,
    send: line => child.stdin?.write(`${line}\n`),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const code = await Promise.race([exited, wait(childStopMs).then(() => 'late' as const)]);
      if (code !== 'late') return code;
      child.kill('SIGKILL');
      return exited;
    },
  };
}

async function until(what: string, limitMs: number, found: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (await found()) return;
    await wait(probeMs);
  }
  throw new Error(`${what} did not happen within ${String(limitMs / 1000)} s, so the lane stopped waiting`);
}

function newestSource(folder: string): number {
  let newest = 0;
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    if (entry.name === '.next' || entry.name === 'node_modules') continue;
    const path = `${folder}/${entry.name}`;
    newest = Math.max(newest, entry.isDirectory() ? newestSource(path) : statSync(join(root, path)).mtimeMs);
  }
  return newest;
}

const builtAt = (): number => {
  try {
    return statSync(join(root, dashboardFolder, '.next/BUILD_ID')).mtimeMs;
  } catch {
    return 0;
  }
};

export type Built = { readonly seconds: number | undefined; readonly output: string };

export async function buildDashboard(force: boolean, echo: (line: string) => void): Promise<Built> {
  const newest = Math.max(...[dashboardFolder, 'features', 'shared'].map(newestSource), statSync(join(root, 'package-lock.json')).mtimeMs);
  if (!force && builtAt() > newest) return { seconds: undefined, output: 'the build is newer than every source file' };
  const started = performance.now();
  const build = startChild([process.execPath, next, 'build', dashboardFolder], { NEXT_TELEMETRY_DISABLED: '1' }, echo);
  const code = await build.exited;
  if (code !== 0) throw new Error(`next build exited with ${String(code)}: ${build.said().trim().split('\n').slice(-5).join(' | ')}`);
  return { seconds: (performance.now() - started) / 1000, output: build.said() };
}

const freePort = async (): Promise<number> => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  if (address === null || typeof address === 'string') throw new Error('the free port probe got no port');
  return address.port;
};

export type World = {
  readonly origin: string;
  readonly ownerUrl: string;
  readonly owner: Kysely<unknown>;
  readonly keys: ReadonlyMap<string, string>;
  readonly holdEngine: () => Promise<void>;
  readonly releaseEngine: () => Promise<void>;
  readonly engineSaid: () => string;
};

const seedLine = /^seed ([a-z-]+): (\S+) /;

async function loginUrl(owner: Kysely<unknown>, ownerUrl: string): Promise<string> {
  const password = randomBytes(18).toString('hex');
  const exists = await sql<{ found: boolean }>`select exists (select from pg_roles where rolname = ${loginRole}) as found`.execute(owner);
  if (exists.rows[0]?.found === true) await sql`alter role ${sql.id(loginRole)} login password ${sql.lit(password)}`.execute(owner);
  else await sql`create role ${sql.id(loginRole)} login password ${sql.lit(password)} in role dashboard`.execute(owner);
  const url = new URL(ownerUrl);
  url.username = loginRole;
  url.password = password;
  return url.toString();
}

export type Agent = 'stand-in' | 'real';

export async function withWorld<T>(seeds: readonly string[], echo: (line: string) => void, work: (world: World) => Promise<T>, agent: Agent = 'stand-in'): Promise<T> {
  const engine = startChild([process.execPath, join(root, 'tools/verify/main.ts'), 'local-engine', ...seeds.flatMap(seed => ['--seed', seed]), '--agent', agent], {}, line => {
    echo(`local-engine: ${line}`);
  });
  let dashboard: Child | undefined;
  let owner: Kysely<unknown> | undefined;
  const stopping = (): void => {
    void dashboard?.stop();
    void engine.stop();
  };
  process.on('SIGTERM', stopping).on('SIGINT', stopping);
  try {
    const ready = until('local engine ready', engineReadyMs, () => engine.said().includes('local engine ready')).then(() => 'ready' as const);
    if ((await Promise.race([ready, engine.exited.then(() => 'exited' as const)])) === 'exited') throw new Error(`local-engine exited before it was ready: ${engine.said().trim().split('\n').slice(-5).join(' | ')}`);
    const lines = engine.said().split('\n');
    const ownerUrl = lines.find(line => line.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length);
    if (ownerUrl === undefined) throw new Error('local-engine printed no DATABASE_URL');
    const keys = new Map(lines.flatMap(line => {
      const found = seedLine.exec(line);
      return found?.[1] === undefined || found[2] === undefined ? [] : [[found[1], found[2]] as const];
    }));
    owner = adminClient(ownerUrl);
    const port = await freePort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const database = await loginUrl(owner, ownerUrl);
    const started = startChild([process.execPath, next, 'start', dashboardFolder, '-p', String(port), '-H', '127.0.0.1'], { DATABASE_URL: database, NEXT_TELEMETRY_DISABLED: '1' }, line => {
      echo(`dashboard: ${line}`);
    });
    dashboard = started;
    await until('the dashboard answering', dashboardReadyMs, () => fetch(`${origin}/tasks/NOPE-1`).then(response => response.status === 404, () => false));
    echo(`dashboard ready at ${origin}`);
    const command = (sent: string, answer: string) => async (): Promise<void> => {
      const before = engine.said().length;
      engine.send(sent);
      await until(answer, commandMs, () => engine.said().slice(before).includes(answer));
    };
    return await work({ origin, ownerUrl, owner, keys, holdEngine: command('stop-engine', 'engine killed and held'), releaseEngine: command('start-engine', 'engine released'), engineSaid: () => engine.said() });
  } finally {
    process.off('SIGTERM', stopping).off('SIGINT', stopping);
    await dashboard?.stop();
    await owner?.destroy();
    await engine.stop();
  }
}

export type Lane = { readonly unit: string; readonly id: string; readonly seeds: readonly string[]; readonly agent?: Agent; readonly run: (world: World, browser: Browser, shots: string) => Promise<readonly Line[]> };

export const isLane = (value: unknown): value is Lane =>
  typeof value === 'object' && value !== null && 'unit' in value && typeof value.unit === 'string' && 'id' in value && typeof value.id === 'string' && 'seeds' in value && Array.isArray(value.seeds) && 'run' in value && typeof value.run === 'function';

const shotsFolder = (unit: string): string => join(root, '.shots', unit);

export const dashboardLane = (declared: readonly Lane[]): Scenario => ({
  name: 'dashboard-lane',
  summary: "builds the dashboard when its sources changed, starts local-engine with the lane's seeds and the dashboard as child processes, runs the named lanes of a unit in a browser, and saves their screenshots under .shots/<unit>/; dashboard-lane <unit> <lane>... or all",
  run: async args => {
    const [unit, ...wanted] = args;
    const ofUnit = declared.filter(lane => lane.unit === unit);
    const lanes = wanted.includes('all') ? ofUnit : ofUnit.filter(lane => wanted.includes(lane.id));
    if (unit === undefined || lanes.length === 0) throw new Error(`name a unit and its lanes; the declared lanes are ${declared.map(lane => `${lane.unit} ${lane.id}`).join(', ')}`);
    const echo = (line: string): void => {
      process.stdout.write(`${line}\n`);
    };
    const built = await buildDashboard(false, echo);
    const lines: Line[] = [info('next build', 'passed', built.seconds === undefined ? built.output : `${built.seconds.toFixed(1)} s`)];
    await withBrowser(async browser => {
      for (const lane of lanes) {
        const ran = await withWorld(lane.seeds, echo, world => lane.run(world, browser, shotsFolder(lane.unit)), lane.agent).catch((error: unknown) => [fail(`lane ${lane.id} runs to completion`, error instanceof Error ? error.message : String(error))]);
        lines.push(...ran.map(line => ({ ...line, name: `${lane.unit} lane ${lane.id}: ${line.name}` })));
      }
    });
    return lines;
  },
});
