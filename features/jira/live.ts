import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { z } from 'zod';
import { actionKinds, marker } from '../../shared/actions.ts';
import { connect, type Database } from '../../shared/db/client.ts';
import type { OutboxState } from '../../shared/db/types.ts';
import { fail, pass, type Check } from '../../tools/verify/check.ts';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { jiraClient, type Jira } from './client.ts';
import { markerProperty } from './performers.ts';
import { currentAssignee } from './source.ts';

export const laneNames = ['flow', 'twice', 'assignee', 'search-identity', 'restart', 'no-marker', 'same-status', 'check', 'pages', 'perf'] as const;

type LaneName = (typeof laneNames)[number];

type Statuses = { readonly start: string; readonly end: string };

const liveKeys = z.object({
  JIRA_SITE: z.url({ protocol: /^https$/ }),
  JIRA_EMAIL: z.email(),
  JIRA_API_TOKEN: z.string().regex(/^\S+$/),
  JIRA_PROJECT: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
});

type LiveKeys = z.infer<typeof liveKeys>;

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const testLabel = 'autoworker-test';
const pollMs = 500;
const searchWaitMs = 90_000;
const engineWaitMs = 60_000;
const outboxLeaseMs = 8_000;
const perfBudget = { runMs: 5_000, commentMs: 2_000 };

const created = z.object({ key: z.string().min(1) });
const changelog = z.object({ values: z.array(z.object({ items: z.array(z.object({ field: z.string(), fromString: z.string().nullable(), toString: z.string().nullable() })) })) });
const commentBody = z.object({ body: z.unknown() });

const expect = (name: string, holds: boolean, detail: string): Check => (holds ? pass(name, detail) : fail(name, detail));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs / 1000)} s waiting for ${what}`);
    await wait(pollMs);
  }
}

type Proxy = { readonly url: string; killOnComment: (() => void) | undefined; readonly close: () => Promise<void> };

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

function startProxy(site: string): Promise<Proxy> {
  const proxy: { killOnComment: (() => void) | undefined } = { killOnComment: undefined };
  const server: Server = createServer((request, response) => {
    const method = request.method ?? 'GET';
    const path = request.url ?? '/';
    bodyOf(request)
      .then(async body => {
        const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
        if (request.headers.authorization !== undefined) headers['authorization'] = request.headers.authorization;
        const upstream = await fetch(new URL(path, site), { method, headers, ...(body.length === 0 ? {} : { body }) });
        const answered = Buffer.from(await upstream.arrayBuffer());
        const kill = proxy.killOnComment;
        if (kill !== undefined && method === 'POST' && /^\/rest\/api\/3\/issue\/[^/]+\/comment$/.test(path) && upstream.status === 201) {
          proxy.killOnComment = undefined;
          kill();
          response.destroy();
          return;
        }
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        response.end(answered);
      })
      .catch((error: unknown) => {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ errorMessages: [`the lane's proxy could not reach Jira: ${messageOf(error)}`] }));
      });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      resolve(
        Object.assign(proxy, {
          url: `http://127.0.0.1:${String(port)}`,
          close: () =>
            new Promise<void>(done => {
              server.closeAllConnections();
              server.close(() => {
                done();
              });
            }),
        }),
      );
    });
  });
}

type Engine = { readonly exited: Promise<number | null>; readonly child: ChildProcess };

type World = {
  readonly keys: LiveKeys;
  readonly jira: Jira;
  readonly me: string;
  readonly run: string;
  readonly label: string;
  readonly db: Database;
  readonly creator: string;
  readonly runAs: string;
  readonly repository: string;
  readonly proxy: Proxy;
  readonly filed: string[];
  readonly log: string[];
  engine: Engine | undefined;
  readonly start: (root?: string) => void;
  readonly stop: () => Promise<void>;
};

const fakeJwt = (claims: object): string => [{ alg: 'none' }, claims, 'signature'].map(part => Buffer.from(typeof part === 'string' ? part : JSON.stringify(part)).toString('base64url')).join('.');

