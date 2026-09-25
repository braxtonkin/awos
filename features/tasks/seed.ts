import type { Database } from '../../shared/db/client.ts';
import type { TaskState } from '../../shared/db/types.ts';
import type { StepKind } from '../../shared/workflow.ts';
import { advance } from './advance.ts';
import { claim } from './claim.ts';
import { coreRunAs } from './run-as.ts';
import { workflowsByName } from './start.ts';
import { workflows } from './simulate.ts';

const hourMs = 3_600_000;

const dayMs = 24 * hourMs;

export const pastSeeds = {
  done: { finishedMsAgo: 2 * hourMs },
  expired: { finishedMsAgo: 31 * dayMs },
} as const;

export type PastSeed = keyof typeof pastSeeds;

export const pastSeedNames = Object.keys(pastSeeds) as readonly PastSeed[];

export type Planted = { readonly seed: PastSeed; readonly task: string; readonly key: string; readonly state: TaskState; readonly step: string; readonly finishedAt: Date };

const stepMs = 5 * 60_000;

const leaseMs = 60_000;

const byName = workflowsByName(workflows);

function passingOutput(kind: StepKind): unknown {
  const base = { outcome: 'done', summary: `Finished ${kind.name}.`, blocks: [{ kind: 'text', title: null, body: `The seeded ${kind.name} attempt did what the ticket asks.` }] };
  const found = [base, { ...base, behavior: 'fixed' }].find(output => kind.judge(output) === 'pass');
  if (found === undefined) throw new Error(`No seeded output passes the ${kind.name} step.`);
  return found;
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
  const steps = workflow.steps;
  const finishedAt = new Date(now.getTime() - pastSeeds[seed].finishedMsAgo);
  const foundAt = new Date(finishedAt.getTime() - steps.length * stepMs - stepMs);
  const task = await db
    .insertInto('task')
    .values({
      routine_id: version.routine_id,
      found_version: version.version,
      repository_id: version.repository_id,
      key,
      title: `Seeded work that ended ${seed === 'expired' ? 'long ago' : 'recently'}`,
      found_at: foundAt,
      workflow: version.workflow,
      needs_repository: version.needs_repository,
      step: steps[0].name,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const runAs = await coreRunAs(null)(db, task.id);
  for (const [index, kind] of steps.entries()) {
    const startedAt = new Date(foundAt.getTime() + (index + 1) * stepMs - stepMs / 2);
    const endedAt = index === steps.length - 1 ? finishedAt : new Date(startedAt.getTime() + stepMs / 2);
    const claimed = await claim(db, task.id, startedAt, leaseMs, runAs, null);
    if (!('attempt' in claimed)) throw new Error(`The seed could not claim ${kind.name} of ${key}: ${claimed.refused}.`);
    await advance(db, byName, claimed.attempt, { output: passingOutput(kind), observed: null }, endedAt);
  }
  const ended = await db.selectFrom('task').select(['task.state', 'task.step']).where('task.id', '=', task.id).executeTakeFirstOrThrow();
  return { seed, task: task.id, key, state: ended.state, step: ended.step, finishedAt };
}
