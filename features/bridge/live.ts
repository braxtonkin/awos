import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { sql, type RawBuilder } from 'kysely';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import { reduce, type Item } from '../../shared/items.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { withPostgres, type TestPostgres } from '../../tools/verify/postgres.ts';
import { bridgeListener, deliveries, issueToken, numberCommand, rules, sendCommand, type BridgeEngine, type Delivery, type Finish } from './engine.ts';
import { runBridge, type AfterTurn, type BridgeSettings, type Ending } from './job.ts';
import { attemptId, bridgeRequestIds, headers, pinned, protocolVersion, type AttemptId, type Line } from './protocol.ts';

type Tapped = { readonly at: number; readonly text: string };

type EngineHandle = { readonly url: URL; readonly up: () => Promise<void>; readonly down: () => Promise<void> };

type World = {
  readonly db: Database;
  readonly url: string;
  readonly attempt: AttemptId;
  readonly token: string;
  readonly engine: EngineHandle;
  readonly dir: string;
  readonly workspace: string;
  readonly codexHome: string;
  readonly tapFile: string;
};

type Run = { readonly ending: Promise<Ending>; readonly log: string[] };

type Lane = { readonly summary: string; readonly usesCodex: boolean; readonly run: (world: World) => Promise<readonly Check[]> };

const loginPath = '/codex/auth.json';
const leaseMs = 60_000;
const turnTimeoutMs = 240_000;
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const tickPrompt = (seconds: number): string =>
  `Run exactly this shell command once and wait for it to finish: for i in $(seq 1 ${String(seconds)}); do echo tick $i; sleep 1; done. Then reply with the single word done.`;

const parseJson = (text: string): unknown => JSON.parse(text);

const laneFinish: Finish = async (writer, attempt, now) => {
  const rows = await writer.selectFrom('attempt_event').select('body').where('attempt_id', '=', attempt).where('kind', '=', 'app').orderBy('seq').execute();
  const items = reduce(rows);
  const last = items.items.findLast(item => item.type === 'agentMessage' && item.completed);
  await writer
    .updateTable('attempt')
    .set({ finished_at: now, verdict: 'pass', output: JSON.stringify({ finalMessage: last?.text ?? null }) })
    .where('id', '=', attempt)
    .execute();
};

const worldRows = (now: Date) => [
  sql`insert into person (email, name, jira_account_id) values ('ada@example.com', 'Ada', 'acc-ada')`,
  sql`with saved as (
        insert into human_action (id, at, person_id, kind, repository_id) values ('00000000-0000-4000-8000-000000000009', ${now}, 1, 'add_repository', 1) returning id)
      insert into repository (github, branch, saved_by) select 'example/sandbox', 'main', id from saved`,
  sql`insert into routine (creator_id, run_as_id) values (1, 1)`,
  sql`insert into human_action (id, at, person_id, kind, routine_id) values ('00000000-0000-4000-8000-000000000001', ${now}, 1, 'edit_routine', 1)`,
  sql`insert into routine_version (routine_id, version, name, goal, repository_id, action_id, workflow, source, needs_repository, gates)
      values (1, 1, 'Bridge lane', 'Run one turn behind the bridge.', 1, '00000000-0000-4000-8000-000000000001', 'code-change', '{"kind": "jira-search"}', true, '{}')`,
  sql`insert into task (routine_id, found_version, repository_id, key, title, found_at, assignee_account_id, workflow, needs_repository, step)
      values (1, 1, 1, 'LANE-1', 'Bridge lane', ${now}, 'acc-ada', 'code-change', true, 'specify')`,
  sql`insert into attempt (task_id, routine_id, routine_version, step, epoch, run_as_id, started_at, lease_until)
      values (1, 1, 1, 'specify', 0, 1, ${now}, ${new Date(now.getTime() + leaseMs)})`,
  sql`create table lane_stored (id bigint generated always as identity primary key, seq bigint not null, fragment boolean not null, body jsonb not null)`,
  sql`create function lane_remember() returns trigger language plpgsql as $$
      begin
        insert into lane_stored (seq, fragment, body) values (new.seq, new.fragment, new.body);
        return new;
      end
      $$`,
  sql`create trigger lane_remember after insert on attempt_event for each row execute function lane_remember()`,
];

