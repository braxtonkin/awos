import type { Database } from '../../shared/db/client.ts';
import type { TaskState, WaitingOn } from '../../shared/db/types.ts';
import type { Reproduction } from '../../shared/reproduction.ts';
import type { Review } from '../../shared/review.ts';
import type { Instruction, StepKind, Unasked, Workflow } from '../../shared/workflow.ts';
import { advance, handOff, type Then } from './advance.ts';
import { claim } from './claim.ts';
import { coreRunAs } from './run-as.ts';
import { beginFromNowhere } from './sim-jobs.ts';
import { workflowsByName } from './start.ts';
import { workflows } from './simulate.ts';

const hourMs = 3_600_000;

const dayMs = 24 * hourMs;

type Turn = { readonly output: (kind: StepKind) => unknown; readonly observed: Unasked | 'handed_off' | null; readonly evidence: Reproduction | null; readonly reply: Review | null };

type Ends = { readonly state: 'done' } | { readonly state: 'waiting'; readonly waitingOn: WaitingOn; readonly reason: Instruction };

type Story = { readonly title: string; readonly endedMsAgo: number; readonly turns: readonly Turn[]; readonly ends: Ends };

function passingOutput(kind: StepKind): unknown {
  const base = { outcome: 'done', summary: `Finished ${kind.name}.`, blocks: [{ kind: 'text', title: null, body: `The seeded ${kind.name} attempt did what the ticket asks.` }] };
  const found = [base, { ...base, behavior: 'fixed' }].find(output => kind.judge(output) === 'pass');
  if (found === undefined) throw new Error(`No seeded output passes the ${kind.name} step.`);
  return found;
}

const passes: Turn = { output: passingOutput, observed: null, evidence: null, reply: null };

const said = (summary: string, body: string): Review => ({ outcome: 'done', summary, blocks: [{ kind: 'text', title: null, body }] });

const madeNoChange = { ...said('The agent made no change.', "Implement made no change: the attempt pushed no commit, and it did not start from a lost attempt's push. Verify can only compare a change with the base, so the attempt failed."), outcome: 'fail' };

const answered = (reply: Review): Turn => ({ output: () => reply, observed: null, evidence: null, reply });

const reproducing = (reply: Review, evidence: Reproduction): Turn => ({ output: () => ({ ...reply, behavior: 'fixed' }), observed: null, evidence, reply });

const changedNothing = (reply: Review): Turn => ({ output: () => madeNoChange, observed: 'fail', evidence: null, reply });

const engineSaid = (verdict: Unasked | 'handed_off', output: Review): Turn => ({ output: () => output, observed: verdict, evidence: null, reply: null });

const stillRounded = said('The branch already rounds each price half up, so there was nothing to change.', 'roundPrice in src/prices.ts already rounds half up to the cent, and test/prices.test.ts already checks 2.675.');

const baseCommit = '2026cf3506c1612b6ebcea2b74dbe10eff048ffe';

const changeCommit = '297e66759ec41516810912fe4beba4d005628371';

const installed = { exitCode: 0, timedOut: false, output: 'added 38 packages, and audited 39 packages in 2s\n\nfound 0 vulnerabilities' };

const reproduced: Reproduction = {
  state: 'ran',
  script: 'set -e\nnpm test -- --run test/prices.test.ts\n',
  base: { commit: baseCommit, checkout: null, setup: installed, run: { exitCode: 1, timedOut: false, output: 'FAIL test/prices.test.ts: roundPrice(2.675) returned 2.67, not 2.68, because it rounds half down.' } },
  change: { commit: changeCommit, checkout: null, setup: installed, run: { exitCode: 0, timedOut: false, output: 'PASS test/prices.test.ts: 3 tests passed.' } },
};

const smokeTested: Reproduction = {
  state: 'ran',
  script: 'set -e\nnpm run smoke\n',
  base: { commit: baseCommit, checkout: null, setup: installed, run: { exitCode: 1, timedOut: false, output: 'npm error Missing script: "smoke"' } },
  change: { commit: changeCommit, checkout: null, setup: installed, run: { exitCode: 0, timedOut: false, output: 'PASS test/smoke.test.ts: the sandbox starts and answers.' } },
};

