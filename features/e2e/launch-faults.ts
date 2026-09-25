import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { labels } from '../../shared/cluster.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { gitServer, seedRepository, type GitServer } from '../../tools/verify/cluster.ts';
import { startFakeCluster, type FakeCluster } from '../../tools/verify/fake-cluster.ts';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { actAs, applySetup, closeStore, fakeCodexLogin, openStore, startEngine, until, type Engine, type Store } from './autoworker.ts';

const owner = 'owner@example.com';
const repository = 'lane/sandbox';
const bridgePort = 4531;
const engineUrl = `http://127.0.0.1:${String(bridgePort)}/`;
const image = `127.0.0.1:5001/autoworker-job:launch-faults@sha256:${'b'.repeat(64)}`;
const waitMs = 30_000;

type World = { readonly store: Store; readonly git: GitServer; readonly cluster: FakeCluster; readonly routine: string; readonly out: (line: string) => void };

const setupFile = (codexLogin: string) => ({
  admin: owner,
  people: [{ name: 'Lane Owner', email: owner, logins: { github: { env: 'LANE_GITHUB_TOKEN' }, codex: { file: codexLogin } } }],
  repositories: [{ github: repository, branch: 'main' }],
  routines: [
    {
      name: 'Launch faults',
      goal: 'Take each made-up task through Specify.',
      workflow: 'code-change',
      source: { kind: 'jira-search', jql: 'project = LANE' },
      everyMinutes: 1440,
      repository: { github: repository, branch: 'main' },
      creator: owner,
      runAs: owner,
      gates: ['specify'],
      steps: { specify: { instructions: 'Keep the plan to one paragraph.', skills: [] } },
    },
  ],
});

const engineSettings = (world: World): Readonly<Record<string, string>> => ({
  KUBECONFIG: world.cluster.kubeconfig,
  JOB_IMAGE: image,
  JOB_NAMESPACE: world.cluster.namespace,
  JOB_ENGINE_URL: engineUrl,
  GIT_BASE_URL: world.git.base,
  BRIDGE_PORT: String(bridgePort),
  BRIDGE_POLL_MS: '100',
  WORKER_EVERY_MS: '500',
  SWEEP_EVERY_MS: '600000',
  REAPER_EVERY_MS: '1000',
  LEASE_MS: '60000',
  ATTEMPT_START_LEASE_MS: '60000',
  SCHEDULER_EVERY_MS: '600000',
  CHECKS_EVERY_MS: '600000',
});

async function addTask(world: World, key: string): Promise<void> {
  const version = await world.store.db.selectFrom('routine_version').select(['routine_version.version', 'routine_version.repository_id']).where('routine_id', '=', world.routine).executeTakeFirstOrThrow();
  await world.store.db
    .insertInto('task')
    .values({ routine_id: world.routine, found_version: version.version, repository_id: version.repository_id, key, title: `Plan ${key}.`, found_at: new Date(), workflow: 'code-change', needs_repository: true, step: 'specify' })
    .execute();
}

type Attempt = { readonly id: string; readonly verdict: string | null; readonly jobCreated: boolean; readonly tokenHash: Buffer | null };

async function attemptsOf(world: World, key: string): Promise<readonly Attempt[]> {
  const rows = await world.store.db
    .selectFrom('attempt')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .select(['attempt.id', 'attempt.verdict', 'attempt.job_created_at', 'attempt.bridge_token_hash'])
    .where('task.key', '=', key)
    .orderBy('attempt.id')
    .execute();
  return rows.map(row => ({ id: row.id, verdict: row.verdict, jobCreated: row.job_created_at !== null, tokenHash: row.bridge_token_hash }));
}

const secretKeys = z.object({ stringData: z.object({ ATTEMPT_ID: z.string(), ATTEMPT_TOKEN: z.string() }) });

const jobOf = (world: World, attempt: string): boolean => world.cluster.objects('jobs').some(job => job.metadata.labels?.[labels.attempt] === attempt);

const tokenOf = (world: World, attempt: string): string | undefined =>
  world.cluster
    .objects('secrets')
    .filter(secret => secret.metadata.labels?.[labels.attempt] === attempt)
    .flatMap(secret => {
      const keys = secretKeys.safeParse(secret);
      return keys.success ? [keys.data.stringData.ATTEMPT_TOKEN] : [];
    })[0];

const hashOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

const review = { outcome: 'done', summary: 'The Job the scenario played wrote its plan.', blocks: [{ kind: 'text', title: null, body: 'Plan: change nothing, since this Job is played by the scenario.' }] };

const appLine = (seq: number, message: object) => ({ seq, kind: 'app', text: JSON.stringify(message) });

