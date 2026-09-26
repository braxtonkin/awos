import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { sql } from 'kysely';
import type { Database } from '../../shared/db/client.ts';
import type { CredentialState, TaskState, WaitingOn } from '../../shared/db/types.ts';
import { review } from '../../shared/review.ts';
import { checksOf, fail, info, pass, type Check, type Line, type Scenario } from '../../tools/verify/check.ts';
import { buildAttemptImage, ensureRegistry, jobNamespace, kindAddress, kubernetes, registry, repositoryRoot } from '../../tools/verify/cluster.ts';
import { kind } from '../../tools/verify/kind.ts';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { accessCopy, actAs, applySetup, closeStore, driverSettings, fakeCodexLogin, openStore, standInImage, startEngine, type Engine, type Store } from './autoworker.ts';
import { catalog, scripts, type Entry, type Script, type ScriptName } from './catalog.ts';
import { ticking } from './codex-stand-in.ts';
import { localLogins, startLocalWorld, type LocalWorld } from './local-world.ts';
import { sandboxSeed } from './sandbox-seed.ts';

const run = promisify(execFile);

const repository = 'example/sandbox';
const repositoryBranch = 'main';
const project = 'LOCAL';
const serviceAccount = 'autoworker-job';
const settleMs = 8 * 60_000;
const pollMs = 1_000;
const namespaceGoneMs = 120_000;
const restartDelayMs = 1_000;
const longTicks = 3_600;
const steerText = 'Also log the start time once.';
const expiredTokenVariable = 'EXPIRED_GITHUB_TOKEN';

type Person = { readonly name: string; readonly email: string; readonly jiraAccountId?: string };

export const actingPerson: Person = { name: 'Braxton Kinney', email: 'braxton.kinney@example.com', jiraAccountId: localLogins.jiraAccountId };

const worker: Person = { name: 'Priya Natarajan', email: 'priya.natarajan@example.com' };

const people: readonly Person[] = [actingPerson, worker, { name: 'Tomás Rivera', email: 'tomas.rivera@example.com' }, { name: 'Mei Chen', email: 'mei.chen@example.com' }];

const routines = {
  work: { name: 'Local work', goal: 'Take each local ticket as far as its script goes.', label: 'local-work', gates: [], runAs: worker.email },
  gated: { name: 'Gated work', goal: 'Plan each gated ticket, then wait for a person to approve the plan.', label: 'local-gated', gates: ['specify'], runAs: worker.email },
  unassigned: { name: 'Unassigned work', goal: 'Take each ticket as its assignee, with nobody to fall back on.', label: 'local-unassigned', gates: [], runAs: undefined },
  past: { name: 'Past work', goal: 'Hold the tasks that finished before this world started.', label: 'local-past', gates: [], runAs: worker.email },
} as const;

type RoutineName = keyof typeof routines;

export const seedNames = ['running', 'steer-acted', 'question', 'waiting-gate', 'failed-behavior', 'failed-environment', 'stopped', 'done', 'expired', 'nobody-to-run-as', 'login-expired', 'no-tasks', 'no-routines'] as const;

export type SeedName = (typeof seedNames)[number];

type Then = 'steer' | 'stop';

type Plant =
  | { readonly kind: 'ticket'; readonly routine: Exclude<RoutineName, 'past'>; readonly work: ScriptName | 'catalog'; readonly ticks?: number; readonly assigned: boolean; readonly then?: Then }
  | { readonly kind: 'past'; readonly key: string }
  | { readonly kind: 'login' }
  | { readonly kind: 'empty'; readonly routines: boolean };

type TaskExpect = {
  readonly kind: 'task';
  readonly state: TaskState;
  readonly step: string;
  readonly waitingOn: WaitingOn | null;
  readonly reason: string | null;
  readonly streaming: boolean;
  readonly steer: 'none' | 'sent' | 'acted';
  readonly choice: boolean;
  readonly aged: boolean;
};

type Expect = TaskExpect | { readonly kind: 'login'; readonly state: CredentialState } | { readonly kind: 'world'; readonly routines: boolean; readonly tasks: number };

type Seed = { readonly plant: Plant; readonly expect: Expect };

const quiet = { waitingOn: null, reason: null, streaming: false, steer: 'none', choice: false, aged: false } as const;

const waitsForRetry = (step: string, reason: string): TaskExpect => ({ kind: 'task', state: 'waiting', step, ...quiet, waitingOn: 'retry', reason });

