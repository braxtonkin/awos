import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import type { DB, HumanActionKind, Verdict } from '../../shared/db/types.ts';
import type { Answer, Note } from '../../shared/review.ts';
import { inTransaction, type Transacting } from '../../shared/transaction.ts';
import type { Instruction, Unasked, Workflow } from '../../shared/workflow.ts';
import { allows, approved, decide, lastStepOf, retried, stopped, waitingOn, type Held, type Next } from './decide.ts';
import type { Workflows } from './start.ts';

export type PersonAction =
  | { readonly kind: 'stop' }
  | { readonly kind: 'retry'; readonly note: Note | null }
  | { readonly kind: 'send_back'; readonly review: string; readonly note: Note }
  | { readonly kind: 'approve'; readonly review: string }
  | { readonly kind: 'answer'; readonly review: string; readonly answer: Answer };

export type Person = { readonly id: string; readonly person: string; readonly at: Date };

export type Report = { readonly output: unknown; readonly observed: Unasked | null } | { readonly output: unknown; readonly observed: 'fail'; readonly ends: Instruction };

export type Advanced = { readonly state: Next['standing']['state']; readonly step: string } | { readonly finished: Verdict | null };

export type Acted = { readonly recorded: string } | { readonly refused: 'not-now' | 'stale' | 'answer-does-not-fit' | 'id-taken' };

type Writer = Transaction<DB>;

const counts = z.record(z.string(), z.int().nonnegative());

const kinds: Readonly<Record<Answer['kind'], HumanActionKind>> = { pick: 'pick_choice', untick: 'untick_items', edit: 'edit_draft' };

function workflowOf(workflows: Workflows, name: string): Workflow {
  const found = workflows.get(name);
  if (found === undefined) throw new Error(`No workflow named ${name} was given to the engine. Its start check refuses a task whose workflow it lacks.`);
  return found;
}

async function hold(writer: Writer, workflows: Workflows, task: string): Promise<{ readonly held: Held; readonly workflow: Workflow }> {
  const row = await writer
    .selectFrom('task')
    .innerJoin('routine_version as version', join => join.onRef('version.routine_id', '=', 'task.routine_id').onRef('version.version', '=', 'task.found_version'))
    .select([
      'task.key',
      'task.workflow',
      'task.step',
      'task.state',
      'task.waiting_on',
      'task.review_attempt',
      'task.retries',
      'task.input_waits',
      'task.counts',
      sql<string[]>`task.approved::text[]`.as('approved'),
      'task.repository_id',
      sql<string[]>`version.gates::text[]`.as('gates'),
      'version.last_step',
      'version.ignore_later_reviews',
    ])
    .where('task.id', '=', task)
    .forUpdate('task')
    .executeTakeFirstOrThrow();
  const workflow = workflowOf(workflows, row.workflow);
  return {
    workflow,
    held: {
      key: row.key,
      step: row.step,
      state: row.state,
      waitingOn: row.waiting_on,
      review: row.review_attempt,
      retries: row.retries,
      inputWaits: row.input_waits,
      counts: counts.parse(row.counts),
      approved: row.approved,
      gates: row.gates,
      end: row.last_step ?? lastStepOf(workflow),
      ignoreLaterReviews: row.ignore_later_reviews,
      hasRepository: row.repository_id !== null,
    },
  };
}

const columnsOf = (next: Next, stoppedBy: string | null = null) => ({
  step: next.step,
  state: next.standing.state,
  waiting_on: waitingOn(next.standing),
  waiting_reason: next.standing.state === 'waiting' ? next.standing.reason : null,
  review_attempt: 'review' in next.standing ? next.standing.review : null,
  retries: next.retries,
  input_waits: next.inputWaits,
  counts: { ...next.counts },
  approved: [...next.approved],
  stopped_by: stoppedBy,
});

export type Standing = {
  readonly task: string;
  readonly actsAs: string;
  readonly verdict: Verdict;
  readonly state: Next['standing']['state'];
  readonly waitingOn: string | null;
};

export type Then = (tx: Transacting, standing: Standing) => Promise<void>;

const nothingMore: Then = () => Promise.resolve();

export async function advanceWithin(tx: Transacting, workflows: Workflows, attempt: string, report: Report, now: Date, then: Then = nothingMore): Promise<Advanced> {
  const found = await tx
    .selectFrom('attempt')
    .select(['attempt.task_id', 'attempt.run_as_id', 'attempt.finished_at', 'attempt.verdict'])
    .where('attempt.id', '=', attempt)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (found.finished_at !== null) return { finished: found.verdict };
  const { held, workflow } = await hold(tx, workflows, found.task_id);
  const kind = workflow.steps.find(candidate => candidate.name === held.step);
  const verdict = report.observed ?? (kind === undefined ? 'fail' : kind.judge(report.output));
  const next = decide(workflow, held, verdict, attempt, 'ends' in report ? report.ends : null);
  await tx
    .with('finished', query =>
      query
        .updateTable('attempt')
        .set({ finished_at: now, verdict, output: JSON.stringify(report.output ?? null) })
        .where('attempt.id', '=', attempt)
        .where('attempt.finished_at', 'is', null)
        .returning('attempt.task_id'),
    )
    .updateTable('task')
    .from('finished')
    .set({ ...columnsOf(next), lost: 0 })
    .whereRef('task.id', '=', 'finished.task_id')
    .execute();
  await then(tx, { task: found.task_id, actsAs: found.run_as_id, verdict, state: next.standing.state, waitingOn: waitingOn(next.standing) });
  return { state: next.standing.state, step: next.step };
}

