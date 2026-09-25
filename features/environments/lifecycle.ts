import { sql } from 'kysely';
import { refusal, type Database } from '../../shared/db/client.ts';
import type { Json } from '../../shared/db/types.ts';
import type { Loop } from '../../shared/loop.ts';
import type { Instruction } from '../../shared/workflow.ts';
import { environment, type Environment, type Providers } from './provider.ts';

export type Started =
  | { readonly kind: 'started'; readonly environment: Environment }
  | { readonly kind: 'unknown-provider'; readonly provider: string; readonly note: Instruction }
  | { readonly kind: 'attempt-ended' }
  | { readonly kind: 'failed'; readonly reason: string };

export type StartSettings = { readonly now: () => Date; readonly startDeadlineMs: number };

export type ReconcileSettings = { readonly providers: Providers; readonly everyMs: number; readonly startDeadlineMs: number };

type Recorded = { readonly result: Json | null; readonly stopped_at: Date | null };

const given = (providers: Providers): string => [...providers.keys()].join(', ');

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const unknownProvider = (github: string, provider: string, providers: Providers): Instruction =>
  `The repository ${github} names the Verify provider ${provider}, which this engine was not given. Add the provider to the map in services/engine/providers.ts, or set the repository's provider to one of ${given(providers)}, then press Retry.`;

export async function providerProblems(db: Database, providers: Providers): Promise<readonly string[]> {
  const names = [...providers.keys()];
  const repositories = await db
    .selectFrom('repository')
    .select(['github', 'branch', 'verify_provider'])
    .where('verify_provider', 'not in', names)
    .orderBy('id')
    .execute();
  const environments = await db
    .selectFrom('verify_environment as environment')
    .innerJoin('attempt', 'attempt.id', 'environment.attempt_id')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .leftJoin('repository', 'repository.id', 'task.repository_id')
    .select(['environment.attempt_id', 'environment.provider', 'repository.github', 'repository.branch'])
    .where('environment.stopped_at', 'is', null)
    .where('environment.provider', 'not in', names)
    .orderBy('environment.id')
    .execute();
  return [
    ...repositories.map(
      row =>
        `The repository ${row.github} on ${row.branch} names the Verify provider ${row.verify_provider}, which this engine was not given. Add the provider to the map in services/engine/providers.ts, or set the repository's verify_provider to one of ${given(providers)}.`,
    ),
    ...environments.map(
      row =>
        `The environment of attempt ${row.attempt_id} in the repository ${row.github ?? 'that no longer exists'} on ${row.branch ?? 'no branch'} came from the Verify provider ${row.provider}, which this engine was not given, and nobody has stopped it. Add the provider to the map in services/engine/providers.ts, so the engine can stop it.`,
    ),
  ];
}

function outcomeOf(row: Recorded | undefined): Started | undefined {
  if (row === undefined) return undefined;
  if (row.stopped_at !== null) return { kind: 'attempt-ended' };
  if (row.result !== null) return { kind: 'started', environment: environment.parse(row.result) };
  return undefined;
}

const recordedFor = (db: Database, attemptId: string): Promise<Recorded | undefined> =>
  db.selectFrom('verify_environment').select(['result', 'stopped_at']).where('attempt_id', '=', attemptId).orderBy('id').executeTakeFirst();

async function record(db: Database, attemptId: string, provider: string, now: Date): Promise<void> {
  try {
    await db
      .insertInto('verify_environment')
      .columns(['attempt_id', 'provider', 'recorded_at', 'called_at'])
      .expression(eb =>
        eb
          .selectFrom('attempt')
          .select([eb.val(attemptId).as('attempt_id'), eb.val(provider).as('provider'), eb.val(now).as('recorded_at'), eb.val(now).as('called_at')])
          .where('attempt.id', '=', attemptId)
          .where('attempt.finished_at', 'is', null),
      )
      .execute();
  } catch (error) {
    const refused = refusal(error);
    if (refused?.kind !== 'unique' || refused.name !== 'one_environment_per_attempt') throw error;
  }
}

async function claim(db: Database, attemptId: string, now: Date): Promise<boolean> {
  const claimed = await db
    .updateTable('verify_environment')
    .set(eb => ({ called_at: now, starting: eb('starting', '+', 1) }))
    .where('attempt_id', '=', attemptId)
    .where('stopped_at', 'is', null)
    .where('result', 'is', null)
    .where(eb => eb.exists(eb.selectFrom('attempt').select('attempt.id').where('attempt.id', '=', attemptId).where('attempt.finished_at', 'is', null)))
    .returning('id')
    .executeTakeFirst();
  return claimed !== undefined;
}

type Returned = { readonly environment: Environment; readonly at: Date };