export const seeds: Readonly<Record<SeedName, Seed>> = {
  running: { plant: { kind: 'ticket', routine: 'work', work: 'longStream', ticks: longTicks, assigned: true }, expect: { kind: 'task', state: 'ready', step: 'specify', ...quiet, streaming: true } },
  'steer-acted': {
    plant: { kind: 'ticket', routine: 'work', work: 'longStream', ticks: longTicks, assigned: true, then: 'steer' },
    expect: { kind: 'task', state: 'ready', step: 'specify', ...quiet, streaming: true, steer: 'acted' },
  },
  question: {
    plant: { kind: 'ticket', routine: 'work', work: 'question', assigned: true },
    expect: { kind: 'task', state: 'waiting', step: 'specify', ...quiet, waitingOn: 'answer', reason: 'Answer the review specify left for task', choice: true },
  },
  'waiting-gate': {
    plant: { kind: 'ticket', routine: 'gated', work: 'catalog', assigned: true },
    expect: { kind: 'task', state: 'waiting', step: 'specify', ...quiet, waitingOn: 'approval', reason: 'Approve specify for task' },
  },
  'failed-behavior': { plant: { kind: 'ticket', routine: 'work', work: 'stillWrong', assigned: true }, expect: waitsForRetry('verify', 'Retry starts again at Implement, because Verify') },
  'failed-environment': { plant: { kind: 'ticket', routine: 'work', work: 'brokenEnvironment', assigned: true }, expect: waitsForRetry('verify', "Verify's environment failed 4 times in a row.") },
  stopped: { plant: { kind: 'ticket', routine: 'work', work: 'longStream', assigned: true, then: 'stop' }, expect: { kind: 'task', state: 'stopped', step: 'specify', ...quiet } },
  done: { plant: { kind: 'past', key: 'PAST-1' }, expect: { kind: 'task', state: 'done', step: 'land', ...quiet } },
  expired: { plant: { kind: 'past', key: 'PAST-2' }, expect: { kind: 'task', state: 'done', step: 'land', ...quiet, aged: true } },
  'nobody-to-run-as': { plant: { kind: 'ticket', routine: 'unassigned', work: 'longStream', assigned: false }, expect: waitsForRetry('specify', 'Nobody to run this task as.') },
  'login-expired': { plant: { kind: 'login' }, expect: { kind: 'login', state: 'invalid' } },
  'no-tasks': { plant: { kind: 'empty', routines: true }, expect: { kind: 'world', routines: true, tasks: 0 } },
  'no-routines': { plant: { kind: 'empty', routines: false }, expect: { kind: 'world', routines: false, tasks: 0 } },
};

type Observed = TaskExpect | { readonly kind: 'login'; readonly state: CredentialState | null } | { readonly kind: 'world'; readonly routines: boolean; readonly tasks: number } | { readonly kind: 'missing'; readonly what: string };

function differences(expected: Expect, observed: Observed): readonly string[] {
  if (observed.kind === 'missing') return [observed.what];
  if (expected.kind !== observed.kind) return [`reads back as a ${observed.kind}, not a ${expected.kind}`];
  return Object.entries(expected).flatMap(([field, want]: [string, unknown]) => {
    const got: unknown = Reflect.get(observed, field);
    const same = field === 'reason' && typeof want === 'string' && typeof got === 'string' ? got.startsWith(want) : got === want;
    return same ? [] : [`${field} is ${JSON.stringify(got)}, not ${JSON.stringify(want)}`];
  });
}

const reviewOutput = review.loose();

