import { sql } from 'kysely';
import { actionKinds, type Enqueue, type Owe } from '../../shared/actions.ts';
import type { Database } from '../../shared/db/client.ts';
import type { Loop } from '../../shared/loop.ts';
import { review } from '../../shared/review.ts';
import type { Transacting } from '../../shared/transaction.ts';
import type { Unasked } from '../../shared/workflow.ts';
import { guarded, landPass, landStep, type AtLand, type Follow, type LandOutput, type LandStore, type ReadPullRequest, type ReviewStep } from './land.ts';
import { workflow } from './workflow.ts';

export type Standing = { readonly task: string; readonly actsAs: string; readonly state: string; readonly waitingOn: string | null };

export type AfterVerdict = (tx: Transacting, standing: Standing) => Promise<void>;

export type TaskRunner = {
  readonly claim: (db: Database, task: string, now: Date, leaseMs: number) => Promise<{ readonly attempt: string } | { readonly refused: string }>;
  readonly renew: (db: Database, attempt: string, now: Date, leaseMs: number) => Promise<'renewed' | 'lost'>;
  readonly finish: (db: Database, attempt: string, report: { readonly output: unknown; readonly observed: Unasked | null }, now: Date, then: AfterVerdict) => Promise<{ readonly finished: unknown } | { readonly state: string }>;
  readonly handOff: (db: Database, attempt: string, output: unknown, now: Date, then: AfterVerdict) => Promise<boolean>;
  readonly approveFromOutside: (db: Database, task: string) => Promise<boolean>;
};

export type LandSettings = {
  readonly everyMs: number;
  readonly leaseMs: number;
  readonly read: ReadPullRequest;
  readonly review: ReviewStep;
  readonly tasks: TaskRunner;
  readonly enqueue: Enqueue;
};

const noEvidence = 'Verify recorded no evidence for this pull request.';

const openedPull = actionKinds.prOpenDraft.result;

function evidenceOf(output: unknown): string {
  const parsed = review.safeParse(output);
  if (!parsed.success) return noEvidence;
  const texts = parsed.data.blocks.flatMap(block => (block.kind === 'text' ? [block.body] : []));
  const evidence = [parsed.data.summary, ...texts].filter(text => text.trim() !== '').join('\n\n');
  return evidence === '' ? noEvidence : evidence;
}

