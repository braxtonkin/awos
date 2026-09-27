import { sql } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import { slotOrigin } from '../../shared/slots.ts';
import { marks, marksOf, verdict, type Mark } from '../../shared/task-status.ts';
import { connectors, taskStates, waitingOns, type Login, type NeedsYou, type TaskRow, type World } from './protocol.ts';

const moment = z.union([z.date(), z.string()]).transform(value => new Date(value).toISOString());

const id = z.union([z.string(), z.number()]).transform(String);

const taskRow = z.object({
  key: z.string(),
  title: z.string(),
  routine: z.string(),
  routine_id: id,
  workflow: z.string(),
  step: z.string(),
  state: z.enum(taskStates),
  waiting_on: z.enum(waitingOns).nullable(),
  waiting_reason: z.string().nullable(),
  found_at: moment,
  person: z.string(),
  person_id: id,
  started_at: moment.nullable(),
  finished_at: moment.nullable(),
  verdict: verdict.nullable(),
});

type Row = z.infer<typeof taskRow>;

const sinceOf = (row: Row): string | null => {
  switch (row.state) {
    case 'ready':
      return row.finished_at === null ? row.started_at : null;
    case 'waiting':
      return row.finished_at ?? row.found_at;
    case 'stopped':
    case 'done':
      return row.finished_at;
  }
};

const needRank: Readonly<Record<Mark, number>> = { failed: 0, 'needs-you': 1, running: 2, stopped: 3, landed: 4 };

const rankOf = (task: TaskRow): number => Math.min(...task.marks.map(mark => needRank[mark]));

const byNeed = (a: TaskRow, b: TaskRow): number => rankOf(a) - rankOf(b);

const taskOf = (row: Row): TaskRow => ({
  key: row.key,
  title: row.title,
  routine: row.routine,
  workflow: row.workflow,
  step: row.step,
  state: row.state,
  waitingOn: row.waiting_on,
  waitingReason: row.waiting_reason,
  marks: marksOf({ state: row.state, waitingOn: row.waiting_on, newestVerdict: row.verdict }),
  person: row.person,
  since: sinceOf(row),
});

const personOfTask = sql<string>`coalesce(assignee.id, routine.creator_id)`;

const tasks = (db: Database) =>
  db
    .selectFrom('task')
    .innerJoin('routine', 'routine.id', 'task.routine_id')
    .innerJoin('routine_version as version', join => join.onRef('version.routine_id', '=', 'task.routine_id').onRef('version.version', '=', 'task.found_version'))
    .leftJoin('person as assignee', 'assignee.jira_account_id', 'task.assignee_account_id')
    .innerJoin('person as owner', join => join.on(eb => eb('owner.id', '=', personOfTask)))
    .leftJoinLateral(
      eb => eb.selectFrom('attempt').select(['attempt.started_at', 'attempt.finished_at', 'attempt.verdict']).whereRef('attempt.task_id', '=', 'task.id').orderBy('attempt.id', 'desc').limit(1).as('newest'),
      join => join.onTrue(),
    )
    .select([
      'task.key',
      'task.title',
      'version.name as routine',
      'routine.id as routine_id',
      'task.workflow',
      'task.step',
      'task.state',
      'task.waiting_on',
      'task.waiting_reason',
      'task.found_at',
      'owner.name as person',
      'owner.id as person_id',
      'newest.started_at',
      'newest.finished_at',
      'newest.verdict',
    ]);

const loginRow = z.object({ connector: z.enum(connectors), state: z.enum(['invalid', 'unknown', 'valid']).nullable(), expires_at: moment.nullable() });

const worldRow = z.object({ routines: z.coerce.number(), tasks: z.boolean(), next: z.object({ routine: z.string(), at: moment }).nullable() });

const expiringWithinMs = 7 * 24 * 60 * 60_000;

const runningShown = 10;