export const advance = (db: Database, workflows: Workflows, attempt: string, report: Report, now: Date, then: Then = nothingMore): Promise<Advanced> =>
  inTransaction(db, tx => advanceWithin(tx, workflows, attempt, report, now, then));

export async function abandon(db: Database, attempt: string, reason: Instruction, now: Date): Promise<boolean> {
  return inTransaction(db, async tx => {
    const finished = await tx
      .updateTable('attempt')
      .set({ finished_at: now, verdict: 'not_launched' })
      .where('attempt.id', '=', attempt)
      .where('attempt.finished_at', 'is', null)
      .where('attempt.job_created_at', 'is', null)
      .returning('attempt.task_id')
      .executeTakeFirst();
    if (finished === undefined) return false;
    await tx.updateTable('task').set({ state: 'waiting', waiting_on: 'retry', waiting_reason: reason }).where('task.id', '=', finished.task_id).where('task.state', '=', 'ready').execute();
    return true;
  });
}

export async function handOff(db: Database, attempt: string, output: unknown, now: Date, then: Then): Promise<boolean> {
  return inTransaction(db, async writer => {
    const found = await writer
      .selectFrom('attempt')
      .innerJoin('task', 'task.id', 'attempt.task_id')
      .select(['attempt.task_id', 'attempt.run_as_id', 'task.state', 'task.waiting_on'])
      .where('attempt.id', '=', attempt)
      .where('attempt.finished_at', 'is', null)
      .forUpdate()
      .executeTakeFirst();
    if (found === undefined) return false;
    await writer.updateTable('attempt').set({ finished_at: now, verdict: 'handed_off', output: JSON.stringify(output) }).where('attempt.id', '=', attempt).execute();
    await writer.updateTable('task').set({ lost: 0 }).where('task.id', '=', found.task_id).execute();
    await then(writer, { task: found.task_id, actsAs: found.run_as_id, verdict: 'handed_off', state: found.state, waitingOn: found.waiting_on });
    return true;
  });
}

async function answerFits(writer: Writer, workflow: Workflow, attempt: string, answer: Answer): Promise<boolean> {
  const row = await writer.selectFrom('attempt').select(['attempt.step', 'attempt.output']).where('attempt.id', '=', attempt).executeTakeFirstOrThrow();
  const parsed = workflow.steps.find(kind => kind.name === row.step)?.output.safeParse(row.output);
  const block = parsed?.success === true ? parsed.data.blocks[answer.block] : undefined;
  if (block === undefined) return false;
  switch (answer.kind) {
    case 'pick':
      return block.kind === 'choice' && block.options.some(option => option.id === answer.option);
    case 'untick':
      return block.kind === 'checklist' && answer.items.every(item => block.items.some(listed => listed.id === item));
    case 'edit':
      return block.kind === 'draft';
  }
}

const recordOf = (action: PersonAction): { readonly kind: HumanActionKind; readonly attempt: string | null; readonly detail: Readonly<Record<string, unknown>> } => {
  switch (action.kind) {
    case 'stop':
      return { kind: 'stop_task', attempt: null, detail: {} };
    case 'retry':
      return { kind: 'retry_task', attempt: null, detail: action.note === null ? {} : { note: action.note } };
    case 'send_back':
      return { kind: 'send_back', attempt: action.review, detail: { note: action.note } };
    case 'approve':
      return { kind: 'approve', attempt: action.review, detail: {} };
    case 'answer':
      return { kind: kinds[action.answer.kind], attempt: action.review, detail: action.answer };
  }
};

export type StopTurn = (writer: Writer, attempt: string, now: Date) => Promise<void>;

export const noTurnToStop: StopTurn = () => Promise.resolve();