async function atLand(db: Database): Promise<readonly AtLand[]> {
  const rows = await db
    .selectFrom('task')
    .innerJoin('routine_version as version', join => join.onRef('version.routine_id', '=', 'task.routine_id').onRef('version.version', '=', 'task.found_version'))
    .innerJoin('repository', 'repository.id', 'task.repository_id')
    .select(eb => [
      'task.id',
      'task.key',
      'task.state',
      'task.owed_actions',
      'repository.github',
      sql<boolean>`version.gates <@ task.approved`.as('gates_approved'),
      eb.selectFrom('attempt').select('attempt.id').whereRef('attempt.task_id', '=', 'task.id').where('attempt.finished_at', 'is', null).as('attempt'),
      eb
        .selectFrom('attempt')
        .select(sql<string[]>`coalesce(array_agg(attempt.output ->> 'answers'), '{}')`.as('answered'))
        .whereRef('attempt.task_id', '=', 'task.id')
        .where('attempt.step', '=', landStep)
        .where(sql<boolean>`attempt.output ? 'answers'`)
        .as('answered'),
      eb
        .exists(
          eb
            .selectFrom('outbox')
            .select('outbox.id')
            .whereRef('outbox.task_id', '=', 'task.id')
            .where('outbox.kind', '=', actionKinds.prMarkReady.kind)
            .where('outbox.state', 'in', ['owed', 'done', 'refused']),
        )
        .as('marked_ready'),
      eb
        .selectFrom('outbox')
        .select(sql<string | null>`case when outbox.state = 'refused' then outbox.result -> 'refused' ->> 'head' end`.as('refused_at'))
        .whereRef('outbox.task_id', '=', 'task.id')
        .where('outbox.kind', '=', actionKinds.prMerge.kind)
        .orderBy('outbox.position', 'desc')
        .limit(1)
        .as('refused_at'),
      eb
        .selectFrom('outbox')
        .select('outbox.result')
        .whereRef('outbox.task_id', '=', 'task.id')
        .where('outbox.kind', '=', actionKinds.prOpenDraft.kind)
        .where('outbox.state', '=', 'done')
        .orderBy('outbox.position', 'desc')
        .limit(1)
        .as('opened'),
      eb
        .selectFrom('attempt as verified')
        .select('verified.output')
        .whereRef('verified.task_id', '=', 'task.id')
        .where('verified.verdict', '=', 'pass')
        .where('verified.step', '!=', landStep)
        .orderBy('verified.id', 'desc')
        .limit(1)
        .as('evidence'),
    ])
    .where('task.workflow', '=', workflow.name)
    .where('task.step', '=', landStep)
    .where(eb => eb.or([eb('task.state', '=', 'ready'), eb.and([eb('task.state', '=', 'waiting'), eb('task.waiting_on', '=', 'outside_approval')])]))
    .orderBy('task.id')
    .execute();
  return rows.map(row => {
    const opened = openedPull.safeParse(row.opened);
    return {
      task: row.id,
      key: row.key,
      pull: { repository: row.github, branch: `autoworker/${row.key}`, number: opened.success ? opened.data.number : null },
      awaiting: row.state === 'waiting',
      owes: row.owed_actions > 0,
      attempt: row.attempt,
      record: { answered: row.answered ?? [], markedReady: row.marked_ready === true, refusedAt: row.refused_at, gatesApproved: row.gates_approved, evidence: evidenceOf(row.evidence) },
    };
  });
}

const oweAll =
  (enqueue: Enqueue, owes: readonly Owe[], now: Date): AfterVerdict =>
  async (tx, standing) => {
    await enqueue(tx, { task: standing.task, actsAs: standing.actsAs, now }, owes);
  };

const follow =
  (enqueue: Enqueue, { whenDone, whenAwaiting }: Follow, now: Date): AfterVerdict =>
  async (tx, standing) => {
    if (standing.state === 'done') await enqueue(tx, { task: standing.task, actsAs: standing.actsAs, now }, whenDone);
    if (whenAwaiting === null || standing.state !== 'waiting' || standing.waitingOn !== 'outside_approval') return;
    await tx.updateTable('task').set({ waiting_reason: whenAwaiting.note }).where('task.id', '=', standing.task).execute();
    await enqueue(tx, { task: standing.task, actsAs: standing.actsAs, now }, whenAwaiting.actions);
  };

function postgresStore(db: Database, settings: LandSettings, now: Date): LandStore {
  const { tasks, enqueue, leaseMs } = settings;
  return {
    atLand: () => atLand(db),
    claim: async task => {
      const claimed = await tasks.claim(db, task, now, leaseMs);
      return 'attempt' in claimed ? claimed.attempt : undefined;
    },
    renew: async attempt => (await tasks.renew(db, attempt, now, leaseMs)) === 'renewed',
    handOff: (attempt, output: LandOutput, owes) => tasks.handOff(db, attempt, output, now, oweAll(enqueue, owes, now)),
    finish: async (attempt, verdict, output, then) => !('finished' in (await tasks.finish(db, attempt, { output, observed: verdict }, now, follow(enqueue, then, now)))),
    resume: task => tasks.approveFromOutside(db, task),
  };
}

export function landLoop(settings: LandSettings): Loop {
  return {
    name: 'land',
    everyMs: settings.everyMs,
    pass: (db, { now }) => landPass({ store: postgresStore(db, settings, now), read: settings.read, review: settings.review, guards: guarded }),
  };
}

export const landLoops = (settings: Omit<LandSettings, 'read'> & { readonly read: ReadPullRequest | null }): readonly Loop[] =>
  settings.read === null ? [] : [landLoop({ ...settings, read: settings.read })];
