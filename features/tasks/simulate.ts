import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { sql } from 'kysely';
import { z } from 'zod';
import { connect, refusal, type Database } from '../../shared/db/client.ts';
import type { DB, TaskState } from '../../shared/db/types.ts';
import type { TestPostgres } from '../../tools/verify/postgres.ts';
import { claim, claimable, pass, reap, renew } from './claim.ts';
import { watch, type PropertyName, type Violation } from './invariants.ts';

export const profileName = z.enum(['default', 'races', 'hangs']);

export type ProfileName = z.infer<typeof profileName>;

export const mutantName = z.enum(['one_live_attempt_per_task', 'finished_attempt_is_final', 'live_attempt_matches_ready_task', 'attempt_runs_as_a_person']);

export type MutantName = z.infer<typeof mutantName>;

export const mutants: Readonly<Record<MutantName, PropertyName>> = {
  one_live_attempt_per_task: 'OneLiveAttempt',
  finished_attempt_is_final: 'LateWriteChangesNothing',
  live_attempt_matches_ready_task: 'LiveAttemptMeansReady',
  attempt_runs_as_a_person: 'AttemptRunsAsAPerson',
};

const ownedTables = ['person', 'repository', 'routine', 'routine_version', 'task', 'human_action', 'attempt'] as const satisfies readonly (keyof DB)[];

export const noMutantYet: Readonly<Record<string, readonly string[]>> = {
  'Postgres will not drop the key that live_attempt_matches_ready_task points at while that foreign key stands': ['live_attempt_target'],
  'live_attempt_matches_ready_task is MATCH SIMPLE, so a null in any of these would skip it, and the claim copies all three from the task, where none can be null': [
    'attempt_names_its_task',
    'attempt_names_its_routine',
    'attempt_names_its_stage',
  ],
  "it speeds finding a task's attempts and refuses nothing": ['attempts_by_task'],
  'the claim reads the task, its newest routine version, and the person it runs as from rows that exist, so no claim can name a missing row': [
    'attempt_of_task',
    'attempt_cites_goal_version',
    'attempt_run_as_is_a_person',
  ],
  'the paved pass, reap, and park statements write these columns together, and no T2 fault writes them apart': [
    'attempt_verdict_when_finished',
    'output_when_passed',
    'waiting_has_reason',
  ],
  'every T2 statement and fault passes the time it writes, so none leaves a time empty': [
    'task_records_when_it_was_found',
    'action_records_when_it_happened',
    'attempt_records_when_it_started',
    'attempt_holds_a_lease',
  ],
  "a person's stop and retry arrive with T3, and T2 writes no human action on a task": [
    'stopped_has_stop_action',
    'stop_names_its_action',
    'action_on_task',
    'one_target',
    'target_fits_kind',
    'human_action_is_final',
  ],
  'routine edits arrive with the dashboard, and T2 seeds each routine with one version, so every claim finds one': [
    'attempt_follows_a_goal_version',
    'version_of_routine',
    'version_works_in_a_repository',
    'version_names_one_repository',
    'version_saved_by_action',
    'routine_version_is_final',
    'goal_not_blank',
    'schedule_is_five_cron_fields',
    'pause_names_its_action',
    'action_on_routine',
    'action_taken_by_person',
  ],
  'intake writes people, repositories, routines, and tasks, and T2 only seeds them': [
    'one_person_per_email',
    'email_is_lowercase',
    'one_person_per_jira_account',
    'names_owner_and_repository',
    'branch_not_blank',
    'one_row_per_branch',
    'routine_has_a_creator',
    'creator_is_a_person',
    'run_as_is_a_person',
    'one_task_per_key',
    'task_works_where_its_routine_said',
  ],
};

const moves = ['claim', 'renew', 'pass', 'hang', 'wake', 'crash', 'burst', 'late', 'reassign'] as const;

const assignees = ['jira-ada', 'jira-bo', 'jira-nobody', null] as const;

type Move = (typeof moves)[number];

