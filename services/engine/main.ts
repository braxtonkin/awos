import { once } from 'node:events';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { sql } from 'kysely';
import { z } from 'zod';
import { agentSteps } from '../../features/code-change/stage-output.ts';
import { workflow as codeChange } from '../../features/code-change/workflow.ts';
import { bridgeListener, numberCommand, rules } from '../../features/bridge/engine.ts';
import { attemptId } from '../../features/bridge/protocol.ts';
import { checkLeaseMarginMs, checkLoop, type CheckLoopSettings } from '../../features/credentials/check-loop.ts';
import { landLoops } from '../../features/code-change/land-loop.ts';
import { coreReview } from '../../features/code-change/land.ts';
import { checksFor } from '../../features/credentials/checks.ts';
import { githubApi } from '../../features/credentials/github-check.ts';
import { openJiraLogin } from '../../features/credentials/jira-login.ts';
import { sealingKey, type SealingKey } from '../../features/credentials/seal.ts';
import { open, writeBack } from '../../features/credentials/store.ts';
import { providerProblems, reconcile } from '../../features/environments/lifecycle.ts';
import { publishProviders } from '../../features/environments/provider.ts';
import { clientsFrom, type OpenToken } from '../../features/github/client.ts';
import { mergeStateReader } from '../../features/github/merge-state.ts';
import { githubPerformers, outboxMergeRow } from '../../features/github/performers.ts';
import type { JiraAccess } from '../../features/jira/client.ts';
import { jiraPerformers } from '../../features/jira/performers.ts';
import { currentAssignee, jiraSearch, ticketDescription } from '../../features/jira/source.ts';
import { jobSettings } from '../../features/jobs/settings.ts';
import { sweep } from '../../features/jobs/sweep.ts';
import { enqueue } from '../../features/outbox/enqueue.ts';
import { databaseTime, outboxLoops, registryOf } from '../../features/outbox/perform.ts';
import { scheduleSource } from '../../features/routines/schedule-source.ts';
import { scheduler } from '../../features/routines/scheduler.ts';
import { pauseWithin, resumeWithin, runNowWithin, type RoutineAction } from '../../features/routines/actions.ts';
import { requests, type Applied, type Applying, type Handlers } from '../../features/requests/apply.ts';
import { sourcesByKind } from '../../features/routines/source.ts';
import { actWithin, advance, approveFromOutside, handOff, refusalOf, steerWithin, type PersonAction, type SteerTurn, type StopTurn } from '../../features/tasks/advance.ts';
import { claim, renew } from '../../features/tasks/claim.ts';
import { reaper } from '../../features/tasks/reaper.ts';
import { saveRoutine } from '../../features/tasks/setup.ts';
import { coreRunAs, type RunAsRule } from '../../features/tasks/run-as.ts';
import { finishStep, type StepRunner } from '../../features/tasks/step-runner.ts';
import { publishWorkflows, startProblems } from '../../features/tasks/start.ts';
import type { Performers } from '../../shared/actions.ts';
import { connectCluster } from '../../shared/cluster.ts';
import { connect, type Database } from '../../shared/db/client.ts';
import { postgresNow } from '../../shared/db/now.ts';
import { realClock, runLoop, type Loop } from '../../shared/loop.ts';
import type { RequestKind } from '../../shared/requests.ts';
import type { Transacting } from '../../shared/transaction.ts';
import { attempts } from './attempts.ts';
import { providers } from './providers.ts';
import { workflows, type ActionKind } from './workflows.ts';

const milliseconds = z.coerce.number().int().positive();

