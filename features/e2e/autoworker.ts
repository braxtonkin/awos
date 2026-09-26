import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
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
import type { Entry } from './catalog.ts';
import { setupProbe } from './codex-stand-in.ts';
import type { GitHub } from './github.ts';
import { taskFor } from './record.ts';
import { sandboxCommands } from './sandbox-seed.ts';
import { identity } from './solutions.ts';
import type { EngineWorld } from './world.ts';

const run = promisify(execFile);

const setupCommand = join(repositoryRoot, 'services/engine/setup.ts');

const engineCommand = join(repositoryRoot, 'services/engine/main.ts');

const actCommand = join(repositoryRoot, 'services/engine/act.ts');

export type Store = { readonly url: string; readonly db: Database; readonly key: string; readonly folder: string };

export async function openStore(url: string, key: string = randomBytes(32).toString('base64')): Promise<Store> {
  return { url, db: connect(url, 4), key, folder: await mkdtemp(join(tmpdir(), 'autoworker-')) };
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

export type Engine = { readonly said: () => string; readonly exited: Promise<void>; readonly stop: (graceMs?: number) => Promise<void>; readonly kill: () => Promise<void> };

const stopGraceMs = 30_000;

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
    exited,
    stop: async (graceMs = stopGraceMs) => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await Promise.race([exited, wait(graceMs, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
    kill: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
}

const restartDelayMs = 1_000;

export type Supervised = { readonly stop: (graceMs?: number) => Promise<void>; readonly hold: () => Promise<void>; readonly release: () => void; readonly starts: () => number; readonly said: () => string };

export function supervise(store: Store, settings: Readonly<Record<string, string>>, stopping: AbortSignal, out: (line: string) => void, echo?: (line: string) => void): Supervised {
  const stopped = new AbortController();
  const signal = AbortSignal.any([stopping, stopped.signal]);
  let engine: Engine = startEngine(store, settings, echo);
  let starts = 1;
  let said = '';
  let held: PromiseWithResolvers<void> | undefined;
  const watching = (async () => {
    while (!signal.aborted) {
      const ended = await Promise.race([engine.exited.then(() => 'exited' as const), once(signal, 'abort').then(() => 'stopping' as const)]);
      if (ended === 'stopping') return;
      said += engine.said();
      if (held !== undefined) {
        out('the engine is held stopped until start-engine');
        const released = await Promise.race([held.promise.then(() => true), once(signal, 'abort').then(() => false)]);
        if (!released) return;
      } else {
        out(`the engine exited, so it starts again in ${String(restartDelayMs)} ms`);
      }
      const waited = await wait(restartDelayMs, undefined, { signal }).then(
        () => true,
        () => false,
      );
      if (!waited) return;
      engine = startEngine(store, settings, echo);
      starts += 1;
    }
  })();
  return {
    stop: async graceMs => {
      stopped.abort();
      await watching;
      await engine.stop(graceMs);
    },
    hold: async () => {
      held ??= Promise.withResolvers();
      await engine.kill();
    },
    release: () => {
      const releasing = held;
      held = undefined;
      releasing?.resolve();
    },
    starts: () => starts,
    said: () => said + engine.said(),
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

export const faultNames = ['engine-restart', 'lost-job', 'base-conflict'] as const;

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
  readonly github: GitHub;
  readonly entry: Pick<Entry, 'name' | 'file'>;
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

export const driverSettings = (worldSettings: Readonly<Record<string, string>>, image: string, namespace: string, address: string): Readonly<Record<string, string>> => ({
  JOB_IMAGE: image,
  JOB_NAMESPACE: namespace,
  JOB_SERVICE_ACCOUNT: e2eServiceAccount,
  JOB_ENGINE_URL: `http://${address}:${String(e2eBridgePort)}/`,
  BRIDGE_PORT: String(e2eBridgePort),
  WORKER_EVERY_MS: '2000',
  SCHEDULER_EVERY_MS: '10000',
  LAND_EVERY_MS: '5000',
  ...worldSettings,
});

type Person = { readonly name: string; readonly email: string; readonly jiraAccountId?: string; readonly logins: object };

export type Plan = {
  readonly owner: string;
  readonly accountId: string;
  readonly repository: string;
  readonly branch: string;
  readonly commands: { readonly fastTest: string | undefined; readonly setup: string | undefined };
  readonly routine: { readonly name: string; readonly goal: string; readonly jql: string; readonly everyMinutes: number; readonly runAs: RunAs | 'owner' };
};

function setupFile(plan: Plan, login: string): object {
  const logins = { github: { env: 'GITHUB_TOKEN' }, codex: { file: login }, jira: { env: 'AUTOWORKER_JIRA_LOGIN' } };
  const runsAs: Readonly<Record<Plan['routine']['runAs'], string | undefined>> = { assignee: undefined, team: teamAccount, owner: plan.owner };
  const runAs = runsAs[plan.routine.runAs];
  const people: readonly Person[] = [
    { name: 'Sandbox owner', email: plan.owner, jiraAccountId: plan.accountId, logins },
    ...(plan.routine.runAs === 'team' ? [{ name: 'Sandbox team', email: teamAccount, logins }] : []),
  ];
  return {
    admin: plan.owner,
    people,
    repositories: [
      {
        github: plan.repository,
        branch: plan.branch,
        ...(plan.commands.fastTest === undefined ? {} : { fastTestCommand: plan.commands.fastTest }),
        ...(plan.commands.setup === undefined ? {} : { setupCommand: plan.commands.setup }),
      },
    ],
    routines: [
      {
        name: plan.routine.name,
        goal: plan.routine.goal,
        workflow: 'code-change',
        source: { kind: 'jira-search', jql: plan.routine.jql },
        everyMinutes: plan.routine.everyMinutes,
        repository: { github: plan.repository, branch: plan.branch },
        creator: plan.owner,
        ...(runAs === undefined ? {} : { runAs }),
        gates: [],
        lastStep: 'land',
        jiraStartStatus: startStatus,
        jiraEndStatus: endStatus,
      },
    ],
  };
}

export async function setUpAutoWorker(store: Store, world: EngineWorld, plan: Plan): Promise<string> {
  const login = join(store.folder, 'codex.json');
  await writeFile(login, await world.codexLogin(), { mode: 0o600 });
  const setup = await applySetup(store, setupFile(plan, login), { GITHUB_TOKEN: world.secrets.github, AUTOWORKER_JIRA_LOGIN: world.secrets.jiraLogin });
  if (setup.code !== 0) throw new Error(`setup failed: ${setup.out}`);
  if (world.trustLogins) await store.db.updateTable('credential').set({ state: 'valid', checked_at: new Date() }).execute();
  return setup.out.replaceAll('\n', '; ');
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

const faultCheckNames: Readonly<Record<Fault, string>> = { 'engine-restart': 'attempt continued', 'lost-job': 'lost attempt replaced', 'base-conflict': 'conflict resolved by a merge' };

async function continuedCheck(db: Database, ticket: string, fault: Exclude<Fault, 'base-conflict'>, hit: Implementing | undefined): Promise<Check> {
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

const baseMovedNotes = 'notes/base-moved.md';

const conflictSentBack = 'the pull request conflicts with its base branch';

type Fact = { readonly holds: boolean; readonly said: string };

function factsCheck(name: string, facts: readonly Fact[]): Check {
  const detail = facts.map(fact => fact.said).join('; ');
  return facts.every(fact => fact.holds) ? pass(name, detail) : fail(name, detail);
}

async function resolvedCheck(drive: Drive, db: Database, base: string | undefined): Promise<Check> {
  const name = faultCheckNames['base-conflict'];
  if (base === undefined) return fail(name, 'the fault never fired, because no Implement event was stored');
  const attempts = await db
    .selectFrom('attempt')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .select(['attempt.id', 'attempt.step', 'attempt.verdict', 'attempt.output', 'attempt.start_commit', 'attempt.last_pushed'])
    .where('task.key', '=', drive.ticket)
    .orderBy('attempt.id')
    .execute();
  const land = attempts.find(attempt => attempt.step === 'land' && attempt.verdict === 'red_check' && JSON.stringify(attempt.output).includes(conflictSentBack));
  const listed = attempts.map(attempt => `${attempt.id} ${attempt.step} ${attempt.verdict ?? 'live'}`).join(', ') || 'none';
  if (land === undefined) return factsCheck(name, [{ holds: false, said: `no Land attempt sent the task back because ${conflictSentBack}; attempts: ${listed}` }]);
  const sentBack: Fact = { holds: true, said: `Land attempt ${land.id} sent the task back, because ${conflictSentBack}` };
  const rework = attempts.find(attempt => attempt.step === 'implement' && Number(attempt.id) > Number(land.id));
  if (rework === undefined) return factsCheck(name, [sentBack, { holds: false, said: `no Implement attempt followed Land attempt ${land.id}` }]);
  const implement = `Implement attempt ${rework.id}`;
  const named = (await promptOf(db, rework.id)).includes(base);
  const pushed = rework.last_pushed === null ? undefined : await drive.github.commit(rework.last_pushed);
  const parents = pushed?.parents ?? [];
  const start = rework.start_commit;
  const merged = parents.length === 2 && start !== null && parents.includes(start) && parents.includes(base);
  const mergeSaid =
    pushed === undefined
      ? `${implement} pushed nothing`
      : merged
        ? `${implement} pushed ${pushed.sha}, a merge of its start commit and the base commit`
        : `${implement} pushed ${pushed.sha} with the parents ${parents.join(' and ') || 'none'}, which are not its start commit ${start ?? 'unknown'} and the base commit`;
  const blobsAt = async (commit: string): Promise<ReadonlyMap<string, string>> => drive.github.blobs((await drive.github.commit(commit)).tree);
  const head = await drive.github.branchHead(drive.branch);
  const onBranch = head === undefined ? new Map<string, string>() : await blobsAt(head);
  const ours = pushed === undefined ? undefined : (await blobsAt(pushed.sha)).get(drive.entry.file);
  const theirs = (await blobsAt(base)).get(drive.entry.file);
  const held = onBranch.get(drive.entry.file);
  const keptOurs = held !== undefined && held === ours && held !== theirs;
  const version = keptOurs ? 'the version Implement pushed' : held === undefined ? 'no version' : held === theirs ? "the base commit's own version" : 'another version';
  const notes = onBranch.has(baseMovedNotes);
  const task = await taskFor(db, drive.ticket);
  return factsCheck(name, [
    sentBack,
    { holds: true, said: `${implement} followed it` },
    { holds: named, said: `${implement}'s prompt ${named ? 'names' : 'does not name'} the base commit ${base}` },
    { holds: rework.verdict === 'pass', said: `${implement} ended ${rework.verdict ?? 'live'}` },
    { holds: merged, said: mergeSaid },
    { holds: task?.state === 'done', said: `the task is ${task?.state ?? 'missing'}` },
    { holds: notes && keptOurs, said: `${drive.branch} ${notes ? 'holds' : 'lacks'} ${baseMovedNotes} and holds ${version} of ${drive.entry.file}` },
  ]);
}

async function probeOutput(db: Database, attempt: string): Promise<string | undefined> {
  const row = await db
    .selectFrom('attempt_event')
    .select(sql<string | null>`body -> 'params' -> 'item' ->> 'aggregatedOutput'`.as('output'))
    .where('attempt_id', '=', attempt)
    .where('method', '=', 'item/completed')
    .where('item_id', '=', setupProbe.item)
    .executeTakeFirst();
  return row === undefined ? undefined : (row.output ?? '');
}

async function setupCheck(db: Database, ticket: string): Promise<Check> {
  const name = "Implement started with the repository's setup already run";
  const probes = await Promise.all(
    (await implementAttempts(db, ticket)).map(async ({ id, verdict }) => {
      const output = await probeOutput(db, id);
      return { id, output, skippedAs: output === undefined && (verdict === 'lost' || verdict === 'not_launched') ? verdict : undefined };
    }),
  );
  const judged = probes.filter(probe => probe.skippedAs === undefined);
  const detail = probes
    .map(probe => `Implement attempt ${probe.id} ${probe.output === undefined ? `ran no probe${probe.skippedAs === undefined ? '' : `, skipped because it ended ${probe.skippedAs}`}` : `printed "${probe.output.trim()}"`}`)
    .join('; ');
  return judged.length > 0 && judged.every(probe => probe.output?.includes(setupProbe.present) === true) ? pass(name, detail) : fail(name, detail || 'no Implement attempt ran');
}

type Park = { readonly step: string; readonly reason: string | null };

async function parkOf(db: Database, ticket: string): Promise<Park | undefined> {
  const task = await db.selectFrom('task').select(['state', 'step', 'waiting_reason']).where('key', '=', ticket).executeTakeFirst();
  return task?.state === 'waiting' ? { step: task.step, reason: task.waiting_reason } : undefined;
}

const parkedText = (ticket: string, park: Park): string => `${ticket} parked at ${park.step} ${park.reason === null ? 'with no waiting reason' : `with the waiting reason "${park.reason}"`}`;

async function podNames(core: CoreV1Api, namespace: string, attempt: string): Promise<readonly string[]> {
  return (await core.listNamespacedPod({ namespace, labelSelector: `${labels.attempt}=${attempt}` })).items.flatMap(pod => (pod.metadata?.name === undefined ? [] : [pod.metadata.name]));
}

export async function inJobNamespace<T>(world: EngineWorld, namespace: string, log: (line: string) => void, work: (cluster: { readonly core: CoreV1Api; readonly image: string; readonly address: string }) => Promise<T>): Promise<T> {
  const up = checksOf(await kind.run(['up']));
  const broken = up.find(check => !check.passed);
  if (broken !== undefined) throw new Error(`kind did not come up: ${broken.name}, ${broken.detail}`);
  log(await ensureRegistry());
  const image = await world.image(await buildAttemptImage(`${registry.host}/autoworker-job:e2e`));
  const address = await kindAddress();
  const core = kubernetes();
  await jobNamespace(core, namespace, e2eServiceAccount);
  try {
    return await work({ core, image, address });
  } finally {
    await core.deleteNamespace({ name: namespace });
  }
}

export async function driveAutoWorker(drive: Drive): Promise<void> {
  const park = await inJobNamespace(drive.world, drive.namespace, drive.log, ({ core, image, address }) => driveInNamespace(drive, core, image, address));
  if (park !== undefined) throw new Error(parkedText(drive.ticket, park));
}

async function driveInNamespace(drive: Drive, core: CoreV1Api, image: string, address: string): Promise<Park | undefined> {
  const store = await openStore(drive.databaseUrl);
  try {
    const run = drive.branch.replace(/^e2e\/run-/, '');
    const project = drive.ticket.split('-')[0] ?? 'SBX';
    const routine = { name: 'End to end', goal: 'Take each sandbox ticket to a merged pull request.', jql: `project = ${project} AND labels = e2e-run-${run}`, everyMinutes: 1, runAs: drive.runAs };
    drive.log(await setUpAutoWorker(store, drive.world, { owner: drive.jira.email.toLowerCase(), accountId: await drive.jira.accountId(), repository: drive.github.repository, branch: drive.branch, commands: sandboxCommands, routine }));
    const settings = driverSettings(drive.world.settings, image, drive.namespace, address);
    let engine = startEngine(store, settings);
    let printed = '';
    let hit: Implementing | undefined;
    let movedBase: string | undefined;
    let park: Park | undefined;
    let reportedAt = 0;
    try {
      while (!drive.signal.aborted && park === undefined) {
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
          if (hit !== undefined && drive.fault === 'base-conflict') {
            const files = [
              { path: drive.entry.file, content: identity(drive.entry) },
              { path: baseMovedNotes, content: `The base-conflict fault moved ${drive.branch} forward while ${drive.ticket} was in Implement.\n` },
            ];
            movedBase = await drive.github.advanceBranch(drive.branch, files, `Move ${drive.branch} forward under ${drive.ticket} for the base-conflict fault`);
            drive.check(pass('base moved under the pull request', `${drive.branch} moved to ${movedBase} at the first stored event of Implement attempt ${hit.attempt}, with its own ${drive.entry.file} and ${baseMovedNotes}`));
          }
        }
        if (Date.now() - reportedAt >= reportEveryMs) {
          reportedAt = Date.now();
          if (hit !== undefined) park = await parkOf(store.db, drive.ticket);
          const lines = (await runRecord(store.db, drive.ticket)).map(describeRecord).join('\n');
          if (lines !== printed) {
            for (const line of lines.split('\n').filter(line => line !== '' && !printed.includes(line))) drive.log(line);
            printed = lines;
          }
        }
        await wait(watchEveryMs, undefined, { signal: drive.signal }).catch(() => undefined);
      }
      if (park !== undefined) drive.check(fail('task never parked after the fault', parkedText(drive.ticket, park)));
      const endChecks: Readonly<Record<Fault, () => Promise<Check>>> = {
        'engine-restart': () => continuedCheck(store.db, drive.ticket, 'engine-restart', hit),
        'lost-job': () => continuedCheck(store.db, drive.ticket, 'lost-job', hit),
        'base-conflict': () => resolvedCheck(drive, store.db, movedBase),
      };
      if (drive.fault !== undefined) drive.check(await endChecks[drive.fault]());
      if (drive.world.agent === 'stand-in') drive.check(await setupCheck(store.db, drive.ticket));
      return park;
    } finally {
      await engine.stop();
      drive.log(`engine said: ${engine.said().split('\n').slice(-20).join(' | ')}`);
    }
  } finally {
    await closeStore(store);
  }
}