const handedOff = engineSaid('handed_off', said('Land owed pr.mark-ready.', `GitHub reported green-draft at ${changeCommit}, so Land owed pr.mark-ready.`));

const redCheck = engineSaid('red_check', said('Land sent the task back to Implement.', 'Land sent the task back, because a check failed: check.'));

const smokeWired = said('The requested smoke test wiring is present; all mandated checks pass.', 'npm run smoke runs test/smoke.test.ts, npm run check runs it after the unit tests, and both pass here.');

export const pastSeeds = {
  done: { title: 'Seeded work that ended recently', endedMsAgo: 2 * hourMs, turns: [passes, passes, passes, passes], ends: { state: 'done' } },
  expired: { title: 'Seeded work that ended long ago', endedMsAgo: 31 * dayMs, turns: [passes, passes, passes, passes], ends: { state: 'done' } },
  'failed-after-conflict': {
    title: 'Round each price half up to the cent',
    endedMsAgo: hourMs,
    turns: [
      answered(said('Round each price half up to the cent in src/prices.ts.', 'Change roundPrice in src/prices.ts to round half up, then add a test that 2.675 rounds to 2.68.')),
      answered(said('Changed src/prices.ts to round each price half up.', 'roundPrice now rounds half up to the cent, and test/prices.test.ts checks 2.675.')),
      reproducing(said('Wrote a script that checks roundPrice(2.675) returns 2.68.', 'The script runs the price tests, so it fails while roundPrice rounds half down and passes once it rounds half up.'), reproduced),
      engineSaid('handed_off', said('Land owed pr.mark-ready.', `GitHub reported green-draft at ${changeCommit}, so Land owed pr.mark-ready.`)),
      engineSaid('red_check', said('Land sent the task back to Implement.', 'Land sent the task back, because the pull request conflicts with its base branch.')),
      changedNothing(stillRounded),
      changedNothing(stillRounded),
      changedNothing(stillRounded),
    ],
    ends: { state: 'waiting', waitingOn: 'retry', reason: 'The Implement step failed 3 times in a row. Read its attempts on this page, fix what stopped them, then press Retry to run it again.' },
  },
  'failed-after-red-check': {
    title: 'Wire the smoke test into the sandbox checks',
    endedMsAgo: hourMs,
    turns: [
      answered(said('Add an npm run smoke script and run it from npm run check.', 'Add test/smoke.test.ts, which starts the sandbox and calls it once, add npm run smoke, and run it from npm run check.')),
      answered(said('Added the smoke test and ran it from npm run check.', 'test/smoke.test.ts starts the sandbox and calls it once, and npm run check runs it after the unit tests.')),
      reproducing(said('Wrote a script that runs npm run smoke.', 'The script fails while the sandbox has no smoke script and passes once npm run smoke runs the test.'), smokeTested),
      handedOff,
      redCheck,
      answered(said('Made the smoke test wait for the sandbox to listen.', 'test/smoke.test.ts now waits for the port before it calls the sandbox, so it no longer races the start.')),
      reproducing(said('Wrote a script that runs npm run smoke.', 'The script fails while the sandbox has no smoke script and passes once npm run smoke runs the test.'), smokeTested),
      handedOff,
      redCheck,
      changedNothing(smokeWired),
      changedNothing(smokeWired),
      changedNothing(smokeWired),
    ],
    ends: { state: 'waiting', waitingOn: 'retry', reason: 'The Implement step failed 3 times in a row. Read its attempts on this page, fix what stopped them, then press Retry to run it again.' },
  },
} as const satisfies Readonly<Record<string, Story>>;

export type PastSeed = keyof typeof pastSeeds;

export const pastSeedNames = Object.keys(pastSeeds) as readonly PastSeed[];

export type Planted = { readonly seed: PastSeed; readonly task: string; readonly key: string; readonly state: TaskState; readonly step: string; readonly waitingOn: WaitingOn | null; readonly reason: string | null; readonly finishedAt: Date };

