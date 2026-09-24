import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../shared/db/client.ts';
import type { DB, HumanActionKind, Verdict } from '../../shared/db/types.ts';
import type { Answer } from '../../shared/review.ts';
import type { Unasked, Workflow } from '../../shared/workflow.ts';
import { allows, approved, decide, lastStepOf, retried, stopped, waitingOn, type Held, type Next } from './decide.ts';
import type { Workflows } from './start.ts';

export const note = z.string().trim().min(1).max(4000).brand<'Note'>();

type Note = z.infer<typeof note>;

export type PersonAction =
  | { readonly kind: 'stop' }
  | { readonly kind: 'retry'; readonly note: Note | null }
  | { readonly kind: 'send_back'; readonly review: string; readonly note: Note }
  | { readonly kind: 'approve'; readonly review: string }
  | { readonly kind: 'answer'; readonly review: string; readonly answer: Answer };

export type Person = { readonly id: string; readonly person: string; readonly at: Date };

export type Report = { readonly output: unknown; readonly observed: Unasked | null };

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
  review_attempt: next.standing.state === 'waiting' && 'review' in next.standing ? next.standing.review : null,
  retries: next.retries,
  input_waits: next.inputWaits,
  counts: { ...next.counts },
  approved: [...next.approved],
  stopped_by: stoppedBy,
});

export async function advance(db: Database, workflows: Workflows, attempt: string, report: Report, now: Date): Promise<Advanced> {
  return db.transaction().execute(async writer => {
    const found = await writer.selectFrom('attempt').select(['attempt.task_id', 'attempt.finished_at', 'attempt.verdict']).where('attempt.id', '=', attempt).forUpdate().executeTakeFirstOrThrow();
    if (found.finished_at !== null) return { finished: found.verdict };
    const { held, workflow } = await hold(writer, workflows, found.task_id);
    const kind = workflow.steps.find(candidate => candidate.name === held.step);
    const verdict = report.observed ?? (kind === undefined ? 'fail' : kind.judge(report.output));
    const next = decide(workflow, held, verdict, attempt);
    await writer
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
    return { state: next.standing.state, step: next.step };
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

export async function act(db: Database, workflows: Workflows, task: string, by: Person, action: PersonAction): Promise<Acted> {
  return db.transaction().execute(async writer => {
    await writer.selectFrom('attempt').select('attempt.id').where('attempt.task_id', '=', task).where('attempt.finished_at', 'is', null).forUpdate().execute();
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
    await writer.updateTable('attempt').set({ finished_at: by.at, verdict: 'stopped' }).where('attempt.task_id', '=', task).where('attempt.finished_at', 'is', null).execute();
    const columns = decision === 'stop' ? columnsOf(stopped(held), id) : { ...columnsOf(decision === 'approve' ? approved(held, workflow) : retried(held, workflow)), lost: 0 };
    await writer
      .updateTable('task')
      .set(eb => ({ ...columns, epoch: eb('task.epoch', '+', 1) }))
      .where('task.id', '=', task)
      .execute();
    return { recorded: id };
  });
}

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