async function release(db: Database, attemptId: string, returned: Returned | undefined): Promise<Recorded | undefined> {
  const unrecorded = sql<boolean>`result is null and stopped_at is null`;
  return db
    .updateTable('verify_environment')
    .set(eb => ({
      starting: eb('starting', '-', 1),
      ...(returned === undefined
        ? {}
        : {
            result: sql<Json>`case when ${unrecorded} then ${JSON.stringify(returned.environment)}::jsonb else result end`,
            returned_at: sql<Date>`case when ${unrecorded} then ${returned.at}::timestamptz else returned_at end`,
          }),
    }))
    .where('attempt_id', '=', attemptId)
    .returning(['result', 'stopped_at'])
    .executeTakeFirst();
}

export async function startEnvironment(db: Database, providers: Providers, attemptId: string, { now, startDeadlineMs }: StartSettings): Promise<Started> {
  const repository = await db
    .selectFrom('attempt')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .innerJoin('repository', 'repository.id', 'task.repository_id')
    .select(['repository.github', 'repository.branch', 'repository.verify_provider', 'repository.fast_test_command'])
    .where('attempt.id', '=', attemptId)
    .executeTakeFirst();
  if (repository === undefined) return { kind: 'failed', reason: `attempt ${attemptId} works in no repository, so it has no Verify environment` };
  const provider = providers.get(repository.verify_provider);
  if (provider === undefined) {
    return { kind: 'unknown-provider', provider: repository.verify_provider, note: unknownProvider(repository.github, repository.verify_provider, providers) };
  }
  await record(db, attemptId, provider.name, now());
  const earlier = outcomeOf(await recordedFor(db, attemptId));
  if (earlier !== undefined) return earlier;
  const calledAt = now();
  if (!(await claim(db, attemptId, calledAt))) return outcomeOf(await recordedFor(db, attemptId)) ?? { kind: 'attempt-ended' };
  let returned: Environment;
  try {
    returned = environment.parse(
      await provider.start({
        attemptId,
        repository: { github: repository.github, branch: repository.branch, fastTestCommand: repository.fast_test_command },
        signal: AbortSignal.timeout(startDeadlineMs),
      }),
    );
  } catch (error) {
    await release(db, attemptId, undefined);
    return { kind: 'failed', reason: `the Verify provider ${provider.name} failed to start an environment for attempt ${attemptId}: ${reason(error)}` };
  }
  const returnedAt = now();
  const late = returnedAt.getTime() > calledAt.getTime() + startDeadlineMs;
  const after = await release(db, attemptId, late ? undefined : { environment: returned, at: returnedAt });
  const outcome = outcomeOf(after);
  if (outcome?.kind === 'started') return outcome;
  await provider.stop(attemptId);
  return (
    outcome ?? {
      kind: 'failed',
      reason: `the Verify provider ${provider.name} answered ${String(returnedAt.getTime() - calledAt.getTime())} ms after the start for attempt ${attemptId}, past its deadline of ${String(startDeadlineMs)} ms, so the engine stopped that environment`,
    }
  );
}

export function reconcile({ providers, everyMs, startDeadlineMs }: ReconcileSettings): Loop {
  return {
    name: 'environments',
    everyMs,
    pass: async (db, { now }) => {
      const ended = await db
        .selectFrom('verify_environment as environment')
        .innerJoin('attempt', 'attempt.id', 'environment.attempt_id')
        .select(['environment.id', 'environment.attempt_id', 'environment.provider'])
        .where('environment.stopped_at', 'is', null)
        .where('attempt.finished_at', 'is not', null)
        .orderBy('environment.id')
        .execute();
      const known = ended.flatMap(row => {
        const provider = providers.get(row.provider);
        return provider === undefined ? [] : [{ ...row, provider }];
      });
      const skipped = ended
        .filter(row => !providers.has(row.provider))
        .map(row => `skipped the environment of attempt ${row.attempt_id}, because this engine was not given its provider ${row.provider}`);
      const stops = await Promise.allSettled(known.map(row => row.provider.stop(row.attempt_id)));
      const called = known.filter((_row, index) => stops[index]?.status === 'fulfilled');
      const failed = known.flatMap((row, index) => {
        const stop = stops[index];
        return stop?.status === 'rejected'
          ? [`the provider ${row.provider.name} failed to stop the environment of attempt ${row.attempt_id}, and the next pass calls stop again: ${reason(stop.reason)}`]
          : [];
      });
      const recorded =
        called.length === 0
          ? []
          : await db
              .updateTable('verify_environment')
              .set({ stopped_at: now })
              .where(
                'id',
                'in',
                called.map(row => row.id),
              )
              .where('stopped_at', 'is', null)
              .where(eb => eb.or([eb('starting', '=', 0), eb('called_at', '<', new Date(now.getTime() - startDeadlineMs))]))
              .returning('id')
              .execute();
      const recordedIds = new Set(recorded.map(row => row.id));
      return [
        ...called.map(row =>
          recordedIds.has(row.id)
            ? `stopped the environment of attempt ${row.attempt_id} from ${row.provider.name}`
            : `called stop for the environment of attempt ${row.attempt_id} from ${row.provider.name}, and left the stop unrecorded, because a start may still be in flight or another engine recorded it`,
        ),
        ...failed,
        ...skipped,
      ];
    },
  };
}