async function taskFacts(db: Database, key: string): Promise<Observed> {
  const row = await db
    .selectFrom('task')
    .leftJoin('attempt as review', 'review.id', 'task.review_attempt')
    .select(eb => [
      'task.state',
      'task.step',
      'task.waiting_on',
      'task.waiting_reason',
      'review.output',
      eb
        .exists(
          eb
            .selectFrom('attempt')
            .innerJoin('attempt_event', 'attempt_event.attempt_id', 'attempt.id')
            .select('attempt.id')
            .whereRef('attempt.task_id', '=', 'task.id')
            .where('attempt.finished_at', 'is', null)
            .where('attempt_event.method', '=', 'item/completed')
            .where(sql<boolean>`attempt_event.body -> 'params' -> 'item' ->> 'type' = 'agentMessage'`),
        )
        .$castTo<boolean>()
        .as('streaming'),
      eb
        .selectFrom('attempt_command')
        .innerJoin('attempt', 'attempt.id', 'attempt_command.attempt_id')
        .select(sql<string>`case when count(*) = 0 then 'none' when bool_or(attempt_command.acted_at is not null) then 'acted' else 'sent' end`.as('steer'))
        .whereRef('attempt.task_id', '=', 'task.id')
        .where('attempt_command.kind', '=', 'turn.steer')
        .as('steer'),
      eb
        .selectFrom('attempt')
        .select(sql<boolean>`coalesce(now() - max(attempt.finished_at) > interval '30 days', false)`.as('aged'))
        .whereRef('attempt.task_id', '=', 'task.id')
        .as('aged'),
    ])
    .where('task.key', '=', key)
    .executeTakeFirst();
  if (row === undefined) return { kind: 'missing', what: `no task has the key ${key} yet` };
  const blocks = reviewOutput.safeParse(row.output).data?.blocks ?? [];
  const choices = blocks.filter(block => block.kind === 'choice');
  return {
    kind: 'task',
    state: row.state,
    step: row.step,
    waitingOn: row.waiting_on,
    reason: row.waiting_reason,
    streaming: row.streaming,
    steer: row.steer === 'acted' || row.steer === 'sent' ? row.steer : 'none',
    choice: choices.length === 1 && choices.every(block => block.recommended !== null),
    aged: row.aged ?? false,
  };
}

async function attemptsOf(db: Database, key: string): Promise<string> {
  const rows = await db.selectFrom('attempt').innerJoin('task', 'task.id', 'attempt.task_id').select(['attempt.step', 'attempt.verdict']).where('task.key', '=', key).orderBy('attempt.id').execute();
  return rows.map(row => `${row.step} ${row.verdict ?? 'live'}`).join(', ') || 'none';
}

async function loginFacts(db: Database): Promise<Observed> {
  const row = await db
    .selectFrom('credential')
    .innerJoin('person', 'person.id', 'credential.person_id')
    .select('credential.state')
    .where('person.email', '=', actingPerson.email)
    .where('credential.connector', '=', 'github')
    .executeTakeFirst();
  return row === undefined ? { kind: 'missing', what: `${actingPerson.name} has no GitHub login` } : { kind: 'login', state: row.state };
}

async function worldFacts(db: Database): Promise<Observed> {
  const count = async (table: 'routine' | 'task'): Promise<number> => Number((await db.selectFrom(table).select(eb => eb.fn.countAll<string>().as('rows')).executeTakeFirstOrThrow()).rows);
  return { kind: 'world', routines: (await count('routine')) > 0, tasks: await count('task') };
}

type Planted = { readonly name: SeedName; readonly key: string | undefined; done: boolean; observed: Observed };

const factsOf = (db: Database, entry: Planted): Promise<Observed> => {
  if (seeds[entry.name].plant.kind === 'login') return loginFacts(db);
  return entry.key === undefined ? Promise.resolve(entry.observed) : taskFacts(db, entry.key);
};

const describe = (planted: Planted): string => {
  const { observed } = planted;
  switch (observed.kind) {
    case 'task':
      return `${planted.key ?? ''} ${observed.state} at ${observed.step}${observed.waitingOn === null ? '' : `, waiting on ${observed.waitingOn}`}${observed.streaming ? ', streaming' : ''}${observed.steer === 'none' ? '' : `, steer ${observed.steer}`}${observed.choice ? ', one choice block with a recommended option' : ''}${observed.aged ? ', finished more than 30 days ago' : ''}`;
    case 'login':
      return `${actingPerson.name}'s GitHub login is ${observed.state ?? 'unchecked'}`;
    case 'world':
      return `${observed.routines ? 'routines' : 'no routines'}, ${String(observed.tasks)} tasks`;
    case 'missing':
      return observed.what;
  }
};

const ticketWork = (work: ScriptName | 'catalog'): Entry | Script | undefined => (work === 'catalog' ? catalog[0] : scripts.find(entry => entry.name === work));

function descriptionOf(plant: Extract<Plant, { kind: 'ticket' }>): { readonly summary: string; readonly description: string } {
  const work = ticketWork(plant.work);
  if (work === undefined) throw new Error(`no catalog entry or script is named ${plant.work}`);
  const ticks = plant.ticks ?? ('ticks' in work ? work.ticks : 0);
  return { summary: work.summary, description: ticks === 0 ? work.description : `${work.description}\n\n${ticking(ticks, 1000)}` };
}

