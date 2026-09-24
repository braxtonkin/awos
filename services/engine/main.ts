import { hostname } from 'node:os';
import { z } from 'zod';
import { checkLoop } from '../../features/credentials/check-loop.ts';
import { checksFor } from '../../features/credentials/checks.ts';
import { githubApi } from '../../features/credentials/github-check.ts';
import { sealingKey, type SealingKey } from '../../features/credentials/seal.ts';
import { writeBack } from '../../features/credentials/store.ts';
import { outboxLoops, registryOf } from '../../features/outbox/perform.ts';
import { reaper } from '../../features/tasks/reaper.ts';
import { startProblems } from '../../features/tasks/start.ts';
import type { OwedKinds, Performers } from '../../shared/actions.ts';
import { connect } from '../../shared/db/client.ts';
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
  CHECKS_EVERY_MS: milliseconds.default(60_000),
  CHECK_LEASE_MS: milliseconds.default(300_000),
  CHECK_TIMEOUT_MS: milliseconds.default(120_000),
  GITHUB_API_URL: z.url({ protocol: /^https?$/ }).default(githubApi),
  OUTBOX_EVERY_MS: milliseconds.default(1_000),
  OUTBOX_LEASE_MS: milliseconds.default(60_000),
  OUTBOX_MARGIN_MS: milliseconds.default(5_000),
  OUTBOX_MAX_TRIES: z.coerce.number().int().positive().default(3),
});

type Settings = z.infer<typeof settings>;

type ActionKind = OwedKinds<Workflow>;

const performers = {} satisfies Performers<ActionKind>;

const actions = registryOf(performers);

const loopsFor = (given: Settings, key: SealingKey | undefined): readonly Loop[] => [
  reaper({ everyMs: given.REAPER_EVERY_MS, leaseMs: given.LEASE_MS }),
  ...outboxLoops({ everyMs: given.OUTBOX_EVERY_MS, leaseMs: given.OUTBOX_LEASE_MS, marginMs: given.OUTBOX_MARGIN_MS, maxTries: given.OUTBOX_MAX_TRIES, clock: realClock, registry: actions }),
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
    const loops = loopsFor(given, key);
    if (key === undefined) say('The engine has no CREDENTIAL_KEY, so it opens and checks no credentials.');
    say(`The engine runs the workflows ${[...workflows.keys()].join(', ')}, and the loops ${loops.map(loop => `${loop.name} every ${String(loop.everyMs)} ms`).join(', ')}.`);
    await Promise.all(loops.map(loop => runLoop(loop, db, realClock, stop.signal, say)));
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
