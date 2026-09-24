import { sql } from 'kysely';
import { z } from 'zod';
import { actionKinds, type Enqueue } from '../../shared/actions.ts';
import type { AgentSteps, Earlier, Evidence, Ran } from '../../shared/agent-step.ts';
import type { Database } from '../../shared/db/client.ts';
import { finalMessage, reduce } from '../../shared/items.ts';
import type { Transacting } from '../../shared/transaction.ts';
import { outputSchema, type StepKind, type Workflow } from '../../shared/workflow.ts';
import { advanceWithin, type Then } from './advance.ts';
import { taskBranch, taskBranchHead } from './continuation.ts';
import type { Workflows } from './start.ts';

export type AgentWorkflows = ReadonlyMap<string, AgentSteps>;

export type StepRunner = { readonly workflows: Workflows; readonly agents: AgentWorkflows; readonly enqueue: Enqueue };

export type Step = {
  readonly attempt: string;
  readonly task: string;
  readonly key: string;
  readonly title: string;
  readonly number: number;
  readonly workflow: Workflow;
  readonly kind: StepKind;
  readonly agent: AgentSteps;
  readonly routine: string;
  readonly version: number;
  readonly goal: string;
  readonly startStatus: string | null;
  readonly repository: { readonly github: string; readonly branch: string; readonly fastTestCommand: string | null; readonly jobImage: string | null } | null;
  readonly runAs: { readonly id: string; readonly name: string; readonly email: string };
  readonly branch: string | null;
  readonly start: string | null;
  readonly startedAt: Date;
};

const skillLine = (name: string): string => `Use the repository skill \`${name}\` in \`.agents/skills/${name}\`.`;

const section = (title: string, body: string): string => `## ${title}\n\n${body.trim()}`;

export async function stepOf(db: Database, runner: StepRunner, attempt: string): Promise<Step> {
  const row = await db
    .selectFrom('attempt')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .innerJoin('routine_version as version', join => join.onRef('version.routine_id', '=', 'attempt.routine_id').onRef('version.version', '=', 'attempt.routine_version'))
    .innerJoin('person', 'person.id', 'attempt.run_as_id')
    .leftJoin('repository', 'repository.id', 'task.repository_id')
    .select(eb => [
      'attempt.id',
      'attempt.task_id',
      'attempt.step',
      'attempt.routine_id',
      'attempt.routine_version',
      'attempt.branch',
      'attempt.start_commit',
      'attempt.started_at',
      'task.key',
      'task.title',
      'task.workflow',
      'version.goal',
      'version.jira_start_status',
      'person.id as person_id',
      'person.name as person_name',
      'person.email as person_email',
      'repository.github',
      'repository.branch as repository_branch',
      'repository.fast_test_command',
      'repository.job_image',
      eb.selectFrom('attempt as earlier').select(earlier => earlier.fn.countAll<string>().as('count')).whereRef('earlier.task_id', '=', 'attempt.task_id').whereRef('earlier.id', '<=', 'attempt.id').as('number'),
    ])
    .where('attempt.id', '=', attempt)
    .executeTakeFirstOrThrow();
  const workflow = runner.workflows.get(row.workflow);
  const kind = workflow?.steps.find(candidate => candidate.name === row.step);
  const agent = runner.agents.get(row.workflow);
  if (workflow === undefined || kind === undefined || agent === undefined || kind.runBy !== 'agent') {
    throw new Error(`Attempt ${attempt} is at ${row.step} of ${row.workflow}, which no agent runs in this engine.`);
  }
  return {
    attempt: row.id,
    task: row.task_id,
    key: row.key,
    title: row.title,
    number: Number(row.number ?? '1'),
    workflow,
    kind,
    agent,
    routine: row.routine_id,
    version: row.routine_version,
    goal: row.goal,
    startStatus: row.jira_start_status,
    repository:
      row.github === null || row.repository_branch === null
        ? null
        : { github: row.github, branch: row.repository_branch, fastTestCommand: row.fast_test_command, jobImage: row.job_image },
    runAs: { id: row.person_id, name: row.person_name, email: row.person_email },
    branch: row.branch,
    start: row.start_commit,
    startedAt: row.started_at,
  };
}

const evidenceBody = z.record(z.string(), z.unknown());

async function earlierOf(db: Database, step: Step): Promise<readonly Earlier[]> {
  const rows = await db
    .selectFrom('attempt')
    .leftJoin('evidence', 'evidence.attempt_id', 'attempt.id')
    .select(['attempt.step', 'attempt.verdict', 'attempt.output', 'evidence.body'])
    .where('attempt.task_id', '=', step.task)
    .where('attempt.id', '<', step.attempt)
    .where('attempt.finished_at', 'is not', null)
    .orderBy('attempt.id')
    .execute();
  return rows.flatMap(row => {
    if (row.verdict === null) return [];
    const evidence = evidenceBody.safeParse(row.body);
    return [{ step: row.step, verdict: row.verdict, output: row.output, evidence: evidence.success ? evidence.data : null }];
  });
}