type Profile = {
  readonly stepsPerTask: number;
  readonly workers: number;
  readonly nobodyEvery: number;
  readonly leaseMs: number;
  readonly stepMs: number;
  readonly burst: number;
  readonly odds: Readonly<Record<Move, number>>;
};

export const profiles: Readonly<Record<ProfileName, Profile>> = {
  default: {
    stepsPerTask: 20,
    workers: 4,
    nobodyEvery: 4,
    leaseMs: 30_000,
    stepMs: 6_000,
    burst: 5,
    odds: { claim: 6, renew: 6, pass: 4, hang: 1, wake: 1, crash: 1, burst: 1, late: 2, reassign: 1 },
  },
  races: {
    stepsPerTask: 20,
    workers: 4,
    nobodyEvery: 0,
    leaseMs: 30_000,
    stepMs: 6_000,
    burst: 20,
    odds: { claim: 2, renew: 4, pass: 4, hang: 0, wake: 0, crash: 0, burst: 4, late: 0, reassign: 0 },
  },
  hangs: {
    stepsPerTask: 20,
    workers: 4,
    nobodyEvery: 0,
    leaseMs: 2_000,
    stepMs: 400,
    burst: 5,
    odds: { claim: 6, renew: 3, pass: 3, hang: 3, wake: 0, crash: 1, burst: 0, late: 2, reassign: 0 },
  },
};

export const fingerprint = createHash('sha256').update(JSON.stringify({ moves, profiles, assignees })).digest('hex').slice(0, 16);

export type Plan = {
  readonly profile: ProfileName;
  readonly seeds: readonly number[];
  readonly steps: number;
  readonly mutant?: MutantName;
};

export type Entry = { readonly step: number; readonly at: number; readonly move: string; readonly detail: string };

export type Failure = { readonly step: number; readonly move: string; readonly broken: readonly Violation[] };

export type Burst = { readonly winners: number; readonly ms: number };

export type Run = {
  readonly plan: Plan;
  readonly seed: number;
  readonly steps: number;
  readonly failure: Failure | undefined;
  readonly bursts: readonly Burst[];
  readonly hung: number;
  readonly hungNotLost: readonly string[];
  readonly tally: Readonly<Record<string, number>>;
  readonly done: number;
  readonly trace: readonly Entry[];
};

export type Catalog = { readonly guards: number; readonly unlisted: readonly string[]; readonly absent: readonly string[]; readonly listedTwice: readonly string[] };

type Random = () => number;

type Worker = { readonly state: 'idle' } | { readonly state: 'busy' | 'hung'; readonly attempt: string };

type Held = { readonly index: number; readonly attempt: string };

type World = {
  readonly tasks: readonly string[];
  readonly workers: Worker[];
  readonly lost: string[];
  readonly hung: Set<string>;
  readonly bursts: Burst[];
  readonly tally: Map<string, number>;
  clock: number;
  nextReap: number;
};

type Turn = { readonly db: Database; readonly world: World; readonly profile: Profile; readonly random: Random; readonly quiet: boolean; readonly now: Date };

type Rule = { readonly allowed: (world: World, quiet: boolean) => boolean; readonly perform: (turn: Turn) => Promise<string> | string };

const lanes = Math.min(8, availableParallelism());

const epoch = Date.parse('2026-01-01T00:00:00.000Z');

const traceTail = 40;

const idle: Worker = { state: 'idle' };

function seeded(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: Random, items: readonly T[]): T | undefined => items[Math.floor(random() * items.length)];

function weighted(random: Random, weight: (move: Move) => number): Move | undefined {
  let roll = random() * moves.reduce((sum, move) => sum + weight(move), 0);
  for (const move of moves) {
    if (weight(move) > 0 && roll < weight(move)) return move;
    roll -= weight(move);
  }
  return undefined;
}

const idleWorkers = (world: World): readonly number[] => world.workers.flatMap((worker, index) => (worker.state === 'idle' ? [index] : []));

