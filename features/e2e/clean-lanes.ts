import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { text } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { z } from 'zod';
import { connectCluster, labels, type Cluster } from '../../shared/cluster.ts';
import { connect, type Database } from '../../shared/db/client.ts';
import { checksOf, fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { kind } from '../../tools/verify/kind.ts';
import { withPostgres, type TestPostgres } from '../../tools/verify/postgres.ts';
import { cleanChecks, leftovers, type CleanSources, type Leftover, type Place } from './clean.ts';
import { githubFromEnvironment } from './github.ts';
import { jiraAt } from './jira.ts';
import { PayloadRejected } from './payload.ts';
import { linksFrom, renderReport, stepRuns, tokenUsageMethod, type StepRun } from './report.ts';

const ticket = 'CLEAN-1';
const t0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (seconds: number): Date => new Date(t0 + seconds * 1000);

type Line = { readonly kind: 'app' | 'pushed' | 'end'; readonly method: string | null; readonly itemId: string | null; readonly fragment: boolean; readonly body: unknown };

type AttemptPlan = { readonly step: string; readonly from: number; readonly to: number; readonly inputTokens: number | undefined };

const attemptPlans: readonly AttemptPlan[] = [
  { step: 'specify', from: 0, to: 60, inputTokens: 1200 },
  { step: 'implement', from: 60, to: 360, inputTokens: 5400 },
  { step: 'verify', from: 360, to: 480, inputTokens: 2300 },
  { step: 'land', from: 480, to: 500, inputTokens: undefined },
];

const app = (method: string, params: unknown, itemId: string | null = null, fragment = false): Line => ({ kind: 'app', method, itemId, fragment, body: { method, params } });

function transcript(plan: AttemptPlan): readonly Line[] {
  if (plan.inputTokens === undefined) return [];
  const turnId = `turn-${plan.step}`;
  const item = (id: string, type: string, extra: object) => ({ turnId, item: { id, type, ...extra } });
  return [
    app('turn/started', { turn: { id: turnId } }),
    app('item/started', item('u-1', 'userMessage', { content: [] }), 'u-1'),
    app('item/completed', item('u-1', 'userMessage', { content: [{ type: 'text', text: `Run ${plan.step}.` }] }), 'u-1'),
    app('item/started', item('a-1', 'agentMessage', { text: '' }), 'a-1'),
    app('item/agentMessage/delta', { turnId, itemId: 'a-1', delta: 'Do' }, 'a-1', true),
    app('item/agentMessage/delta', { turnId, itemId: 'a-1', delta: 'ne.' }, 'a-1', true),
    app('item/completed', item('a-1', 'agentMessage', { text: 'Done.' }), 'a-1'),
    app(tokenUsageMethod, { threadId: 'thread-1', turnId, tokenUsage: { total: { inputTokens: plan.inputTokens, cachedInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 0, totalTokens: plan.inputTokens + 40 }, last: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningOutputTokens: 0, totalTokens: 2 } } }),
    app('turn/completed', { turn: { id: turnId, status: 'completed' } }),
    { kind: 'pushed', method: null, itemId: null, fragment: false, body: { commit: 'a'.repeat(40), branch: `autoworker/${ticket}-attempt-1` } },
    { kind: 'end', method: null, itemId: null, fragment: false, body: {} },
  ];
}

type World = {
  readonly lines: (plan: AttemptPlan) => readonly Line[];
  readonly prune: boolean;
  readonly after: (db: Database, attempts: readonly string[]) => Promise<unknown>;
  readonly onGitHub: readonly string[];
};

const taskBranch = `autoworker/${ticket}`;

const attemptBranch = (index: number): string => `${taskBranch}-attempt-${String(index + 1)}`;

const cleanWorld: World = { lines: transcript, prune: true, after: () => Promise.resolve(), onGitHub: ['e2e/run-clean', 'autoworker/CLEAN-10', 'autoworker/CLEAN-10-attempt-1'] };

