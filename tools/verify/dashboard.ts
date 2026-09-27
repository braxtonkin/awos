import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
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
const dashboardStopMs = 10_000;
const probeMs = 250;
const commandMs = 60_000;
const loginRole = 'dashboard_web';

export type Child = { readonly said: () => string; readonly send: (line: string) => void; readonly exited: Promise<number | null>; readonly stop: () => Promise<number | null> };

function startChild(command: readonly string[], env: Readonly<Record<string, string>>, echo: (line: string) => void, stopMs = childStopMs): Child {
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
      const code = await Promise.race([exited, wait(stopMs, undefined, { ref: false }).then(() => 'late' as const)]);
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

const seedLine = /^seed ([a-z-]+(?:@[a-z0-9-]+)?): (\S+) /;

export type Started = { readonly seeds: readonly string[]; readonly readySeconds: number };

const started: Started[] = [];

export const worldsStarted = (): readonly Started[] => [...started];

export async function loginUrl(owner: Kysely<unknown>, ownerUrl: string): Promise<string> {
  const password = randomBytes(18).toString('hex');
  const exists = await sql<{ found: boolean }>`select exists (select from pg_roles where rolname = ${loginRole}) as found`.execute(owner);
  if (exists.rows[0]?.found === true) await sql`alter role ${sql.id(loginRole)} login password ${sql.lit(password)}`.execute(owner);
  else await sql`create role ${sql.id(loginRole)} login password ${sql.lit(password)} in role dashboard`.execute(owner);
  const url = new URL(ownerUrl);
  url.username = loginRole;
  url.password = password;
  return url.toString();
}

export type Dashboard = Child & { readonly origin: string };

export function startDashboard(database: string, key: Readonly<Record<string, string>>, host: string, port: number, echo: (line: string) => void): Dashboard {
  const child = startChild([process.execPath, next, 'start', dashboardFolder, '-p', String(port), '-H', host], { DATABASE_URL: database, NEXT_TELEMETRY_DISABLED: '1', ...key }, line => {
    echo(`dashboard: ${line}`);
  }, dashboardStopMs);
  return { ...child, origin: `http://${host}:${String(port)}` };
}

export const dashboardAnswers = (dashboard: Dashboard): Promise<void> =>
  until('the dashboard answering', dashboardReadyMs, () => fetch(`${dashboard.origin}/tasks/NOPE-1`).then(response => response.status === 404, () => false));

export const agents = ['stand-in', 'real'] as const;

export type Agent = (typeof agents)[number];

export async function withWorld<T>(seeds: readonly string[], echo: (line: string) => void, work: (world: World) => Promise<T>, agent: Agent = 'stand-in'): Promise<T> {
  const began = performance.now();
  const key = { CREDENTIAL_KEY: randomBytes(32).toString('base64'), CREDENTIAL_KEY_VERSION: '1' };
  const engine = startChild([process.execPath, join(root, 'tools/verify/main.ts'), 'local-engine', ...seeds.flatMap(seed => ['--seed', seed]), '--agent', agent], key, line => {
    echo(`local-engine: ${line}`);
  });
  let dashboard: Dashboard | undefined;
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
    const database = await loginUrl(owner, ownerUrl);
    dashboard = startDashboard(database, key, '127.0.0.1', port, echo);
    await dashboardAnswers(dashboard);
    const { origin } = dashboard;
    started.push({ seeds, readySeconds: (performance.now() - began) / 1000 });
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

export type Lane = {
  readonly unit: string;
  readonly id: string;
  readonly seeds: readonly string[];
  readonly run: (world: World, browser: Browser, shots: string) => Promise<readonly Line[]>;
  readonly alone?: true;
  readonly agent?: 'real';
};

export const isLane = (value: unknown): value is Lane =>
  typeof value === 'object' &&
  value !== null &&
  'unit' in value &&
  typeof value.unit === 'string' &&
  'id' in value &&
  typeof value.id === 'string' &&
  'seeds' in value &&
  Array.isArray(value.seeds) &&
  'run' in value &&
  typeof value.run === 'function' &&
  (!('alone' in value) || value.alone === true) &&
  (!('agent' in value) || value.agent === 'real');

const wholeWorldSeeds: ReadonlySet<string> = new Set(['all', 'no-tasks', 'no-routines', 'login-expired']);

export type Group = { readonly lanes: readonly Lane[]; readonly agent: Agent };

const tagOf = (lane: Lane): string => `${lane.unit}-${lane.id}`.toLowerCase().replaceAll(/[^a-z0-9-]/g, '-');

const seedArgument = (lane: Lane, seed: string): string => (wholeWorldSeeds.has(seed) ? seed : `${seed}@${tagOf(lane)}`);

export function groupsOf(lanes: readonly Lane[], forced: Agent | undefined): readonly Group[] {
  const alone = (lane: Lane): boolean => lane.alone === true || lane.agent === 'real' || forced === 'real';
  const worldKey = (lane: Lane): string => (lane.seeds.some(seed => wholeWorldSeeds.has(seed)) ? lane.seeds.toSorted().join(' ') : '');
  const shared = [...Map.groupBy(lanes.filter(lane => !alone(lane)), worldKey).values()].map(members => ({ lanes: members, agent: 'stand-in' as const }));
  return [...shared, ...lanes.filter(alone).map(lane => ({ lanes: [lane], agent: forced ?? lane.agent ?? 'stand-in' }))];
}

function laneWorld(world: World, lane: Lane): World {
  const tag = tagOf(lane);
  const entries = [...world.keys].map(([label, key]) => ({ name: label.split('@')[0] ?? label, instance: label.split('@')[1], key }));
  const keys = new Map([...entries.filter(entry => entry.instance === undefined), ...entries.filter(entry => entry.instance === tag)].map(entry => [entry.name, entry.key] as const));
  const refuse = (): Promise<void> => Promise.reject(new Error(`lane ${lane.unit} ${lane.id} stops the engine, which every lane in its world would feel, so declare it alone: true`));
  return { ...world, keys, holdEngine: lane.alone === true ? world.holdEngine : refuse };
}

export type Ran = { readonly lane: Lane; readonly lines: readonly Line[]; readonly seconds: number };

export async function runGroups(groups: readonly Group[], browser: Browser, shots: string, echo: (line: string) => void): Promise<readonly Ran[]> {
  const ran: Ran[] = [];
  for (const group of groups) {
    const seeds = [...new Set(group.lanes.flatMap(lane => lane.seeds.map(seed => seedArgument(lane, seed))))];
    echo(`world of ${group.lanes.map(lane => `${lane.unit} ${lane.id}`).join(', ')} with ${seeds.join(' ')}`);
    const done = new Set<Lane>();
    const failed = (error: unknown): void => {
      const detail = error instanceof Error ? error.message : String(error);
      for (const lane of group.lanes.filter(each => !done.has(each))) ran.push({ lane, lines: [fail(`lane ${lane.id} runs to completion`, detail)], seconds: 0 });
    };
    await withWorld(seeds, echo, async world => {
      for (const lane of group.lanes) {
        const started = performance.now();
        const lines = await lane.run(laneWorld(world, lane), browser, join(shots, lane.unit)).catch((error: unknown) => [fail(`lane ${lane.id} runs to completion`, error instanceof Error ? error.message : String(error))]);
        done.add(lane);
        ran.push({ lane, lines, seconds: (performance.now() - started) / 1000 });
      }
    }, group.agent).catch(failed);
  }
  return ran;
}

const shotsRoot = join(root, '.shots');

export const dashboardLane = (declared: readonly Lane[]): Scenario => ({
  name: 'dashboard-lane',
  summary:
    "builds the dashboard when its sources changed, runs the named lanes of a unit in a browser against local-engine and the dashboard, as few worlds as dashboard-batch would start for them, and saves their screenshots under .shots/<unit>/; dashboard-lane <unit> <lane>... or all, and --agent real runs real Codex from the live service's login",
  run: async args => {
    const { values, positionals } = parseArgs({ args: [...args], options: { agent: { type: 'string' } }, strict: true, allowPositionals: true });
    const agent = values.agent === undefined ? undefined : agents.find(name => name === values.agent);
    if (values.agent !== undefined && agent === undefined) throw new Error(`--agent takes ${agents.join(' or ')}`);
    const [unit, ...wanted] = positionals;
    const ofUnit = declared.filter(lane => lane.unit === unit);
    const lanes = wanted.includes('all') ? ofUnit : ofUnit.filter(lane => wanted.includes(lane.id));
    if (unit === undefined || lanes.length === 0) throw new Error(`name a unit and its lanes; the declared lanes are ${declared.map(lane => `${lane.unit} ${lane.id}`).join(', ')}`);
    const echo = (line: string): void => {
      process.stdout.write(`${line}\n`);
    };
    const built = await buildDashboard(false, echo);
    const ran = await withBrowser(browser => runGroups(groupsOf(lanes, agent), browser, shotsRoot, echo));
    return [info('next build', 'passed', built.seconds === undefined ? built.output : `${built.seconds.toFixed(1)} s`), ...ran.flatMap(each => each.lines.map(line => ({ ...line, name: `${each.lane.unit} lane ${each.lane.id}: ${line.name}` })))];
  },
});