async function notesFor(db: Database, step: Step): Promise<readonly string[]> {
  const previous = await db
    .selectFrom('attempt')
    .select('attempt.started_at')
    .where('attempt.task_id', '=', step.task)
    .where('attempt.id', '<', step.attempt)
    .where('attempt.verdict', '<>', 'lost')
    .orderBy('attempt.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const rows = await db
    .selectFrom('human_action')
    .innerJoin('person', 'person.id', 'human_action.person_id')
    .select(['person.name', sql<string>`human_action.detail ->> 'note'`.as('note')])
    .where('human_action.task_id', '=', step.task)
    .where('human_action.kind', 'in', ['retry_task', 'send_back'])
    .where(sql<boolean>`human_action.detail ? 'note'`)
    .where('human_action.at', '>', previous?.started_at ?? new Date(0))
    .orderBy('human_action.at')
    .execute();
  return rows.map(row => section(`Note from ${row.name}`, row.note));
}

async function answersFor(db: Database, step: Step): Promise<readonly string[]> {
  const review = await db
    .selectFrom('attempt')
    .select(['attempt.id', 'attempt.verdict', 'attempt.output'])
    .where('attempt.task_id', '=', step.task)
    .where('attempt.step', '=', step.kind.name)
    .where('attempt.id', '<', step.attempt)
    .where('attempt.verdict', '<>', 'lost')
    .orderBy('attempt.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (review?.verdict !== 'needs_input') return [];
  const answers = await db
    .selectFrom('human_action')
    .select(['human_action.kind', 'human_action.detail'])
    .where('human_action.attempt_id', '=', review.id)
    .where('human_action.kind', 'in', ['pick_choice', 'untick_items', 'edit_draft'])
    .orderBy('human_action.at')
    .execute();
  return [section('Your last review, and the answers to it', [JSON.stringify(review.output), ...answers.map(answer => JSON.stringify(answer.detail))].join('\n\n'))];
}

async function lostSummary(db: Database, step: Step): Promise<readonly string[]> {
  const lost = await db
    .selectFrom('attempt')
    .select(['attempt.id', 'attempt.verdict', 'attempt.last_pushed'])
    .where('attempt.task_id', '=', step.task)
    .where('attempt.step', '=', step.kind.name)
    .where('attempt.id', '<', step.attempt)
    .orderBy('attempt.id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (lost?.verdict !== 'lost') return [];
  const lines = await db.selectFrom('attempt_event').select('body').where('attempt_id', '=', lost.id).where('kind', '=', 'app').orderBy('seq').execute();
  const finished = reduce(lines).items.filter(item => item.completed && item.type !== 'userMessage' && item.type !== 'reasoning');
  const listed = finished.map(item => `- ${item.type}: ${item.text.trim().split('\n')[0]?.slice(0, 200) ?? ''}`);
  const pushed = lost.last_pushed === null ? 'It pushed nothing, so this attempt starts where it started.' : `It pushed ${lost.last_pushed}, and this attempt starts from that commit.`;
  return [section(`What lost attempt ${lost.id} finished`, [pushed, ...(listed.length === 0 ? ['It finished no step.'] : listed)].join('\n'))];
}

async function routineStep(db: Database, step: Step): Promise<{ readonly instructions: string; readonly skills: readonly string[] }> {
  const row = await db
    .selectFrom('routine_step')
    .select(['routine_step.instructions', sql<string[]>`routine_step.skills::text[]`.as('skills')])
    .where('routine_step.routine_id', '=', step.routine)
    .where('routine_step.version', '=', step.version)
    .where('routine_step.step', '=', step.kind.name)
    .executeTakeFirst();
  return { instructions: row?.instructions.trim() ?? '', skills: row?.skills ?? [] };
}

async function baseOf(db: Database, task: string): Promise<string | null> {
  const row = await db
    .selectFrom('attempt')
    .select('attempt.start_commit')
    .where('attempt.task_id', '=', task)
    .where('attempt.start_commit', 'is not', null)
    .orderBy('attempt.id')
    .limit(1)
    .executeTakeFirst();
  return row?.start_commit ?? null;
}

export type Prompt = { readonly prompt: string; readonly outputSchema: Readonly<Record<string, unknown>> };

export async function promptFor(db: Database, step: Step, environment: string | null, description: string | null): Promise<Prompt> {
  const { instructions, skills } = await routineStep(db, step);
  const input = step.agent.input({ step: step.kind.name, ticket: { key: step.key, title: step.title, description }, base: await baseOf(db, step.task), earlier: await earlierOf(db, step) });
  const sections = [
    step.kind.prompt.trim(),
    ...(instructions === '' ? [] : [section("The routine's instructions", instructions)]),
    ...(await notesFor(db, step)),
    ...(await answersFor(db, step)),
    section('Goal', step.goal),
    ...(step.repository?.fastTestCommand == null ? [] : [section('Fast test command', `\`${step.repository.fastTestCommand}\``)]),
    ...(environment === null ? [] : [section('Environment', environment)]),
    section('Input', input),
    ...skills.map(skillLine),
    ...(await lostSummary(db, step)),
  ];
  return { prompt: `${sections.join('\n\n')}\n`, outputSchema: outputSchema(step.kind) };
}

const commandItem = z.object({
  method: z.literal('item/completed'),
  params: z.object({
    item: z.looseObject({
      type: z.literal('commandExecution'),
      command: z.string(),
      cwd: z.string().nullable().optional(),
      exitCode: z.int().nullable().optional(),
      aggregatedOutput: z.string().nullable().optional(),
    }),
  }),
});

const ranOf = (body: unknown): readonly Ran[] => {
  const parsed = commandItem.safeParse(body);
  if (!parsed.success) return [];
  const { item } = parsed.data.params;
  return [{ command: item.command, cwd: item.cwd ?? null, exitCode: item.exitCode ?? null, output: item.aggregatedOutput ?? '' }];
};

const replyOf = (final: string | undefined): unknown => {
  if (final === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(final);
    return parsed;
  } catch {
    return final;
  }
};

async function branchesToDelete(tx: Transacting, step: Step): Promise<readonly string[]> {
  const rows = await tx
    .selectFrom('attempt')
    .select('attempt.branch')
    .where('attempt.task_id', '=', step.task)
    .where('attempt.step', '=', step.kind.name)
    .where('attempt.branch', 'is not', null)
    .where(eb => eb.or([eb('attempt.last_pushed', 'is not', null), eb('attempt.verdict', 'in', ['lost', 'stopped'])]))
    .orderBy('attempt.id')
    .execute();
  return rows.flatMap(row => (row.branch === null ? [] : [row.branch]));
}

const owing =
  (runner: StepRunner, step: Step, output: unknown, evidence: Evidence | null, now: Date): Then =>
  async (tx, standing) => {
    const repository = step.repository;
    if (repository === null || step.branch === null || step.start === null) return;
    const attempt = await tx.selectFrom('attempt').select('attempt.last_pushed').where('attempt.id', '=', step.attempt).executeTakeFirstOrThrow();
    const earlierPasses = await tx
      .selectFrom('attempt')
      .select('attempt.id')
      .where('attempt.task_id', '=', step.task)
      .where('attempt.step', '=', step.kind.name)
      .where('attempt.verdict', '=', 'pass')
      .where('attempt.id', '<>', step.attempt)
      .execute();
    const opened = await tx
      .selectFrom('outbox')
      .select('outbox.id')
      .where('outbox.task_id', '=', step.task)
      .where('outbox.kind', '=', actionKinds.prOpenDraft.kind)
      .where('outbox.state', 'in', ['owed', 'done'])
      .execute();
    const actions = step.agent.owes({
      step: step.kind.name,
      verdict: standing.verdict,
      ticket: { key: step.key, title: step.title, description: null },
      repository: { github: repository.github, branch: repository.branch },
      taskBranch: { name: taskBranch(step.key), head: await taskBranchHead(tx, step.task) },
      attempt: { branch: step.branch, start: step.start, lastPushed: attempt.last_pushed },
      branches: standing.verdict === 'pass' ? await branchesToDelete(tx, step) : [],
      pullRequestOwed: opened.length > 0,
      firstPass: earlierPasses.length === 0,
      startStatus: step.startStatus,
      output,
      evidence,
    });
    await runner.enqueue(tx, { task: standing.task, actsAs: standing.actsAs, now }, actions);
  };

export async function finishStep(runner: StepRunner, tx: Transacting, attempt: string, now: Date): Promise<void> {
  const step = await stepOf(tx, runner, attempt);
  const lines = await tx.selectFrom('attempt_event').select('body').where('attempt_id', '=', attempt).where('kind', '=', 'app').orderBy('seq').execute();
  const settled = step.agent.settle({ step: step.kind.name, output: replyOf(finalMessage(reduce(lines))), commands: lines.flatMap(line => ranOf(line.body)) });
  if (settled.evidence !== null) {
    await tx
      .insertInto('evidence')
      .values({ attempt_id: attempt, task_id: step.task, body: JSON.stringify(settled.evidence), recorded_at: now })
      .onConflict(conflict => conflict.column('attempt_id').doNothing())
      .execute();
  }
  await advanceWithin(tx, runner.workflows, attempt, { output: settled.output, observed: null }, now, owing(runner, step, settled.output, settled.evidence, now));
}
