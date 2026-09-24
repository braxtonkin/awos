import { once } from 'node:events';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { z } from 'zod';
import { bridgeListener, noStepRunner, rules } from '../../features/bridge/engine.ts';
import { landLoops } from '../../features/code-change/land-loop.ts';
import { coreReview } from '../../features/code-change/land.ts';
import { checkLoop } from '../../features/credentials/check-loop.ts';
import { checksFor } from '../../features/credentials/checks.ts';
import { githubApi } from '../../features/credentials/github-check.ts';
import { sealingKey, type SealingKey } from '../../features/credentials/seal.ts';
import { open, writeBack } from '../../features/credentials/store.ts';
import { providerProblems, reconcile } from '../../features/environments/lifecycle.ts';
import { providersByName } from '../../features/environments/provider.ts';
import { enqueue } from '../../features/outbox/enqueue.ts';
import { connectCluster } from '../../features/jobs/launch.ts';
import { jobSettings } from '../../features/jobs/settings.ts';
import { sweep } from '../../features/jobs/sweep.ts';
import { clientsFrom, type ClientFor, type OpenToken } from '../../features/github/client.ts';
import { mergeStateReader } from '../../features/github/merge-state.ts';
import { githubPerformers, outboxOwedAt } from '../../features/github/performers.ts';
import { outboxLoops, registryOf } from '../../features/outbox/perform.ts';
import { scheduleSource } from '../../features/routines/schedule-source.ts';
import { postgresNow, scheduler } from '../../features/routines/scheduler.ts';
import { sourcesByKind } from '../../features/routines/source.ts';
import { advance, approveFromOutside, handOff } from '../../features/tasks/advance.ts';
import { claim, renew } from '../../features/tasks/claim.ts';
import { reaper } from '../../features/tasks/reaper.ts';
import { startProblems } from '../../features/tasks/start.ts';
import type { OwedKinds, Performers } from '../../shared/actions.ts';
import { connect, type Database } from '../../shared/db/client.ts';
import { realClock, runLoop, type Loop } from '../../shared/loop.ts';
import type { Workflow } from '../../shared/workflow.ts';
import { workflows } from './workflows.ts';

const milliseconds = z.coerce.number().int().positive();

const settings = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(2).default(10),
  DATABASE_CONNECT_TIMEOUT_MS: milliseconds.default(10_000),
  LEASE_MS: milliseconds.default(60_000),
  REAPER_EVERY_MS: milliseconds.default(30_000),
  SCHEDULER_EVERY_MS: milliseconds.default(10_000),
  ROUTINE_LEASE_MS: milliseconds.default(300_000),
  CHECKS_EVERY_MS: milliseconds.default(60_000),
  CHECK_LEASE_MS: milliseconds.default(300_000),
  CHECK_TIMEOUT_MS: milliseconds.default(120_000),
  GITHUB_API_URL: z.url({ protocol: /^https?$/ }).default(githubApi),
  OUTBOX_EVERY_MS: milliseconds.default(1_000),
  OUTBOX_LEASE_MS: milliseconds.default(60_000),
  OUTBOX_MARGIN_MS: milliseconds.default(5_000),
  OUTBOX_MAX_TRIES: z.coerce.number().int().positive().default(3),
  ENVIRONMENTS_EVERY_MS: milliseconds.default(30_000),
  ENVIRONMENT_START_DEADLINE_MS: milliseconds.default(600_000),
  LAND_EVERY_MS: milliseconds.default(10_000),
  LAND_READ_TIMEOUT_MS: milliseconds.default(20_000),
  ...jobSettings,
  BRIDGE_PORT: z.coerce.number().int().min(0).max(65_535).default(4520),
  BRIDGE_POLL_MS: milliseconds.default(250),
  BRIDGE_KEEPALIVE_MS: milliseconds.default(5_000),
  BRIDGE_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
});

type Settings = z.infer<typeof settings>;

const sources = sourcesByKind([scheduleSource]);

const providers = providersByName([]);

type ActionKind = OwedKinds<Workflow>;

const githubToken =
  (db: Database, key: SealingKey | undefined): OpenToken =>
  async actsAs => {
    if (key === undefined) return { failed: 'The engine has no CREDENTIAL_KEY, so it cannot open a GitHub token.' };
    const opened = await open(db, key, { connector: 'github', owner: actsAs });
    return 'secret' in opened ? { token: opened.secret } : { failed: opened.reason };
  };

const githubClients = (db: Database, given: Settings, key: SealingKey | undefined): ClientFor => clientsFrom(githubToken(db, key), given.GITHUB_API_URL);

const performersFor = (db: Database, given: Settings, key: SealingKey | undefined) =>
  ({
    ...githubPerformers({ clientFor: githubClients(db, given, key), owedAt: outboxOwedAt(db) }),
  }) satisfies Performers<ActionKind>;

