import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { sql } from 'kysely';
import { accessOnly } from '../../shared/codex-login.ts';
import { connect, type Database } from '../../shared/db/client.ts';
import { buildAttemptImage, ensureRegistry, jobNamespace, kindAddress, kubernetes, registry, repositoryRoot } from '../../tools/verify/cluster.ts';
import { kind } from '../../tools/verify/kind.ts';

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

export function startEngine(store: Store, settings: Readonly<Record<string, string>>, echo: (line: string) => void = () => undefined): Engine {
  let said = '';
  const heard = (chunk: string): void => {
    said += chunk;
    for (const line of chunk.split('\n').filter(line => line.trim() !== '')) echo(`  engine: ${line}`);
  };
  const child: ChildProcess = spawn(process.execPath, [engineCommand], { env: { ...baseEnvironment(store), ...settings }, cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.setEncoding('utf8').on('data', heard);
  child.stderr?.setEncoding('utf8').on('data', heard);
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

export type RunRecord = {
  readonly attempt: string;
  readonly step: string;
  readonly verdict: string | null;
  readonly runAs: string;
  readonly branch: string | null;
  readonly pushed: string | null;
  readonly owed: readonly string[];
  readonly inputTokens: number | null;
};

export async function runRecord(db: Database, key: string): Promise<readonly RunRecord[]> {
  const rows = await db
    .selectFrom('attempt')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .innerJoin('person', 'person.id', 'attempt.run_as_id')
    .select(eb => [
      'attempt.id',
      'attempt.step',
      'attempt.verdict',
      'person.email',
      'attempt.branch',
      'attempt.last_pushed',
      eb
        .selectFrom('outbox')
        .select(sql<string[]>`coalesce(array_agg(outbox.kind order by outbox.position), '{}')`.as('kinds'))
        .whereRef('outbox.task_id', '=', 'task.id')
        .whereRef('outbox.owed_at', '=', 'attempt.finished_at')
        .as('owed'),
      eb
        .selectFrom('attempt_event')
        .select(sql<string | null>`max((body -> 'params' -> 'tokenUsage' -> 'total' ->> 'inputTokens')::bigint)::text`.as('tokens'))
        .whereRef('attempt_event.attempt_id', '=', 'attempt.id')
        .where('attempt_event.method', '=', 'thread/tokenUsage/updated')
        .as('input_tokens'),
    ])
    .where('task.key', '=', key)
    .orderBy('attempt.id')
    .execute();
  return rows.map(row => ({
    attempt: row.id,
    step: row.step,
    verdict: row.verdict,
    runAs: row.email,
    branch: row.branch,
    pushed: row.last_pushed,
    owed: row.owed ?? [],
    inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
  }));
}

export const describeRecord = (record: RunRecord): string =>
  `attempt ${record.attempt} ${record.step} ${record.verdict ?? 'live'} as ${record.runAs} on ${record.branch ?? 'no branch'} pushed ${record.pushed ?? 'nothing'} owed [${record.owed.join(', ')}] input tokens ${record.inputTokens === null ? 'unknown' : String(record.inputTokens)}`;

export type Drive = {
  readonly ticket: string;
  readonly branch: string;
  readonly databaseUrl: string;
  readonly jira: { readonly site: string; readonly email: string; readonly accountId: () => Promise<string> };
  readonly github: { readonly repository: string };
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
};

const e2eServiceAccount = 'autoworker-job';

const e2eBridgePort = 4521;

export async function accessCopy(): Promise<string> {
  const copy = accessOnly(await readFile('/codex/auth.json', 'utf8'));
  if ('refused' in copy) throw new Error(copy.reason);
  return copy.login;
}

export async function driveAutoWorker(drive: Drive): Promise<void> {
  const up = await kind.run(['up']);
  const broken = up.find(check => !check.passed);
  if (broken !== undefined) throw new Error(`kind did not come up: ${broken.name}, ${broken.detail}`);
  drive.log(await ensureRegistry());
  const image = await buildAttemptImage(`${registry.host}/autoworker-job:e2e`);
  const address = await kindAddress();
  const core = kubernetes();
  const namespace = `e2e-${randomBytes(3).toString('hex')}`;
  await jobNamespace(core, namespace, e2eServiceAccount);
  const store = await openStore(drive.databaseUrl);
  try {
    const login = join(store.folder, 'codex.json');
    await writeFile(login, await accessCopy(), { mode: 0o600 });
    const run = drive.branch.replace(/^e2e\/run-/, '');
    const project = drive.ticket.split('-')[0] ?? 'SBX';
    const owner = drive.jira.email.toLowerCase();
    const setup = await applySetup(
      store,
      {
        admin: owner,
        people: [{ name: 'Sandbox owner', email: owner, jiraAccountId: await drive.jira.accountId(), logins: { github: { env: 'GITHUB_TOKEN' }, codex: { file: login }, jira: { env: 'AUTOWORKER_JIRA_LOGIN' } } }],
        repositories: [{ github: drive.github.repository, branch: drive.branch, fastTestCommand: 'npm ci && npm test' }],
        routines: [
          {
            name: 'End to end',
            goal: 'Take each sandbox ticket to a merged pull request.',
            workflow: 'code-change',
            source: { kind: 'jira-search', jql: `project = ${project} AND labels = e2e-run-${run}` },
            everyMinutes: 1,
            repository: { github: drive.github.repository, branch: drive.branch },
            creator: owner,
            gates: [],
            lastStep: 'land',
            jiraStartStatus: 'In Progress',
            jiraEndStatus: 'Done',
          },
        ],
      },
      {
        GITHUB_TOKEN: process.env['GITHUB_TOKEN'] ?? '',
        AUTOWORKER_JIRA_LOGIN: `${drive.jira.email}:${process.env['JIRA_API_TOKEN'] ?? ''}`,
      },
    );
    if (setup.code !== 0) throw new Error(`setup failed: ${setup.out}`);
    drive.log(setup.out.replaceAll('\n', '; '));
    const engine = startEngine(store, {
      JOB_IMAGE: image,
      JOB_NAMESPACE: namespace,
      JOB_ENGINE_URL: `http://${address}:${String(e2eBridgePort)}/`,
      BRIDGE_PORT: String(e2eBridgePort),
      JIRA_SITE: drive.jira.site,
      WORKER_EVERY_MS: '2000',
      SCHEDULER_EVERY_MS: '10000',
    });
    let printed = '';
    try {
      while (!drive.signal.aborted) {
        const lines = (await runRecord(store.db, drive.ticket)).map(describeRecord).join('\n');
        if (lines !== printed) {
          for (const line of lines.split('\n').filter(line => line !== '' && !printed.includes(line))) drive.log(line);
          printed = lines;
        }
        await wait(5_000, undefined, { signal: drive.signal }).catch(() => undefined);
      }
    } finally {
      await engine.stop();
      drive.log(`engine said: ${engine.said().split('\n').slice(-20).join(' | ')}`);
    }
  } finally {
    await closeStore(store);
    await core.deleteNamespace({ name: namespace });
  }
}
