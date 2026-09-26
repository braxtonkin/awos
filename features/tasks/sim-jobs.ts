import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { actionKinds, type Enqueue, type Owe, type Owing } from '../../shared/actions.ts';
import type { AgentSteps } from '../../shared/agent-step.ts';
import { refusal, type Database } from '../../shared/db/client.ts';
import { review } from '../../shared/review.ts';
import { inTransaction, type Transacting } from '../../shared/transaction.ts';
import type { Start } from './claim.ts';
import { taskBranchHead } from './continuation.ts';
import { finishStep, type StepRunner } from './step-runner.ts';
import type { Workflows } from './start.ts';
import { startOf } from './worker.ts';

export const stepMutantName = z.enum(['owe-after-verdict', 'finish-before-end-line', 'late-push-lands', 'continue-from-task-head', 'bad-reply-passes']);

export type StepMutantName = z.infer<typeof stepMutantName>;

export type JobLine = { readonly kind: 'app'; readonly body: Readonly<Record<string, unknown>> } | { readonly kind: 'pushed'; readonly commit: string; readonly branch: string } | { readonly kind: 'end' };

export type Posted = 'stored' | 'finished' | 'ended';

export type Jobs = {
  readonly post: (db: Database, attempt: string, lines: readonly JobLine[], now: Date) => Promise<Posted>;
  readonly start: (db: Database, task: string, runAs: string) => Promise<Start | null>;
};

export const repositoryHead = (github: string, branch: string): string => createHash('sha256').update(`${github}@${branch}`).digest('hex').slice(0, 40);

export const commitOf = (label: string): string => createHash('sha1').update(label).digest('hex');

const branchHead = (_actsAs: string, github: string, branch: string): Promise<{ readonly head: string }> => Promise.resolve({ head: repositoryHead(github, branch) });

const turnId = 'turn-1';

export const replyLines = (reply: string | null): readonly JobLine[] => [
  ...(reply === null ? [] : [{ kind: 'app' as const, body: { method: 'item/completed', params: { turnId, item: { id: 'reply', type: 'agentMessage', text: reply } } } }]),
  { kind: 'app', body: { method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } } },
];

export const unparsedReplies: readonly (string | null)[] = [null, 'The agent ended without a review.', '{"outcome": "done", "summary": "No blocks."', '"a bare string"', '{"outcome": "shipped", "summary": "An unknown outcome.", "blocks": []}', '[]'];

const isTurnCompleted = (line: JobLine): boolean => line.kind === 'app' && line.body['method'] === 'turn/completed';

const isEndLine = (line: JobLine): boolean => line.kind === 'end';

const marker = (): string => randomBytes(18).toString('base64url');

export const simEnqueue: Enqueue = async (tx, { task, actsAs, now }, actions) => {
  if (actions.length === 0) return [];
  await tx.selectFrom('task').select('task.id').where('task.id', '=', task).forUpdate().executeTakeFirstOrThrow();
  const { last } = await tx
    .selectFrom('outbox')
    .select(eb => eb.fn.coalesce(eb.fn.max('outbox.position'), sql.lit(0)).as('last'))
    .where('outbox.task_id', '=', task)
    .executeTakeFirstOrThrow();
  const rows = await tx
    .insertInto('outbox')
    .values(actions.map((action, index) => ({ task_id: task, position: last + index + 1, kind: action.kind, payload: JSON.stringify(action.payload), acts_as: actsAs, idempotency_key: marker(), owed_at: now })))
    .returning('outbox.id')
    .execute();
  return rows.map(row => row.id);
};

const passing = { outcome: 'done', summary: 'A reply the plug made up.', blocks: [{ kind: 'text', title: 'Result', body: 'Made up.' }] };

const papering = (agent: AgentSteps): AgentSteps => ({
  ...agent,
  settle: reply => {
    const settled = agent.settle(reply);
    return review.safeParse(settled.output).success ? settled : { output: passing, evidence: null, observed: settled.observed };
  },
});

const deferred = (db: Database) => {
  const owed: { owing: Owing; actions: readonly Owe[] }[] = [];
  const collect: Enqueue = (_tx, owing, actions) => {
    owed.push({ owing, actions });
    return Promise.resolve([]);
  };
  const flush = async (): Promise<void> => {
    for (const { owing, actions } of owed.splice(0)) await inTransaction(db, tx => simEnqueue(tx, owing, actions));
  };
  return { collect, flush };
};