const turnMs = 5 * 60_000;

const leaseMs = 60_000;

const byName = workflowsByName(workflows);

const sentBackForConflicts = new Map([...byName.keys()].map(name => [name, { sentBack: () => ({ kind: 'conflict' }) as const }]));

const recording = (attempt: string, evidence: Reproduction | null, at: Date): Then => async (tx, standing) => {
  if (evidence !== null) await tx.insertInto('evidence').values({ attempt_id: attempt, task_id: standing.task, body: JSON.stringify(evidence), recorded_at: at }).execute();
};

const replyLine = (reply: Review) => ({ method: 'item/completed', params: { turnId: 'seeded', item: { id: 'reply', type: 'agentMessage', text: JSON.stringify(reply) } } });

async function play(db: Database, workflow: Workflow, attempt: string, turn: Turn, endedAt: Date): Promise<void> {
  const claimed = await db.selectFrom('attempt').select('attempt.step').where('attempt.id', '=', attempt).executeTakeFirstOrThrow();
  const kind = workflow.steps.find(candidate => candidate.name === claimed.step);
  if (kind === undefined) throw new Error(`${workflow.name} has no step ${claimed.step}.`);
  if (turn.reply !== null) {
    await db
      .insertInto('attempt_event')
      .values({ attempt_id: attempt, seq: '1', kind: 'app', method: 'item/completed', item_id: 'reply', fragment: false, body: JSON.stringify(replyLine(turn.reply)), stored_at: endedAt })
      .execute();
  }
  const output = turn.output(kind);
  const then = recording(attempt, turn.evidence, endedAt);
  if (turn.observed === 'handed_off') await handOff(db, attempt, output, endedAt, then);
  else await advance(db, byName, attempt, { output, observed: turn.observed }, endedAt, then);
}

export async function seedPast(db: Database, seed: PastSeed, routineName: string, key: string, now: Date): Promise<Planted> {
  const version = await db
    .selectFrom('routine_version as version')
    .select(['version.routine_id', 'version.version', 'version.workflow', 'version.repository_id', 'version.needs_repository'])
    .where('version.name', '=', routineName)
    .orderBy('version.version', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (version === undefined) throw new Error(`No routine is named ${routineName}.`);
  const workflow = byName.get(version.workflow);
  if (workflow === undefined) throw new Error(`The routine ${routineName} runs ${version.workflow}, which the seed does not know.`);
  const { title, endedMsAgo, turns }: Story = pastSeeds[seed];
  const finishedAt = new Date(now.getTime() - endedMsAgo);
  const foundAt = new Date(finishedAt.getTime() - turns.length * turnMs - turnMs);
  const task = await db
    .insertInto('task')
    .values({
      routine_id: version.routine_id,
      found_version: version.version,
      repository_id: version.repository_id,
      key,
      title,
      found_at: foundAt,
      workflow: version.workflow,
      needs_repository: version.needs_repository,
      step: workflow.steps[0].name,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const runAs = await coreRunAs(null)(db, task.id);
  for (const [index, turn] of turns.entries()) {
    const startedAt = new Date(foundAt.getTime() + (index + 1) * turnMs - turnMs / 2);
    const endedAt = index === turns.length - 1 ? finishedAt : new Date(startedAt.getTime() + turnMs / 2);
    const claimed = await claim(db, task.id, startedAt, leaseMs, runAs, await beginFromNowhere(db, byName, sentBackForConflicts, task.id, runAs));
    if (!('attempt' in claimed)) throw new Error(`The seed could not claim turn ${String(index + 1)} of ${key}: ${claimed.refused}.`);
    await play(db, workflow, claimed.attempt, turn, endedAt);
  }
  const ended = await db.selectFrom('task').select(['task.state', 'task.step', 'task.waiting_on', 'task.waiting_reason']).where('task.id', '=', task.id).executeTakeFirstOrThrow();
  return { seed, task: task.id, key, state: ended.state, step: ended.step, waitingOn: ended.waiting_on, reason: ended.waiting_reason, finishedAt };
}