function setupFile(login: string, wanted: readonly SeedName[], withRoutines: boolean): object {
  const expired = wanted.includes('login-expired');
  return {
    admin: actingPerson.email,
    people: people.map(person => ({
      ...person,
      logins: { github: { env: expired && person === actingPerson ? expiredTokenVariable : 'GITHUB_TOKEN' }, codex: { file: login }, jira: { env: 'AUTOWORKER_JIRA_LOGIN' } },
    })),
    repositories: [{ github: repository, branch: repositoryBranch }],
    routines: withRoutines
      ? Object.values(routines).map(routine => ({
          name: routine.name,
          goal: routine.goal,
          workflow: 'code-change',
          source: { kind: 'jira-search', jql: `project = ${project} AND labels = ${routine.label}` },
          everyMinutes: 1,
          repository: { github: repository, branch: repositoryBranch },
          creator: actingPerson.email,
          gates: [...routine.gates],
          ...(routine.runAs === undefined ? {} : { runAs: routine.runAs }),
        }))
      : [],
  };
}

type Supervised = { readonly stop: () => Promise<void>; readonly starts: () => number; readonly said: () => string };

function supervise(store: Store, settings: Readonly<Record<string, string>>, stopping: AbortSignal, out: (line: string) => void): Supervised {
  const stopped = new AbortController();
  const signal = AbortSignal.any([stopping, stopped.signal]);
  let engine: Engine = startEngine(store, settings);
  let starts = 1;
  let said = '';
  const watching = (async () => {
    while (!signal.aborted) {
      const ended = await Promise.race([engine.exited.then(() => 'exited' as const), once(signal, 'abort').then(() => 'stopping' as const)]);
      if (ended === 'stopping') return;
      said += engine.said();
      out(`the engine exited, so local-engine starts it again in ${String(restartDelayMs)} ms`);
      const waited = await wait(restartDelayMs, undefined, { signal }).then(
        () => true,
        () => false,
      );
      if (!waited) return;
      engine = startEngine(store, settings);
      starts += 1;
    }
  })();
  return {
    stop: async () => {
      stopped.abort();
      await watching;
      await engine.stop();
    },
    starts: () => starts,
    said: () => said + engine.said(),
  };
}

const agents = ['stand-in', 'real'] as const;

type Agent = (typeof agents)[number];

type Options = { readonly wanted: readonly SeedName[]; readonly check: boolean; readonly plant: SeedName | undefined; readonly agent: Agent };

const optionsSpec = { seed: { type: 'string', multiple: true }, check: { type: 'boolean', default: false }, plant: { type: 'string' }, agent: { type: 'string', default: 'stand-in' } } as const;

function optionsOf(args: readonly string[]): Options | Check {
  const { values } = parseArgs({ args: [...args], options: optionsSpec, strict: true });
  const given = (values.seed ?? []).flatMap(name => (name === 'all' ? [...seedNames] : [name]));
  const unknown = given.filter(name => !seedNames.some(seed => seed === name));
  if (unknown.length > 0) return fail('seeds named', `${unknown.join(', ')} is not a seed; name all or one of ${seedNames.join(', ')}`);
  const wanted = seedNames.filter(name => given.includes(name));
  const plant = values.plant === undefined ? undefined : seedNames.find(name => name === values.plant);
  const target = plant === undefined ? undefined : seeds[plant].expect;
  if (values.plant !== undefined && (plant === undefined || !wanted.includes(plant) || target?.kind !== 'task' || (target.state !== 'ready' && target.state !== 'waiting'))) {
    return fail('plant named', '--plant takes one seeded task that waits or runs, which local-engine then stops so the check must name it');
  }
  if (plant !== undefined && !values.check) return fail('plant named', '--plant needs --check');
  const agent = agents.find(name => name === values.agent);
  if (agent === undefined) return fail('agent named', `--agent takes ${agents.join(' or ')}; real runs Codex from the live service's login`);
  return { wanted, check: values.check, plant, agent };
}

async function pastSeed(store: Store, seed: SeedName, key: string): Promise<string> {
  const args = [join(repositoryRoot, 'tools/verify/main.ts'), 'tasks-seed', seed, '--database', store.url, '--routine', routines.past.name, '--key', key];
  const { stdout } = await run(process.execPath, args, { cwd: repositoryRoot, timeout: 120_000 });
  return stdout.trim().split('\n').filter(line => line.startsWith('PASS') || line.startsWith('FAIL')).join('; ');
}

async function namespaceGone(namespace: string): Promise<boolean> {
  const core = kubernetes();
  const deadline = Date.now() + namespaceGoneMs;
  while (Date.now() < deadline) {
    const found = await core.readNamespace({ name: namespace }).then(
      () => true,
      () => false,
    );
    if (!found) return true;
    await wait(pollMs);
  }
  return false;
}