function engineHandle(db: Database, engine: BridgeEngine): EngineHandle {
  let server: Server | undefined;
  let stop = new AbortController();
  let port = 0;
  const url = new URL('http://127.0.0.1/');
  return {
    url,
    up: async () => {
      stop = new AbortController();
      const made = createServer(bridgeListener(db, engine, { pollMs: 100, keepAliveMs: 1000, bodyLimitBytes: 64 * 1024 * 1024, stop: stop.signal }));
      await new Promise<void>(resolve => made.listen(port, '127.0.0.1', resolve));
      const address = made.address();
      if (typeof address === 'object' && address !== null) port = address.port;
      url.port = String(port);
      server = made;
    },
    down: async () => {
      stop.abort();
      const closing = server;
      server = undefined;
      if (closing === undefined) return;
      const closed = new Promise<void>(resolve => closing.close(() => { resolve(); }));
      closing.closeAllConnections();
      await closed;
    },
  };
}

const tapScript = (tapFile: string): string => `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const child = spawn('codex', process.argv.slice(2), { stdio: ['inherit', 'pipe', 'inherit'] });
createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', text => {
  appendFileSync(${JSON.stringify(tapFile)}, JSON.stringify({ at: Date.now(), text }) + '\\n');
  process.stdout.write(text + '\\n');
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 1));
`;

async function withWorld<T>(postgres: TestPostgres, planted: string | undefined, work: (world: World) => Promise<T>): Promise<T> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 8);
  const dir = await mkdtemp(join(tmpdir(), 'bridge-lane-'));
  try {
    for (const statement of worldRows(new Date())) await statement.execute(db);
    const attempt = attemptId.parse('1');
    const token = await issueToken(db, attempt);
    if (token === undefined) throw new Error('the attempt took no bridge token');
    const workspace = join(dir, 'workspace');
    const codexHome = join(dir, 'codex-home');
    await mkdir(workspace, { recursive: true });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    spawnSync('git', ['init', '--quiet', workspace]);
    await writeFile(join(workspace, 'README.md'), 'A scratch workspace for a bridge lane.\n');
    if (planted !== undefined) {
      await mkdir(join(workspace, '.codex'), { recursive: true });
      await writeFile(join(workspace, '.codex', 'config.toml'), planted);
    }
    const tapFile = join(dir, 'tap.jsonl');
    await writeFile(join(dir, 'codex-tap.cjs'), tapScript(tapFile), { mode: 0o755 });
    const engine = engineHandle(db, { leaseMs, finish: laneFinish, now: () => new Date(), rules });
    await engine.up();
    try {
      return await work({ db, url: scratch.url, attempt, token, engine, dir, workspace, codexHome, tapFile });
    } finally {
      await engine.down();
    }
  } finally {
    await db.destroy();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    await scratch.drop();
  }
}

async function useLogin(world: World): Promise<string | undefined> {
  const text = await readFile(loginPath, 'utf8').catch(() => undefined);
  if (text === undefined) return `${loginPath} could not be read, so no Codex turn ran. Run this lane in the live service.`;
  const parsed = z.looseObject({ tokens: z.looseObject({ refresh_token: z.string().optional() }) }).safeParse(parseJson(text));
  if (!parsed.success) return `${loginPath} is not a Codex login`;
  if ((parsed.data.tokens.refresh_token ?? '').trim() !== '') return `${loginPath} holds a refresh token, so the lane refuses to run Codex with it`;
  await copyFile(loginPath, join(world.codexHome, 'auth.json'));
  await chmod(join(world.codexHome, 'auth.json'), 0o600);
  return undefined;
}

function settingsFor(world: World, overrides: Partial<BridgeSettings> = {}): BridgeSettings {
  return {
    engineUrl: world.engine.url,
    attempt: world.attempt,
    token: world.token,
    image: 'autoworker/attempt:lane',
    workspace: world.workspace,
    codexHome: world.codexHome,
    codexUser: undefined,
    codexCommand: join(world.dir, 'codex-tap.cjs'),
    heartbeatMs: 1000,
    callTimeoutMs: 5000,
    retryMs: 250,
    streamQuietMs: 4000,
    stopGraceMs: 2000,
    ...overrides,
  };
}

function startBridge(world: World, afterTurn: AfterTurn = () => Promise.resolve(undefined), overrides: Partial<BridgeSettings> = {}): Run {
  const log: string[] = [];
  const ending = runBridge(settingsFor(world, overrides), afterTurn, line => log.push(`${new Date().toISOString()} ${line}`));
  return { ending, log };
}

