import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { CoreV1Api } from '@kubernetes/client-node';
import { sql } from 'kysely';
import { labels } from '../../shared/cluster.ts';
import { accessOnly } from '../../shared/codex-login.ts';
import { connect, type Database } from '../../shared/db/client.ts';
import { checksOf, fail, pass, type Check } from '../../tools/verify/check.ts';
import { buildAttemptImage, ensureRegistry, jobNamespace, kindAddress, kubernetes, pushByDigest, registry, repositoryRoot, sh } from '../../tools/verify/cluster.ts';
import { kind } from '../../tools/verify/kind.ts';
import type { EngineWorld } from './world.ts';

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

export type Engine = { readonly said: () => string; readonly stop: () => Promise<void>; readonly kill: () => Promise<void> };

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
    kill: async () => {
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

export const faultNames = ['engine-restart', 'lost-job'] as const;

export type Fault = (typeof faultNames)[number];

export const runAsNames = ['assignee', 'team'] as const;

export type RunAs = (typeof runAsNames)[number];

export const teamAccount = 'autoworker-team@users.noreply.example.com';

export const startStatus = 'In Progress';

export const endStatus = 'Done';

export type Drive = {
  readonly ticket: string;
  readonly branch: string;
  readonly databaseUrl: string;
  readonly namespace: string;
  readonly jira: { readonly site: string; readonly email: string; readonly accountId: () => Promise<string> };
  readonly github: { readonly repository: string };
  readonly world: EngineWorld;
  readonly fault: Fault | undefined;
  readonly runAs: RunAs;
  readonly check: (check: Check) => void;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
};

const e2eServiceAccount = 'autoworker-job';

const e2eBridgePort = 4521;

const faultWaitMs = 10_000;

const watchEveryMs = 500;

const reportEveryMs = 5_000;

export async function accessCopy(): Promise<string> {
  const copy = accessOnly(await readFile('/codex/auth.json', 'utf8'));
  if ('refused' in copy) throw new Error(copy.reason);
  return copy.login;
}

export async function standInImage(attemptImage: string): Promise<string> {
  const tag = `${registry.host}/autoworker-job-stand-in:e2e`;
  const dockerfile = [
    `FROM ${attemptImage}`,
    'USER root',
    `RUN rm -f /usr/local/bin/codex && printf '#!/bin/sh\\nexec node /app/features/e2e/codex-stand-in.ts "$@"\\n' > /usr/local/bin/codex && chmod 755 /usr/local/bin/codex`,
    'USER 10001:10001',
  ].join('\n');
  await sh(`printf '%s\\n' '${dockerfile.replaceAll("'", "'\\''")}' | docker build -q -t ${tag} -`);
  return pushByDigest(tag);
}

export const driverSettings = (world: EngineWorld, image: string, namespace: string, address: string): Readonly<Record<string, string>> => ({
  JOB_IMAGE: image,
  JOB_NAMESPACE: namespace,
  JOB_SERVICE_ACCOUNT: e2eServiceAccount,
  JOB_ENGINE_URL: `http://${address}:${String(e2eBridgePort)}/`,
  BRIDGE_PORT: String(e2eBridgePort),
  WORKER_EVERY_MS: '2000',
  SCHEDULER_EVERY_MS: '10000',
  LAND_EVERY_MS: '5000',
  ...world.settings,
});

type Person = { readonly name: string; readonly email: string; readonly jiraAccountId?: string; readonly logins: object };

function setupFile(drive: Drive, login: string, accountId: string): object {
  const run = drive.branch.replace(/^e2e\/run-/, '');
  const project = drive.ticket.split('-')[0] ?? 'SBX';
  const owner = drive.jira.email.toLowerCase();
  const logins = { github: { env: 'GITHUB_TOKEN' }, codex: { file: login }, jira: { env: 'AUTOWORKER_JIRA_LOGIN' } };
  const people: readonly Person[] = [
    { name: 'Sandbox owner', email: owner, jiraAccountId: accountId, logins },
    ...(drive.runAs === 'team' ? [{ name: 'Sandbox team', email: teamAccount, logins }] : []),
  ];
  return {
    admin: owner,
    people,
    repositories: [{ github: drive.github.repository, branch: drive.branch, fastTestCommand: 'npm ci && npm test', setupCommand: 'npm ci' }],
    routines: [
      {
        name: 'End to end',
        goal: 'Take each sandbox ticket to a merged pull request.',
        workflow: 'code-change',
        source: { kind: 'jira-search', jql: `project = ${project} AND labels = e2e-run-${run}` },
        everyMinutes: 1,
        repository: { github: drive.github.repository, branch: drive.branch },
        creator: owner,
        ...(drive.runAs === 'team' ? { runAs: teamAccount } : {}),
        gates: [],
        lastStep: 'land',
        jiraStartStatus: startStatus,
        jiraEndStatus: endStatus,
      },
    ],
  };
}

type Implementing = { readonly attempt: string; readonly firstEventAt: Date };

async function firstImplementEvent(db: Database, ticket: string): Promise<Implementing | undefined> {
  const row = await db
    .selectFrom('attempt_event')
    .innerJoin('attempt', 'attempt.id', 'attempt_event.attempt_id')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .select(['attempt.id', 'attempt_event.stored_at'])
    .where('task.key', '=', ticket)
    .where('attempt.step', '=', 'implement')
    .orderBy('attempt_event.stored_at')
    .orderBy('attempt_event.seq')
    .limit(1)
    .executeTakeFirst();
  return row === undefined ? undefined : { attempt: row.id, firstEventAt: row.stored_at };
}

async function implementAttempts(db: Database, ticket: string): Promise<readonly { readonly id: string; readonly verdict: string | null }[]> {
  return db
    .selectFrom('attempt')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .select(['attempt.id', 'attempt.verdict'])
    .where('task.key', '=', ticket)
    .where('attempt.step', '=', 'implement')
    .orderBy('attempt.id')
    .execute();
}

const promptOf = async (db: Database, attempt: string): Promise<string> =>
  (await db.selectFrom('attempt_command').select('input').where('attempt_id', '=', attempt).where('kind', '=', 'turn.start').executeTakeFirst())?.input ?? '';

const faultCheckNames: Readonly<Record<Fault, string>> = { 'engine-restart': 'attempt continued', 'lost-job': 'lost attempt replaced' };

async function continuedCheck(db: Database, ticket: string, fault: Fault, hit: Implementing | undefined): Promise<Check> {
  const name = faultCheckNames[fault];
  if (hit === undefined) return fail(name, 'the fault never fired, because no Implement event was stored');
  const implement = await implementAttempts(db, ticket);
  const described = implement.map(attempt => `${attempt.id} ${attempt.verdict ?? 'live'}`).join(', ');
  if (fault === 'engine-restart') {
    const verdict = implement.find(attempt => attempt.id === hit.attempt)?.verdict;
    return verdict === 'pass' && implement.length === 1 ? pass(name, `Implement attempt ${hit.attempt} passed after the restart; Implement attempts: ${described}`) : fail(name, `Implement attempts: ${described}`);
  }
  const lost = implement.find(attempt => attempt.id === hit.attempt);
  const next = implement.find(attempt => Number(attempt.id) > Number(hit.attempt));
  const prompt = next === undefined ? '' : await promptOf(db, next.id);
  const summarised = prompt.includes(`## What lost attempt ${hit.attempt} finished`);
  return lost?.verdict === 'lost' && next?.verdict === 'pass' && summarised
    ? pass(name, `attempt ${hit.attempt} lost, attempt ${next.id} passed with the lost attempt's summary in its prompt`)
    : fail(name, `Implement attempts: ${described}; the next prompt ${summarised ? 'holds' : 'lacks'} the summary`);
}

async function podNames(core: CoreV1Api, namespace: string, attempt: string): Promise<readonly string[]> {
  return (await core.listNamespacedPod({ namespace, labelSelector: `${labels.attempt}=${attempt}` })).items.flatMap(pod => (pod.metadata?.name === undefined ? [] : [pod.metadata.name]));
}

export async function driveAutoWorker(drive: Drive): Promise<void> {
  const up = checksOf(await kind.run(['up']));
  const broken = up.find(check => !check.passed);
  if (broken !== undefined) throw new Error(`kind did not come up: ${broken.name}, ${broken.detail}`);
  drive.log(await ensureRegistry());
  const image = await drive.world.image(await buildAttemptImage(`${registry.host}/autoworker-job:e2e`));
  const address = await kindAddress();
  const core = kubernetes();
  await jobNamespace(core, drive.namespace, e2eServiceAccount);
  try {
    await driveInNamespace(drive, core, image, address);
  } finally {
    await core.deleteNamespace({ name: drive.namespace });
  }
}

async function driveInNamespace(drive: Drive, core: CoreV1Api, image: string, address: string): Promise<void> {
  const store = await openStore(drive.databaseUrl);
  try {
    const login = join(store.folder, 'codex.json');
    await writeFile(login, await drive.world.codexLogin(), { mode: 0o600 });
    const setup = await applySetup(store, setupFile(drive, login, await drive.jira.accountId()), { GITHUB_TOKEN: drive.world.secrets.github, AUTOWORKER_JIRA_LOGIN: drive.world.secrets.jiraLogin });
    if (setup.code !== 0) throw new Error(`setup failed: ${setup.out}`);
    drive.log(setup.out.replaceAll('\n', '; '));
    if (drive.world.trustLogins) await store.db.updateTable('credential').set({ state: 'valid', checked_at: new Date() }).execute();
    const settings = driverSettings(drive.world, image, drive.namespace, address);
    let engine = startEngine(store, settings);
    let printed = '';
    let hit: Implementing | undefined;
    let reportedAt = 0;
    try {
      while (!drive.signal.aborted) {
        if (drive.fault !== undefined && hit === undefined) {
          hit = await firstImplementEvent(store.db, drive.ticket);
          if (hit !== undefined && drive.fault === 'engine-restart') {
            await engine.kill();
            drive.log(`killed the engine ${String(Date.now() - hit.firstEventAt.getTime())} ms after the first event of Implement attempt ${hit.attempt}`);
            await wait(faultWaitMs);
            engine = startEngine(store, settings);
            drive.check(pass('engine restarted', `killed with SIGKILL at the first stored event of Implement attempt ${hit.attempt}, started again ${String(faultWaitMs / 1000)} s later`));
          }
          if (hit !== undefined && drive.fault === 'lost-job') {
            const pods = await podNames(core, drive.namespace, hit.attempt);
            await Promise.all(pods.map(name => core.deleteNamespacedPod({ name, namespace: drive.namespace, gracePeriodSeconds: 0 })));
            drive.check(pods.length > 0 ? pass('pod deleted mid-step', `${pods.join(', ')} of Implement attempt ${hit.attempt}`) : fail('pod deleted mid-step', `Implement attempt ${hit.attempt} had no pod`));
          }
        }
        if (Date.now() - reportedAt >= reportEveryMs) {
          reportedAt = Date.now();
          const lines = (await runRecord(store.db, drive.ticket)).map(describeRecord).join('\n');
          if (lines !== printed) {
            for (const line of lines.split('\n').filter(line => line !== '' && !printed.includes(line))) drive.log(line);
            printed = lines;
          }
        }
        await wait(watchEveryMs, undefined, { signal: drive.signal }).catch(() => undefined);
      }
      if (drive.fault !== undefined) drive.check(await continuedCheck(store.db, drive.ticket, drive.fault, hit));
    } finally {
      await engine.stop();
      drive.log(`engine said: ${engine.said().split('\n').slice(-20).join(' | ')}`);
    }
  } finally {
    await closeStore(store);
  }
}
