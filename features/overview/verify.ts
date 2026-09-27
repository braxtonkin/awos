import type { Batch } from '../../tools/verify/batch.ts';
import { sql } from 'kysely';
import { connect, type Database } from '../../shared/db/client.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { actAs, type Screen } from '../../tools/verify/screens/screens.ts';
import { lanes, localPeople } from './lanes.ts';
import { readNeedsYou } from './read.ts';

const people = [
  { id: '1', email: 'braxton.kinney@example.com', name: 'Braxton Kinney', account: 'account-bk' },
  { id: '2', email: 'priya.natarajan@example.com', name: 'Priya Natarajan', account: null },
  { id: '3', email: 'mei.chen@example.com', name: 'Mei Chen', account: 'account-mc' },
] as const;

type Planted = { readonly key: string; readonly routine: 1 | 2; readonly assignee: string | null; readonly on: 'retry' | 'outside_approval' | 'approval'; readonly verdict: 'behavior_fail' | 'conflict' | 'review_required'; readonly person: string };

const waiting: readonly Planted[] = [
  { key: 'OV-1', routine: 1, assignee: 'account-bk', on: 'retry', verdict: 'review_required', person: 'Braxton Kinney' },
  { key: 'OV-2', routine: 1, assignee: null, on: 'outside_approval', verdict: 'review_required', person: 'Braxton Kinney' },
  { key: 'OV-3', routine: 1, assignee: 'account-mc', on: 'retry', verdict: 'behavior_fail', person: 'Mei Chen' },
  { key: 'OV-4', routine: 2, assignee: null, on: 'retry', verdict: 'review_required', person: 'Priya Natarajan' },
  { key: 'OV-5', routine: 2, assignee: 'account-nobody', on: 'retry', verdict: 'review_required', person: 'Priya Natarajan' },
  { key: 'OV-6', routine: 1, assignee: 'account-bk', on: 'approval', verdict: 'review_required', person: 'Braxton Kinney' },
  { key: 'OV-8', routine: 1, assignee: 'account-bk', on: 'retry', verdict: 'conflict', person: 'Braxton Kinney' },
];

const running = 'OV-7';

async function plantWorld(db: Database): Promise<void> {
  const now = new Date();
  for (const person of people) await sql`insert into person (email, name, jira_account_id) values (${person.email}, ${person.name}, ${person.account})`.execute(db);
  for (const [routine, creator] of [[1, 1], [2, 2]] as const) {
    const action = `00000000-0000-4000-8000-00000000000${String(routine)}`;
    await sql`insert into routine (creator_id) values (${creator})`.execute(db);
    await sql`insert into human_action (id, at, person_id, kind, routine_id) values (${action}, ${now}, ${creator}, 'edit_routine', ${routine})`.execute(db);
    await sql`insert into routine_version (routine_id, version, name, goal, action_id, workflow, source, needs_repository, gates)
      values (${routine}, 1, ${`Routine ${String(routine)}`}, 'Find tasks.', ${action}, 'code-change', '{"kind": "jira-search"}', false, '{}')`.execute(db);
  }
  for (const task of [...waiting, { key: running, routine: 1, assignee: 'account-bk', on: null, verdict: 'review_required' }]) {
    const inserted = await sql<{ readonly id: string }>`insert into task (routine_id, found_version, key, title, found_at, workflow, needs_repository, step, assignee_account_id)
      values (${task.routine}, 1, ${task.key}, ${`Task ${task.key}`}, ${now}, 'code-change', false, 'verify', ${task.assignee}) returning id`.execute(db);
    const id = inserted.rows[0]?.id ?? '';
    const attempt = await sql<{ readonly id: string }>`insert into attempt (task_id, routine_id, routine_version, step, epoch, run_as_id, started_at, lease_until, finished_at, verdict, output)
      values (${id}, ${task.routine}, 1, 'verify', 0, 1, ${now}, ${now}, ${task.on === null ? null : now}, ${task.on === null ? null : task.verdict}, ${task.on === null ? null : '{}'}) returning id`.execute(db);
    if (task.on === null) continue;
    await sql`update task set state = 'waiting', waiting_on = ${task.on}, waiting_reason = ${`Waits on ${task.on}.`}, review_attempt = ${task.on === 'approval' ? (attempt.rows[0]?.id ?? null) : null} where id = ${id}`.execute(db);
  }
}

async function whoSees(db: Database): Promise<ReadonlyMap<string, readonly string[]>> {
  const everyone = await db.selectFrom('person').select(['person.id', 'person.name']).execute();
  const seen = new Map<string, string[]>();
  for (const person of everyone) {
    const needs = await readNeedsYou(db, person.id, new Date());
    for (const task of [...needs.waiting, ...needs.gates]) seen.set(task.key, [...(seen.get(task.key) ?? []), person.name]);
  }
  return seen;
}

