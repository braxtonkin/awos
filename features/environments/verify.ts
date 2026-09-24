import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { connect, type Database } from '../../shared/db/client.ts';
import { neverStops } from '../../shared/loop.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { withPostgres, type TestPostgres } from '../../tools/verify/postgres.ts';
import { openAttempt, provePlants, world, type PlantProof } from './invariants.ts';
import { reconcile, startEnvironment } from './lifecycle.ts';
import { describe, providersByName } from './provider.ts';
import { mutantName, mutants, probeReconcile, profileName, simulate, type MutantName, type Plan, type Probe, type ProfileName, type Run } from './simulate.ts';

const simulationFlags = {
  profile: { type: 'string' },
  seeds: { type: 'string' },
  seed: { type: 'string' },
  steps: { type: 'string' },
  mutant: { type: 'string' },
} as const;

const simulationOptions = z.object({
  profile: z.union([profileName, z.literal('all')]).default('default'),
  seeds: z.coerce.number().int().positive().default(20),
  seed: z.coerce.number().int().nonnegative().optional(),
  steps: z.coerce.number().int().positive().default(300),
  mutant: z.union([mutantName, z.literal('all')]).optional(),
});

type SimulationOptions = z.infer<typeof simulationOptions>;

function parseSimulationOptions(args: readonly string[]): SimulationOptions {
  const parsed = simulationOptions.safeParse(parseArgs({ args: [...args], options: simulationFlags, strict: true, allowPositionals: false }).values);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

const seedsOf = (options: SimulationOptions): readonly number[] =>
  options.seed === undefined ? Array.from({ length: options.seeds }, (_, index) => index + 1) : [options.seed];

const replay = (run: Run): string =>
  `npm run verify -- environments-sim ${run.plan.mutant === undefined ? `--profile ${run.plan.profile}` : `--mutant ${run.plan.mutant}`} --seed ${String(run.seed)} --steps ${String(run.plan.steps)}`;

function violation(run: Run): string {
  if (run.failure === undefined) return `seed ${String(run.seed)} broke nothing`;
  const { step, move, broken } = run.failure;
  const names = broken.length === 0 ? 'the quiet phase did not settle' : [...new Set(broken.map(found => found.property))].join(', ');
  const rows = broken.slice(0, 3).map(found => `${found.property} ${JSON.stringify(found.row)}`);
  const recent = run.trace.slice(-6).map(entry => `${String(entry.step)} ${entry.move}: ${entry.detail}`);
  return `${names} violated at seed ${String(run.seed)}, step ${String(step)}, after ${move}: ${rows.join('; ')}; last moves: ${recent.join(' | ')}; replay: ${replay(run)}`;
}

const sum = (runs: readonly Run[], count: (run: Run) => number): number => runs.reduce((total, run) => total + count(run), 0);

async function profileChecks(postgres: TestPostgres, profile: ProfileName, options: SimulationOptions): Promise<readonly Check[]> {
  const started = performance.now();
  const runs = await simulate(postgres, [{ profile, seeds: seedsOf(options), steps: options.steps }]);
  const seconds = (performance.now() - started) / 1000;
  const failed = runs.filter(run => run.failure !== undefined);
  const left = sum(runs, run => run.left);
  const unstopped = runs.flatMap(run => run.unstopped.map(attempt => `seed ${String(run.seed)} attempt ${attempt}`));
  const starts = sum(runs, run => run.starts);
  const crashes = (point: keyof Run['crashes']): number => sum(runs, run => run.crashes[point]);
  const [first] = failed;
  const name = `${profile}: ${String(runs.length)} seeds, ${String(failed.length)} violations`;
  const detail = `${String(sum(runs, run => run.steps))} steps in ${seconds.toFixed(1)} s, ${String(starts)} environments made, engine deaths: ${String(crashes('before-start'))} before start, ${String(crashes('after-start'))} after start, ${String(crashes('in-flight'))} while start was in flight, ${String(crashes('idle'))} idle`;
  const leftName = `${profile}: environments left ${String(left)}, and every start the fake counted was followed by a stop`;
  const crashName = 'crashes: engines died between recording a start and calling start, and between start returning and recording its result';
  return [
    first === undefined ? pass(name, detail) : fail(name, violation(first)),
    left === 0 && unstopped.length === 0 && starts > 0
      ? pass(leftName, `${String(starts)} starts`)
      : fail(leftName, `${String(starts)} starts; never stopped: ${unstopped.slice(0, 10).join(', ')}`),
    ...(profile === 'crashes' ? [crashes('before-start') > 0 && crashes('after-start') > 0 ? pass(crashName, detail) : fail(crashName, detail)] : []),
  ];
}

async function mutantCheck(postgres: TestPostgres, mutant: MutantName, options: SimulationOptions): Promise<Check> {
  const property = mutants[mutant];
  const name = `${property} fails without ${mutant}`;
  const plan: Plan = { profile: 'default', seeds: seedsOf(options), steps: options.steps, mutant };
  const runs = await simulate(postgres, [plan]);
  const first = runs.find(run => run.failure !== undefined);
  if (first === undefined) return fail(name, `no violation in ${String(runs.length)} seeds of ${String(options.steps)} steps`);
  return first.failure?.broken.some(found => found.property === property) === true ? pass(name, violation(first)) : fail(name, `expected ${property}, got ${violation(first)}`);
}

function plantsCheck(proofs: readonly PlantProof[]): Check {
  const name = "each property's plant trips that property's check";
  const misses = proofs.flatMap(({ property, plant, atStart, reported }) => {
    if (atStart.length > 0) return [`${property} plant ${String(plant)}: its setup already breaks ${atStart.join(', ')}`];
    return reported.includes(property) ? [] : [`${property} plant ${String(plant)} reported ${reported.length === 0 ? 'nothing' : reported.join(', ')}`];
  });
  return misses.length === 0 ? pass(name, `${String(proofs.length)} of ${String(proofs.length)} plants caught`) : fail(name, misses.join('; '));
}

async function simulationChecks(postgres: TestPostgres, options: SimulationOptions): Promise<readonly Check[]> {
  const checks: Check[] = [];
  if (options.mutant === 'all') {
    checks.push(plantsCheck(await provePlants(postgres)));
    for (const mutant of mutantName.options) checks.push(await mutantCheck(postgres, mutant, options));
  } else if (options.mutant !== undefined) {
    checks.push(await mutantCheck(postgres, options.mutant, options));
  } else {
    for (const profile of options.profile === 'all' ? profileName.options : [options.profile]) checks.push(...(await profileChecks(postgres, profile, options)));
  }
  return checks;
}

const liveStart = { now: () => new Date(), startDeadlineMs: 600_000 };

async function seed(db: Database): Promise<void> {
  for (const statement of world) await statement.execute(db);
}

async function newAttempt(db: Database, key: string): Promise<string> {
  for (const statement of openAttempt(key, new Date())) await statement.execute(db);
  const row = await db.selectFrom('attempt').innerJoin('task', 'task.id', 'attempt.task_id').select('attempt.id').where('task.key', '=', key).executeTakeFirstOrThrow();
  return row.id;
}

async function endAttempt(db: Database, attempt: string): Promise<void> {
  await db
    .updateTable('attempt')
    .set({ finished_at: new Date(), verdict: 'pass', output: JSON.stringify({ outcome: 'done', summary: 'Verified.', blocks: [] }) })
    .where('id', '=', attempt)
    .execute();
}

async function stoppedCount(db: Database): Promise<number> {
  const rows = await db.selectFrom('verify_environment').select('id').where('stopped_at', 'is not', null).execute();
  return rows.length;
}

async function liveChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  const providers = providersByName([]);
  try {
    await seed(db);
    const attempt = await newAttempt(db, 'LIVE-1');
    const started = await startEnvironment(db, providers, attempt, liveStart);
    const said = started.kind === 'started' ? describe(started.environment) : JSON.stringify(started);
    process.stdout.write(`${said}\n`);
    await endAttempt(db, attempt);
    const lines = await reconcile({ providers, everyMs: 30_000, startDeadlineMs: liveStart.startDeadlineMs }).pass(db, { now: new Date(), late: () => false, stop: neverStops });
    const stopped = await stoppedCount(db);
    process.stdout.write(`stopped ${String(stopped)}\n`);
    await db.updateTable('repository').set({ fast_test_command: null }).execute();
    const ci = await startEnvironment(db, providers, await newAttempt(db, 'LIVE-2'), liveStart);
    await db.updateTable('repository').set({ verify_provider: 'probe' }).execute();
    const strangerAttempt = await newAttempt(db, 'LIVE-3');
    const stranger = await startEnvironment(db, providers, strangerAttempt, liveStart);
    const strangerRows = await db.selectFrom('verify_environment').select('id').where('attempt_id', '=', strangerAttempt).execute();
    const startName = 'the tests-only provider gives the workspace and the fast test command';
    const stopName = 'one reconcile pass after the attempt ends records the stop';
    const ciName = 'with no fast test command, the tests-only provider says to run the checks in the CI config';
    const strangerName = 'a repository that names a provider the engine was not given gets a note naming it, and nothing is recorded';
    return [
      said === 'workspace, run: npm ci && npm test' ? pass(startName, said) : fail(startName, said),
      stopped === 1 ? pass(stopName, `stopped ${String(stopped)}; ${lines.join('; ')}`) : fail(stopName, `stopped ${String(stopped)}; ${lines.join('; ')}`),
      ci.kind === 'started' && ci.environment.kind === 'workspace-ci' ? pass(ciName, describe(ci.environment)) : fail(ciName, JSON.stringify(ci)),
      stranger.kind === 'unknown-provider' && stranger.note.includes('probe') && strangerRows.length === 0
        ? pass(strangerName, stranger.note)
        : fail(strangerName, `${JSON.stringify(stranger)}, ${String(strangerRows.length)} rows`),
    ];
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

const engineMain = fileURLToPath(new URL('../../services/engine/main.ts', import.meta.url));

const quickEngine = { ENVIRONMENTS_EVERY_MS: '200', REAPER_EVERY_MS: '200', LEASE_MS: '600000', BRIDGE_PORT: '0' } as const;

type RunningEngine = { readonly said: () => string; readonly waitFor: (text: string) => Promise<boolean>; readonly terminate: () => Promise<number | null> };

function runEngine(url: string): RunningEngine {
  const child = spawn(process.execPath, [engineMain], { env: { ...process.env, ...quickEngine, DATABASE_URL: url }, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  let exited: number | null | undefined;
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    said += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    said += chunk;
  });
  const done = new Promise<number | null>(resolve => {
    child.on('exit', status => {
      exited = status;
      resolve(status);
    });
  });
  return {
    said: () => said.trim(),
    waitFor: async text => {
      const deadline = performance.now() + 15_000;
      while (!said.includes(text) && exited === undefined && performance.now() < deadline) await wait(20);
      return said.includes(text);
    },
    terminate: async () => {
      child.kill('SIGTERM');
      const status = await Promise.race([done, wait(15_000).then(() => 'hung' as const)]);
      if (status === 'hung') {
        child.kill('SIGKILL');
        throw new Error(`the engine did not exit within 15 s of SIGTERM. It said: ${said}`);
      }
      return status;
    },
  };
}

async function engineChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  const scratch = await postgres.scratch();
  const db = connect(scratch.url, 2);
  try {
    await seed(db);
    await db.updateTable('repository').set({ verify_provider: 'probe' }).execute();
    const refused = spawnSync(process.execPath, [engineMain], { env: { ...process.env, DATABASE_URL: scratch.url }, encoding: 'utf8', timeout: 30_000 });
    const refusedName = 'the engine refuses to start when a repository names a provider it was not given, and names probe';
    const refusedCheck =
      refused.status !== 0 && refused.stderr.includes('probe')
        ? pass(refusedName, `exit ${String(refused.status)}: ${refused.stderr.trim().replaceAll('\n', ' ')}`)
        : fail(refusedName, `exit ${String(refused.status)}: ${refused.stdout}${refused.stderr}`);
    await db.updateTable('repository').set({ verify_provider: 'tests-only' }).execute();
    const engines = [runEngine(scratch.url), runEngine(scratch.url)];
    const ready = await Promise.all(engines.map(engine => engine.waitFor('The engine runs')));
    const attempt = await newAttempt(db, 'ENGINE-1');
    const started = await startEnvironment(db, providersByName([]), attempt, liveStart);
    await endAttempt(db, attempt);
    const endedAt = performance.now();
    let rows: readonly { readonly stopped_at: Date | null }[] = [];
    while (performance.now() - endedAt < 5_000) {
      rows = await db.selectFrom('verify_environment').select('stopped_at').where('attempt_id', '=', attempt).execute();
      if (rows.length === 1 && rows[0]?.stopped_at !== null) break;
      await wait(20);
    }
    const stoppedInMs = performance.now() - endedAt;
    const statuses = await Promise.all(engines.map(engine => engine.terminate()));
    const said = engines.map((engine, index) => `engine ${String(index + 1)}: ${engine.said().replaceAll('\n', ' ')}`).join(' | ');
    const stopName = 'with two engines running, the ended attempt has one environment row, and it reads stopped within one interval';
    const exitName = 'both engines exit 0 on SIGTERM';
    return [
      refusedCheck,
      started.kind === 'started' && rows.length === 1 && rows[0]?.stopped_at !== null && stoppedInMs <= 200 * 1.1 + 200
        ? pass(stopName, `stopped ${stoppedInMs.toFixed(0)} ms after the attempt ended; ${said}`)
        : fail(stopName, `${JSON.stringify(started)}, rows ${JSON.stringify(rows)} after ${stoppedInMs.toFixed(0)} ms; ${said}`),
      ready.every(Boolean) && statuses.length === 2 && statuses.every(status => status === 0) ? pass(exitName, statuses.join(', ')) : fail(exitName, `started ${ready.join(', ')}, exits ${statuses.join(', ')}; ${said}`),
    ];
  } finally {
    await db.destroy();
    await scratch.drop();
  }
}

async function perfChecks(postgres: TestPostgres): Promise<readonly Check[]> {
  const probes: Probe[] = [];
  for (let round = 0; round < 5; round += 1) probes.push(await probeReconcile(postgres, 100), await probeReconcile(postgres, 1));
  const hundreds = probes.filter(probe => probe.ended === 100);
  const singles = probes.filter(probe => probe.ended === 1);
  const passName = 'one reconcile pass over 100 ended environments takes at most 1 s';
  const delayName = 'every probed stop landed within one interval plus 10% of its attempt ending';
  const passes = (list: readonly Probe[]): string => list.map(probe => `${probe.passMs.toFixed(1)} ms`).join(', ');
  const late = probes.filter(probe => probe.stopped !== probe.ended || probe.slowestDelayMs > probe.everyMs * 1.1);
  return [
    Math.max(...hundreds.map(probe => probe.passMs)) <= 1000 && hundreds.every(probe => probe.stopped === 100)
      ? pass(passName, `100 at once: ${passes(hundreds)}; 1 alone: ${passes(singles)}`)
      : fail(passName, `100 at once: ${passes(hundreds)}, stopped ${hundreds.map(probe => String(probe.stopped)).join(', ')}`),
    late.length === 0
      ? pass(delayName, `slowest stop ${String(Math.max(...probes.map(probe => probe.slowestDelayMs)))} ms after its attempt ended, against an interval of ${String(probes[0]?.everyMs ?? 0)} ms`)
      : fail(delayName, JSON.stringify(late)),
  ];
}

export const scenarios: readonly Scenario[] = [
  {
    name: 'environments-sim',
    summary: 'runs seeded engines that start, stop, crash, and restart against real Postgres and a fake Verify provider, and checks every property after each step',
    run: args => {
      const options = parseSimulationOptions(args);
      return withPostgres(postgres => simulationChecks(postgres, options));
    },
  },
  {
    name: 'environments-live',
    summary: 'starts the tests-only Verify environment for a made-up attempt, ends the attempt, and stops it in one reconcile pass',
    run: () => withPostgres(liveChecks),
  },
  {
    name: 'environments-engine',
    summary: "starts the engine's entry point: it refuses a repository whose Verify provider it was not given, and two engines stop an ended attempt's environment once",
    run: () => withPostgres(engineChecks),
  },
  {
    name: 'environments-perf',
    summary: 'ends 100 environments at once 5 times, interleaved with 5 single ends, and times the reconcile pass and each stop delay',
    run: () => withPostgres(perfChecks),
  },
];