const present = z.string().transform(() => true);

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
  JIRA_SITE: z.url({ protocol: /^https?$/ }).optional(),
  JIRA_TIMEOUT_MS: milliseconds.default(30_000),
  OUTBOX_EVERY_MS: milliseconds.default(1_000),
  OUTBOX_LEASE_MS: milliseconds.default(60_000),
  OUTBOX_MARGIN_MS: milliseconds.default(5_000),
  OUTBOX_MAX_TRIES: z.coerce.number().int().positive().default(3),
  ENVIRONMENTS_EVERY_MS: milliseconds.default(30_000),
  ENVIRONMENT_START_DEADLINE_MS: milliseconds.default(600_000),
  LAND_EVERY_MS: milliseconds.default(10_000),
  LAND_READ_TIMEOUT_MS: milliseconds.default(20_000),
  REQUESTS_EVERY_MS: milliseconds.default(250),
  REQUEST_TIMEOUT_MS: milliseconds.default(10_000),
  ...jobSettings,
  JOB_ENGINE_URL: z.url({ protocol: /^https?$/ }).optional(),
  GIT_BASE_URL: z.url({ protocol: /^(https|git)$/ }).default('https://github.com/'),
  WORKER_EVERY_MS: milliseconds.default(5_000),
  ATTEMPT_START_LEASE_MS: milliseconds.default(900_000),
  BRIDGE_PORT: z.coerce.number().int().min(0).max(65_535).default(4520),
  BRIDGE_POLL_MS: milliseconds.default(250),
  BRIDGE_KEEPALIVE_MS: milliseconds.default(5_000),
  BRIDGE_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(64 * 1024 * 1024),
  CREDENTIAL_KEY: present.optional(),
  CREDENTIAL_KEY_VERSION: present.optional(),
}).superRefine((given, context) => {
  const rules = [
    {
      broken: given.CHECK_LEASE_MS <= given.CHECK_TIMEOUT_MS + checkLeaseMarginMs,
      path: 'CHECK_LEASE_MS',
      message: `must be more than CHECK_TIMEOUT_MS plus ${String(checkLeaseMarginMs)} ms, so a check that runs until its timeout still holds its lease when it finishes`,
    },
    {
      broken: given.ATTEMPT_START_LEASE_MS <= given.ENVIRONMENT_START_DEADLINE_MS + given.CHECK_TIMEOUT_MS + checkLeaseMarginMs,
      path: 'ATTEMPT_START_LEASE_MS',
      message: `must be more than ENVIRONMENT_START_DEADLINE_MS plus CHECK_TIMEOUT_MS plus ${String(checkLeaseMarginMs)} ms, so an attempt whose Codex check and environment start both run to their limits still holds its lease when it launches`,
    },
    { broken: given.JOB_IMAGE !== undefined && given.CREDENTIAL_KEY === undefined, path: 'CREDENTIAL_KEY', message: 'must be set when JOB_IMAGE is, because each Job gets logins the engine opens with it' },
    { broken: given.JOB_IMAGE !== undefined && given.JOB_ENGINE_URL === undefined, path: 'JOB_ENGINE_URL', message: 'must be set when JOB_IMAGE is, because each Job reaches the bridge at it' },
    { broken: given.CREDENTIAL_KEY_VERSION !== undefined && given.CREDENTIAL_KEY === undefined, path: 'CREDENTIAL_KEY', message: 'must be set when CREDENTIAL_KEY_VERSION is, or the engine would open and check no credentials' },
  ];
  for (const rule of rules) if (rule.broken) context.issues.push({ code: 'custom', path: [rule.path], message: rule.message, input: undefined });
});

type Settings = z.infer<typeof settings>;

const runner: StepRunner = { workflows, agents: new Map([[codeChange.name, agentSteps]]), enqueue };

const stopTurn: StopTurn = async (writer, attempt, now) => {
  await numberCommand(writer, attemptId.parse(attempt), { kind: 'turn.stop' }, now);
};

const steerTurn: SteerTurn = async (writer, attempt, message, action, now) => {
  const sent = await numberCommand(writer, attemptId.parse(attempt), { kind: 'turn.steer', message, action }, now);
  return sent === 'no-turn' ? 'starting' : sent === 'ended' ? 'ended' : 'sent';
};