const held = (world: World, states: readonly ('busy' | 'hung')[]): readonly Held[] =>
  world.workers.flatMap((worker, index) => (worker.state !== 'idle' && states.includes(worker.state) ? [{ index, attempt: worker.attempt }] : []));

function count(world: World, outcome: string, times = 1): void {
  world.tally.set(outcome, (world.tally.get(outcome) ?? 0) + times);
}

async function unguardedLateWrite(db: Database, attempt: string, now: Date): Promise<'applied' | 'refused'> {
  try {
    await db.updateTable('attempt').set({ finished_at: now, verdict: 'pass', output: { late: true } }).where('id', '=', attempt).execute();
    return 'applied';
  } catch (error) {
    const found = refusal(error);
    if (found?.kind === 'final' && found.name === 'finished_attempt_is_final') return 'refused';
    throw error;
  }
}

const rules: Readonly<Record<Move, Rule>> = {
  claim: {
    allowed: world => idleWorkers(world).length > 0,
    perform: async ({ db, world, profile, random, quiet, now }) => {
      const worker = pick(random, idleWorkers(world));
      const task = pick(random, quiet ? await claimable(db) : world.tasks);
      if (worker === undefined || task === undefined) return 'nothing to claim';
      const outcome = await claim(db, task, now, profile.leaseMs);
      if ('refused' in outcome) {
        const refused = 'parked' in outcome ? `${outcome.refused}, ${outcome.parked ? 'parked' : 'not parked'}` : outcome.refused;
        count(world, `claim refused ${refused}`);
        return `task ${task}: ${refused}`;
      }
      count(world, 'claim won');
      world.workers[worker] = { state: 'busy', attempt: outcome.attempt };
      return `task ${task}: attempt ${outcome.attempt}`;
    },
  },
  renew: {
    allowed: world => held(world, ['busy']).length > 0,
    perform: async ({ db, world, profile, random, now }) => {
      const worker = pick(random, held(world, ['busy']));
      if (worker === undefined) return 'no busy worker';
      const outcome = await renew(db, worker.attempt, now, profile.leaseMs);
      count(world, `renew ${outcome}`);
      if (outcome === 'lost') world.workers[worker.index] = idle;
      return `attempt ${worker.attempt}: ${outcome}`;
    },
  },
  pass: {
    allowed: world => held(world, ['busy']).length > 0,
    perform: async ({ db, world, random, now }) => {
      const worker = pick(random, held(world, ['busy']));
      if (worker === undefined) return 'no busy worker';
      world.workers[worker.index] = idle;
      const outcome = await pass(db, worker.attempt, { summary: 'passed by a simulated worker' }, now);
      count(world, `pass ${outcome}`);
      return `attempt ${worker.attempt}: ${outcome}`;
    },
  },
  hang: {
    allowed: (world, quiet) => !quiet && held(world, ['busy']).length > 0,
    perform: ({ world, random }) => {
      const worker = pick(random, held(world, ['busy']));
      if (worker === undefined) return 'no busy worker';
      world.workers[worker.index] = { state: 'hung', attempt: worker.attempt };
      world.hung.add(worker.attempt);
      count(world, 'hang');
      return `attempt ${worker.attempt}`;
    },
  },
  wake: {
    allowed: (world, quiet) => !quiet && held(world, ['hung']).length > 0,
    perform: ({ world, random }) => {
      const worker = pick(random, held(world, ['hung']));
      if (worker === undefined) return 'no hung worker';
      world.workers[worker.index] = { state: 'busy', attempt: worker.attempt };
      world.hung.delete(worker.attempt);
      count(world, 'wake');
      return `attempt ${worker.attempt}`;
    },
  },
  crash: {
    allowed: (world, quiet) => !quiet && held(world, ['busy', 'hung']).length > 0,
    perform: ({ world, random }) => {
      const worker = pick(random, held(world, ['busy', 'hung']));
      if (worker === undefined) return 'no worker holds an attempt';
      world.workers[worker.index] = idle;
      count(world, 'crash');
      return `attempt ${worker.attempt} is left to its lease`;
    },
  },
  burst: {
    allowed: (_world, quiet) => !quiet,
    perform: async ({ db, world, profile, random, now }) => {
      const task = pick(random, await claimable(db));
      if (task === undefined) return 'nothing claimable';
      const started = performance.now();
      const outcomes = await Promise.all(Array.from({ length: profile.burst }, () => claim(db, task, now, profile.leaseMs)));
      const won = outcomes.flatMap(outcome => ('attempt' in outcome ? [outcome.attempt] : []));
      world.bursts.push({ winners: won.length, ms: performance.now() - started });
      count(world, 'burst');
      const taker = pick(random, idleWorkers(world));
      const [winner] = won;
      if (taker !== undefined && winner !== undefined && won.length === 1) world.workers[taker] = { state: 'busy', attempt: winner };
      return `task ${task}: ${String(won.length)} of ${String(profile.burst)} claims won`;
    },
  },
  late: {
    allowed: (world, quiet) => !quiet && world.lost.length > 0,
    perform: async ({ db, world, profile, random, now }) => {
      const attempt = pick(random, world.lost);
      if (attempt === undefined) return 'no lost attempt';
      if (random() < 0.5) {
        const outcome = random() < 0.5 ? await renew(db, attempt, now, profile.leaseMs) : await pass(db, attempt, { summary: 'a late result' }, now);
        count(world, `guarded late write ${outcome}`);
        return `guarded late write on attempt ${attempt}: ${outcome}`;
      }
      const outcome = await unguardedLateWrite(db, attempt, now);
      count(world, `unguarded late write ${outcome}`);
      return `unguarded late write on attempt ${attempt}: ${outcome}`;
    },
  },
  reassign: {
    allowed: (_world, quiet) => !quiet,
    perform: async ({ db, world, random }) => {
      const task = pick(random, world.tasks);
      const assignee = pick(random, assignees) ?? null;
      if (task === undefined) return 'no task';
      await db.updateTable('task').set({ assignee_account_id: assignee }).where('id', '=', task).execute();
      count(world, 'reassign');
      return `task ${task}: assignee ${assignee ?? 'none'}`;
    },
  },
};