async function storeLine(tx: Transacting, attempt: string, seq: number, line: JobLine, now: Date): Promise<void> {
  const body = line.kind === 'app' ? line.body : line.kind === 'pushed' ? { commit: line.commit, branch: line.branch } : {};
  const method = line.kind === 'app' && typeof line.body['method'] === 'string' ? line.body['method'] : null;
  await tx
    .insertInto('attempt_event')
    .values({ attempt_id: attempt, seq: String(seq), kind: line.kind, method, item_id: null, fragment: false, body: JSON.stringify(body), stored_at: now })
    .execute();
  if (line.kind === 'pushed') await tx.updateTable('attempt').set({ last_pushed: line.commit }).where('id', '=', attempt).where('branch', '=', line.branch).execute();
}

export function jobs(workflows: Workflows, plug: AgentSteps, mutant: StepMutantName | undefined): Jobs {
  const agent = mutant === 'bad-reply-passes' ? papering(plug) : plug;
  const finishesOn = mutant === 'finish-before-end-line' ? isTurnCompleted : isEndLine;
  const post = async (db: Database, attempt: string, lines: readonly JobLine[], now: Date): Promise<Posted> => {
    const later = deferred(db);
    const runner: StepRunner = { workflows, agents: new Map([...workflows.keys()].map(name => [name, agent])), enqueue: mutant === 'owe-after-verdict' ? later.collect : simEnqueue };
    const posted = await inTransaction(db, async (tx): Promise<Posted> => {
      const held = await tx.selectFrom('attempt').select('attempt.finished_at').where('attempt.id', '=', attempt).forUpdate().executeTakeFirstOrThrow();
      if (held.finished_at !== null) return 'ended';
      const { stored } = await tx
        .selectFrom('attempt_event')
        .select(eb => eb.fn.coalesce(eb.fn.max('attempt_event.seq'), sql.lit('0')).as('stored'))
        .where('attempt_event.attempt_id', '=', attempt)
        .executeTakeFirstOrThrow();
      let seq = Number(stored);
      for (const line of lines) {
        seq += 1;
        await storeLine(tx, attempt, seq, line, now);
        if (finishesOn(line)) {
          await finishStep(runner, tx, attempt, now);
          return 'finished';
        }
      }
      return 'stored';
    });
    await later.flush();
    return posted;
  };
  const real = async (db: Database, task: string, runAs: string): Promise<Start | null> => {
    const found = await startOf(db, { branchHead, runner: { workflows, agents: new Map([...workflows.keys()].map(name => [name, agent])) } }, task, runAs);
    return found === null || 'refused' in found ? null : found;
  };
  const start = async (db: Database, task: string, runAs: string): Promise<Start | null> => {
    if (mutant !== 'continue-from-task-head') return real(db, task, runAs);
    const head = await taskBranchHead(db, task);
    return head === null ? real(db, task, runAs) : { commit: head, inherited: false, merge: null };
  };
  return { post, start };
}

export async function latePush(db: Database, attempt: string, branch: string, commit: string, now: Date): Promise<'applied' | 'refused'> {
  try {
    await inTransaction(db, async tx => {
      const { stored } = await tx
        .selectFrom('attempt_event')
        .select(eb => eb.fn.coalesce(eb.fn.max('attempt_event.seq'), sql.lit('0')).as('stored'))
        .where('attempt_event.attempt_id', '=', attempt)
        .executeTakeFirstOrThrow();
      await storeLine(tx, attempt, Number(stored) + 1, { kind: 'pushed', commit, branch }, now);
    });
    return 'applied';
  } catch (error) {
    const found = refusal(error);
    if (found?.kind === 'final' && (found.name === 'event_needs_live_attempt' || found.name === 'finished_attempt_is_final')) return 'refused';
    throw error;
  }
}

const results: Readonly<Record<string, (payload: unknown) => unknown>> = {
  [actionKinds.branchAdvance.kind]: payload => ({ head: z.object({ to: z.string() }).parse(payload).to }),
  [actionKinds.branchDelete.kind]: () => ({ deleted: true }),
  [actionKinds.prOpenDraft.kind]: () => ({ number: 1, url: 'https://github.com/example/sandbox/pull/1' }),
  [actionKinds.ticketComment.kind]: () => ({ comment: '1' }),
};

export async function performNext(db: Database, task: string, now: Date): Promise<string | undefined> {
  const next = await db
    .selectFrom('outbox')
    .select(['outbox.id', 'outbox.kind', 'outbox.payload'])
    .where('outbox.task_id', '=', task)
    .where('outbox.state', '=', 'owed')
    .orderBy('outbox.position')
    .limit(1)
    .executeTakeFirst();
  if (next === undefined) return undefined;
  const result = results[next.kind]?.(next.payload) ?? {};
  await db.updateTable('outbox').set({ state: 'done', result: JSON.stringify(result), settled_at: now }).where('outbox.id', '=', next.id).where('outbox.state', '=', 'owed').execute();
  return next.kind;
}