const byWhom = (request: Applying<RequestKind>): RoutineAction => ({ id: request.action, person: request.person, at: request.at });

const onTask = async (tx: Transacting, request: Applying<PersonAction['kind']>, action: PersonAction): Promise<Applied> => {
  const acted = await actWithin(tx, workflows, request.target, byWhom(request), action, stopTurn);
  return 'recorded' in acted ? 'recorded' : { refused: refusalOf(action.kind, acted.refused) };
};

const recordedOr = (done: boolean, refused: string): Applied => (done ? 'recorded' : { refused });

const handlers = {
  stop: (tx, request) => onTask(tx, request, { kind: 'stop' }),
  retry: (tx, request) => onTask(tx, request, { kind: 'retry', note: request.payload.note }),
  approve: (tx, request) => onTask(tx, request, { kind: 'approve', review: request.payload.review }),
  send_back: (tx, request) => onTask(tx, request, { kind: 'send_back', review: request.payload.review, note: request.payload.note }),
  answer: (tx, request) => onTask(tx, request, { kind: 'answer', review: request.payload.review, answer: request.payload.answer }),
  steer: async (tx, request) => {
    const steered = await steerWithin(tx, request.target, byWhom(request), request.payload.message, steerTurn);
    return 'recorded' in steered ? 'recorded' : steered;
  },
  pause: async (tx, request) => recordedOr((await pauseWithin(tx, request.target, byWhom(request))) === 'paused', 'The routine is already paused.'),
  resume: async (tx, request) => recordedOr((await resumeWithin(tx, request.target, byWhom(request))) === 'resumed', 'The routine is not paused.'),
  run_now: async (tx, request) => {
    const pressed = await runNowWithin(tx, request.target, byWhom(request));
    return typeof pressed === 'object' ? pressed : recordedOr(pressed === 'pressed', 'A Run now press already waits for this routine to start.');
  },
  save_routine: async (tx, request) => {
    const saved = await saveRoutine(tx, workflows, { action: request.action, person: request.person, at: request.at, routine: request.target, draft: request.payload });
    return 'version' in saved ? 'recorded' : saved;
  },
} satisfies Handlers<RequestKind>;

const checkSettings = (given: Settings, key: SealingKey): CheckLoopSettings => ({
  everyMs: given.CHECKS_EVERY_MS,
  leaseMs: given.CHECK_LEASE_MS,
  key,
  checks: checksFor({
    codex: { timeoutMs: given.CHECK_TIMEOUT_MS },
    github: { baseUrl: given.GITHUB_API_URL, timeoutMs: given.CHECK_TIMEOUT_MS },
    jira: { site: given.JIRA_SITE, timeoutMs: given.CHECK_TIMEOUT_MS },
  }),
  checker: `engine ${hostname()} ${String(process.pid)}`,
  now: () => new Date(),
  writeBack,
});

const workerLoops = (db: Database, given: Settings, key: SealingKey | undefined, runAs: RunAsRule, describeTicket: (ticket: string, actsAs: string) => Promise<string | null>): readonly Loop[] =>
  key === undefined || given.JOB_IMAGE === undefined || given.JOB_ENGINE_URL === undefined
    ? []
    : [
        attempts({
          everyMs: given.WORKER_EVERY_MS,
          startLeaseMs: given.ATTEMPT_START_LEASE_MS,
          runner,
          runAs,
          db,
          checks: checkSettings(given, key),
          jobs: { image: given.JOB_IMAGE, namespace: given.JOB_NAMESPACE, serviceAccount: given.JOB_SERVICE_ACCOUNT, deadlineSeconds: given.JOB_DEADLINE_SECONDS },
          engineUrl: given.JOB_ENGINE_URL,
          gitBaseUrl: given.GIT_BASE_URL,
          providers,
          startDeadlineMs: given.ENVIRONMENT_START_DEADLINE_MS,
          describeTicket,
        }),
      ];