async function reapStep({ db, world, profile, now }: Turn): Promise<string> {
  world.nextReap += profile.leaseMs / 2;
  const reaped = await reap(db, now);
  const ended = new Set(reaped.map(entry => entry.attempt));
  world.workers.forEach((worker, index) => {
    if (worker.state !== 'idle' && ended.has(worker.attempt)) world.workers[index] = idle;
  });
  world.lost.push(...reaped.map(entry => entry.attempt));
  count(world, 'reaped', reaped.length);
  count(world, 'parked by the reap', reaped.filter(entry => entry.parked).length);
  return reaped
    .map(entry => `attempt ${entry.attempt} of task ${entry.task} (${entry.key}), lease expired ${String(entry.expiredForMs)} ms before the reap${entry.parked ? ', parked the task' : ''}`)
    .join('; ');
}

async function perform(turn: Turn): Promise<{ readonly move: string; readonly detail: string }> {
  if (turn.world.clock >= turn.world.nextReap) return { move: 'reap', detail: await reapStep(turn) };
  const move = weighted(turn.random, candidate => (rules[candidate].allowed(turn.world, turn.quiet) ? turn.profile.odds[candidate] : 0));
  if (move === undefined) return { move: 'idle', detail: 'no move is allowed' };
  return { move, detail: await rules[move].perform(turn) };
}

