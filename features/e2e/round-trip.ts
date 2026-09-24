import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { sql } from 'kysely';
import { z } from 'zod';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { buildAttemptImage, ensureRegistry, gitServer, jobNamespace, kindAddress, kubernetes, pushByDigest, registry, seedRepository, sh, type GitServer } from '../../tools/verify/cluster.ts';
import { kind } from '../../tools/verify/kind.ts';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { accessCopy, actAs, applySetup, closeStore, fakeCodexLogin, openStore, startEngine, until, type Engine, type Store } from './autoworker.ts';
import { standInPlan, ticking } from './codex-stand-in.ts';

const owner = 'owner@example.com';
const repository = 'lane/sandbox';
const serviceAccount = 'autoworker-job';
const bridgePort = 4520;
const stepWaitMs = 180_000;
const realWaitMs = 900_000;

type World = {
  readonly store: Store;
  readonly git: GitServer;
  readonly address: string;
  readonly namespace: string;
  readonly core: ReturnType<typeof kubernetes>;
  readonly routine: string;
  readonly out: (line: string) => void;
};

const setupFile = (codexLogin: string) => ({
  admin: owner,
  people: [{ name: 'Lane Owner', email: owner, logins: { github: { env: 'LANE_GITHUB_TOKEN' }, codex: { file: codexLogin } } }],
  repositories: [{ github: repository, branch: 'main' }],
  routines: [
    {
      name: 'Round trip',
      goal: 'Take each made-up task through Specify and Implement.',
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

async function seedWorld(store: Store, codexText: string): Promise<string> {
  const loginFile = join(store.folder, 'codex.json');
  await writeFile(loginFile, codexText, { mode: 0o600 });
  const setup = await applySetup(store, setupFile(loginFile), { LANE_GITHUB_TOKEN: 'lane-token-for-the-git-daemon' });
  if (setup.code !== 0) throw new Error(`setup failed: ${setup.out}`);
  const routine = await store.db.selectFrom('routine').select('routine.id').executeTakeFirstOrThrow();
  return routine.id;
}

async function trustLogins(store: Store): Promise<void> {
  await store.db.updateTable('credential').set({ state: 'valid', checked_at: new Date() }).execute();
}

async function addTask(world: World, key: string, title: string): Promise<string> {
  const version = await world.store.db.selectFrom('routine_version').select(['routine_version.version', 'routine_version.repository_id']).where('routine_id', '=', world.routine).executeTakeFirstOrThrow();
  const row = await world.store.db
    .insertInto('task')
    .values({ routine_id: world.routine, found_version: version.version, repository_id: version.repository_id, key, title, found_at: new Date(), workflow: 'code-change', needs_repository: true, step: 'specify' })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

const engineSettings = (world: World, image: string): Readonly<Record<string, string>> => ({
  JOB_IMAGE: image,
  JOB_NAMESPACE: world.namespace,
  JOB_ENGINE_URL: `http://${world.address}:${String(bridgePort)}/`,
  GIT_BASE_URL: world.git.base,
  BRIDGE_PORT: String(bridgePort),
  BRIDGE_POLL_MS: '100',
  WORKER_EVERY_MS: '1000',
  SWEEP_EVERY_MS: '2000',
  REAPER_EVERY_MS: '5000',
  LEASE_MS: '60000',
  ATTEMPT_START_LEASE_MS: '240000',
  SCHEDULER_EVERY_MS: '600000',
  CHECKS_EVERY_MS: '600000',
});

type Attempt = { readonly id: string; readonly step: string; readonly verdict: string | null; readonly finished: boolean };

async function attemptsOf(world: World, key: string): Promise<readonly Attempt[]> {
  const rows = await world.store.db
    .selectFrom('attempt')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .select(['attempt.id', 'attempt.step', 'attempt.verdict', 'attempt.finished_at'])
    .where('task.key', '=', key)
    .orderBy('attempt.id')
    .execute();
  return rows.map(row => ({ id: row.id, step: row.step, verdict: row.verdict, finished: row.finished_at !== null }));
}

async function taskOf(world: World, key: string): Promise<{ readonly step: string; readonly state: string; readonly waitingOn: string | null; readonly reason: string | null }> {
  const row = await world.store.db.selectFrom('task').select(['step', 'state', 'waiting_on', 'waiting_reason']).where('key', '=', key).executeTakeFirstOrThrow();
  return { step: row.step, state: row.state, waitingOn: row.waiting_on, reason: row.waiting_reason };
}

const promptOf = async (world: World, attempt: string): Promise<string> =>
  (await world.store.db.selectFrom('attempt_command').select('input').where('attempt_id', '=', attempt).where('kind', '=', 'turn.start').executeTakeFirst())?.input ?? '';

const podsOf = async (world: World, attempt: string): Promise<readonly { readonly name: string; readonly phase: string; readonly finishedAt: Date | undefined }[]> => {
  const { items } = await world.core.listNamespacedPod({ namespace: world.namespace, labelSelector: `autoworker.dev/attempt=${attempt}` });
  return items.map(pod => ({
    name: pod.metadata?.name ?? '',
    phase: pod.status?.phase ?? 'Unknown',
    finishedAt: pod.status?.containerStatuses?.[0]?.state?.terminated?.finishedAt,
  }));
};

const logOf = async (world: World, pod: string): Promise<string> => {
  try {
    return await world.core.readNamespacedPodLog({ name: pod, namespace: world.namespace, timestamps: true });
  } catch {
    return '';
  }
};

const waitForAttempt = (world: World, key: string, step: string, index = 0): Promise<Attempt | undefined> =>
  until(stepWaitMs, async () => (await attemptsOf(world, key)).filter(attempt => attempt.step === step)[index]);

const waitForWait = (world: World, key: string, ms = stepWaitMs): Promise<string | undefined> =>
  until(ms, async () => {
    const task = await taskOf(world, key);
    return task.state === 'waiting' ? (task.reason ?? '') : undefined;
  });

const waitForRunningPod = (world: World, attempt: string, ms = stepWaitMs): Promise<string | undefined> =>
  until(ms, async () => (await podsOf(world, attempt)).find(pod => pod.phase === 'Running' || pod.phase === 'Succeeded')?.name);

async function storedTicks(world: World, attempt: string): Promise<readonly string[]> {
  const rows = await world.store.db
    .selectFrom('attempt_event')
    .select(sql<string>`body -> 'params' -> 'item' ->> 'text'`.as('text'))
    .where('attempt_id', '=', attempt)
    .where('method', '=', 'item/completed')
    .execute();
  return rows.map(row => row.text).filter(text => /^tick \d+$/.test(text));
}

async function overheadCheck(world: World, label: string, attempt: string | undefined): Promise<Check> {
  const name = `${label} perf: the engine's overhead for the Specify attempt is under 60 s`;
  const found = attempt === undefined ? undefined : await overheadOf(world, attempt);
  if (found === undefined) return fail(name, 'the attempt has no turn start, turn end, or finish');
  const total = found.toTurnMs + found.toVerdictMs;
  return total <= 60_000 ? pass(name, `${String(found.toTurnMs)} ms from claim to turn start, ${String(found.toVerdictMs)} ms from turn end to verdict`) : fail(name, `${String(total)} ms`);
}

type Overhead = { readonly toTurnMs: number; readonly toVerdictMs: number };

async function overheadOf(world: World, attempt: string): Promise<Overhead | undefined> {
  const row = await world.store.db
    .selectFrom('attempt')
    .select(eb => [
      'attempt.started_at',
      'attempt.finished_at',
      eb.selectFrom('attempt_command').select('attempt_command.acted_at').whereRef('attempt_command.attempt_id', '=', 'attempt.id').where('attempt_command.kind', '=', 'turn.start').as('turn_started'),
      eb.selectFrom('attempt_event').select('attempt_event.stored_at').whereRef('attempt_event.attempt_id', '=', 'attempt.id').where('attempt_event.method', '=', 'turn/completed').as('turn_ended'),
    ])
    .where('attempt.id', '=', attempt)
    .executeTakeFirst();
  if (row?.finished_at == null || row.turn_started == null || row.turn_ended == null) return undefined;
  return { toTurnMs: row.turn_started.getTime() - row.started_at.getTime(), toVerdictMs: row.finished_at.getTime() - row.turn_ended.getTime() };
}

async function roundTrip(world: World, image: string, label: string, plan: (stored: string) => boolean): Promise<readonly Check[]> {
  const key = `${label}-a`;
  await addTask(world, key, 'Change titleCase in src/words.ts so it returns the text with the first letter of each space-separated word in upper case and the rest unchanged. The behavior is fully specified here, so plan without asking questions.');
  const engine = startEngine(world.store, engineSettings(world, image), world.out);
  try {
    const specify = await waitForAttempt(world, key, 'specify');
    const reason = await waitForWait(world, key, label === 'real' ? realWaitMs : stepWaitMs);
    const evidence = specify === undefined ? undefined : await world.store.db.selectFrom('evidence').select('body').where('attempt_id', '=', specify.id).executeTakeFirst();
    const stored = z.object({ plan: z.string() }).safeParse(evidence?.body);
    const model = specify === undefined ? undefined : await world.store.db.selectFrom('attempt_event').select(sql<string>`body -> 'result' ->> 'model'`.as('model')).where('attempt_id', '=', specify.id).where(sql<boolean>`body ->> 'id' = 'bridge-thread-start'`).executeTakeFirst();
    const specifyGone = specify === undefined ? undefined : await until(60_000, async () => ((await podsOf(world, specify.id)).length === 0 ? true : undefined));
    const implementBefore = (await attemptsOf(world, key)).filter(attempt => attempt.step === 'implement');
    const checks: Check[] = [
      stored.success && plan(stored.data.plan) ? pass(`${label} 3: Postgres holds the plan`, stored.data.plan.slice(0, 200)) : fail(`${label} 3: Postgres holds the plan`, `${JSON.stringify(evidence?.body ?? null)}; ${engine.said().slice(-1500)}`),
      reason?.includes(`Approve specify for task ${key}`) === true
        ? pass(`${label} 3: the task waits for Approve`, reason)
        : fail(`${label} 3: the task waits for Approve`, `${reason ?? 'the task never waited'}; the review: ${JSON.stringify(specify === undefined ? null : ((await world.store.db.selectFrom('attempt').select('output').where('id', '=', specify.id).executeTakeFirst())?.output ?? null)).slice(0, 1500)}`),
      specifyGone === true ? pass(`${label} 3: the Specify pod is gone`, `attempt ${specify?.id ?? ''}`) : fail(`${label} 3: the Specify pod is gone`, 'a pod still runs'),
      implementBefore.length === 0 ? pass(`${label} 3: no Implement attempt before Approve`, 'none') : fail(`${label} 3: no Implement attempt before Approve`, JSON.stringify(implementBefore)),
      await overheadCheck(world, label, specify?.id),
      model?.model === 'gpt-6-luna' ? pass(`${label}: the thread ran on gpt-6-luna`, 'thread/start answered gpt-6-luna') : fail(`${label}: the thread ran on gpt-6-luna`, JSON.stringify(model ?? null)),
    ];
    const approved = await actAs(world.store, ['approve', key, '--step', 'specify', '--as', owner]);
    checks.push(approved.code === 0 ? pass(`${label} 4: act.ts approve`, approved.out) : fail(`${label} 4: act.ts approve`, approved.out));
    const implement = await waitForAttempt(world, key, 'implement');
    const pod = implement === undefined ? undefined : await waitForRunningPod(world, implement.id);
    const prompt = implement === undefined ? '' : await promptOf(world, implement.id);
    checks.push(
      pod !== undefined ? pass(`${label} 4: an Implement pod starts`, pod) : fail(`${label} 4: an Implement pod starts`, engine.said().slice(-1500)),
      stored.success && prompt.includes(stored.data.plan) ? pass(`${label} 4: the Implement prompt holds the plan`, `${String(prompt.length)} characters`) : fail(`${label} 4: the Implement prompt holds the plan`, prompt.slice(0, 600)),
    );
    const stopped = await actAs(world.store, ['stop', key, '--as', owner]);
    checks.push(stopped.code === 0 ? pass(`${label}: the task stops for cleanup`, stopped.out) : fail(`${label}: the task stops for cleanup`, stopped.out));
    world.out(`${label}: ${String(checks.filter(check => check.passed).length)} of ${String(checks.length)} passed`);
    return checks;
  } finally {
    await engine.stop();
  }
}

async function sendBack(world: World, image: string): Promise<readonly Check[]> {
  const key = 'stand-in-b';
  const note = 'Plan for the smaller change only.';
  await addTask(world, key, 'Make titleCase capitalize each word.');
  const engine = startEngine(world.store, engineSettings(world, image), world.out);
  try {
    const reason = await waitForWait(world, key);
    const sent = await actAs(world.store, ['send-back', key, '--step', 'specify', '--note', note, '--as', owner]);
    const again = await waitForAttempt(world, key, 'specify', 1);
    const prompt = again === undefined ? '' : await promptOf(world, again.id);
    const routineAt = prompt.indexOf('Keep the plan to one paragraph.');
    const noteAt = prompt.indexOf(note);
    await waitForWait(world, key);
    await actAs(world.store, ['stop', key, '--as', owner]);
    return [
      reason === undefined ? fail('5: the second task waits for Approve', engine.said().slice(-800)) : pass('5: the second task waits for Approve', reason),
      sent.code === 0 ? pass('5: act.ts send-back', sent.out) : fail('5: act.ts send-back', sent.out),
      noteAt > routineAt && routineAt >= 0 ? pass("5: Specify runs again with the note after the routine's instructions", `attempt ${again?.id ?? ''}`) : fail("5: Specify runs again with the note after the routine's instructions", prompt.slice(0, 800)),
    ];
  } finally {
    await engine.stop();
  }
}

async function outage(world: World, image: string): Promise<readonly Check[]> {
  const key = 'stand-in-c';
  const ticks = 16;
  await addTask(world, key, `Tick through the turn: ${ticking(ticks, 1000)}.`);
  let engine: Engine = startEngine(world.store, engineSettings(world, image), world.out);
  try {
    const specify = await waitForAttempt(world, key, 'specify');
    const started = specify === undefined ? undefined : await until(stepWaitMs, async () => ((await storedTicks(world, specify.id)).length >= 3 ? true : undefined));
    await engine.stop();
    const downAt = Date.now();
    await wait(8_000);
    engine = startEngine(world.store, engineSettings(world, image), world.out);
    const reason = await waitForWait(world, key);
    const stored = specify === undefined ? [] : await storedTicks(world, specify.id);
    const expected = Array.from({ length: ticks }, (_, index) => `tick ${String(index + 1)}`);
    const seqs = specify === undefined ? [] : await world.store.db.selectFrom('attempt_event').select('seq').where('attempt_id', '=', specify.id).orderBy('seq').execute();
    const gaps = seqs.filter((row, index) => index > 0 && Number(row.seq) !== Number(seqs[index - 1]?.seq ?? 0) + 1).length;
    await actAs(world.store, ['stop', key, '--as', owner]);
    const name = '6: an 8 s engine stop mid-turn loses and repeats no event';
    return [
      started === true && reason !== undefined && JSON.stringify([...stored].sort()) === JSON.stringify([...expected].sort()) && new Set(stored).size === stored.length
        ? pass(name, `${String(stored.length)} ticks stored once each, engine down ${String(Math.round((Date.now() - downAt) / 1000))} s before the turn ended, ${String(gaps)} gaps among the ${String(seqs.length)} numbered lines left after fragments were pruned`)
        : fail(name, `stored ${JSON.stringify(stored)}; waited ${reason ?? 'never'}; ${engine.said().slice(-800)}`),
    ];
  } finally {
    await engine.stop();
  }
}

const logTime = (log: string, needle: string): number | undefined => {
  const line = log.split('\n').find(entry => entry.includes(needle));
  const stamp = line?.split(' ')[0];
  return stamp === undefined ? undefined : Date.parse(stamp);
};

async function stopMidTurn(world: World, image: string): Promise<readonly Check[]> {
  const key = 'stand-in-d';
  await addTask(world, key, `Tick until stopped: ${ticking(120, 1000)}.`);
  const engine = startEngine(world.store, engineSettings(world, image), world.out);
  try {
    const specify = await waitForAttempt(world, key, 'specify');
    const ticked = specify === undefined ? undefined : await until(stepWaitMs, async () => ((await storedTicks(world, specify.id)).length >= 2 ? true : undefined));
    const stopped = await actAs(world.store, ['stop', key, '--as', owner]);
    const at = await world.store.db.selectFrom('human_action').innerJoin('task', 'task.id', 'human_action.task_id').select('human_action.at').where('task.key', '=', key).where('human_action.kind', '=', 'stop_task').executeTakeFirst();
    const exited = specify === undefined ? undefined : await until(60_000, async () => (await podsOf(world, specify.id)).find(pod => pod.finishedAt !== undefined));
    const log = exited === undefined ? '' : await logOf(world, exited.name);
    const turnEnded = logTime(log, 'stand-in turn interrupted');
    const stopAt = at?.at.getTime();
    const endedWithinMs = turnEnded === undefined || stopAt === undefined ? undefined : turnEnded - stopAt;
    return [
      ticked === true && stopped.code === 0 ? pass('7: act.ts stop mid-turn', stopped.out) : fail('7: act.ts stop mid-turn', `${stopped.out}; ${engine.said().slice(-800)}`),
      endedWithinMs !== undefined && endedWithinMs <= 1000 ? pass('7: the turn ends within 1 s of the stop', `${String(endedWithinMs)} ms`) : fail('7: the turn ends within 1 s of the stop', `${String(endedWithinMs)} ms; ${log.slice(-800)}`),
      exited !== undefined ? pass('7: the pod exits', `${exited.name} finished at ${exited.finishedAt?.toISOString() ?? ''}`) : fail('7: the pod exits', 'still running after 60 s'),
    ];
  } finally {
    await engine.stop();
  }
}

async function stopThenRetry(world: World, image: string): Promise<readonly Check[]> {
  const key = 'stand-in-e';
  const note = 'Keep the old export name.';
  await addTask(world, key, `Implement slowly: ${ticking(60, 1000)}.`);
  const engine = startEngine(world.store, engineSettings(world, image), world.out);
  try {
    await waitForWait(world, key);
    await actAs(world.store, ['approve', key, '--step', 'specify', '--as', owner]);
    const implement = await waitForAttempt(world, key, 'implement');
    const ticked = implement === undefined ? undefined : await until(stepWaitMs, async () => ((await storedTicks(world, implement.id)).length >= 2 ? true : undefined));
    const stopped = await actAs(world.store, ['stop', key, '--as', owner]);
    const ended = implement === undefined ? undefined : await until(10_000, async () => ((await attemptsOf(world, key)).find(attempt => attempt.id === implement.id)?.verdict === 'stopped' ? true : undefined));
    const retried = await actAs(world.store, ['retry', key, '--note', note, '--as', owner]);
    const again = await waitForAttempt(world, key, 'implement', 1);
    const prompt = again === undefined ? '' : await promptOf(world, again.id);
    const specifies = (await attemptsOf(world, key)).filter(attempt => attempt.step === 'specify');
    await actAs(world.store, ['stop', key, '--as', owner]);
    return [
      ticked === true && stopped.code === 0 && ended === true ? pass('8: Stop ends the Implement attempt at once', stopped.out) : fail('8: Stop ends the Implement attempt at once', `${stopped.out}; ${engine.said().slice(-800)}`),
      retried.code === 0 && again !== undefined && specifies.length === 1
        ? pass('8: Retry resumes the task at Implement and keeps Specify', `attempt ${again.id}, one Specify attempt`)
        : fail('8: Retry resumes the task at Implement and keeps Specify', `${retried.out}; ${String(specifies.length)} Specify attempts`),
      prompt.includes(`## Note from Lane Owner

${note}`) && prompt.indexOf(note) > prompt.indexOf('# Implement')
        ? pass("8: the next Implement prompt holds the note after the step's own prompt", `attempt ${again?.id ?? ''}`)
        : fail("8: the next Implement prompt holds the note after the step's own prompt", prompt.slice(0, 800)),
    ];
  } finally {
    await engine.stop();
  }
}

async function standInImage(attemptImage: string): Promise<string> {
  const tag = `${registry.host}/autoworker-job-stand-in:round-trip`;
  const dockerfile = [
    `FROM ${attemptImage}`,
    'USER root',
    `RUN rm -f /usr/local/bin/codex && printf '#!/bin/sh\\nexec node /app/features/e2e/codex-stand-in.ts "$@"\\n' > /usr/local/bin/codex && chmod 755 /usr/local/bin/codex`,
    'USER 10001:10001',
  ].join('\n');
  await sh(`printf '%s\\n' '${dockerfile.replaceAll("'", "'\\''")}' | docker build -q -t ${tag} -`);
  return pushByDigest(tag);
}

const lanes = ['stand-in', 'send-back', 'outage', 'stop', 'retry', 'real'] as const;

type Lane = (typeof lanes)[number];

const isLane = (name: string): name is Lane => lanes.some(lane => lane === name);

async function roundTripLive(args: readonly string[], out: (line: string) => void): Promise<readonly Check[]> {
  const chosen = args.length === 0 || args.includes('all') ? [...lanes] : args;
  const unknown = chosen.filter(name => !isLane(name));
  if (unknown.length > 0) return [fail('round-trip names known parts', `unknown ${unknown.join(', ')}; name any of ${lanes.join(', ')}, or all`)];
  const checks: Check[] = [...(await kind.run(['up']))];
  if (!checks.every(check => check.passed)) return checks;
  checks.push(pass('1: registry ready', await ensureRegistry()));
  const attemptImage = await buildAttemptImage(`${registry.host}/autoworker-job:round-trip`);
  const standIn = await standInImage(attemptImage);
  checks.push(pass('1: attempt images built', `${attemptImage}; stand-in ${standIn}`));
  const address = await kindAddress();
  const core = kubernetes();
  const namespace = `round-trip-${randomBytes(3).toString('hex')}`;
  await jobNamespace(core, namespace, serviceAccount);
  const git = await gitServer(address);
  const head = await seedRepository(git, repository, { 'README.md': 'A sandbox for the round trip.\n', 'src/words.ts': 'export const titleCase = (text: string): string => text;\n' });
  checks.push(pass('1: kind, a namespace, and a git server ready', `${namespace}, ${git.base}${repository}.git at ${head}`));
  try {
    return await withPostgres(async postgres => {
      const scratch = await postgres.scratch();
      const store = await openStore(scratch.stableUrl);
      try {
        const routine = await seedWorld(store, fakeCodexLogin());
        await trustLogins(store);
        const world: World = { store, git, address, namespace, core, routine, out };
        checks.push(pass('1: Postgres and the setup file ready', `routine ${routine} with a gate after Specify`));
        for (const name of chosen.filter(isLane)) {
          const began = performance.now();
          try {
            if (name === 'stand-in') checks.push(...(await roundTrip(world, standIn, 'stand-in', stored => stored === standInPlan)));
            if (name === 'send-back') checks.push(...(await sendBack(world, standIn)));
            if (name === 'outage') checks.push(...(await outage(world, standIn)));
            if (name === 'stop') checks.push(...(await stopMidTurn(world, standIn)));
            if (name === 'retry') checks.push(...(await stopThenRetry(world, standIn)));
            if (name === 'real') {
              const reseeded = await seedWorld(store, await accessCopy());
              await store.db.updateTable('credential').set({ state: 'valid', checked_at: new Date() }).where('connector', '=', 'github').execute();
              checks.push(...(await roundTrip({ ...world, routine: reseeded }, attemptImage, 'real', stored => stored.trim().length > 0)));
            }
          } catch (error) {
            checks.push(fail(`${name}: runs to completion`, error instanceof Error ? error.message : String(error)));
          }
          checks.push(pass(`${name}: took`, `${((performance.now() - began) / 1000).toFixed(1)} s`));
        }
        return checks;
      } finally {
        await closeStore(store);
        await scratch.drop();
      }
    });
  } finally {
    await git.stop();
    await core.deleteNamespace({ name: namespace });
  }
}

export const roundTripScenario: Scenario = {
  name: 'round-trip',
  summary: "runs the owner's round trip on kind: a Specify pod with the real bridge, a gate, Approve, Send back, an 8 s engine stop, and Stop; name parts, or all",
  run: args =>
    roundTripLive(args, line => {
      process.stdout.write(`${line}\n`);
    }),
};