const accessOnlyCodexLogin = (): string => `${JSON.stringify({ tokens: { access_token: fakeJwt({ exp: Math.floor(Date.now() / 1000) + 86_400 }), refresh_token: '' } }, null, 2)}\n`;

const setupFile = {
  admin: 'lane-creator@example.com',
  people: [
    { name: 'Lane Creator', email: 'lane-creator@example.com', logins: { github: { env: 'LANE_GITHUB_TOKEN' }, codex: { file: 'codex.json' }, jira: { env: 'LANE_JIRA_LOGIN' } } },
    { name: 'Lane Run-as', email: 'lane-run-as@example.com', logins: { github: { env: 'LANE_GITHUB_TOKEN' }, codex: { file: 'codex.json' }, jira: { env: 'LANE_MADE_UP_JIRA_LOGIN' } } },
  ],
};

function runSetup(databaseUrl: string, key: string, keys: LiveKeys, folder: string): string {
  const setup = spawnSync(process.execPath, [join(repoRoot, 'services/engine/setup.ts'), join(folder, 'setup.json')], {
    env: {
      PATH: process.env['PATH'] ?? '',
      DATABASE_URL: databaseUrl,
      CREDENTIAL_KEY: key,
      CREDENTIAL_KEY_VERSION: '1',
      LANE_GITHUB_TOKEN: `made-up-github-${randomBytes(8).toString('hex')}`,
      LANE_JIRA_LOGIN: `${keys.JIRA_EMAIL}:${keys.JIRA_API_TOKEN}`,
      LANE_MADE_UP_JIRA_LOGIN: `lane-run-as@example.com:made-up-${randomBytes(12).toString('hex')}`,
    },
    encoding: 'utf8',
  });
  if (setup.status !== 0) throw new Error(`setup exited ${String(setup.status)}: ${setup.stderr.trim()}`);
  return setup.stdout.trim().split('\n').join('; ');
}

async function plantedCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'jira-no-marker-'));
  for (const entry of ['features', 'shared', 'services', 'package.json', 'tsconfig.json']) {
    await cp(join(repoRoot, entry), join(root, entry), { recursive: true, filter: source => !source.split(/[\\/]/).includes('node_modules') });
  }
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  const performers = join(root, 'features/jira/performers.ts');
  const source = await readFile(performers, 'utf8');
  const guarded = "{ catches: 'nothing', find: findComment(access), call: postComment(access, db) }";
  if (!source.includes(guarded)) throw new Error(`the plant did not apply, because ${performers} no longer holds ${guarded}`);
  await writeFile(performers, source.replace(guarded, "{ catches: 'duplicates', call: postComment(access, db) }"));
  return root;
}

