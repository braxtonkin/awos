import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { connect, type Database } from '../../shared/db/client.ts';
import { repositoryRoot } from '../../tools/verify/cluster.ts';

const run = promisify(execFile);

const setupCommand = join(repositoryRoot, 'services/engine/setup.ts');

const engineCommand = join(repositoryRoot, 'services/engine/main.ts');

const actCommand = join(repositoryRoot, 'services/engine/act.ts');

export type Store = { readonly url: string; readonly db: Database; readonly key: string; readonly folder: string };

export async function openStore(url: string): Promise<Store> {
  return { url, db: connect(url, 4), key: randomBytes(32).toString('base64'), folder: await mkdtemp(join(tmpdir(), 'autoworker-')) };
}

export async function closeStore(store: Store): Promise<void> {
  await store.db.destroy();
  await rm(store.folder, { recursive: true, force: true });
}

const baseEnvironment = (store: Store): Readonly<Record<string, string>> => ({
  PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
  HOME: process.env['HOME'] ?? '/root',
  DATABASE_URL: store.url,
  CREDENTIAL_KEY: store.key,
  CREDENTIAL_KEY_VERSION: '1',
});

export type Ran = { readonly code: number; readonly out: string };

const childResult = async (work: Promise<{ readonly stdout: string; readonly stderr: string }>): Promise<Ran> => {
  try {
    const { stdout, stderr } = await work;
    return { code: 0, out: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const out = typeof error === 'object' && error !== null && 'stdout' in error && 'stderr' in error ? `${String(error.stdout)}${String(error.stderr)}` : String(error);
    return { code: 1, out: out.trim() };
  }
};

export async function applySetup(store: Store, file: object, secrets: Readonly<Record<string, string>>): Promise<Ran> {
  const path = join(store.folder, `setup-${randomBytes(4).toString('hex')}.json`);
  await writeFile(path, JSON.stringify(file, null, 2));
  return childResult(run(process.execPath, [setupCommand, path], { env: { ...baseEnvironment(store), ...secrets }, cwd: repositoryRoot, timeout: 120_000 }));
}

export async function actAs(store: Store, args: readonly string[]): Promise<Ran> {
  return childResult(run(process.execPath, [actCommand, ...args], { env: baseEnvironment(store), cwd: repositoryRoot, timeout: 60_000 }));
}

export type Engine = { readonly said: () => string; readonly stop: () => Promise<void> };

export function startEngine(store: Store, settings: Readonly<Record<string, string>>): Engine {
  let said = '';
  const child: ChildProcess = spawn(process.execPath, [engineCommand], { env: { ...baseEnvironment(store), ...settings }, cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (said += chunk));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (said += chunk));
  const exited = new Promise<void>(resolve => child.once('exit', () => { resolve(); }));
  return {
    said: () => said,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.race([exited, wait(30_000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
}

export async function until<T>(ms: number, test: () => Promise<T | undefined>): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await test();
    if (found !== undefined) return found;
    if (Date.now() > deadline) return undefined;
    await wait(500);
  }
}

export const fakeCodexLogin = (): string => {
  const part = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = `${part({ alg: 'none' })}.${part({ exp: Math.floor(Date.now() / 1000) + 30 * 86_400 })}.${part({ signature: 'none' })}`;
  return `${JSON.stringify({ tokens: { access_token: token, refresh_token: '', id_token: token, account_id: 'stand-in' } }, null, 2)}\n`;
};