async function tapped(world: World): Promise<readonly Tapped[]> {
  const text = await readFile(world.tapFile, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(row => row !== '')
    .map(row => z.object({ at: z.number(), text: z.string() }).parse(parseJson(row)));
}

async function until(ms: number, done: () => Promise<boolean>): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await done()) return true;
    await wait(100);
  }
  return done();
}

const storedWhere = async (world: World, condition: RawBuilder<boolean>): Promise<number> => {
  const { rows } = await sql<{ n: number }>`select count(*)::int as n from lane_stored where ${condition}`.execute(world.db);
  return rows[0]?.n ?? 0;
};

const commandStarted = (world: World): Promise<boolean> =>
  storedWhere(world, sql<boolean>`body->>'method' = 'item/started' and body->'params'->'item'->>'type' = 'commandExecution'`).then(n => n > 0);

type Tally = { readonly emitted: number; readonly stored: number; readonly lost: readonly number[]; readonly duplicated: readonly number[]; readonly changed: readonly number[]; readonly fragmentsLeft: number };

async function tally(world: World): Promise<Tally> {
  const lines = await tapped(world);
  const { rows: history } = await sql<{ seq: string; body: unknown }>`select seq, body from lane_stored order by id`.execute(world.db);
  const endRows = await world.db.selectFrom('attempt_event').select('seq').where('attempt_id', '=', world.attempt).where('kind', '!=', 'app').execute();
  const emitted = lines.length + endRows.length;
  const times = new Map<number, number>();
  const bodies = new Map<number, unknown>();
  for (const row of history) {
    const seq = Number(row.seq);
    times.set(seq, (times.get(seq) ?? 0) + 1);
    bodies.set(seq, row.body);
  }
  const lost: number[] = [];
  const changed: number[] = [];
  for (let seq = 1; seq <= emitted; seq += 1) if (!times.has(seq)) lost.push(seq);
  lines.forEach((line, index) => {
    const body = bodies.get(index + 1);
    if (body !== undefined && !isDeepStrictEqual(body, parseJson(line.text))) changed.push(index + 1);
  });
  const left = await world.db.selectFrom('attempt_event').select(sql<number>`count(*)::int`.as('n')).where('attempt_id', '=', world.attempt).where('fragment', '=', true).executeTakeFirstOrThrow();
  return {
    emitted,
    stored: times.size,
    lost,
    duplicated: [...times].filter(([, count]) => count > 1).map(([seq]) => seq),
    changed,
    fragmentsLeft: left.n,
  };
}

const models = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) return value.flatMap(models);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => (key === 'model' && typeof inner === 'string' ? [inner, ...models(inner)] : models(inner)));
};

async function modelCheck(world: World): Promise<Check> {
  const { rows } = await sql<{ body: unknown }>`select body from lane_stored`.execute(world.db);
  const seen = [...new Set(rows.flatMap(row => models(row.body)))];
  const name = `every model the stored events name is ${pinned.model}`;
  return seen.length > 0 && seen.every(model => model === pinned.model) ? pass(name, `models seen: ${seen.join(', ')}`) : fail(name, `models seen: ${seen.join(', ') || 'none'}`);
}

async function endingCheck(run: Run, expect: 0 | 1, reason?: string): Promise<Check> {
  const ending = await Promise.race([run.ending, wait(turnTimeoutMs).then(() => undefined)]);
  const name = expect === 0 ? 'the bridge exits 0 once the engine stored its end line' : 'the Job side exits non-zero';
  if (ending === undefined) return fail(name, `the bridge did not stop within ${String(turnTimeoutMs / 1000)} s; log: ${run.log.join(' | ')}`);
  const said = 'reason' in ending ? ending.reason : 'ok';
  const matches = ending.code === expect && (reason === undefined || said.includes(reason));
  return matches ? pass(name, `code ${String(ending.code)}: ${said}`) : fail(name, `code ${String(ending.code)}: ${said}; log: ${run.log.join(' | ')}`);
}