const worldQuery = (db: Database, now: Date) =>
  db.selectNoFrom(eb => [
    eb.selectFrom('routine').select(eb.fn.countAll().as('count')).as('routines'),
    eb.exists(eb.selectFrom('task').select('task.id')).as('tasks'),
    jsonObjectFrom(
      eb
        .selectFrom('routine')
        .innerJoinLateral(
          inner => inner.selectFrom('routine_version').select(['routine_version.name', 'routine_version.every']).whereRef('routine_version.routine_id', '=', 'routine.id').orderBy('routine_version.version', 'desc').limit(1).as('newest'),
          join => join.onTrue(),
        )
        .select(sql<string>`newest.name`.as('routine'))
        .select(sql<Date>`date_bin(newest.every, ${now}::timestamptz, ${slotOrigin}::timestamptz) + newest.every`.as('at'))
        .where('routine.paused_by', 'is', null)
        .orderBy('at')
        .limit(1),
    ).as('next'),
  ]);

const worldOf = (row: z.infer<typeof worldRow>): World => {
  if (row.routines === 0) return { kind: 'no-routines' };
  if (!row.tasks) return { kind: 'no-tasks', next: row.next };
  return { kind: 'tasks' };
};

async function readWorld(db: Database, now: Date): Promise<World> {
  return worldOf(worldRow.parse(await worldQuery(db, now).executeTakeFirstOrThrow()));
}

const needsRow = z.object({ tasks: z.array(taskRow), logins: z.array(loginRow), running: z.array(taskRow), running_count: z.coerce.number(), world: worldRow });

export async function readNeedsYou(db: Database, person: string | undefined, now: Date): Promise<NeedsYou> {
  const mine = person ?? '0';
  const row = await db
    .selectNoFrom(eb => [
      jsonArrayFrom(tasks(db).where('task.state', '=', 'waiting').where(personOfTask, '=', mine).orderBy(sql`coalesce(newest.finished_at, task.found_at)`).orderBy('task.id')).as('tasks'),
      jsonArrayFrom(
        eb
          .selectFrom('credential')
          .select(['credential.connector', 'credential.state', 'credential.expires_at'])
          .where('credential.person_id', '=', mine)
          .where(inner => inner.or([inner('credential.state', '=', 'invalid'), inner('credential.expires_at', '<', new Date(now.getTime() + expiringWithinMs))]))
          .orderBy('credential.connector'),
      ).as('logins'),
      jsonArrayFrom(tasks(db).where('task.state', '=', 'ready').orderBy('newest.started_at').orderBy('task.id').limit(runningShown)).as('running'),
      eb.selectFrom('task').select(eb.fn.countAll().as('count')).where('task.state', '=', 'ready').as('running_count'),
      jsonObjectFrom(worldQuery(db, now)).as('world'),
    ])
    .executeTakeFirstOrThrow();
  const parsed = needsRow.parse(row);
  const waiting = parsed.tasks.map(taskOf);
  return {
    at: now.toISOString(),
    picked: person !== undefined,
    waiting: waiting.filter(task => task.waitingOn !== 'approval'),
    gates: waiting.filter(task => task.waitingOn === 'approval'),
    logins: parsed.logins.map((login): Login => ({ connector: login.connector, state: login.state, expiresAt: login.expires_at })),
    running: parsed.running.map(taskOf),
    moreRunning: Math.max(0, parsed.running_count - parsed.running.length),
    world: worldOf(parsed.world),
  };
}

export type Option = { readonly id: string; readonly name: string };

export type StateFilter = Mark | 'all';

export type Filters = { readonly state: StateFilter | undefined; readonly routine: string | undefined; readonly person: string | undefined };

const idText = z.string().regex(/^[1-9]\d*$/);

const firstOf = (value: unknown): unknown => (Array.isArray(value) ? value[0] : value);

const filtersSchema = z.object({
  state: z.preprocess(firstOf, z.enum([...marks, 'all']).optional().catch(undefined)),
  routine: z.preprocess(firstOf, idText.optional().catch(undefined)),
  person: z.preprocess(firstOf, idText.optional().catch(undefined)),
});

const filtersOf = (params: Readonly<Record<string, string | readonly string[] | undefined>>): Filters => {
  const parsed = filtersSchema.parse(params);
  return { state: parsed.state, routine: parsed.routine, person: parsed.person };
};