export async function actWithin(writer: Transacting, workflows: Workflows, task: string, by: Person, action: PersonAction, stopTurn: StopTurn): Promise<Acted> {
  const live = await writer.selectFrom('attempt').select('attempt.id').where('attempt.task_id', '=', task).where('attempt.finished_at', 'is', null).forUpdate().execute();
  const { held, workflow } = await hold(writer, workflows, task);
  const earlier = await writer.selectFrom('human_action').select(['human_action.task_id', 'human_action.kind']).where('human_action.id', '=', by.id).executeTakeFirst();
  if (earlier !== undefined) return earlier.task_id === task && earlier.kind === recordOf(action).kind ? { recorded: by.id } : { refused: 'id-taken' };
  const decision = allows(held, action.kind === 'stop' || action.kind === 'retry' ? { kind: action.kind } : { kind: action.kind, review: action.review });
  if (decision === 'not-now' || decision === 'stale') return { refused: decision };
  if (action.kind === 'answer' && !(await answerFits(writer, workflow, action.review, action.answer))) return { refused: 'answer-does-not-fit' };
  const { id } = by;
  const record = recordOf(action);
  await writer
    .insertInto('human_action')
    .values({ id, at: by.at, person_id: by.person, kind: record.kind, task_id: task, attempt_id: record.attempt, detail: JSON.stringify(record.detail) })
    .execute();
  if (decision === 'record') return { recorded: id };
  for (const { id: stopping } of live) await stopTurn(writer, stopping, by.at);
  await writer.updateTable('attempt').set({ finished_at: by.at, verdict: 'stopped' }).where('attempt.task_id', '=', task).where('attempt.finished_at', 'is', null).execute();
  const columns = decision === 'stop' ? columnsOf(stopped(held), id) : { ...columnsOf(decision === 'approve' ? approved(held, workflow) : retried(held, workflow)), lost: 0 };
  await writer
    .updateTable('task')
    .set(eb => ({ ...columns, epoch: eb('task.epoch', '+', 1) }))
    .where('task.id', '=', task)
    .execute();
  return { recorded: id };
}

const notNow: Readonly<Record<PersonAction['kind'], Instruction>> = {
  stop: 'The task is not running or waiting, so there is nothing to stop.',
  retry: 'The task is done or waits for an approval, so there is nothing to retry.',
  approve: 'The task waits on no review.',
  send_back: 'The task waits on no review.',
  answer: 'The task waits on no review.',
};

const idTaken: Instruction = 'Another action already has this id.';

export function refusalOf(kind: PersonAction['kind'], refused: Extract<Acted, { readonly refused: unknown }>['refused']): Instruction {
  switch (refused) {
    case 'not-now':
      return notNow[kind];
    case 'stale':
      return 'The task no longer waits on that review.';
    case 'answer-does-not-fit':
      return 'The answer does not fit any block of that review.';
    case 'id-taken':
      return idTaken;
  }
}

export type SteerTurn = (writer: Writer, attempt: string, message: string, action: string, now: Date) => Promise<'sent' | 'ended' | 'starting'>;

export type Steered = { readonly recorded: string } | { readonly refused: Instruction };

const notRunning: Instruction = 'The agent is not running, so it cannot read a message. Retry with a note instead.';

const starting: Instruction = 'The agent is still starting, so it cannot read a message yet. Send it again in a moment.';

export async function steerWithin(writer: Transacting, task: string, by: Person, message: string, steerTurn: SteerTurn): Promise<Steered> {
  const earlier = await writer.selectFrom('human_action').select(['human_action.task_id', 'human_action.kind']).where('human_action.id', '=', by.id).executeTakeFirst();
  if (earlier !== undefined) return earlier.task_id === task && earlier.kind === 'steer_task' ? { recorded: by.id } : { refused: idTaken };
  const live = await writer
    .selectFrom('attempt')
    .select('attempt.id')
    .where('attempt.task_id', '=', task)
    .where('attempt.finished_at', 'is', null)
    .forUpdate()
    .executeTakeFirst();
  const steered = live === undefined ? 'ended' : await steerTurn(writer, live.id, message, by.id, by.at);
  if (steered !== 'sent') return { refused: steered === 'starting' ? starting : notRunning };
  await writer
    .insertInto('human_action')
    .values({ id: by.id, at: by.at, person_id: by.person, kind: 'steer_task', task_id: task })
    .execute();
  return { recorded: by.id };
}

export const act = (db: Database, workflows: Workflows, task: string, by: Person, action: PersonAction, stopTurn: StopTurn): Promise<Acted> =>
  inTransaction(db, writer => actWithin(writer, workflows, task, by, action, stopTurn));

export async function approveFromOutside(db: Database, task: string): Promise<boolean> {
  const { numUpdatedRows } = await db
    .updateTable('task')
    .set({ state: 'ready', waiting_on: null, waiting_reason: null })
    .where('task.id', '=', task)
    .where('task.state', '=', 'waiting')
    .where('task.waiting_on', '=', 'outside_approval')
    .executeTakeFirst();
  return numUpdatedRows === 1n;
}

export type Addressed = { readonly task: string; readonly person: string; readonly review: string | null };

export async function address(db: Database, key: string, email: string, step: string | null): Promise<Addressed | string> {
  const task = await db
    .selectFrom('task')
    .leftJoin('attempt as review', 'review.id', 'task.review_attempt')
    .select(['task.id', 'task.review_attempt', 'review.step as reviewed'])
    .where('task.key', '=', key)
    .executeTakeFirst();
  if (task === undefined) return `No task has the key ${key}.`;
  const person = await db.selectFrom('person').select('person.id').where('person.email', '=', email.toLowerCase()).executeTakeFirst();
  if (person === undefined) return `No person has the email ${email}.`;
  if (step !== null && task.reviewed !== step) return `Task ${key} waits on no review of ${step}.`;
  return { task: task.id, person: person.id, review: task.review_attempt };
}