function tallyChecks(counted: Tally): readonly Check[] {
  const tallyName = `lines stored ${String(counted.stored)}, lost ${String(counted.lost.length)}, duplicated ${String(counted.duplicated.length)}`;
  return [
    counted.lost.length === 0 && counted.duplicated.length === 0 && counted.stored === counted.emitted && counted.changed.length === 0
      ? pass(tallyName, `the bridge numbered ${String(counted.emitted)} lines, and each was stored exactly once with the text the app server wrote`)
      : fail(tallyName, `emitted ${String(counted.emitted)}; lost ${counted.lost.join(', ') || 'none'}; duplicated ${counted.duplicated.join(', ') || 'none'}; changed ${counted.changed.join(', ') || 'none'}`),
    counted.fragmentsLeft === 0 ? pass(`fragments left ${String(counted.fragmentsLeft)}`, 'every finished item pruned its fragments') : fail(`fragments left ${String(counted.fragmentsLeft)}`, 'a finished item kept fragment rows'),
  ];
}

const itemKey = (item: Item): string => JSON.stringify([item.id, item.type, item.text, item.completed, item.clientId]);

async function pruneAndReplayChecks(world: World): Promise<readonly Check[]> {
  const live = reduce((await tapped(world)).map(line => ({ body: parseJson(line.text) })));
  const stored = reduce(await world.db.selectFrom('attempt_event').select('body').where('attempt_id', '=', world.attempt).where('kind', '=', 'app').orderBy('seq').execute());
  const { rows: history } = await sql<{ seq: string; fragment: boolean; body: unknown }>`select seq, fragment, body from lane_stored order by seq`.execute(world.db);
  const joined = reduce(history.filter(row => row.fragment).map(row => ({ body: row.body })));
  const finals = new Map(stored.items.map(item => [item.id, item]));
  const compared = joined.items.map(item => ({ item, final: finals.get(item.id) }));
  const mismatched = compared.filter(({ item, final }) => final === undefined || !final.completed || final.text !== item.text);
  const byType = [...new Set(compared.map(({ final }) => final?.type ?? 'missing'))];
  const sameSteps = isDeepStrictEqual(live.items.map(itemKey), stored.items.map(itemKey)) && isDeepStrictEqual(live.turns, stored.turns);
  const replayName = 'the stored lines replay through shared/items.ts into the same items and turns the live stream produced, one for one';
  const joinName = "each finished item's stored text equals its fragments joined before the prune";
  return [
    sameSteps ? pass(replayName, `${String(stored.items.length)} items in ${String(stored.turns.length)} turns`) : fail(replayName, `live ${JSON.stringify(live.items.map(itemKey))}; stored ${JSON.stringify(stored.items.map(itemKey))}`),
    compared.length > 0 && mismatched.length === 0
      ? pass(joinName, `${String(compared.length)} items with fragments, of types ${byType.join(', ')}`)
      : fail(joinName, compared.length === 0 ? 'no item streamed fragments' : mismatched.map(({ item, final }) => `${item.id} (${final?.type ?? 'missing'}): fragments ${JSON.stringify(item.text.slice(0, 200))} vs final ${JSON.stringify(final?.text.slice(0, 200))}`).join('; ')),
  ];
}

async function outageLane(world: World, outageMs: number): Promise<readonly Check[]> {
  await sendCommand(world.db, world.attempt, { kind: 'turn.start', prompt: tickPrompt(Math.ceil(outageMs / 1000) + 8), outputSchema: null }, new Date());
  const run = startBridge(world);
  const started = await until(120_000, () => commandStarted(world));
  if (!started) return [fail('the turn starts a shell command', `no commandExecution item was stored within 120 s; log: ${run.log.join(' | ')}`)];
  const before = (await tapped(world)).length;
  await world.engine.down();
  const downAt = Date.now();
  await wait(outageMs);
  const whileDown = (await tapped(world)).filter(line => line.at >= downAt).length;
  await world.engine.up();
  const upAt = Date.now();
  const ended = await endingCheck(run, 0);
  const counted = await tally(world);
  const resent = run.log.filter(line => line.includes('posting works again'));
  return [
    ended,
    pass(`the engine was down for ${String(outageMs / 1000)} s mid-turn`, `${String(before)} lines before the outage, ${String(whileDown)} written while the engine was down, and the bridge said: ${resent.join(' | ') || 'nothing about a failure'}; restarted at ${new Date(upAt).toISOString()}`),
    ...tallyChecks(counted),
    await modelCheck(world),
  ];
}

const plantedConfig = ['model = "no-such-model-probe"', 'model_reasoning_effort = "high"', 'approval_policy = "on-request"', 'sandbox_mode = "read-only"', ''].join('\n');

