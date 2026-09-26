import { sql } from 'kysely';
import { z } from 'zod';
import { actionKinds, type Enqueue, type Owe } from '../../shared/actions.ts';
import type { Database } from '../../shared/db/client.ts';
import type { Clock, Loop } from '../../shared/loop.ts';
import type { Transacting } from '../../shared/transaction.ts';
import type { Unasked } from '../../shared/workflow.ts';
import { guarded, landPass, landStep, type AtLand, type Follow, type LandOutput, type LandStore, type ReviewStep } from './land.ts';
import type { ReadMergeState } from '../../shared/merge-state.ts';
import { evidenceText } from '../../shared/reproduction.ts';
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
  readonly read: ReadMergeState;
  readonly readTimeoutMs: number;
  readonly review: ReviewStep;
  readonly tasks: TaskRunner;
  readonly enqueue: Enqueue;
  readonly clock: Clock;
};

const noEvidence = 'Verify recorded no evidence for this pull request.';

const opened = z.object({ payload: actionKinds.prOpenDraft.payload, result: actionKinds.prOpenDraft.result });

const answers = z.array(z.object({ kind: z.enum(['ejection', 'review', 'refusal']), id: z.string() }));

const refusedRow = z.object({ row: z.string(), head: z.string().nullable() }).nullable();

const verifyStep: (typeof workflow)['steps'][number]['name'] = 'verify';

const evidenceOf = (body: unknown): string => evidenceText(body) ?? noEvidence;

async function atLand(db: Database, only: string | null): Promise<readonly AtLand[]> {
  const rows = await db
    .selectFrom('task')
    .innerJoin('routine_version as version', join => join.onRef('version.routine_id', '=', 'task.routine_id').onRef('version.version', '=', 'task.found_version'))
    .innerJoin('repository', 'repository.id', 'task.repository_id')
    .select(eb => [
      'task.id',
      'task.key',
      'task.state',
      'task.owed_actions',
      'repository.id as repository_id',
      'repository.github',
      'repository.draft_leaves',
      'version.jira_start_status',
      'version.jira_end_status',
      sql<boolean>`version.gates <@ task.approved`.as('gates_approved'),
      eb.selectFrom('attempt').select('attempt.id').whereRef('attempt.task_id', '=', 'task.id').where('attempt.finished_at', 'is', null).as('attempt'),
      eb
        .selectFrom('attempt')
        .select(sql`coalesce(jsonb_agg(attempt.output -> 'answers' order by attempt.id), '[]')`.as('answered'))
        .whereRef('attempt.task_id', '=', 'task.id')
        .where('attempt.step', '=', landStep)
        .where(sql<boolean>`attempt.output ? 'answers'`)
        .as('answered'),
      eb
        .selectFrom('attempt as acting')
        .select('acting.run_as_id')
        .whereRef('acting.task_id', '=', 'task.id')
        .where('acting.step', '=', landStep)
        .orderBy('acting.id', 'desc')
        .limit(1)
        .as('acts_as'),
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
        .select(sql`case when outbox.state = 'refused' then jsonb_build_object('row', outbox.id::text, 'head', outbox.result -> 'refused' -> 'head') end`.as('refused'))
        .whereRef('outbox.task_id', '=', 'task.id')
        .where('outbox.kind', '=', actionKinds.prMerge.kind)
        .orderBy('outbox.position', 'desc')
        .limit(1)
        .as('refused'),
      eb
        .selectFrom('outbox')
        .select(sql<string | null>`outbox.payload ->> 'commit'`.as('updated_at'))
        .whereRef('outbox.task_id', '=', 'task.id')
        .where('outbox.kind', '=', actionKinds.prUpdateBranch.kind)
        .orderBy('outbox.position', 'desc')
        .limit(1)
        .as('updated_at'),
      eb
        .selectFrom('outbox')
        .select(sql`jsonb_build_object('payload', outbox.payload, 'result', outbox.result)`.as('opened'))
        .whereRef('outbox.task_id', '=', 'task.id')
        .where('outbox.kind', '=', actionKinds.prOpenDraft.kind)
        .where('outbox.state', '=', 'done')
        .orderBy('outbox.position', 'desc')
        .limit(1)
        .as('opened'),
      eb
        .selectFrom('attempt as verified')
        .innerJoin('evidence', 'evidence.attempt_id', 'verified.id')
        .select('evidence.body')
        .whereRef('verified.task_id', '=', 'task.id')
        .where('verified.verdict', '=', 'pass')
        .where('verified.step', '=', verifyStep)
        .orderBy('verified.id', 'desc')
        .limit(1)
        .as('evidence'),
    ])
    .where('task.workflow', '=', workflow.name)
    .where('task.step', '=', landStep)
    .$if(only !== null, query => query.where('task.id', '=', only ?? ''))
    .where(eb => eb.or([eb('task.state', '=', 'ready'), eb.and([eb('task.state', '=', 'waiting'), eb('task.waiting_on', '=', 'outside_approval')])]))
    .orderBy('task.id')
    .execute();
  return rows.map(row => {
    const pull = opened.safeParse(row.opened);
    const refused = refusedRow.safeParse(row.refused ?? null);
    return {
      task: row.id,
      key: row.key,
      pull: {
        repository: row.github,
        repositoryId: row.repository_id,
        branch: pull.success ? pull.data.payload.head : `autoworker/${row.key}`,
        number: pull.success ? pull.data.result.number : null,
        actsAs: row.acts_as,
      },
      awaiting: row.state === 'waiting',
      owes: row.owed_actions > 0,
      attempt: row.attempt,
      statuses: { start: row.jira_start_status, end: row.jira_end_status },
      record: {
        draftLeaves: row.draft_leaves,
        answered: answers.safeParse(row.answered ?? []).data ?? [],
        markedReady: row.marked_ready === true,
        refused: refused.success ? refused.data : null,
        updatedAt: row.updated_at,
        gatesApproved: row.gates_approved,
        evidence: evidenceOf(row.evidence),
      },
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

function postgresStore(db: Database, settings: LandSettings): LandStore {
  const { tasks, enqueue, leaseMs, clock } = settings;
  return {
    atLand: () => atLand(db, null),
    reread: async task => (await atLand(db, task))[0],
    claim: async task => {
      const claimed = await tasks.claim(db, task, clock.now(), leaseMs);
      return 'attempt' in claimed ? claimed.attempt : undefined;
    },
    renew: async attempt => (await tasks.renew(db, attempt, clock.now(), leaseMs)) === 'renewed',
    handOff: (attempt, output: LandOutput, owes) => {
      const now = clock.now();
      return tasks.handOff(db, attempt, output, now, oweAll(enqueue, owes, now));
    },
    finish: async (attempt, verdict, output, then) => {
      const now = clock.now();
      return !('finished' in (await tasks.finish(db, attempt, { output, observed: verdict }, now, follow(enqueue, then, now))));
    },
    resume: task => tasks.approveFromOutside(db, task),
  };
}

export function landLoop(settings: LandSettings): Loop {
  return {
    name: 'land',
    everyMs: settings.everyMs,
    pass: db => landPass({ store: postgresStore(db, settings), read: settings.read, review: settings.review, guards: guarded, readTimeoutMs: settings.readTimeoutMs }),
  };
}

export const landLoops = (settings: Omit<LandSettings, 'read'> & { readonly read: ReadMergeState | null }): readonly Loop[] =>
  settings.read === null ? [] : [landLoop({ ...settings, read: settings.read })];