async function seed(db: Database, world: World): Promise<readonly string[]> {
  const person = (await db.insertInto('person').values({ email: 'owner@example.com', name: 'Owner', jira_account_id: 'owner-account' }).returning('id').executeTakeFirstOrThrow()).id;
  const saving = '00000000-0000-4000-8000-000000000001';
  const editing = '00000000-0000-4000-8000-000000000002';
  await sql`with saved as (insert into human_action (id, at, person_id, kind, repository_id) values (${saving}, ${at(0)}, ${person}, 'add_repository', 1) returning id)
            insert into repository (github, branch, saved_by) select 'example/sandbox', 'main', id from saved`.execute(db);
  const routine = (await db.insertInto('routine').values({ creator_id: person, run_as_id: person }).returning('id').executeTakeFirstOrThrow()).id;
  await db.insertInto('human_action').values({ id: editing, at: at(0), person_id: person, kind: 'edit_routine', routine_id: routine }).execute();
  await sql`insert into routine_version (routine_id, version, name, goal, repository_id, action_id, workflow, source, needs_repository, gates)
            values (${routine}, 1, 'Clean', 'Leave nothing behind.', 1, ${editing}, 'code-change', '{"kind": "jira-search"}', true, '{}')`.execute(db);
  const task = (
    await db
      .insertInto('task')
      .values({ routine_id: routine, found_version: 1, repository_id: '1', key: ticket, title: 'Clean', found_at: at(0), assignee_account_id: 'owner-account', workflow: 'code-change', needs_repository: true, step: 'specify' })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const attempts: string[] = [];
  for (const plan of attemptPlans) {
    await db.updateTable('task').set({ step: plan.step }).where('id', '=', task).execute();
    const attempt = (
      await db
        .insertInto('attempt')
        .values({
          task_id: task,
          routine_id: routine,
          routine_version: 1,
          step: plan.step,
          epoch: 0,
          run_as_id: person,
          started_at: at(plan.from),
          lease_until: at(plan.from + 30),
          ...(plan.inputTokens === undefined ? {} : { branch: attemptBranch(attempts.length), start_commit: 'b'.repeat(40) }),
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    attempts.push(attempt);
    const lines = world.lines(plan);
    for (const [index, line] of lines.entries()) {
      await db
        .insertInto('attempt_event')
        .values({ attempt_id: attempt, seq: String(index + 1), kind: line.kind, method: line.method, item_id: line.itemId, fragment: line.fragment, body: JSON.stringify(line.body), stored_at: at(plan.from + index) })
        .execute();
      if (world.prune && line.method === 'item/completed' && line.itemId !== null) {
        await db.deleteFrom('attempt_event').where('attempt_id', '=', attempt).where('item_id', '=', line.itemId).where('fragment', '=', true).execute();
      }
    }
    if (plan.step === 'verify') {
      await db
        .insertInto('verify_environment')
        .values({ attempt_id: attempt, provider: 'tests-only', recorded_at: at(plan.from), called_at: at(plan.from), result: JSON.stringify({ kind: 'workspace-ci' }), returned_at: at(plan.from + 1), stopped_at: at(plan.to) })
        .execute();
    }
    await db.updateTable('attempt').set({ high_water: String(lines.length), finished_at: at(plan.to), verdict: 'pass', output: JSON.stringify({}) }).where('id', '=', attempt).execute();
  }
  await db
    .insertInto('outbox')
    .values({ task_id: task, position: 1, kind: 'ticket.comment', payload: JSON.stringify({}), acts_as: person, idempotency_key: 'clean-world-comment-marker-1', owed_at: at(10), state: 'done', result: JSON.stringify({}), settled_at: at(11), tries: 1 })
    .execute();
  await db
    .insertInto('outbox')
    .values({ task_id: task, position: 2, kind: 'pr.open-draft', payload: JSON.stringify({ repository: 'example/sandbox', head: taskBranch, base: 'main', title: 'Clean', body: 'Clean' }), acts_as: person, idempotency_key: 'clean-world-open-draft-marker-2', owed_at: at(300), state: 'done', result: JSON.stringify({ number: 7, url: 'https://github.com/example/sandbox/pull/7' }), settled_at: at(301), tries: 1 })
    .execute();
  await world.after(db, attempts);
  return attempts;
}

type Plant = {
  readonly name: string;
  readonly world: World;
  readonly cluster?: (cluster: Cluster, attempts: readonly string[]) => Promise<unknown>;
  readonly expect: (attempts: readonly string[]) => { readonly place: Place; readonly name: string };
};

const verifyAttempt = (attempts: readonly string[]): string => attempts[2] ?? 'missing';

const plants: readonly Plant[] = [
  {
    name: 'a Secret labeled for a finished attempt',
    world: cleanWorld,
    cluster: (cluster, attempts) =>
      cluster.core.createNamespacedSecret({
        namespace: cluster.namespace,
        body: { metadata: { name: `autoworker-attempt-${verifyAttempt(attempts)}`, labels: { [labels.attempt]: verifyAttempt(attempts) } }, stringData: { PLANTED: 'yes' } },
      }),
    expect: attempts => ({ place: 'cluster', name: `Secret autoworker-attempt-${verifyAttempt(attempts)}` }),
  },
  {
    name: 'an owed outbox action',
    world: {
      ...cleanWorld,
      after: db =>
        db.insertInto('outbox').values({ task_id: '1', position: 3, kind: 'ticket.transition', payload: JSON.stringify({}), acts_as: '1', idempotency_key: 'clean-world-planted-owed-row', owed_at: at(600) }).execute(),
    },
    expect: () => ({ place: 'outbox', name: 'outbox row 3 (ticket.transition)' }),
  },
  {
    name: 'a gap in the stored events',
    world: { ...cleanWorld, after: (db, attempts) => db.deleteFrom('attempt_event').where('attempt_id', '=', verifyAttempt(attempts)).where('seq', '=', '1').execute() },
    expect: attempts => ({ place: 'events', name: `attempt ${verifyAttempt(attempts)} events 1` }),
  },
  {
    name: 'an item completed twice',
    world: { ...cleanWorld, lines: plan => (plan.step === 'verify' ? transcript(plan).flatMap(line => (line.method === 'item/completed' && line.itemId === 'a-1' ? [line, line] : [line])) : transcript(plan)) },
    expect: attempts => ({ place: 'events', name: `attempt ${verifyAttempt(attempts)} item a-1` }),
  },
  {
    name: 'a fragment left after its item completed',
    world: {
      ...cleanWorld,
      prune: false,
      after: (db, attempts) => db.deleteFrom('attempt_event').where('attempt_id', '<>', verifyAttempt(attempts)).where('fragment', '=', true).execute(),
    },
    expect: attempts => ({ place: 'fragments', name: `attempt ${verifyAttempt(attempts)} item a-1` }),
  },
  {
    name: 'an item that never completed in a passed attempt',
    world: { ...cleanWorld, lines: plan => (plan.step === 'verify' ? transcript(plan).filter(line => !(line.method === 'item/completed' && line.itemId === 'a-1')) : transcript(plan)) },
    expect: attempts => ({ place: 'replay', name: `attempt ${verifyAttempt(attempts)} item a-1` }),
  },
  {
    name: 'a Verify environment never stopped',
    world: { ...cleanWorld, after: db => db.updateTable('verify_environment').set({ stopped_at: null }).execute() },
    expect: () => ({ place: 'environments', name: 'Verify environment 1 (tests-only)' }),
  },
  {
    name: "an attempt's branch left on GitHub",
    world: { ...cleanWorld, onGitHub: [...cleanWorld.onGitHub, attemptBranch(1)] },
    expect: () => ({ place: 'github', name: `branch ${attemptBranch(1)}` }),
  },
  {
    name: "the pull request's branch left on GitHub",
    world: { ...cleanWorld, onGitHub: [...cleanWorld.onGitHub, taskBranch] },
    expect: () => ({ place: 'github', name: `branch ${taskBranch}` }),
  },
];

const listed =
  (branches: readonly string[]) =>
  (prefix: string): Promise<readonly string[]> =>
    Promise.resolve(branches.filter(branch => branch.startsWith(prefix)));

const describe = (found: readonly Leftover[]): string => (found.length === 0 ? 'nothing left' : found.map(entry => `${entry.place}: ${entry.name} ${entry.detail}`).join('; '));

async function inWorld<T>(postgres: TestPostgres, world: World, work: (db: Database, attempts: readonly string[]) => Promise<T>): Promise<T> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  try {
    return await work(db, await seed(db, world));
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

async function cleanLane(args: readonly string[]): Promise<readonly Check[]> {
  const { values } = parseArgs({ args: [...args], options: { repository: { type: 'string', default: 'braxtonkdev/autoworker-oss' }, 'read-github': { type: 'boolean', default: false } } });
  if (values['read-github'] && (process.env['GITHUB_TOKEN'] ?? '') === '') return [fail('GITHUB_TOKEN is set', '--read-github runs in the live service, which reads GitHub with the sandbox token')];
  const checks: Check[] = [...(checksOf(await kind.run(['up'])))];
  if (!checks.every(check => check.passed)) return checks;
  const cluster = connectCluster(`e2e-clean-${randomBytes(3).toString('hex')}`);
  await cluster.core.createNamespace({ body: { metadata: { name: cluster.namespace } } });
  checks.push(pass('namespace ready', cluster.namespace));
  if (values['read-github']) {
    const runBranches = await githubFromEnvironment(process.env, values.repository).branchesStartingWith('e2e/run-');
    checks.push(runBranches.length > 0 ? pass('the GitHub read finds branches by prefix', `${String(runBranches.length)} under e2e/run-`) : fail('the GitHub read finds branches by prefix', `nothing under e2e/run- in ${values.repository}`));
  }
  try {
    return await withPostgres(async postgres => {
      const sourcesFor = (database: Database, world: World): CleanSources => ({ database, cluster, branchesStartingWith: listed(world.onGitHub) });
      const clean = await inWorld(postgres, cleanWorld, db => leftovers(sourcesFor(db, cleanWorld), ticket));
      checks.push(...cleanChecks(clean).map(check => ({ ...check, name: `clean world, ${check.name}` })));
      for (const plant of plants) {
        const check = await inWorld(postgres, plant.world, async (db, attempts) => {
          await plant.cluster?.(cluster, attempts);
          try {
            const found = await leftovers(sourcesFor(db, plant.world), ticket);
            const expected = plant.expect(attempts);
            const named = found.length === 1 && found[0]?.place === expected.place && found[0].name === expected.name;
            return named ? pass(`the clean check fails on ${plant.name} and names it`, describe(found)) : fail(`the clean check fails on ${plant.name} and names it`, `expected ${expected.place}: ${expected.name}, found ${describe(found)}`);
          } finally {
            const { items } = await cluster.core.listNamespacedSecret({ namespace: cluster.namespace, labelSelector: labels.attempt });
            await Promise.all(items.map(secret => cluster.core.deleteNamespacedSecret({ namespace: cluster.namespace, name: secret.metadata?.name ?? '' })));
          }
        });
        checks.push(check);
      }
      return checks;
    });
  } finally {
    await cluster.core.deleteNamespace({ name: cluster.namespace });
  }
}

type FakeJira = { readonly url: string; readonly posted: { readonly path: string; readonly body: string }[]; readonly close: () => Promise<void> };

const commentPost = z.object({ body: z.string() });

async function fakeJira(): Promise<FakeJira> {
  const posted: { path: string; body: string }[] = [];
  const server = createServer((request, response) => {
    void text(request).then(sent => {
      const path = new URL(request.url ?? '/', 'http://fake').pathname;
      if (request.method !== 'POST' || !/^\/rest\/api\/2\/issue\/[^/]+\/comment$/.test(path)) {
        response.writeHead(404).end(JSON.stringify({ errorMessages: [`no fake route for ${request.method ?? ''} ${path}`] }));
        return;
      }
      const { body } = commentPost.parse(JSON.parse(sent));
      posted.push({ path, body });
      response.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ id: String(10000 + posted.length), body, created: new Date(t0).toISOString() }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake Jira has no port');
  return { url: `http://127.0.0.1:${String(address.port)}`, posted, close: () => new Promise(resolve => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    }) };
}

const expectedRuns: readonly Pick<StepRun, 'step' | 'inputTokens'>[] = attemptPlans.map(plan => ({ step: plan.step, inputTokens: plan.inputTokens }));

const reportLinks = [
  { label: 'pull request', url: 'https://github.com/example/sandbox/pull/7' },
  { label: 'merge commit', url: 'https://github.com/example/sandbox/commit/abc' },
  { label: 'pull request CI run', url: 'https://github.com/example/sandbox/runs/1' },
  { label: 'run branch CI run', url: 'https://github.com/example/sandbox/runs/2' },
];

async function reportLane(): Promise<readonly Check[]> {
  return withPostgres(async postgres => {
    const checks: Check[] = [];
    const runs = await inWorld(postgres, cleanWorld, db => stepRuns(db, ticket));
    const seen = runs.map(run => ({ step: run.step, inputTokens: run.inputTokens }));
    checks.push(JSON.stringify(seen) === JSON.stringify(expectedRuns) ? pass('input tokens per step come from the last usage event', JSON.stringify(seen)) : fail('input tokens per step come from the last usage event', `expected ${JSON.stringify(expectedRuns)}, read ${JSON.stringify(seen)}`));
    const durations = runs.map(run => (run.finishedAt === null ? -1 : (run.finishedAt.getTime() - run.startedAt.getTime()) / 1000));
    checks.push(JSON.stringify(durations) === '[60,300,120,20]' ? pass('each step keeps its duration', durations.join(', ')) : fail('each step keeps its duration', durations.join(', ')));
    const broken: World = { ...cleanWorld, after: db => db.updateTable('attempt_event').set({ body: JSON.stringify({ method: tokenUsageMethod, params: { tokenUsage: { total: {} } } }) }).where('method', '=', tokenUsageMethod).execute() };
    const rejected = await inWorld(postgres, broken, db => stepRuns(db, ticket).then(() => 'accepted', (error: unknown) => (error instanceof PayloadRejected ? error.message : `threw ${String(error)}`)));
    checks.push(rejected.includes('params.tokenUsage.total.inputTokens:') ? pass('a usage event without input tokens is rejected by field name', rejected) : fail('a usage event without input tokens is rejected by field name', rejected));
    const fake = await fakeJira();
    try {
      const jira = jiraAt(fake.url, 'owner@example.com', 'made-up-token');
      const body = renderReport({
        branch: 'e2e/run-clean',
        driver: 'autoworker',
        entry: 'titleCase',
        furthest: 'merged',
        stop: 'every step reached',
        timeline: [
          { name: 'ticket filed', at: at(0) },
          { name: 'merged', at: at(500) },
        ],
        steps: runs,
        links: linksFrom(jira.browse(ticket), [{ links: reportLinks }]),
        overheadMs: 4000,
        autoworkerOverheadMs: 90_000,
      });
      const posted = await jira.comment(ticket, body);
      const link = jira.commentLink(ticket, posted);
      const sent = fake.posted[0]?.body ?? '';
      const rows = ['|specify|1|pass|60 s|1,200|', '|implement|2|pass|300 s|5,400|', '|verify|3|pass|120 s|2,300|', '|land|4|pass|20 s|none recorded|', 'Input tokens in all: 8,900, from 3 of 4 attempts.', "AutoWorker's overhead, the run's time to clean less the agent's turn time: 90 s."];
      const missingRows = rows.filter(row => !sent.includes(row));
      checks.push(fake.posted.length === 1 && fake.posted[0]?.path === `/rest/api/2/issue/${ticket}/comment` ? pass('the report is posted once as a comment on the ticket', fake.posted[0].path) : fail('the report is posted once as a comment on the ticket', JSON.stringify(fake.posted.map(entry => entry.path))));
      checks.push(missingRows.length === 0 ? pass('the report holds each step with its duration and input tokens', rows.join(' ')) : fail('the report holds each step with its duration and input tokens', `missing ${missingRows.join(' ')}`));
      const missingLinks = [{ label: 'ticket', url: jira.browse(ticket) }, ...reportLinks].filter(entry => !sent.includes(`[${entry.label}|${entry.url}]`)).map(entry => entry.label);
      checks.push(missingLinks.length === 0 && !sent.includes('Missing:') ? pass('the report links the ticket, the pull request, the merge commit, and both CI runs', ['ticket', ...reportLinks.map(entry => entry.label)].join(', ')) : fail('the report links the ticket, the pull request, the merge commit, and both CI runs', `missing ${missingLinks.join(', ')}`));
      checks.push(link.startsWith(`${fake.url}/browse/${ticket}?focusedCommentId=`) ? pass('the report comment has a link', link) : fail('the report comment has a link', link));
      const partial = renderReport({ branch: 'e2e/run-clean', driver: 'none', entry: 'titleCase', furthest: 'ticket filed', stop: 'timed out', timeline: [], steps: [], links: linksFrom(jira.browse(ticket), []), overheadMs: 0, autoworkerOverheadMs: undefined });
      checks.push(partial.includes('Missing: pull request, merge commit, pull request CI run, run branch CI run') ? pass('a report without the later links says which are missing', 'pull request, merge commit, pull request CI run, run branch CI run') : fail('a report without the later links says which are missing', partial));
    } finally {
      await fake.close();
    }
    return checks;
  });
}

export const cleanScenarios: readonly Scenario[] = [
  {
    name: 'e2e-clean',
    summary: 'checks a finished world for leftovers against Postgres, kind, and GitHub, then plants a labeled Secret, an owed outbox row, an event gap, a twice-completed item, a left fragment, and an unstopped environment, and passes only when each is named',
    run: cleanLane,
  },
  {
    name: 'e2e-report',
    summary: "reads each step's duration and input tokens from stored usage events, renders the run report, and posts it to a local fake Jira",
    run: reportLane,
  },
];