const shows = (state: StateFilter | undefined, task: TaskRow): boolean => {
  if (state === 'all') return true;
  return state === undefined ? !task.marks.includes('landed') : task.marks.includes(state);
};

export type ListRow = TaskRow & { readonly landedInMs: number | null };

export type TaskList = {
  readonly filters: Filters;
  readonly rows: readonly ListRow[];
  readonly matching: number;
  readonly routines: readonly Option[];
  readonly people: readonly Option[];
  readonly world: World;
};

const listShown = 100;

const spanRow = z.object({ first_started: moment.nullable(), last_finished: moment.nullable() });

export async function readTaskList(db: Database, params: Readonly<Record<string, string | readonly string[] | undefined>>, now: Date): Promise<TaskList> {
  const filters = filtersOf(params);
  const [found, routines, people, world] = await Promise.all([
    tasks(db)
      .select(eb => [
        eb.selectFrom('attempt').select(inner => inner.fn.min('attempt.started_at').as('first')).whereRef('attempt.task_id', '=', 'task.id').as('first_started'),
        eb.selectFrom('attempt').select(inner => inner.fn.max('attempt.finished_at').as('last')).whereRef('attempt.task_id', '=', 'task.id').as('last_finished'),
      ])
      .$if(filters.routine !== undefined, query => query.where('routine.id', '=', filters.routine ?? '0'))
      .$if(filters.person !== undefined, query => query.where(personOfTask, '=', filters.person ?? '0'))
      .orderBy('task.found_at', 'desc')
      .orderBy('task.id', 'desc')
      .execute(),
    db
      .selectFrom('routine')
      .innerJoinLateral(
        eb => eb.selectFrom('routine_version').select('routine_version.name').whereRef('routine_version.routine_id', '=', 'routine.id').orderBy('routine_version.version', 'desc').limit(1).as('newest'),
        join => join.onTrue(),
      )
      .select(['routine.id', 'newest.name'])
      .orderBy('newest.name')
      .execute(),
    db.selectFrom('person').select(['person.id', 'person.name']).where('person.kind', '=', 'person').orderBy('person.name').execute(),
    readWorld(db, now),
  ]);
  const rows = found.flatMap(raw => {
    const task = taskOf(taskRow.parse(raw));
    if (!shows(filters.state, task)) return [];
    const span = spanRow.parse(raw);
    const landedInMs = task.state === 'done' && span.first_started !== null && span.last_finished !== null ? Date.parse(span.last_finished) - Date.parse(span.first_started) : null;
    return [{ ...task, landedInMs }];
  });
  return { filters, rows: rows.toSorted(byNeed).slice(0, listShown), matching: rows.length, routines, people, world };
}

type Column = { readonly step: string; readonly tasks: readonly TaskRow[] };

export type BoardRow = { readonly workflow: string; readonly columns: readonly Column[]; readonly landed: number };

export type Board = { readonly rows: readonly BoardRow[]; readonly world: World };

export async function readBoard(db: Database, now: Date): Promise<Board> {
  const [found, steps, world] = await Promise.all([
    tasks(db).orderBy('task.found_at').orderBy('task.id').execute(),
    db.selectFrom('published_workflow_step').select(['published_workflow_step.workflow', 'published_workflow_step.name']).orderBy('published_workflow_step.workflow').orderBy('published_workflow_step.position').execute(),
    readWorld(db, now),
  ]);
  const all = found.map(raw => taskOf(taskRow.parse(raw)));
  const workflows = [...new Set(all.map(task => task.workflow))].toSorted();
  const rows = workflows.map((workflow): BoardRow => {
    const mine = all.filter(task => task.workflow === workflow);
    const open = mine.filter(task => task.state !== 'done');
    const published = steps.filter(each => each.workflow === workflow).map(each => each.name);
    const unknown = [...new Set(open.map(task => task.step))].filter(step => !published.includes(step));
    return {
      workflow,
      columns: [...published, ...unknown].map(step => ({ step, tasks: open.filter(task => task.step === step).toSorted(byNeed) })),
      landed: mine.length - open.length,
    };
  });
  return { rows, world };
}