const threadStartResult = z.object({
  result: z.looseObject({ model: z.string(), reasoningEffort: z.string().nullable(), approvalPolicy: z.unknown(), sandbox: z.looseObject({ type: z.string() }) }),
});

async function rawThreadStart(world: World): Promise<unknown> {
  const child: ChildProcess = spawn('codex', ['app-server', '--listen', 'stdio://'], {
    cwd: world.workspace,
    env: { PATH: process.env['PATH'] ?? '', HOME: world.codexHome, CODEX_HOME: world.codexHome },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const { stdin, stdout } = child;
  if (stdin === null || stdout === null) throw new Error('codex app-server has no pipes');
  const answers = new Map<string, unknown>();
  createInterface({ input: stdout }).on('line', text => {
    const parsed = z.looseObject({ id: z.string().optional() }).safeParse(parseJson(text));
    if (parsed.success && parsed.data.id !== undefined) answers.set(parsed.data.id, parsed.data);
  });
  try {
    stdin.write(`${JSON.stringify({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'bridge-lane-control', version: '1' }, capabilities: null } })}\n`);
    await until(30_000, () => Promise.resolve(answers.has('init')));
    stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
    stdin.write(`${JSON.stringify({ id: 'start', method: 'thread/start', params: { cwd: world.workspace } })}\n`);
    await until(30_000, () => Promise.resolve(answers.has('start')));
    return answers.get('start');
  } finally {
    child.kill('SIGTERM');
  }
}

async function plantedLane(world: World): Promise<readonly Check[]> {
  await writeFile(join(world.codexHome, 'config.toml'), `[projects.${JSON.stringify(world.workspace)}]
trust_level = "trusted"
`);
  const control = threadStartResult.safeParse(await rawThreadStart(world));
  await sendCommand(world.db, world.attempt, { kind: 'turn.start', prompt: 'Reply with the single word ack.', outputSchema: null }, new Date());
  const run = startBridge(world);
  const ended = await endingCheck(run, 0);
  const response = await world.db
    .selectFrom('attempt_event')
    .select('body')
    .where('attempt_id', '=', world.attempt)
    .where(sql<string>`body->>'id'`, '=', bridgeRequestIds.threadStart)
    .executeTakeFirst();
  const pinnedThread = threadStartResult.safeParse(response?.body);
  const turn = await storedWhere(world, sql<boolean>`body->>'method' = 'turn/completed' and body->'params'->'turn'->>'status' = 'completed'`);
  const controlName = 'with no pins, the planted .codex/config.toml in the trusted workspace sets the thread, so the file loads';
  const pinName = `with the bridge's pins, the thread runs ${pinned.model} with effort ${pinned.effort}, approval policy ${pinned.approvalPolicy}, and sandbox dangerFullAccess`;
  const got = pinnedThread.success ? pinnedThread.data.result : undefined;
  return [
    control.success && control.data.result.model === 'no-such-model-probe' && control.data.result.reasoningEffort === 'high'
      ? pass(controlName, `unpinned thread/start took model ${control.data.result.model} and effort ${control.data.result.reasoningEffort}`)
      : fail(controlName, JSON.stringify(control.success ? control.data.result : control.error.issues).slice(0, 500)),
    got !== undefined && got.model === pinned.model && got.reasoningEffort === pinned.effort && got.approvalPolicy === pinned.approvalPolicy && got.sandbox.type === 'dangerFullAccess'
      ? pass(pinName, JSON.stringify({ model: got.model, reasoningEffort: got.reasoningEffort, approvalPolicy: got.approvalPolicy, sandbox: got.sandbox.type }))
      : fail(pinName, JSON.stringify(got ?? response?.body ?? 'no thread/start response stored').slice(0, 500)),
    turn === 1 ? pass('the pinned turn completes', 'one turn/completed with status completed') : fail('the pinned turn completes', `${String(turn)} completed turns`),
    ended,
    await modelCheck(world),
  ];
}

async function steerLane(world: World): Promise<readonly Check[]> {
  await sendCommand(world.db, world.attempt, { kind: 'turn.start', prompt: tickPrompt(20), outputSchema: null }, new Date());
  const run = startBridge(world);
  if (!(await until(120_000, () => commandStarted(world)))) return [fail('the turn starts a shell command', run.log.join(' | '))];
  const sent = await sendCommand(world.db, world.attempt, { kind: 'turn.steer', message: 'When the command finishes, end your reply with the word banana.' }, new Date());
  if (sent === 'ended') return [fail('the steer is stored', 'the attempt had ended')];
  const seen: Delivery[] = [];
  await until(60_000, async () => {
    const state = (await deliveries(world.db, world.attempt)).find(entry => entry.seq === sent.seq)?.delivery;
    if (state !== undefined && seen.at(-1) !== state) seen.push(state);
    return state === 'acted on';
  });
  const ended = await endingCheck(run, 0);
  const { rows: userItems } = await sql<{ seq: string; item: string; method: string }>`
    select seq, body->'params'->'item'->>'id' as item, body->>'method' as method from lane_stored
    where body->'params'->'item'->>'clientId' = ${sent.clientMessageId ?? ''} order by seq`.execute(world.db);
  const itemIds = [...new Set(userItems.map(row => row.item))];
  const firstSeq = Number(userItems[0]?.seq ?? Number.MAX_SAFE_INTEGER);
  const after = await storedWhere(world, sql<boolean>`seq > ${firstSeq} and body->>'method' = 'item/completed' and body->'params'->'item'->>'type' = 'agentMessage'`);
  const writes = (await tapped(world)).length;
  const stamps = await world.db.selectFrom('attempt_command').select(['sent_at', 'received_at', 'acted_at']).where('attempt_id', '=', world.attempt).where('seq', '=', String(sent.seq)).executeTakeFirst();
  return [
    stamps !== undefined && stamps.received_at !== null && stamps.acted_at !== null && stamps.sent_at <= stamps.received_at && stamps.received_at <= stamps.acted_at && seen.at(-1) === 'acted on'
      ? pass('the steer reads sent, then received, then acted on', `polled ${seen.join(' -> ')}; sent ${stamps.sent_at.toISOString()}, received ${stamps.received_at.toISOString()}, acted on ${stamps.acted_at.toISOString()}`)
      : fail('the steer reads sent, then received, then acted on', `polled ${seen.join(' -> ') || 'nothing'}; ${JSON.stringify(stamps)}`),
    itemIds.length === 1 ? pass('the app server took the steer once, as one userMessage item carrying the command id', `item ${itemIds[0] ?? ''}, lines ${userItems.map(row => `${row.seq} ${row.method}`).join(', ')}`) : fail('the app server took the steer once, as one userMessage item carrying the command id', `items ${itemIds.join(', ') || 'none'}`),
    after > 0 ? pass("the agent's next message follows the steer", `${String(after)} agent messages completed after line ${String(firstSeq)} of ${String(writes)}`) : fail("the agent's next message follows the steer", 'no agent message after it'),
    ended,
  ];
}

async function stopLane(world: World): Promise<readonly Check[]> {
  await sendCommand(world.db, world.attempt, { kind: 'turn.start', prompt: tickPrompt(40), outputSchema: null }, new Date());
  const run = startBridge(world);
  if (!(await until(120_000, () => commandStarted(world)))) return [fail('the turn starts a shell command', run.log.join(' | '))];
  const stoppedAt = Date.now();
  const stopped = await world.db.transaction().execute(async writer => {
    const command = await numberCommand(writer, world.attempt, { kind: 'turn.stop' }, new Date());
    await writer.updateTable('attempt').set({ finished_at: new Date(), verdict: 'stopped' }).where('id', '=', world.attempt).execute();
    return command;
  });
  const ended = await endingCheck(run, 1, 'ended');
  const lines = await tapped(world);
  const interrupted = lines.find(line => line.at >= stoppedAt && /"method":"turn\/completed"/.test(line.text) && /"status":"interrupted"/.test(line.text));
  const row = await world.db.selectFrom('attempt').select(['verdict']).where('id', '=', world.attempt).executeTakeFirstOrThrow();
  const withinName = 'turn/completed arrives as interrupted within 1 s of the stop';
  return [
    stopped === 'ended' ? fail('the engine sends turn.stop', 'the attempt had ended') : pass('the engine sends turn.stop', `command ${String(stopped.seq)}, stored with the stop in one transaction`),
    interrupted !== undefined && interrupted.at - stoppedAt <= 1000 ? pass(withinName, `${String(interrupted.at - stoppedAt)} ms`) : fail(withinName, interrupted === undefined ? 'no interrupted turn/completed' : `${String(interrupted.at - stoppedAt)} ms`),
    row.verdict === 'stopped' ? pass('the attempt ends stopped', 'verdict stopped') : fail('the attempt ends stopped', `verdict ${String(row.verdict)}`),
    ended,
  ];
}

async function fenceLane(world: World): Promise<readonly Check[]> {
  await sendCommand(world.db, world.attempt, { kind: 'turn.start', prompt: tickPrompt(30), outputSchema: null }, new Date());
  const run = startBridge(world);
  if (!(await until(120_000, () => commandStarted(world)))) return [fail('the turn starts a shell command', run.log.join(' | '))];
  await world.db.updateTable('attempt').set({ finished_at: new Date(), verdict: 'lost' }).where('id', '=', world.attempt).execute();
  const storedAtLoss = await storedWhere(world, sql<boolean>`true`);
  const ended = await endingCheck(run, 1, 'ended');
  await wait(2000);
  const storedLater = await storedWhere(world, sql<boolean>`true`);
  const written = (await tapped(world)).length;
  return [
    ended,
    storedLater === storedAtLoss
      ? pass('nothing more is stored once the attempt is lost', `${String(storedAtLoss)} lines stored, of ${String(written)} the app server wrote`)
      : fail('nothing more is stored once the attempt is lost', `${String(storedAtLoss)} at the loss, ${String(storedLater)} later`),
  ];
}

async function post(world: World, lines: readonly Line[], overrides: Partial<Record<'token' | 'protocol' | 'pid' | 'image', string>> = {}): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(new URL('events', world.engine.url), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${overrides.token ?? world.token}`,
      [headers.attempt]: world.attempt,
      [headers.protocol]: overrides.protocol ?? String(protocolVersion),
      [headers.pid]: overrides.pid ?? '4242',
      [headers.image]: overrides.image ?? 'autoworker/attempt:lane',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ received: 0, lines }),
  });
  return { status: response.status, body: await response.json() };
}

const appLine = (seq: number): Line => ({ seq, kind: 'app', text: JSON.stringify({ method: 'probe', params: { seq } }) });

async function wireLane(world: World): Promise<readonly Check[]> {
  const rowsNow = async (): Promise<number> => storedWhere(world, sql<boolean>`true`);
  const first = await post(world, [appLine(1), appLine(2), appLine(3)]);
  const replay = await post(world, [appLine(1), appLine(2), appLine(3)]);
  const afterReplay = await rowsNow();
  const gap = await post(world, [appLine(4), appLine(6), appLine(7)]);
  const afterGap = await rowsNow();
  const resend = await post(world, [appLine(5), appLine(6), appLine(7)]);
  const other = await post(world, [appLine(8)], { pid: '4343' });
  const wrongToken = await post(world, [appLine(8)], { token: 'x'.repeat(43) });
  const protocol = await post(world, [appLine(8)], { protocol: String(protocolVersion + 1), image: 'registry.example/attempt@sha256:abc' });
  const expect = (name: string, ok: boolean, detail: unknown): Check => (ok ? pass(name, JSON.stringify(detail)) : fail(name, JSON.stringify(detail)));
  const said = (body: unknown): string => z.object({ reason: z.string() }).safeParse(body).data?.reason ?? '';
  return [
    expect('a first batch of lines 1 to 3 is stored and acknowledged as 3', first.status === 200 && isDeepStrictEqual(first.body, { stored: 3 }), first),
    expect('a replay of the stored batch adds no row and leaves the acknowledgement at 3', replay.status === 200 && isDeepStrictEqual(replay.body, { stored: 3 }) && afterReplay === 3, { replay, rows: afterReplay }),
    expect('a batch that skips line 5 stores up to the gap and acknowledges 4', gap.status === 200 && isDeepStrictEqual(gap.body, { stored: 4 }) && afterGap === 4, { gap, rows: afterGap }),
    expect('the resend from line 5 stores the rest and acknowledges 7', resend.status === 200 && isDeepStrictEqual(resend.body, { stored: 7 }), resend),
    expect('a call from a second bridge process is refused', other.status === 409 && z.object({ refused: z.literal('process') }).safeParse(other.body).success, other),
    expect("a call with another attempt's token is refused", wrongToken.status === 401, wrongToken),
    expect('a bridge with another protocol number is refused, and the reason names its image', protocol.status === 426 && said(protocol.body).includes('registry.example/attempt@sha256:abc'), protocol),
  ];
}

async function longOutageLane(world: World): Promise<readonly Check[]> {
  const lease = 3000;
  const engineMain = join(repoRoot, 'services', 'engine', 'main.ts');
  const startEngine = (): ChildProcess =>
    spawn(process.execPath, [engineMain], { env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: world.url, LEASE_MS: String(lease), REAPER_EVERY_MS: '500', BRIDGE_PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const said: string[] = [];
  const listen = (child: ChildProcess): void => {
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => said.push(chunk.trim()));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => said.push(chunk.trim()));
  };
  const stopEngine = async (child: ChildProcess): Promise<void> => {
    const exited = new Promise<void>(resolve => child.on('exit', () => { resolve(); }));
    child.kill('SIGTERM');
    await exited;
  };
  let reaper = startEngine();
  listen(reaper);
  await sendCommand(world.db, world.attempt, { kind: 'turn.start', prompt: tickPrompt(20), outputSchema: null }, new Date());
  const run = startBridge(world);
  if (!(await until(120_000, () => commandStarted(world)))) return [fail('the turn starts a shell command', run.log.join(' | '))];
  await world.engine.down();
  await stopEngine(reaper);
  const outageMs = 2 * lease + 1500;
  await wait(outageMs);
  reaper = startEngine();
  listen(reaper);
  await world.engine.up();
  const ended = await endingCheck(run, 0);
  await stopEngine(reaper);
  const row = await world.db.selectFrom('attempt').select(['verdict']).where('id', '=', world.attempt).executeTakeFirstOrThrow();
  const counted = await tally(world);
  return [
    pass(`the engine and its reaper were down for ${String(outageMs)} ms, more than two ${String(lease)} ms leases`, said.filter(line => line.includes('gave')).join(' | ')),
    row.verdict === 'pass' ? pass('the attempt was not reaped, and it finished through its end line', 'verdict pass') : fail('the attempt was not reaped, and it finished through its end line', `verdict ${String(row.verdict)}; engine said ${said.join(' | ')}`),
    ...tallyChecks(counted),
    ended,
  ];
}

const lanes: Readonly<Record<string, Lane>> = {
  outage: {
    summary: 'one real turn with the engine stopped for 8 s mid-turn; every line stored once, no fragment left, and the stored lines replay into the live items',
    usesCodex: true,
    run: async world => [...(await outageLane(world, 8000)), ...(await pruneAndReplayChecks(world))],
  },
  'long-outage': { summary: 'the engine and its reaper stopped for longer than two lease periods mid-turn', usesCodex: true, run: longOutageLane },
  steer: { summary: 'a steering message mid-turn goes sent, received, acted on', usesCodex: true, run: steerLane },
  stop: { summary: 'a stop mid-turn sends turn.stop and the turn ends interrupted', usesCodex: true, run: stopLane },
  wire: { summary: 'a replayed batch, a gap, a second process, a wrong token, and a protocol mismatch, over HTTP', usesCodex: false, run: wireLane },
  planted: { summary: 'a planted .codex/config.toml changes nothing the bridge pins', usesCodex: true, run: plantedLane },
  fence: { summary: 'an attempt marked lost mid-turn stores nothing more, and its Job side exits non-zero', usesCodex: true, run: fenceLane },
};

export const liveScenarios: readonly Scenario[] = [
  {
    name: 'bridge-live',
    summary: `runs the real codex app-server behind the bridge against an engine on real Postgres; --lane picks one of ${Object.keys(lanes).join(', ')} (default outage)`,
    run: args => {
      const { values } = parseArgs({ args: [...args], options: { lane: { type: 'string', default: 'outage' } } });
      const lane = lanes[values.lane];
      if (lane === undefined) return Promise.resolve([fail('the lane exists', `no lane ${values.lane}; lanes: ${Object.keys(lanes).join(', ')}`)]);
      return withPostgres(postgres =>
        withWorld(postgres, values.lane === 'planted' ? plantedConfig : undefined, async world => {
          if (lane.usesCodex) {
            const refused = await useLogin(world);
            if (refused !== undefined) return [fail('an access-only Codex login is mounted', refused)];
          }
          return lane.run(world);
        }),
      );
    },
  },
];