const githubToken =
  (db: Database, key: SealingKey | undefined): OpenToken =>
  async actsAs => {
    if (key === undefined) return { failed: 'The engine has no CREDENTIAL_KEY, so it cannot open a GitHub token.' };
    const opened = await open(db, key, { connector: 'github', owner: actsAs });
    return 'secret' in opened ? { token: opened.secret } : { failed: opened.reason };
  };

const loopsFor = (given: Settings, key: SealingKey | undefined, db: Database): readonly Loop[] => {
  const jira: JiraAccess = { site: given.JIRA_SITE, timeoutMs: given.JIRA_TIMEOUT_MS, logins: person => openJiraLogin(db, key, person) };
  const sources = sourcesByKind([scheduleSource, jiraSearch(jira)]);
  const clientFor = clientsFrom(githubToken(db, key), given.GITHUB_API_URL);
  const performers = {
    ...jiraPerformers(jira, db),
    ...githubPerformers({ clientFor, mergeRowOf: outboxMergeRow(db) }),
  } satisfies Performers<ActionKind>;
  const actions = registryOf(performers);
  const runAs = coreRunAs(given.JIRA_SITE === undefined ? null : currentAssignee(jira));
  return [
    reaper({ everyMs: given.REAPER_EVERY_MS, leaseMs: given.LEASE_MS }),
    requests({ everyMs: given.REQUESTS_EVERY_MS, timeoutMs: given.REQUEST_TIMEOUT_MS, handlers, now: () => new Date() }),
    scheduler({ everyMs: given.SCHEDULER_EVERY_MS, leaseMs: given.ROUTINE_LEASE_MS, sources, workflows, now: postgresNow }),
    reconcile({ providers, everyMs: given.ENVIRONMENTS_EVERY_MS, startDeadlineMs: given.ENVIRONMENT_START_DEADLINE_MS }),
    ...landLoops({
      everyMs: given.LAND_EVERY_MS,
      leaseMs: given.LEASE_MS,
      read: mergeStateReader(db, clientFor),
      readTimeoutMs: given.LAND_READ_TIMEOUT_MS,
      review: coreReview,
      enqueue,
      clock: realClock,
      tasks: { claim: async (landDb, task, now, leaseMs) => claim(landDb, task, now, leaseMs, await runAs(landDb, task), null), renew, handOff, approveFromOutside, finish: (writer, attempt, report, now, then) => advance(writer, workflows, attempt, report, now, then) },
    }),
    ...(given.JOB_IMAGE === undefined ? [] : [sweep({ everyMs: given.SWEEP_EVERY_MS, cluster: connectCluster(given.JOB_NAMESPACE) })]),
    ...outboxLoops({ everyMs: given.OUTBOX_EVERY_MS, leaseMs: given.OUTBOX_LEASE_MS, marginMs: given.OUTBOX_MARGIN_MS, maxTries: given.OUTBOX_MAX_TRIES, time: databaseTime, registry: actions }),
    ...(key === undefined ? [] : [checkLoop(checkSettings(given, key))]),
    ...workerLoops(db, given, key, runAs, given.JIRA_SITE === undefined ? () => Promise.resolve(null) : ticketDescription(jira)),
  ];
};

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
    const unreachable = await sql`select 1`.execute(db).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    if (unreachable !== undefined) {
      process.stderr.write(`The engine did not start, because it could not reach Postgres at ${new URL(given.DATABASE_URL).host}, the host in DATABASE_URL. ${unreachable}\n`);
      process.exitCode = 1;
      return;
    }
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
    await publishWorkflows(db, workflows);
    await publishProviders(db, providers);
    const bridge = createServer(
      bridgeListener(
        db,
        { leaseMs: given.LEASE_MS, finish: (tx, attempt, now) => finishStep(runner, tx, attempt, now), now: () => new Date(), rules },
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
    const loops = loopsFor(given, key, db);
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