async function playJob(attempt: string, token: string): Promise<string> {
  const turn = { threadId: 'thread-1', turn: { id: 'turn-1', items: [] } };
  const lines = [
    appLine(1, { method: 'turn/started', params: { ...turn, turn: { ...turn.turn, status: 'inProgress' } } }),
    appLine(2, { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'reply', type: 'agentMessage', text: JSON.stringify(review) } } }),
    appLine(3, { method: 'turn/completed', params: { ...turn, turn: { ...turn.turn, status: 'completed' } } }),
    { seq: 4, kind: 'end' },
  ];
  const response = await fetch(`${engineUrl}events`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-autoworker-attempt': attempt,
      'x-autoworker-protocol': '1',
      'x-autoworker-pid': '7',
      'x-autoworker-image': image,
    },
    body: JSON.stringify({ received: 0, lines }),
  });
  return `${String(response.status)} ${await response.text()}`;
}

async function launchedAndFinished(world: World, key: string, label: string, engine: () => Engine): Promise<readonly Check[]> {
  const launched = await until(waitMs, async () => (await attemptsOf(world, key)).find(attempt => attempt.jobCreated && jobOf(world, attempt.id)));
  if (launched === undefined) {
    const seen = await attemptsOf(world, key);
    return [fail(`${label}: the worker creates the attempt's Job`, `attempts ${JSON.stringify(seen.map(attempt => ({ id: attempt.id, verdict: attempt.verdict, jobCreated: attempt.jobCreated })))}; ${engine().said().slice(-1500)}`)];
  }
  const token = tokenOf(world, launched.id);
  const matches = token !== undefined && launched.tokenHash !== null && hashOf(token).equals(launched.tokenHash);
  const posted = token === undefined ? 'no token in the Secret' : await playJob(launched.id, token);
  const finished = await until(waitMs, async () => (await attemptsOf(world, key)).find(attempt => attempt.id === launched.id && attempt.verdict !== null));
  const all = await attemptsOf(world, key);
  return [
    pass(`${label}: the worker creates the attempt's Job`, `attempt ${launched.id}`),
    matches ? pass(`${label}: the Secret holds the token the engine last issued`, `attempt ${launched.id}`) : fail(`${label}: the Secret holds the token the engine last issued`, token === undefined ? 'no Secret' : 'the hash differs'),
    finished?.verdict === 'pass' ? pass(`${label}: the end line through the bridge finishes the step`, `attempt ${launched.id} pass; post answered ${posted}`) : fail(`${label}: the end line through the bridge finishes the step`, `verdict ${finished?.verdict ?? 'none'}; post answered ${posted}; ${engine().said().slice(-1500)}`),
    all.length === 1 && all.every(attempt => attempt.verdict !== 'lost')
      ? pass(`${label}: the task used one attempt and lost none`, `attempts ${all.map(attempt => `${attempt.id} ${attempt.verdict ?? 'live'}`).join(', ')}`)
      : fail(`${label}: the task used one attempt and lost none`, `attempts ${all.map(attempt => `${attempt.id} ${attempt.verdict ?? 'live'}`).join(', ')}`),
  ];
}

async function clean(world: World, engine: () => Engine): Promise<readonly Check[]> {
  await addTask(world, 'LF-1');
  return launchedAndFinished(world, 'LF-1', 'clean', engine);
}

async function kubernetesError(world: World, engine: () => Engine): Promise<readonly Check[]> {
  world.cluster.failOnce({ verb: 'create', kind: 'jobs', status: 500 });
  await addTask(world, 'LF-2');
  return launchedAndFinished(world, 'LF-2', 'kubernetes error before the Job', engine);
}

async function crash(world: World, engine: { current: Engine }): Promise<readonly Check[]> {
  let killed = false;
  world.cluster.before({
    verb: 'create',
    kind: 'secrets',
    run: async () => {
      await engine.current.kill();
      killed = true;
    },
  });
  await addTask(world, 'LF-3');
  const died = await until(waitMs, () => Promise.resolve(killed ? true : undefined));
  engine.current = startEngine(world.store, engineSettings(world), world.out);
  return [died === true ? pass('crash: the engine dies between the token and the Job', 'killed at its Secret create') : fail('crash: the engine dies between the token and the Job', 'the hook never ran'), ...(await launchedAndFinished(world, 'LF-3', 'crash before the Job', () => engine.current))];
}