const loopsFor = (db: Database, given: Settings, key: SealingKey | undefined): readonly Loop[] => [
  reaper({ everyMs: given.REAPER_EVERY_MS, leaseMs: given.LEASE_MS }),
  scheduler({ everyMs: given.SCHEDULER_EVERY_MS, leaseMs: given.ROUTINE_LEASE_MS, sources, workflows, now: postgresNow }),
  reconcile({ providers, everyMs: given.ENVIRONMENTS_EVERY_MS, startDeadlineMs: given.ENVIRONMENT_START_DEADLINE_MS }),
  ...landLoops({
    everyMs: given.LAND_EVERY_MS,
    leaseMs: given.LEASE_MS,
    read: mergeStateReader(db, githubClients(db, given, key)),
    readTimeoutMs: given.LAND_READ_TIMEOUT_MS,
    review: coreReview,
    enqueue,
    clock: realClock,
    tasks: { claim, renew, handOff, approveFromOutside, finish: (db, attempt, report, now, then) => advance(db, workflows, attempt, report, now, then) },
  }),
  ...(given.JOB_IMAGE === undefined ? [] : [sweep({ everyMs: given.SWEEP_EVERY_MS, cluster: connectCluster(given.JOB_NAMESPACE) })]),
  ...outboxLoops({ everyMs: given.OUTBOX_EVERY_MS, leaseMs: given.OUTBOX_LEASE_MS, marginMs: given.OUTBOX_MARGIN_MS, maxTries: given.OUTBOX_MAX_TRIES, clock: realClock, registry: registryOf(performersFor(db, given, key)) }),
  ...(key === undefined
    ? []
    : [
        checkLoop({
          everyMs: given.CHECKS_EVERY_MS,
          leaseMs: given.CHECK_LEASE_MS,
          key,
          checks: checksFor({ codex: { timeoutMs: given.CHECK_TIMEOUT_MS }, github: { baseUrl: given.GITHUB_API_URL, timeoutMs: given.CHECK_TIMEOUT_MS } }),
          checker: `engine ${hostname()} ${String(process.pid)}`,
          now: () => new Date(),
          writeBack,
        }),
      ]),
];

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function run(given: Settings, key: SealingKey | undefined): Promise<void> {
  const stop = new AbortController();
  const stopping = (signal: NodeJS.Signals): void => {
    say(stop.signal.aborted ? `The engine got ${signal} again and still finishes its pass.` : `The engine got ${signal}, so each loop finishes its pass and stops.`);
    stop.abort();
  };
  process.on('SIGTERM', stopping).on('SIGINT', stopping);
  const db = connect(given.DATABASE_URL, given.DATABASE_POOL_SIZE, given.DATABASE_CONNECT_TIMEOUT_MS);
  try {
    const problems = await startProblems(db, workflows);
    if (problems.length > 0) {
      process.stderr.write(`The engine did not start, because its routines and tasks do not fit the workflows it was given.\n${problems.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    const unknownProviders = await providerProblems(db, providers);
    if (unknownProviders.length > 0) {
      process.stderr.write(`The engine did not start, because a repository or an environment names a Verify provider it was not given.\n${unknownProviders.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    const bridge = createServer(
      bridgeListener(
        db,
        { leaseMs: given.LEASE_MS, finish: noStepRunner, now: () => new Date(), rules },
        { pollMs: given.BRIDGE_POLL_MS, keepAliveMs: given.BRIDGE_KEEPALIVE_MS, bodyLimitBytes: given.BRIDGE_BODY_LIMIT_BYTES, stop: stop.signal },
      ),
    );
    bridge.listen(given.BRIDGE_PORT);
    await once(bridge, 'listening');
    stop.signal.addEventListener('abort', () => {
      bridge.close();
      bridge.closeIdleConnections();
    });
    const address = bridge.address();
    say(`The engine serves the bridge on port ${typeof address === 'object' && address !== null ? String(address.port) : String(given.BRIDGE_PORT)}.`);
    const loops = loopsFor(db, given, key);
    if (key === undefined) say('The engine has no CREDENTIAL_KEY, so it opens and checks no credentials.');
    if (given.JOB_IMAGE === undefined) say('The engine has no JOB_IMAGE, so it launches no Jobs and sweeps none.');
    say(`The engine runs the workflows ${[...workflows.keys()].join(', ')}, the Verify providers ${[...providers.keys()].join(', ')}, and the loops ${loops.map(loop => `${loop.name} every ${String(loop.everyMs)} ms`).join(', ')}.`);
    await Promise.all(loops.map(loop => runLoop(loop, db, realClock, stop.signal, say)));
    bridge.closeAllConnections();
    say('The engine stopped.');
  } finally {
    await db.destroy();
  }
}

const keyFrom = (env: NodeJS.ProcessEnv): SealingKey | undefined | Error => {
  if (env['CREDENTIAL_KEY'] === undefined) return undefined;
  try {
    return sealingKey(env);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

const parsed = settings.safeParse(process.env);
const key = keyFrom(process.env);
if (!parsed.success) {
  process.stderr.write(`The engine did not start, because a setting is missing or wrong.\n${z.prettifyError(parsed.error)}\n`);
  process.exitCode = 1;
} else if (key instanceof Error) {
  process.stderr.write(`The engine did not start, because its sealing key is wrong. ${key.message}\n`);
  process.exitCode = 1;
} else {
  await run(parsed.data, key);
}
