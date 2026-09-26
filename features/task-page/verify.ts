import { setTimeout as wait } from 'node:timers/promises';
import { sql } from 'kysely';
import { connect, type Database } from '../../shared/db/client.ts';
import { emptyTranscript, reduce } from '../../shared/items.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { withPostgres } from '../../tools/verify/postgres.ts';
import type { Lane } from '../../tools/verify/dashboard.ts';
import type { Screen } from '../../tools/verify/screens/screens.ts';
import { agentLanes } from './agent-lanes.ts';
import { lanes as taskLanes, localPeople } from './lanes.ts';
import { reviewAnswers } from './review-answers.ts';
import type { Cursor, Frame, Line } from './protocol.ts';
import { frames, type Pace } from './stream.ts';
import { extend } from './timeline.ts';

const fast: Pace = { pollMs: 20, linesPerPoll: 3 };
const settleMs = 10_000;

const worldRows = (now: Date) => [
  sql`insert into person (email, name) values ('braxton.kinney@example.com', 'Braxton Kinney')`,
  sql`with saved as (insert into human_action (id, at, person_id, kind, repository_id) values ('00000000-0000-4000-8000-000000000009', ${now}, 1, 'add_repository', 1) returning id)
      insert into repository (github, branch, saved_by) select 'example/sandbox', 'main', id from saved`,
  sql`insert into routine (creator_id, run_as_id) values (1, 1)`,
  sql`insert into human_action (id, at, person_id, kind, routine_id) values ('00000000-0000-4000-8000-000000000001', ${now}, 1, 'edit_routine', 1)`,
  sql`insert into routine_version (routine_id, version, name, goal, repository_id, action_id, workflow, source, needs_repository, gates)
      values (1, 1, 'Stream lane', 'Stream two attempts.', 1, '00000000-0000-4000-8000-000000000001', 'code-change', '{"kind": "jira-search"}', true, '{}')`,
  sql`insert into task (routine_id, found_version, repository_id, key, title, found_at, workflow, needs_repository, step)
      values (1, 1, 1, 'LANE-1', 'Stream lane', ${now}, 'code-change', true, 'specify')`,
];

const startAttempt = (now: Date) =>
  sql<{ readonly id: string }>`insert into attempt (task_id, routine_id, routine_version, step, epoch, run_as_id, started_at, lease_until)
      values (1, 1, 1, 'specify', 0, 1, ${now}, ${new Date(now.getTime() + 60_000)}) returning id`;

type Body = { readonly method: string; readonly params: Readonly<Record<string, unknown>> };

const started = (id: string): Body => ({ method: 'item/started', params: { turnId: 't', item: { id, type: 'agentMessage', text: '' } } });
const delta = (id: string, text: string): Body => ({ method: 'item/agentMessage/delta', params: { turnId: 't', itemId: id, delta: text } });
const completed = (id: string, text: string): Body => ({ method: 'item/completed', params: { turnId: 't', item: { id, type: 'agentMessage', text } } });
const turn = (method: 'turn/started' | 'turn/completed'): Body => ({ method, params: { turn: { id: 't', status: method === 'turn/started' ? 'inProgress' : 'completed' } } });

async function store(db: Database, attempt: string, seq: number, body: Body): Promise<void> {
  const itemId = 'itemId' in body.params ? body.params['itemId'] : typeof body.params['item'] === 'object' && body.params['item'] !== null && 'id' in body.params['item'] ? body.params['item'].id : null;
  const fragment = body.method.endsWith('/delta');
  await db
    .insertInto('attempt_event')
    .values({ attempt_id: attempt, seq: String(seq), kind: 'app', method: body.method, item_id: typeof itemId === 'string' ? itemId : null, fragment, body: JSON.stringify(body), stored_at: new Date() })
    .execute();
}

type Reader = { readonly lines: Line[]; readonly stop: () => Promise<Cursor | undefined> };

const readers: Reader[] = [];

function read(db: Database, task: string, after: Cursor | undefined): Reader {
  const lines: Line[] = [];
  const stopping = new AbortController();
  let cursor = after;
  let failure: Error | undefined;
  const done = (async () => {
    for await (const sent of frames(db, task, after, stopping.signal, fast)) {
      const frame: Frame = sent.data;
      if (frame.kind !== 'line') continue;
      lines.push({ attempt: frame.attempt, seq: frame.seq, at: frame.at, body: frame.body });
      cursor = { attempt: frame.attempt, line: frame.seq };
    }
  })().catch((error: unknown) => {
    failure = error instanceof Error ? error : new Error(JSON.stringify(error));
  });
  const reader = {
    lines,
    stop: async () => {
      stopping.abort();
      await done;
      if (failure !== undefined) throw failure;
      return cursor;
    },
  };
  readers.push(reader);
  return reader;
}

async function caughtUp(reader: Reader, attempt: string, seq: number): Promise<boolean> {
  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline) {
    if (reader.lines.some(line => line.attempt === attempt && line.seq === seq)) return true;
    await wait(fast.pollMs);
  }
  return false;
}

async function storedItems(db: Database, attempts: readonly string[]): Promise<string> {
  const rows = await db.selectFrom('attempt_event').select(['attempt_id', 'body']).where('kind', '=', 'app').orderBy('attempt_id').orderBy('seq').execute();
  return JSON.stringify(attempts.map(attempt => reduce(rows.filter(row => row.attempt_id === attempt)).items));
}

const streamed = (lines: readonly Line[], attempts: readonly string[]): string => {
  const made = extend(attempts.map(attempt => ({ attempt, transcript: emptyTranscript, times: {}, actions: {} })), lines);
  return JSON.stringify(made.map(each => each.transcript.items));
};