async function withWorld<T>(work: (world: World) => Promise<T>): Promise<T> {
  const parsed = liveKeys.safeParse(process.env);
  if (!parsed.success) throw new Error(`The live keys are not usable: ${parsed.error.issues.map(issue => String(issue.path[0])).join(', ')}. Run in the live service and set JIRA_PROJECT.`);
  const keys = parsed.data;
  const jira = jiraClient(keys.JIRA_SITE, { email: keys.JIRA_EMAIL, token: keys.JIRA_API_TOKEN }, 'the lane', AbortSignal.timeout(20 * 60_000));
  const me = await jira.myself();
  const run = `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${randomBytes(2).toString('hex')}`;
  const folder = await mkdtemp(join(tmpdir(), 'jira-live-'));
  const proxy = await startProxy(keys.JIRA_SITE);
  try {
    return await withPostgres(async postgres => {
      const scratch = await postgres.scratch();
      const db = connect(scratch.url, 4);
      const key = randomBytes(32).toString('base64');
      await writeFile(join(folder, 'setup.json'), JSON.stringify(setupFile));
      await writeFile(join(folder, 'codex.json'), accessOnlyCodexLogin());
      say(`setup: ${runSetup(scratch.stableUrl, key, keys, folder)}`);
      const people = await db.selectFrom('person').select(['id', 'email']).execute();
      const idOf = (email: string): string => people.find(person => person.email === email)?.id ?? '';
      const creator = idOf('lane-creator@example.com');
      const repository = await db.transaction().execute(async tx => {
        const saved = randomUUID();
        const row = await tx.insertInto('repository').values({ github: 'example/sandbox', branch: 'main', saved_by: saved }).returning('id').executeTakeFirstOrThrow();
        await tx.insertInto('human_action').values({ id: saved, at: new Date(), person_id: creator, kind: 'add_repository', repository_id: row.id }).execute();
        return row.id;
      });
      const log: string[] = [];
      const world: World = {
        keys,
        jira,
        me,
        run,
        label: `autoworker-p6-${run}`,
        db,
        creator,
        runAs: idOf('lane-run-as@example.com'),
        repository,
        proxy,
        filed: [],
        log,
        engine: undefined,
        start: (root = repoRoot) => {
          const child = spawn(process.execPath, [join(root, 'services/engine/main.ts')], {
            env: {
              PATH: process.env['PATH'] ?? '',
              DATABASE_URL: scratch.stableUrl,
              CREDENTIAL_KEY: key,
              CREDENTIAL_KEY_VERSION: '1',
              JIRA_SITE: proxy.url,
              SCHEDULER_EVERY_MS: '1000',
              OUTBOX_EVERY_MS: '500',
              OUTBOX_LEASE_MS: String(outboxLeaseMs),
              OUTBOX_MARGIN_MS: '2000',
              OUTBOX_MAX_TRIES: '2',
              CHECKS_EVERY_MS: '2000',
              CHECK_TIMEOUT_MS: '5000',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          const hear = (chunk: string): void => {
            for (const line of chunk.split('\n').filter(text => text.trim() !== '')) {
              log.push(line);
              say(`  engine: ${line}`);
            }
          };
          child.stdout.setEncoding('utf8').on('data', hear);
          child.stderr.setEncoding('utf8').on('data', hear);
          world.engine = { child, exited: new Promise(resolve => child.on('exit', resolve)) };
        },
        stop: async () => {
          const engine = world.engine;
          world.engine = undefined;
          if (engine === undefined || engine.child.exitCode !== null || engine.child.signalCode !== null) return;
          engine.child.kill('SIGTERM');
          if ((await Promise.race([engine.exited, wait(engineWaitMs).then(() => 'hung' as const)])) === 'hung') engine.child.kill('SIGKILL');
        },
      };
      try {
        return await work(world);
      } finally {
        await world.stop();
        await db.destroy();
        await scratch.drop();
      }
    });
  } finally {
    await proxy.close();
    await rm(folder, { recursive: true, force: true });
  }
}

const labelQuery = (world: World): string => `project = ${world.keys.JIRA_PROJECT} AND labels = "${world.label}" ORDER BY key ASC`;

async function fileTicket(world: World, lane: string): Promise<string> {
  const { key } = await world.jira.call('POST', '/rest/api/3/issue', created, {
    fields: {
      project: { key: world.keys.JIRA_PROJECT },
      issuetype: { name: 'Task' },
      summary: `AutoWorker P6 probe, lane ${lane}, run ${world.run}`,
      labels: [testLabel, world.label],
      assignee: { accountId: world.me },
    },
  });
  world.filed.push(key);
  say(`filed ${key}`);
  return key;
}

const searchable = (world: World, count: number): Promise<number> =>
  until(`the search to find ${String(count)} probe tickets`, searchWaitMs, async () => {
    const found = await world.jira.search(labelQuery(world), 100);
    return found.length >= count ? found.length : undefined;
  });

type RoutineOptions = { readonly pageSize?: number; readonly runAs?: string; readonly statuses?: Statuses };

async function addRoutine(world: World, options: RoutineOptions = {}): Promise<string> {
  const routine = await world.db.insertInto('routine').values({ creator_id: world.creator, run_as_id: options.runAs ?? null }).returning('id').executeTakeFirstOrThrow();
  const action = randomUUID();
  await world.db.insertInto('human_action').values({ id: action, at: new Date(), person_id: world.creator, kind: 'edit_routine', routine_id: routine.id }).execute();
  await world.db
    .insertInto('routine_version')
    .values({
      routine_id: routine.id,
      version: 1,
      name: `Probe search ${world.run}`,
      goal: 'Record a task for each probe ticket.',
      every: '1 day',
      repository_id: world.repository,
      action_id: action,
      workflow: 'code-change',
      source: JSON.stringify({ kind: 'jira-search', jql: labelQuery(world), ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }) }),
      needs_repository: true,
      jira_start_status: options.statuses?.start ?? null,
      jira_end_status: options.statuses?.end ?? null,
    })
    .execute();
  return routine.id;
}

async function press(world: World, routine: string): Promise<void> {
  const id = randomUUID();
  await world.db.insertInto('human_action').values({ id, at: new Date(), person_id: world.creator, kind: 'run_now', routine_id: routine }).execute();
  await world.db.insertInto('routine_run').values({ routine_id: routine, version: 1, reason: 'run_now', pressed_by: id }).execute();
}

type Run = { readonly id: string; readonly outcome: string; readonly found: number; readonly note: string | null; readonly ms: number };

const finishedRun = (world: World, routine: string, count: number): Promise<Run> =>
  until(`run ${String(count)} of routine ${routine} to finish`, engineWaitMs, async () => {
    const runs = await world.db
      .selectFrom('routine_run')
      .select(['id', 'outcome', 'found', 'note', sql<string>`extract(epoch from finished_at - started_at) * 1000`.as('ms')])
      .where('routine_id', '=', routine)
      .where('finished_at', 'is not', null)
      .orderBy('id')
      .execute();
    const run = runs[count - 1];
    return run === undefined ? undefined : { id: run.id, outcome: run.outcome ?? 'unfinished', found: run.found, note: run.note, ms: Number(run.ms) };
  });

type Task = { readonly id: string; readonly key: string; readonly title: string; readonly assignee: string | null };

async function tasksOf(world: World, keys: readonly string[]): Promise<readonly Task[]> {
  if (keys.length === 0) return [];
  const rows = await world.db.selectFrom('task').select(['id', 'key', 'title', 'assignee_account_id']).where('key', 'in', keys).orderBy('key').execute();
  return rows.map(row => ({ id: row.id, key: row.key, title: row.title, assignee: row.assignee_account_id }));
}

async function taskOf(world: World, key: string): Promise<Task> {
  const [task] = await tasksOf(world, [key]);
  if (task === undefined) throw new Error(`no task was recorded for ${key}`);
  return task;
}

type Owing = { readonly row: string; readonly marker: string };

async function owe(world: World, task: string, kind: string, payload: unknown, actsAs = world.creator): Promise<Owing> {
  const owedMarker = marker.parse(randomBytes(18).toString('base64url'));
  const { last } = await world.db
    .selectFrom('outbox')
    .select(eb => eb.fn.coalesce(eb.fn.max('position'), sql.lit(0)).as('last'))
    .where('task_id', '=', task)
    .executeTakeFirstOrThrow();
  const { id } = await world.db
    .insertInto('outbox')
    .values({ task_id: task, position: last + 1, kind, payload: JSON.stringify(payload), acts_as: actsAs, idempotency_key: owedMarker, owed_at: sql<Date>`clock_timestamp()` })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { row: id, marker: owedMarker };
}

type Row = { readonly state: OutboxState; readonly claimed: boolean; readonly tries: number; readonly error: string | null; readonly result: unknown; readonly ms: number | null };

async function rowOf(world: World, row: string): Promise<Row> {
  const found = await world.db
    .selectFrom('outbox')
    .select(['state', 'claim', 'tries', 'last_error', 'result', sql<string | null>`extract(epoch from settled_at - owed_at) * 1000`.as('ms')])
    .where('id', '=', row)
    .executeTakeFirstOrThrow();
  return { state: found.state, claimed: found.claim !== null, tries: found.tries, error: found.last_error, result: found.result, ms: found.ms === null ? null : Number(found.ms) };
}

const settledRow = (world: World, row: string, states: readonly OutboxState[] = ['done', 'failed', 'refused']): Promise<Row> =>
  until(`outbox row ${row} to settle`, engineWaitMs, async () => {
    const found = await rowOf(world, row);
    return states.includes(found.state) ? found : undefined;
  });

async function marked(world: World, ticket: string, owedMarker: string): Promise<readonly string[]> {
  const comments = await world.jira.comments(ticket);
  return comments
    .filter(comment => {
      const value = comment.properties.get(markerProperty);
      return typeof value === 'object' && value !== null && 'marker' in value && value.marker === owedMarker;
    })
    .map(comment => comment.id);
}

async function statusMoves(world: World, ticket: string): Promise<readonly string[]> {
  const { values } = await world.jira.call('GET', `/rest/api/3/issue/${ticket}/changelog?startAt=0&maxResults=100`, changelog);
  return values.flatMap(entry => entry.items.filter(item => item.field === 'status').map(item => `${item.fromString ?? '?'} -> ${item.toString ?? '?'}`));
}

async function recordedProbe(world: World, lane: string, options: RoutineOptions = {}): Promise<{ readonly ticket: string; readonly routine: string; readonly run: Run; readonly task: Task | undefined }> {
  const ticket = await fileTicket(world, lane);
  await searchable(world, 1);
  const routine = await addRoutine(world, options);
  if (world.engine === undefined) world.start();
  const run = await finishedRun(world, routine, 1);
  const [task] = await tasksOf(world, [ticket]);
  return { ticket, routine, run, task };
}

const describeRun = (run: Run): string => `run ${run.id} ${run.outcome}, found ${String(run.found)}${run.note === null ? '' : `, note: ${run.note}`}`;

async function flow(world: World, statuses: Statuses): Promise<readonly Check[]> {
  const { ticket, routine, run, task } = await recordedProbe(world, 'flow', { statuses });
  if (task === undefined) return [fail('the routine run records the probe as a task', describeRun(run))];
  const checks = [
    expect(
      'the routine run records the probe as a task keyed by the ticket, with its summary and assignee',
      run.outcome === 'done' && task.title.includes(world.run) && task.assignee === world.me,
      `${describeRun(run)}; task ${task.id} keyed ${task.key}, titled "${task.title}", assigned to ${task.assignee === world.me ? 'the sandbox account' : (task.assignee ?? 'nobody')}`,
    ),
  ];
  const opened = `https://github.com/example/sandbox/pull/${(1000n + BigInt(task.id)).toString()}`;
  await world.db
    .insertInto('outbox')
    .values({ task_id: task.id, position: 1, kind: actionKinds.prOpenDraft.kind, payload: '{}', acts_as: world.creator, idempotency_key: marker.parse(randomBytes(18).toString('base64url')), owed_at: new Date(), state: 'done', settled_at: new Date(), result: JSON.stringify({ number: Number(1000n + BigInt(task.id)), url: opened }) })
    .execute();
  const comment = await owe(world, task.id, actionKinds.ticketComment.kind, { ticket, text: `AutoWorker recorded ${ticket} as task ${task.id}.\nThis comment is a probe.`, linkPullRequest: true });
  const first = await settledRow(world, comment.row);
  await world.db.updateTable('outbox').set({ state: 'owed', settled_at: null, result: null }).where('id', '=', comment.row).execute();
  const second = await settledRow(world, comment.row);
  const posted = await marked(world, ticket, comment.marker);
  const [only] = posted;
  const body = only === undefined ? '' : JSON.stringify((await world.jira.call('GET', `/rest/api/3/issue/${ticket}/comment/${only}`, commentBody)).body);
  checks.push(
    expect(
      'owing one comment twice shows one comment, which links the pull request',
      first.state === 'done' && second.state === 'done' && posted.length === 1 && body.includes(opened),
      `first ${first.state} ${JSON.stringify(first.result)}, owed again then ${second.state} ${JSON.stringify(second.result)}; comments with the marker: ${posted.join(', ') || 'none'}; the comment links ${body.includes(opened) ? opened : 'nothing'}`,
    ),
  );
  const version = await world.db.selectFrom('routine_version').select(['jira_start_status', 'jira_end_status']).where('routine_id', '=', routine).executeTakeFirstOrThrow();
  const start = version.jira_start_status ?? statuses.start;
  const end = version.jira_end_status ?? statuses.end;
  const before = (await world.jira.ticket(ticket)).status;
  const toStart = await owe(world, task.id, actionKinds.ticketTransition.kind, { ticket, status: start, from: before });
  const toEnd = await owe(world, task.id, actionKinds.ticketTransition.kind, { ticket, status: end, from: start });
  const started = await settledRow(world, toStart.row);
  const ended = await settledRow(world, toEnd.row);
  const after = (await world.jira.ticket(ticket)).status;
  const moves = await statusMoves(world, ticket);
  checks.push(
    expect(
      `the ticket moves from the routine's start status to its end status, ${start} then ${end}`,
      started.state === 'done' && ended.state === 'done' && after === end && moves.join(', ') === `${before} -> ${start}, ${start} -> ${end}`,
      `rows ${started.state} and ${ended.state}; the ticket is in ${after}; its status changes: ${moves.join(', ')}`,
    ),
  );
  return checks;
}

async function twice(world: World): Promise<readonly Check[]> {
  const { ticket, routine, run } = await recordedProbe(world, 'twice');
  await press(world, routine);
  const again = await finishedRun(world, routine, 2);
  const tasks = await world.db.selectFrom('task').select('id').where('key', '=', ticket).execute();
  return [expect('two runs over the same ticket leave one task', run.outcome === 'done' && again.outcome === 'done' && again.found === 1 && tasks.length === 1, `${describeRun(run)}; ${describeRun(again)}; ${String(tasks.length)} task for ${ticket}`)];
}

const assigneeInSearch = (world: World, ticket: string, account: string | null): Promise<true> =>
  until(`the search to show ${ticket} assigned to ${account ?? 'nobody'}`, searchWaitMs, async () => {
    const [found] = await world.jira.search(`key = ${ticket}`, 1);
    return found?.assignee === account ? true : undefined;
  });

async function assignee(world: World): Promise<readonly Check[]> {
  const { ticket, routine, task } = await recordedProbe(world, 'assignee');
  const read = currentAssignee({ site: world.keys.JIRA_SITE, timeoutMs: 20_000, logins: () => Promise.resolve({ login: { email: world.keys.JIRA_EMAIL, token: world.keys.JIRA_API_TOKEN }, who: 'the lane' }) });
  const seen: string[] = [`run 1: ${task?.assignee === world.me ? 'the sandbox account' : (task?.assignee ?? 'nobody')}`];
  let follows = task?.assignee === world.me;
  for (const [index, account] of [null, world.me].entries()) {
    await world.jira.call('PUT', `/rest/api/3/issue/${ticket}/assignee`, z.null(), { accountId: account });
    await assigneeInSearch(world, ticket, account);
    await press(world, routine);
    await finishedRun(world, routine, index + 2);
    const now = await taskOf(world, ticket);
    const readNow = await read(ticket, world.creator);
    seen.push(`run ${String(index + 2)} after assigning ${account === null ? 'nobody' : 'the sandbox account'}: the task has ${now.assignee === null ? 'nobody' : 'the sandbox account'}, and the assignee read says ${readNow === null ? 'nobody' : 'the sandbox account'}`);
    follows = follows && now.assignee === account && readNow === account;
  }
  return [expect("the task's assignee account follows the ticket's assignee in Jira", follows, seen.join('; '))];
}

async function searchIdentity(world: World): Promise<readonly Check[]> {
  const { routine, run } = await recordedProbe(world, 'search-identity', { runAs: world.runAs });
  const named = `person ${world.runAs} (Lane Run-as)`;
  const logged = world.log.some(line => line.includes('401') && line.includes(named));
  await world.db.updateTable('routine').set({ run_as_id: null }).where('id', '=', routine).execute();
  await press(world, routine);
  const second = await finishedRun(world, routine, 2);
  const tasks = await tasksOf(world, world.filed);
  return [
    expect('a search as the run-as person with a made-up token fails with 401, and the note and the log name that person', run.outcome === 'failed' && (run.note ?? '').includes('401') && (run.note ?? '').includes(named) && logged, `${describeRun(run)}; the log names them: ${String(logged)}`),
    expect("with the run-as cleared, the search runs as the routine's creator and records the task", second.outcome === 'done' && tasks.length === 1, `${describeRun(second)}; tasks: ${tasks.map(task => task.key).join(', ')}`),
  ];
}

async function restart(world: World, plant: boolean): Promise<readonly Check[]> {
  const { ticket, task } = await recordedProbe(world, plant ? 'no-marker' : 'restart');
  if (task === undefined) return [fail('the probe is recorded as a task', ticket)];
  const running = world.engine;
  world.proxy.killOnComment = () => running?.child.kill('SIGKILL');
  const comment = await owe(world, task.id, actionKinds.ticketComment.kind, { ticket, text: `AutoWorker probe comment for ${ticket}. The engine is killed after Jira stores it.`, linkPullRequest: false });
  await Promise.race([running?.exited, wait(engineWaitMs)]);
  world.engine = undefined;
  const killed = await rowOf(world, comment.row);
  const afterKill = await marked(world, ticket, comment.marker);
  const root = plant ? await plantedCopy() : undefined;
  try {
    world.start(root);
    const settled = await settledRow(world, comment.row);
    const posted = await marked(world, ticket, comment.marker);
    const detail = `after the kill the row was ${killed.state}${killed.claimed ? ' and still claimed' : ''} with ${String(afterKill.length)} comment; after the restart${plant ? ' of an engine whose comment performer has no marker check' : ''} it is ${settled.state} after ${String(settled.tries)} lapsed tries, and the ticket has ${String(posted.length)} comments with the marker`;
    return plant
      ? [expect('without the marker check, the restarted engine posts the comment again, so the ticket has two', killed.state === 'owed' && afterKill.length === 1 && settled.state === 'done' && posted.length === 2, detail)]
      : [expect('the restarted engine finds the comment by its marker, so the ticket has one and the row is done', killed.state === 'owed' && afterKill.length === 1 && settled.state === 'done' && posted.length === 1, detail)];
  } finally {
    if (root !== undefined) {
      await world.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function sameStatus(world: World, statuses: Statuses): Promise<readonly Check[]> {
  const { ticket, task } = await recordedProbe(world, 'same-status');
  if (task === undefined) return [fail('the probe is recorded as a task', ticket)];
  const current = (await world.jira.ticket(ticket)).status;
  const movesBefore = await statusMoves(world, ticket);
  const same = await settledRow(world, (await owe(world, task.id, actionKinds.ticketTransition.kind, { ticket, status: current, from: current })).row);
  const movesAfter = await statusMoves(world, ticket);
  const [toStart] = (await world.jira.transitions(ticket)).filter(move => move.to === statuses.start);
  if (toStart === undefined) return [fail(`the lane can move ${ticket} to ${statuses.start}`, `no transition from ${current} leads there`)];
  await world.jira.transition(ticket, toStart.id);
  const left = await settledRow(world, (await owe(world, task.id, actionKinds.ticketTransition.kind, { ticket, status: statuses.end, from: current })).row);
  const finalStatus = (await world.jira.ticket(ticket)).status;
  return [
    expect('a move to the status the ticket is in is done, and the changelog shows no new transition', same.state === 'done' && movesAfter.length === movesBefore.length, `row ${same.state}; status changes before ${String(movesBefore.length)}, after ${String(movesAfter.length)}`),
    expect(
      'a move whose expected status the ticket has left fails and names the status it found',
      left.state === 'failed' && (left.error ?? '').includes(`"${statuses.start}"`) && finalStatus === statuses.start,
      `row ${left.state} after ${String(left.tries)} tries: ${left.error ?? 'no error'}; the ticket stays in ${finalStatus}`,
    ),
  ];
}

async function check(world: World): Promise<readonly Check[]> {
  world.start();
  const states = await until('the engine to check both Jira logins', engineWaitMs, async () => {
    const rows = await world.db.selectFrom('credential').select(['person_id', 'state']).where('connector', '=', 'jira').where('state', 'is not', null).execute();
    return rows.length === 2 ? rows : undefined;
  });
  const stateOf = (person: string): string => states.find(row => row.person_id === person)?.state ?? 'unchecked';
  const causes = await world.db
    .selectFrom('credential_check')
    .innerJoin('credential', 'credential.id', 'credential_check.credential_id')
    .select(['credential.person_id', 'credential_check.cause'])
    .where('credential.connector', '=', 'jira')
    .execute();
  return [
    expect(
      'the engine checks the real Jira login as valid and the made-up one as invalid',
      stateOf(world.creator) === 'valid' && stateOf(world.runAs) === 'invalid',
      `real: ${stateOf(world.creator)}; made-up: ${stateOf(world.runAs)}; causes: ${causes.map(row => row.cause ?? 'none').join(' | ')}`,
    ),
  ];
}

async function pages(world: World): Promise<readonly Check[]> {
  for (let filed = 0; filed < 3; filed += 1) await fileTicket(world, 'pages');
  await searchable(world, 3);
  const routine = await addRoutine(world, { pageSize: 2 });
  world.start();
  const run = await finishedRun(world, routine, 1);
  const tasks = await tasksOf(world, world.filed);
  return [expect('a search with a page size of 2 records all 3 probe tickets', run.found === 3 && tasks.length === 3, `${describeRun(run)}; tasks: ${tasks.map(task => task.key).join(', ')}`)];
}

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.POSITIVE_INFINITY;

async function perf(world: World): Promise<readonly Check[]> {
  for (let filed = 0; filed < 10; filed += 1) await fileTicket(world, 'perf');
  await searchable(world, 10);
  const routine = await addRoutine(world);
  world.start();
  const runs: Run[] = [];
  const comments: number[] = [];
  for (let round = 1; round <= 3; round += 1) {
    if (round > 1) await press(world, routine);
    runs.push(await finishedRun(world, routine, round));
    const [first] = world.filed;
    const task = await taskOf(world, first ?? '');
    const row = await settledRow(world, (await owe(world, task.id, actionKinds.ticketComment.kind, { ticket: task.key, text: `AutoWorker perf probe comment ${String(round)}.`, linkPullRequest: false })).row);
    comments.push(row.ms ?? Number.POSITIVE_INFINITY);
  }
  const slowest = Math.max(...runs.map(run => run.ms));
  const commentMedian = median(comments);
  return [
    expect(`each routine run over 10 tickets takes at most ${String(perfBudget.runMs / 1000)} s`, runs.every(run => run.found === 10) && slowest <= perfBudget.runMs, runs.map(run => `${describeRun(run)} in ${run.ms.toFixed(0)} ms`).join('; ')),
    expect(`the median comment row takes at most ${String(perfBudget.commentMs / 1000)} s from owed to done`, commentMedian <= perfBudget.commentMs, `${comments.map(ms => `${ms.toFixed(0)} ms`).join(', ')}; median ${commentMedian.toFixed(0)} ms, which includes up to 500 ms of the outbox's poll`),
  ];
}

const lanes: Readonly<Record<LaneName, (world: World, statuses: Statuses) => Promise<readonly Check[]>>> = {
  flow,
  twice: world => twice(world),
  assignee: world => assignee(world),
  'search-identity': world => searchIdentity(world),
  restart: world => restart(world, false),
  'no-marker': world => restart(world, true),
  'same-status': sameStatus,
  check: world => check(world),
  pages: world => pages(world),
  perf: world => perf(world),
};

const laneName = z.enum(laneNames);

export async function liveLanes(lane: string, statuses: Statuses): Promise<readonly Check[]> {
  const chosen = laneName.safeParse(lane);
  if (!chosen.success) return [fail('the lane exists', `${lane} is not one of ${laneNames.join(', ')}`)];
  return withWorld(async world => {
    const started = performance.now();
    const checks = await lanes[chosen.data](world, statuses).catch((error: unknown) => [fail(`lane ${chosen.data} runs to completion`, messageOf(error))]);
    return [...checks, pass('probe tickets filed, each labeled as a test', `${world.filed.join(', ') || 'none'} with the labels ${testLabel} and ${world.label}, in ${((performance.now() - started) / 1000).toFixed(0)} s`)];
  });
}