async function settle(store: Store, planted: readonly Planted[], signal: AbortSignal, out: (line: string) => void): Promise<void> {
  const deadline = Date.now() + settleMs;
  const acted = new Set<SeedName>();
  while (!signal.aborted && Date.now() < deadline && planted.some(entry => !entry.done)) {
    for (const entry of planted.filter(candidate => !candidate.done)) {
      const { plant, expect } = seeds[entry.name];
      entry.observed = await factsOf(store.db, entry);
      if (plant.kind === 'ticket' && plant.then !== undefined && !acted.has(entry.name) && entry.observed.kind === 'task' && entry.observed.streaming && entry.key !== undefined) {
        const asked = plant.then === 'steer' ? ['steer', entry.key, '--message', steerText] : ['stop', entry.key];
        const sent = (await actAs(store, [...asked, '--as', actingPerson.email])).code === 0;
        if (sent) {
          acted.add(entry.name);
          out(`seed ${entry.name}: ${plant.then === 'steer' ? 'steered' : 'stopped'} ${entry.key} while it streamed`);
        }
        continue;
      }
      if (differences(expect, entry.observed).length === 0) {
        entry.done = true;
        out(`seed ${entry.name}: ${describe(entry)}`);
      }
    }
    await wait(pollMs, undefined, { signal }).catch(() => undefined);
  }
}

type Plants = { readonly planted: readonly Planted[]; readonly counts: readonly string[] };

async function plantAll(store: Store, local: LocalWorld, wanted: readonly SeedName[], agent: Agent, out: (line: string) => void): Promise<Plants> {
  const login = join(store.folder, 'codex.json');
  await writeFile(login, agent === 'real' ? await accessCopy() : fakeCodexLogin(), { mode: 0o600 });
  const secrets = { GITHUB_TOKEN: local.engine.secrets.GITHUB_TOKEN, AUTOWORKER_JIRA_LOGIN: local.engine.secrets.AUTOWORKER_JIRA_LOGIN, [expiredTokenVariable]: 'expired-github-token' };
  const applied = async (withRoutines: boolean): Promise<string> => {
    const result = await applySetup(store, setupFile(login, wanted, withRoutines), secrets);
    if (result.code !== 0) throw new Error(`setup failed: ${result.out}`);
    return result.out.replaceAll('\n', '; ');
  };
  const planted: Planted[] = [];
  const counts = [await applied(false)];
  if (wanted.includes('no-routines')) planted.push({ name: 'no-routines', key: undefined, done: true, observed: await worldFacts(store.db) });
  for (const name of wanted) {
    const { plant } = seeds[name];
    if (plant.kind !== 'ticket') continue;
    const { summary, description } = descriptionOf(plant);
    const key = await local.jira.fileTicket({ project, summary, description, label: routines[plant.routine].label, assignee: plant.assigned ? (actingPerson.jiraAccountId ?? null) : null });
    planted.push({ name, key, done: false, observed: { kind: 'missing', what: `the engine has not found ${key}` } });
  }
  if (wanted.some(name => name !== 'no-routines')) counts.push(await applied(true));
  if (wanted.includes('no-tasks')) planted.push({ name: 'no-tasks', key: undefined, done: true, observed: await worldFacts(store.db) });
  await store.db
    .updateTable('credential')
    .set({ state: 'valid', checked_at: new Date() })
    .$if(wanted.includes('login-expired'), update =>
      update.where('credential.id', 'not in', store.db.selectFrom('credential').innerJoin('person', 'person.id', 'credential.person_id').select('credential.id').where('person.email', '=', actingPerson.email).where('credential.connector', '=', 'github')),
    )
    .execute();
  for (const name of wanted) {
    const { plant } = seeds[name];
    if (plant.kind === 'past') {
      out(`seed ${name}: ${await pastSeed(store, name, plant.key)}`);
      planted.push({ name, key: plant.key, done: false, observed: await taskFacts(store.db, plant.key) });
    }
    if (plant.kind === 'login') planted.push({ name, key: undefined, done: false, observed: await loginFacts(store.db) });
  }
  return { planted, counts };
}