async function streamScenario(): Promise<readonly Check[]> {
  return withPostgres(async postgres => {
    const scratch = await postgres.scratch();
    const db = connect(scratch.url, 4);
    try {
      const now = new Date();
      for (const row of worldRows(now)) await row.execute(db);
      const first = String((await startAttempt(now).execute(db)).rows[0]?.id);
      const firstLines = [turn('turn/started'), started('a1'), delta('a1', 'Reading '), delta('a1', 'the ticket'), completed('a1', 'Reading the ticket'), turn('turn/completed')];
      for (const [index, body] of firstLines.entries()) await store(db, first, index + 1, body);
      const reader = read(db, '1', undefined);
      const readFirst = await caughtUp(reader, first, firstLines.length);
      await db.deleteFrom('attempt_event').where('attempt_id', '=', first).where('fragment', '=', true).execute();
      await db.updateTable('attempt').set({ finished_at: new Date(), verdict: 'stopped' }).where('id', '=', first).execute();
      const second = String((await startAttempt(new Date()).execute(db)).rows[0]?.id);
      await store(db, second, 1, turn('turn/started'));
      await store(db, second, 2, started('b1'));
      await store(db, second, 3, delta('b1', 'Half '));
      const readSecond = await caughtUp(reader, second, 3);
      const cursor = await reader.stop();
      await store(db, second, 4, delta('b1', 'done'));
      await store(db, second, 5, completed('b1', 'Half done'));
      await db.deleteFrom('attempt_event').where('attempt_id', '=', second).where('fragment', '=', true).execute();
      await store(db, second, 6, started('b2'));
      await store(db, second, 7, completed('b2', 'Finished'));
      const resumed = read(db, '1', cursor);
      const readAfter = await caughtUp(resumed, second, 7);
      await resumed.stop();
      const lines = [...reader.lines, ...resumed.lines];
      const attempts = [first, second];
      const expected = await storedItems(db, attempts);
      const got = streamed(lines, attempts);
      const keys = lines.map(line => `${line.attempt}:${String(line.seq)}`);
      const twice = keys.filter((key, index) => keys.indexOf(key) !== index);
      const planted = streamed(lines.filter(line => !(line.attempt === second && line.seq === 5)), attempts);
      return [
        readFirst && readSecond && readAfter ? pass('frames delivers every stored line of both attempts, before and after a reconnect', `${String(lines.length)} line frames`) : fail('frames delivers every stored line of both attempts, before and after a reconnect', `first ${String(readFirst)}, second ${String(readSecond)}, after reconnect ${String(readAfter)}`),
        twice.length === 0 ? pass('no line arrives twice across the reconnect', keys.join(' ')) : fail('no line arrives twice across the reconnect', twice.join(' ')),
        got === expected ? pass('the frames reduce to the same transcript as reduce over the stored lines', expected) : fail('the frames reduce to the same transcript as reduce over the stored lines', `frames ${got}, stored ${expected}`),
        planted !== expected ? pass('dropping one line frame makes the transcripts differ', planted) : fail('dropping one line frame makes the transcripts differ', 'the planted transcript still matched'),
      ];
    } finally {
      await Promise.allSettled(readers.splice(0).map(reader => reader.stop()));
      await db.destroy();
      await scratch.drop();
    }
  });
}

export const scenarios: readonly Scenario[] = [
  {
    name: 'task-page-stream',
    summary: 'streams the stored lines of two attempts through frames, prunes fragments, reconnects from the last cursor, and checks the frames reduce to the transcript that reduce gives over the stored lines; a plant that drops one line must differ',
    run: streamScenario,
  },
  {
    name: 'review-answers',
    summary: "starts local-engine with the question seed, adds a checklist and a draft to the waiting review, sends a pick, an untick, and an edit through request, and checks the engine records each as its action; the plant answers a block that does not exist, which the engine must refuse",
    run: reviewAnswers,
  },
];

const task = (name: string, seed: string, steps: Screen['steps'] = []): Screen => ({ name, group: 'chrome', path: '/tasks/{key}', seed, steps, height: 900, names: localPeople });

const agent = (name: string, seed: string, steps: Screen['steps'] = []): Screen => ({ name, group: 'agent', path: '/tasks/{key}', seed, steps, height: 900, names: localPeople });

export const screens: readonly Screen[] = [
  task('task-running', 'running', [{ waitFor: '[data-live="true"]' }]),
  task('task-waiting', 'question'),
  task('task-empty', 'nobody-to-run-as'),
  task('task-stopped', 'stopped'),
  task('acting-menu', 'running', [{ click: 'summary[aria-label="Acting as"]' }]),
  { name: 'task-not-found', group: 'chrome', path: '/tasks/NOPE-1', seed: 'running', steps: [], height: 900, names: localPeople },
  agent('agent-running', 'running', [{ waitFor: '[data-live="true"]' }]),
  agent('agent-steered', 'steer-acted', [{ waitFor: '[data-request][data-delivery="acted"]' }]),
  agent('agent-question', 'question', [{ waitFor: '[data-question="open"]' }]),
  agent('agent-failed', 'failed-behavior'),
  agent('agent-environment', 'failed-environment'),
  agent('agent-stopped', 'stopped'),
  agent('agent-empty', 'nobody-to-run-as'),
  agent('agent-replay', 'done'),
  agent('agent-expired', 'expired'),
];

export const lanes: readonly Lane[] = [...taskLanes, ...agentLanes];