async function refused(world: World, engine: () => Engine): Promise<readonly Check[]> {
  const key = 'LF-4';
  await world.store.db.updateTable('credential').set({ state: 'invalid' }).where('connector', '=', 'codex').execute();
  await addTask(world, key);
  const ended = await until(waitMs, async () => (await attemptsOf(world, key)).find(attempt => attempt.verdict !== null));
  const task = await world.store.db.selectFrom('task').select(['state', 'waiting_on', 'lost']).where('key', '=', key).executeTakeFirstOrThrow();
  await world.store.db.updateTable('credential').set({ state: 'valid', checked_at: new Date() }).where('connector', '=', 'codex').execute();
  const retried = await actAs(world.store, ['retry', key, '--as', owner]);
  const next = await until(waitMs, async () => (await attemptsOf(world, key)).find(attempt => attempt.id !== ended?.id && attempt.jobCreated));
  const prompt = next === undefined ? '' : ((await world.store.db.selectFrom('attempt_command').select('input').where('attempt_id', '=', next.id).where('kind', '=', 'turn.start').executeTakeFirst())?.input ?? '');
  return [
    ended?.verdict === 'not_launched' ? pass('refused: a refused launch ends its attempt not launched', `attempt ${ended.id}`) : fail('refused: a refused launch ends its attempt not launched', `verdict ${ended?.verdict ?? 'none'}; ${engine().said().slice(-800)}`),
    task.state === 'waiting' && task.waiting_on === 'retry' && task.lost === 0 ? pass('refused: the task waits for Retry and counts no lost attempt', `lost ${String(task.lost)}`) : fail('refused: the task waits for Retry and counts no lost attempt', JSON.stringify(task)),
    retried.code === 0 && next !== undefined ? pass('refused: Retry launches a new attempt', `attempt ${next.id}`) : fail('refused: Retry launches a new attempt', `${retried.out}; ${engine().said().slice(-800)}`),
    next !== undefined && !/lost attempt/i.test(prompt) ? pass('refused: the next prompt does not call the refused attempt lost', `${String(prompt.length)} characters`) : fail('refused: the next prompt does not call the refused attempt lost', prompt.slice(0, 800)),
  ];
}

const lanes = ['clean', 'kubernetes-error', 'crash', 'refused'] as const;

type Lane = (typeof lanes)[number];

const isLane = (name: string): name is Lane => lanes.some(lane => lane === name);

async function launchFaults(args: readonly string[], out: (line: string) => void): Promise<readonly Check[]> {
  const chosen = args.length === 0 || args.includes('all') ? [...lanes] : args;
  const unknown = chosen.filter(name => !isLane(name));
  if (unknown.length > 0) return [fail('launch-faults names known lanes', `unknown ${unknown.join(', ')}; name any of ${lanes.join(', ')}, or all`)];
  const git = await gitServer('127.0.0.1');
  const cluster = await startFakeCluster('launch-faults');
  try {
    await seedRepository(git, repository, { 'README.md': 'A sandbox for launch faults.\n' });
    return await withPostgres(async postgres => {
      const scratch = await postgres.scratch();
      const store = await openStore(scratch.stableUrl);
      try {
        const loginFile = join(store.folder, 'codex.json');
        await writeFile(loginFile, fakeCodexLogin(), { mode: 0o600 });
        const setup = await applySetup(store, setupFile(loginFile), { LANE_GITHUB_TOKEN: 'lane-token-for-the-git-daemon' });
        if (setup.code !== 0) return [fail('launch-faults: setup applies', setup.out)];
        await store.db.updateTable('credential').set({ state: 'valid', checked_at: new Date() }).execute();
        const routine = await store.db.selectFrom('routine').select('routine.id').executeTakeFirstOrThrow();
        const world: World = { store, git, cluster, routine: routine.id, out };
        const engine = { current: startEngine(store, engineSettings(world), out) };
        const checks: Check[] = [];
        try {
          for (const name of chosen.filter(isLane)) {
            if (name === 'clean') checks.push(...(await clean(world, () => engine.current)));
            if (name === 'kubernetes-error') checks.push(...(await kubernetesError(world, () => engine.current)));
            if (name === 'crash') checks.push(...(await crash(world, engine)));
            if (name === 'refused') checks.push(...(await refused(world, () => engine.current)));
          }
          return checks;
        } finally {
          await engine.current.stop();
        }
      } finally {
        await closeStore(store);
        await scratch.drop();
      }
    });
  } finally {
    await cluster.stop();
    await git.stop();
  }
}

export const launchFaultsScenario: Scenario = {
  name: 'launch-faults',
  summary:
    "runs the engine's worker against a fake Kubernetes API and plays each Job through the engine's bridge endpoint: a clean launch, a Kubernetes error and an engine crash between the token and the Job, and a refused launch; name lanes, or all",
  run: args =>
    launchFaults(args, line => {
      process.stdout.write(`${line}\n`);
    }),
};