async function hold(signal: AbortSignal, out: (line: string) => void, options: Options): Promise<readonly Line[]> {
  const began = performance.now();
  const lines: Line[] = [];
  const up = checksOf(await kind.run(['up']));
  if (!up.every(check => check.passed)) return up;
  out(await ensureRegistry());
  const attemptImage = await buildAttemptImage(`${registry.host}/autoworker-job:e2e`);
  const image = options.agent === 'real' ? attemptImage : await standInImage(attemptImage);
  const address = await kindAddress();
  const namespace = `local-${randomBytes(4).toString('hex')}`;
  const core = kubernetes();
  await jobNamespace(core, namespace, serviceAccount);
  let world: LocalWorld | undefined;
  try {
    world = await startLocalWorld(address, repository);
    const local = world;
    await local.github.seedBranch(repositoryBranch, await sandboxSeed(), 'Seed the local sandbox');
    return await withPostgres(async postgres => {
      const scratch = await postgres.scratch();
      const store = await openStore(scratch.url);
      try {
        const { planted, counts } = await plantAll(store, local, options.wanted, options.agent, out);
        const settings = { ...driverSettings(local.engine.settings, image, namespace, address), CHECKS_EVERY_MS: '5000' };
        const engine = supervise(store, settings, signal, out);
        try {
          await settle(store, planted, signal, out);
          if (signal.aborted) {
            lines.push(info('local engine ready', 'n/a', 'SIGTERM arrived before every seed settled'));
          } else {
            out('local engine ready');
            out(`DATABASE_URL=${store.url}`);
            out(`JOB_NAMESPACE=${namespace}`);
            for (const count of counts) out(`setup: ${count}`);
            for (const entry of planted) out(`seed ${entry.name}: ${describe(entry)}${entry.done ? '' : ', not yet as named'}${entry.key === undefined ? '' : `; attempts: ${await attemptsOf(store.db, entry.key)}`}`);
            lines.push(info('seconds to ready', 'passed', ((performance.now() - began) / 1000).toFixed(1)));
            if (options.check) {
              if (options.plant !== undefined) {
                const target = planted.find(entry => entry.name === options.plant);
                if (target?.key !== undefined) out(`plant: ${(await actAs(store, ['stop', target.key, '--as', actingPerson.email])).out}`);
              }
              for (const entry of planted) {
                const observed = await factsOf(store.db, entry);
                const wrong = differences(seeds[entry.name].expect, observed);
                const name = `seed ${entry.name} reads back as named`;
                lines.push(wrong.length === 0 ? pass(name, describe({ ...entry, observed })) : fail(name, wrong.join('; ')));
              }
            } else {
              await once(signal, 'abort');
            }
          }
        } finally {
          await engine.stop();
          lines.push(info('engine starts', 'passed', String(engine.starts())));
          lines.push(info('the engine said last', 'passed', engine.said().split('\n').filter(line => line.trim() !== '').slice(-3).join(' | ')));
        }
        return lines;
      } finally {
        await closeStore(store);
        await scratch.drop();
      }
    });
  } finally {
    await core.deleteNamespace({ name: namespace });
    const gone = await namespaceGone(namespace);
    lines.push(gone ? pass('the namespace is deleted with its Jobs, Pods, and Secrets', namespace) : fail('the namespace is deleted with its Jobs, Pods, and Secrets', `${namespace} still exists after ${String(namespaceGoneMs / 1000)} s`));
    if (world !== undefined) {
      const folder = world.gitFolder;
      await world.stop();
      lines.push(existsSync(folder) ? fail('the branches are deleted with the git daemon', `${folder} still exists`) : pass('the branches are deleted with the git daemon', folder));
    }
  }
}

export const localEngineScenario: Scenario = {
  name: 'local-engine',
  summary: [
    'starts Postgres, a fake GitHub, a fake Jira, the git daemon, and the engine with Jobs on kind in its own JOB_NAMESPACE,',
    'with the Codex stand-in, or real Codex under --agent real in the live service,',
    'applies a setup with Braxton Kinney and three made-up people, plants each --seed (or all), prints local engine ready,',
    'and holds until SIGTERM, restarting the engine whenever it exits;',
    '--check reads every seed back and exits instead, and --plant <seed> stops that seeded task first so the check must name it',
  ].join(' '),
  run: async args => {
    const options = optionsOf(args);
    if ('passed' in options) return [options];
    const stop = new AbortController();
    const stopping = (): void => {
      stop.abort();
    };
    process.on('SIGTERM', stopping).on('SIGINT', stopping);
    const out = (line: string): void => {
      process.stdout.write(`${line}\n`);
    };
    try {
      return await hold(stop.signal, out, options);
    } finally {
      process.off('SIGTERM', stopping).off('SIGINT', stopping);
    }
  },
};