async function dropGuard(db: Database, name: MutantName): Promise<void> {
  const { rows } = await sql<{ ddl: string }>`
    select format('alter table %s drop constraint %I', conrelid::regclass, conname) as ddl
    from pg_constraint where conname = ${name} and connamespace = 'public'::regnamespace
    union all
    select format('drop index %s', x.indexrelid::regclass)
    from pg_index x
    where x.indexrelid = to_regclass(${name})
      and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))
    union all
    select format('drop trigger %I on %s', tgname, tgrelid::regclass)
    from pg_trigger where tgname = ${name} and not tgisinternal`.execute(db);
  const [only, ...more] = rows;
  if (only === undefined || more.length > 0) throw new Error(`mutant ${name} must name exactly one constraint, index, or trigger, and it names ${String(rows.length)}`);
  await sql.raw(only.ddl).execute(db);
}

async function setUp(db: Database, profile: Profile, steps: number): Promise<World> {
  const at = new Date(epoch);
  const ada = await db.insertInto('person').values({ email: 'ada@example.com', name: 'Ada', jira_account_id: 'jira-ada' }).returning('id').executeTakeFirstOrThrow();
  await db.insertInto('person').values({ email: 'bo@example.com', name: 'Bo', jira_account_id: 'jira-bo' }).execute();
  const team = await db.insertInto('person').values({ email: 'release-team@example.com', name: 'Release team', kind: 'shared' }).returning('id').executeTakeFirstOrThrow();
  const repository = await db.insertInto('repository').values({ github: 'example/sandbox', branch: 'main' }).returning('id').executeTakeFirstOrThrow();
  const asTeam = await db.insertInto('routine').values({ creator_id: ada.id, run_as_id: team.id }).returning('id').executeTakeFirstOrThrow();
  const asAssignee = await db.insertInto('routine').values({ creator_id: ada.id }).returning('id').executeTakeFirstOrThrow();
  for (const [index, routine] of [asTeam, asAssignee].entries()) {
    const action = `00000000-0000-4000-8000-00000000000${String(index + 1)}`;
    await db.insertInto('human_action').values({ id: action, at, person_id: ada.id, kind: 'edit_routine', routine_id: routine.id }).execute();
    await db
      .insertInto('routine_version')
      .values({ routine_id: routine.id, version: 1, name: 'Labeled tickets', goal: 'Take each labeled ticket to a merged change.', schedule: '*/15 * * * *', repository_id: repository.id, action_id: action })
      .execute();
  }
  const tasks = await db
    .insertInto('task')
    .values(
      Array.from({ length: Math.max(4, Math.ceil(steps / profile.stepsPerTask)) }, (_, index) => {
        const nobody = profile.nobodyEvery > 0 && index % profile.nobodyEvery === profile.nobodyEvery - 1;
        return {
          routine_id: nobody || index % 2 === 1 ? asAssignee.id : asTeam.id,
          found_version: 1,
          repository_id: repository.id,
          key: `SIM-${String(index + 1)}`,
          title: `Ticket ${String(index + 1)}`,
          found_at: at,
          assignee_account_id: nobody ? 'jira-nobody' : 'jira-bo',
        };
      }),
    )
    .returning('id')
    .execute();
  return {
    tasks: tasks.map(task => task.id),
    workers: Array.from({ length: profile.workers }, () => idle),
    lost: [],
    hung: new Set(),
    bursts: [],
    tally: new Map(),
    clock: epoch,
    nextReap: epoch + profile.leaseMs / 2,
  };
}

async function tasksIn(db: Database, state: TaskState): Promise<number> {
  const { tasks } = await db
    .selectFrom('task')
    .select(eb => eb.fn.countAll<string>().as('tasks'))
    .where('state', '=', state)
    .executeTakeFirstOrThrow();
  return Number(tasks);
}

async function hungNotLost(db: Database, hung: ReadonlySet<string>): Promise<readonly string[]> {
  if (hung.size === 0) return [];
  const rows = await db.selectFrom('attempt').select('id').where('id', 'in', [...hung]).where('verdict', 'is distinct from', 'lost').orderBy('id').execute();
  return rows.map(row => row.id);
}

