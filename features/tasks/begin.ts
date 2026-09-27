import { sql } from 'kysely';
import type { AgentSteps, Earlier } from '../../shared/agent-step.ts';
import type { Database } from '../../shared/db/client.ts';
import type { FailedCheck, PersonNote, ReworkObligation, SendBack } from '../../shared/rework.ts';
import { runByAgent, type Failure, type Instruction, type Workflow } from '../../shared/workflow.ts';
import { continuation, taskBranchHead, type Continuation } from './continuation.ts';
import type { Workflows } from './start.ts';
import { earlierOf } from './history.ts';

export type Start = { readonly commit: string; readonly inherited: boolean };

export type BranchHead = (actsAs: string, github: string, branch: string) => Promise<{ readonly head: string } | { readonly refused: Instruction }>;

export type FailedChecks = (actsAs: string, github: string, head: string, names: readonly [string, ...string[]]) => Promise<readonly [FailedCheck, ...FailedCheck[]]>;

export type Reads = { readonly branchHead: BranchHead; readonly failedChecks: FailedChecks };

export type Seen = { readonly epoch: number; readonly latest: string | null };

const begun = Symbol('begun');

export type Begun = { readonly start: Start | null; readonly obligation: ReworkObligation | null; readonly seen: Seen; readonly [begun]: true };

export type Beginning = {
  readonly reads: Reads;
  readonly runner: { readonly workflows: Workflows; readonly agents: ReadonlyMap<string, Pick<AgentSteps, 'sentBack'>> };
  readonly continuation?: (db: Database, task: string) => Promise<Continuation>;
};

type Refused = { readonly refused: Instruction };

type Repository = { readonly github: string; readonly branch: string };

type Cause = Exclude<ReworkObligation, { readonly kind: 'note' }>;

const noRepositoryToRead: Instruction = 'This task came back for a reason AutoWorker reads from GitHub, and it has no repository to read it in. Stop the task, then save the routine with a repository.';

async function startFrom(found: Continuation, branchHead: BranchHead, runAs: string): Promise<Start | Refused | null> {
  switch (found.from) {
    case 'lost':
      return { commit: found.commit, inherited: true };
    case 'task':
      return { commit: found.commit, inherited: false };
    case 'repository': {
      const read = await branchHead(runAs, found.github, found.branch);
      return 'refused' in read ? read : { commit: read.head, inherited: false };
    }
    case 'nowhere':
      return null;
  }
}

const returnsTo = (workflow: Workflow, { step, verdict }: Earlier, target: string): boolean => {
  const failures: Readonly<Partial<Record<string, Failure>>> = workflow.steps.find(kind => kind.name === step)?.failures ?? {};
  const failure = failures[verdict];
  return failure !== undefined && (failure.kind === 'return' || failure.kind === 'review') && failure.to === target;
};

export const senderOf = (workflow: Workflow, earlier: readonly Earlier[], step: string): Earlier | undefined =>
  earlier
    .slice(earlier.findLastIndex(entry => entry.step === step && entry.verdict === 'pass') + 1)
    .findLast(entry => returnsTo(workflow, entry, step));

async function notesOf(db: Database, task: string): Promise<readonly PersonNote[]> {
  const previous = await db
    .selectFrom('attempt')
    .select('attempt.started_at')
    .where('attempt.task_id', '=', task)
    .where('attempt.verdict', 'not in', ['lost', 'not_launched'])
    .orderBy('attempt.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const rows = await db
    .selectFrom('human_action')
    .innerJoin('person', 'person.id', 'human_action.person_id')
    .select(['person.name', sql<string>`human_action.detail ->> 'note'`.as('note')])
    .where('human_action.task_id', '=', task)
    .where('human_action.kind', 'in', ['retry_task', 'send_back'])
    .where(sql<boolean>`human_action.detail ? 'note'`)
    .where('human_action.at', '>', previous?.started_at ?? new Date(0))
    .orderBy('human_action.at')
    .execute();
  return rows.map(row => ({ by: row.name, text: row.note }));
}

type Resolving = { readonly db: Database; readonly reads: Reads; readonly runAs: string; readonly task: string; readonly repository: Repository | null; readonly start: Start | null };

async function resolved(owed: SendBack, { db, reads, runAs, task, repository, start }: Resolving): Promise<Cause | Refused> {
  switch (owed.kind) {
    case 'behavior':
    case 'review':
      return { ...owed, notes: [] };
    case 'conflict': {
      if (repository === null) return { refused: noRepositoryToRead };
      const read = await reads.branchHead(runAs, repository.github, repository.branch);
      return 'refused' in read ? read : { kind: 'conflict', branch: repository.branch, head: read.head, notes: [] };
    }
    case 'check': {
      const head = owed.head ?? (await taskBranchHead(db, task)) ?? start?.commit;
      if (repository === null || head === undefined) return { refused: noRepositoryToRead };
      const base = await reads.branchHead(runAs, repository.github, repository.branch);
      if ('refused' in base) return base;
      const [first, ...rest] = await reads.failedChecks(runAs, repository.github, head, owed.names);
      return { kind: 'check', head, branch: repository.branch, base: base.head, checks: [first, ...rest], notes: [] };
    }
  }
}

const owedWith = (cause: Cause | null, notes: readonly PersonNote[]): ReworkObligation | null => {
  if (cause !== null) return { ...cause, notes: [...notes] };
  const [first, ...rest] = notes;
  return first === undefined ? null : { kind: 'note', notes: [first, ...rest] };
};

export async function begin(db: Database, beginning: Beginning, task: string, runAs: string | null): Promise<Begun | Refused> {
  const row = await db
    .selectFrom('task')
    .leftJoin('repository', 'repository.id', 'task.repository_id')
    .select(eb => [
      'task.workflow',
      'task.step',
      'task.epoch',
      'repository.github',
      'repository.branch',
      eb.selectFrom('attempt').select(latest => latest.fn.max('attempt.id').as('latest')).whereRef('attempt.task_id', '=', 'task.id').as('latest'),
    ])
    .where('task.id', '=', task)
    .executeTakeFirstOrThrow();
  const seen: Seen = { epoch: row.epoch, latest: row.latest };
  const workflow = beginning.runner.workflows.get(row.workflow);
  const kind = workflow?.steps.find(candidate => candidate.name === row.step);
  if (runAs === null || workflow === undefined || kind === undefined || !runByAgent(kind)) return { start: null, obligation: null, seen, [begun]: true };
  const start = await startFrom(await (beginning.continuation ?? continuation)(db, task), beginning.reads.branchHead, runAs);
  if (start !== null && 'refused' in start) return start;
  const agent = beginning.runner.agents.get(row.workflow);
  const sender = senderOf(workflow, await earlierOf(db, task), row.step);
  const repository = row.github === null || row.branch === null ? null : { github: row.github, branch: row.branch };
  const cause = agent === undefined || sender === undefined ? null : await resolved(agent.sentBack(sender), { db, reads: beginning.reads, runAs, task, repository, start });
  if (cause !== null && 'refused' in cause) return cause;
  return { start, obligation: owedWith(cause, await notesOf(db, task)), seen, [begun]: true };
}