const everyWaitingTaskHasItsPerson = (seen: ReadonlyMap<string, readonly string[]>): readonly string[] =>
  waiting.flatMap(task => {
    const names = seen.get(task.key) ?? [];
    return names.length === 1 && names[0] === task.person ? [] : [`${task.key} shows for ${names.join(' and ') || 'nobody'}, not only ${task.person}`];
  });

async function readScenario(): Promise<readonly Check[]> {
  return withPostgres(async postgres => {
    const scratch = await postgres.scratch();
    const db = connect(scratch.url, 4);
    try {
      await plantWorld(db);
      const seen = await whoSees(db);
      const wrong = everyWaitingTaskHasItsPerson(seen);
      const stray = [...seen.keys()].filter(key => !waiting.some(task => task.key === key));
      const bk = await readNeedsYou(db, '1', new Date());
      const failed = [...bk.waiting, ...bk.gates, ...(await readNeedsYou(db, '3', new Date())).waiting].find(task => task.key === 'OV-3');
      const conflicted = bk.waiting.find(task => task.key === 'OV-8');
      const nobody = await readNeedsYou(db, undefined, new Date());
      await sql`alter table person drop constraint one_person_per_jira_account`.execute(db);
      await sql`insert into person (email, name, jira_account_id) values ('planted@example.com', 'Planted Person', 'account-mc')`.execute(db);
      const planted = everyWaitingTaskHasItsPerson(await whoSees(db));
      return [
        wrong.length === 0 ? pass('every seeded waiting task shows for its person and for nobody else', waiting.map(task => `${task.key} ${task.person}`).join(', ')) : fail('every seeded waiting task shows for its person and for nobody else', wrong.join('; ')),
        stray.length === 0 ? pass('no task that is not waiting shows as waiting', `${running} is running`) : fail('no task that is not waiting shows as waiting', stray.join(', ')),
        bk.gates.map(task => task.key).join() === 'OV-6' ? pass('the gate shows under Approve for its person', 'OV-6') : fail('the gate shows under Approve for its person', bk.gates.map(task => task.key).join(', ')),
        failed?.marks.join() === 'failed,needs-you' ? pass('the failed task carries Failed beside Needs you', 'failed, needs-you') : fail('the failed task carries Failed beside Needs you', failed?.marks.join(', ') ?? 'OV-3 is missing'),
        conflicted?.marks.join() === 'needs-you' ? pass('a task that its conflicts parked carries Needs you without Failed', 'needs-you') : fail('a task that its conflicts parked carries Needs you without Failed', conflicted?.marks.join(', ') ?? 'OV-8 is missing'),
        nobody.waiting.length + nobody.gates.length === 0 && nobody.running.map(task => task.key).join() === running ? pass('with nobody picked, nothing waits and the running task still shows', running) : fail('with nobody picked, nothing waits and the running task still shows', JSON.stringify(nobody)),
        planted.length > 0 ? pass('a plant that gives a task a second person fails the check', planted.join('; ')) : fail('a plant that gives a task a second person fails the check', 'every task still showed for one person'),
      ];
    } finally {
      await db.destroy();
      await scratch.drop();
    }
  });
}

export const scenarios: readonly Scenario[] = [
  {
    name: 'overview-read',
    summary: 'plants waiting tasks for three people in Postgres and checks that Needs you shows each for its person and for nobody else, the gate under Approve, Failed beside Needs you, and Needs you alone for a task its conflicts parked; a plant that gives a task a second person must fail',
    run: readScenario,
  },
];

const overview = (name: string, path: string, seed: string, steps: Screen['steps'] = []): Screen => ({ name, group: 'overview', path, seed, steps, height: 900, names: localPeople });

export const screens: readonly Screen[] = [
  overview('needs-you', '/', 'waiting-gate'),
  overview('needs-you-nothing', '/', 'login-expired', actAs('Mei Chen')),
  overview('board', '/board', 'failed-behavior'),
  overview('tasks', '/tasks', 'running'),
  overview('tasks-waiting', '/tasks?state=needs-you', 'question'),
  overview('tasks-landed', '/tasks?state=landed', 'done'),
  overview('tasks-stopped', '/tasks?state=stopped', 'stopped'),
  { ...overview('empty-no-routines', '/', 'no-routines'), alone: true },
  { ...overview('empty-no-tasks', '/tasks', 'no-tasks'), alone: true },
];

export { lanes };

export const batch: Batch = { scenarios: [['overview-read']], engine: [['routines-sim', '--mutant', 'all']] };