async function runSeed(postgres: TestPostgres, plan: Plan, seed: number): Promise<Run> {
  const profile = profiles[plan.profile];
  const random = seeded(seed);
  const trace: Entry[] = [];
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, profile.burst + 2);
  try {
    if (plan.mutant !== undefined) await dropGuard(db, plan.mutant);
    const world = await setUp(db, profile, plan.steps);
    const watched = await watch(db);
    const ended = async (steps: number, failure: Failure | undefined): Promise<Run> => ({
      plan,
      seed,
      steps,
      failure,
      bursts: world.bursts,
      hung: world.hung.size,
      hungNotLost: failure === undefined ? await hungNotLost(db, world.hung) : [],
      tally: Object.fromEntries(world.tally),
      done: await tasksIn(db, 'done'),
      trace: failure === undefined ? trace.slice(-traceTail) : trace,
    });
    if (watched.atStart.length > 0) return await ended(0, { step: 0, move: 'setup', broken: watched.atStart });
    const quietCap = world.tasks.length * 40 + 100;
    let step = 0;
    while (step < plan.steps + quietCap) {
      step += 1;
      const quiet = step > plan.steps;
      if (quiet && (await tasksIn(db, 'ready')) === 0) break;
      const made = await perform({ db, world, profile, random, quiet, now: new Date(world.clock) });
      trace.push({ step, at: world.clock - epoch, ...made });
      const broken = await watched.step();
      if (broken.length > 0) return await ended(step, { step, move: made.move, broken });
      world.clock += 1 + Math.floor(random() * profile.stepMs);
    }
    const unsettled = await watched.settled();
    return await ended(step, unsettled.length > 0 ? { step, move: 'the quiet phase ended', broken: unsettled } : undefined);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const where = `${plan.profile} seed ${String(seed)}${plan.mutant === undefined ? '' : ` without ${plan.mutant}`}`;
    throw new Error(`${where} threw after step ${String(trace.at(-1)?.step ?? 0)}: ${reason}`, { cause: error });
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

export async function simulate(postgres: TestPostgres, plans: readonly Plan[], onFailure?: (run: Run) => void): Promise<readonly Run[]> {
  const jobs = plans.flatMap(plan => plan.seeds.map(seed => ({ plan, seed })));
  const runs: Run[] = [];
  const errors: unknown[] = [];
  let next = 0;
  const lane = async (): Promise<void> => {
    while (errors.length === 0 && next < jobs.length) {
      const index = next;
      next += 1;
      const job = jobs[index];
      if (job === undefined) return;
      try {
        const run = await runSeed(postgres, job.plan, job.seed);
        runs[index] = run;
        if (run.failure !== undefined) onFailure?.(run);
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, jobs.length) }, lane));
  if (errors.length > 0) throw errors[0];
  return runs;
}

export async function checkCatalog(postgres: TestPostgres): Promise<Catalog> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 1);
  try {
    const { rows } = await sql<{ name: string }>`
      with owned as (select unnest(${ownedTables}::regclass[]) as relation)
      select c.conname as name
      from pg_constraint c
      join owned o on o.relation = c.conrelid
      join pg_class t on t.oid = c.conrelid
      left join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where not (c.contype = 'p' and c.conname = t.relname || '_pkey')
        and not (c.contype = 'n' and c.conname = t.relname || '_' || a.attname || '_not_null')
      union all
      select i.relname
      from pg_index x
      join owned o on o.relation = x.indrelid
      join pg_class i on i.oid = x.indexrelid
      where not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u', 'x'))
      union all
      select g.tgname
      from pg_trigger g
      join owned o on o.relation = g.tgrelid
      where not g.tgisinternal`.execute(db);
    const guards = new Set(rows.map(row => row.name));
    const listed = [...Object.keys(mutants), ...Object.values(noMutantYet).flat()];
    return {
      guards: guards.size,
      unlisted: [...guards].filter(name => !listed.includes(name)).sort(),
      absent: listed.filter(name => !guards.has(name)).sort(),
      listedTwice: [...new Set(listed.filter((name, index) => listed.indexOf(name) !== index))].sort(),
    };
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}
