import { sql } from 'kysely';
import { z } from 'zod';
import { labels } from '../../shared/cluster.ts';
import type { Database } from '../../shared/db/client.ts';
import { reduce } from '../../shared/items.ts';
import { fail, pass, type Check } from '../../tools/verify/check.ts';
import { leftovers, type CleanSources } from './clean.ts';
import { attemptsInOrder, evidenceRows, taskFor } from './record.ts';

export const agentModel = 'gpt-6-luna';

const stepOrder = ['specify', 'implement', 'verify', 'land'] as const;

const agentSteps = new Set<string>(['specify', 'implement', 'verify']);

const reproduction = z.object({
  script: z.string().min(1),
  before: z.object({ exitCode: z.int().nullable() }),
  after: z.object({ exitCode: z.int().nullable() }),
});

const check = (name: string, ok: boolean, detail: string): Check => (ok ? pass(name, detail) : fail(name, detail));

async function models(db: Database, attempt: string): Promise<readonly string[]> {
  const rows = await db
    .selectFrom('attempt_event')
    .select(sql<string | null>`body -> 'result' ->> 'model'`.as('model'))
    .where('attempt_id', '=', attempt)
    .where(sql<boolean>`body ->> 'id' = 'bridge-thread-start'`)
    .execute();
  return rows.map(row => row.model ?? 'none');
}

async function replayed(db: Database, attempt: string): Promise<{ readonly stored: readonly string[]; readonly replayed: readonly string[] }> {
  const rows = await db.selectFrom('attempt_event').select(['seq', 'kind', 'method', 'item_id', 'body']).where('attempt_id', '=', attempt).orderBy('seq').execute();
  const stored = rows.filter(row => row.method === 'item/completed' && row.item_id !== null).flatMap(row => (row.item_id === null ? [] : [row.item_id]));
  const transcript = reduce(rows.map(row => ({ kind: row.kind, method: row.method, body: row.body })));
  return { stored, replayed: transcript.items.filter(item => item.status === 'completed').map(item => item.id) };
}

export async function recordChecks(db: Database, ticket: string, runAs: string, description: string): Promise<readonly Check[]> {
  const tasks = await db.selectFrom('task').select(['id', 'state']).where('key', '=', ticket).execute();
  const task = await taskFor(db, ticket);
  if (task === undefined) return [fail('record: one task for the ticket', `no task has the key ${ticket}`)];
  const attempts = await attemptsInOrder(db, task.id);
  const described = attempts.map(attempt => `${attempt.id} ${attempt.step} ${attempt.verdict ?? 'live'}`).join(', ');
  const passed = attempts.filter(attempt => attempt.verdict === 'pass').map(attempt => attempt.step);
  const checks: Check[] = [
    check('record: one task for the ticket, and it is done', tasks.length === 1 && task.state === 'done', `${String(tasks.length)} task rows, state ${task.state}`),
    check('record: attempts in step order with their verdicts', JSON.stringify(passed) === JSON.stringify(stepOrder) && attempts.every(attempt => attempt.verdict !== null), described),
    check(`record: every attempt ran as ${runAs}`, attempts.length > 0 && attempts.every(attempt => attempt.runAs === runAs), attempts.map(attempt => `${attempt.id} as ${attempt.runAs}`).join(', ')),
  ];
  const prompts = await db.selectFrom('attempt_command').innerJoin('attempt', 'attempt.id', 'attempt_command.attempt_id').select(['attempt.id', 'attempt_command.input']).where('attempt.task_id', '=', task.id).where('attempt_command.kind', '=', 'turn.start').orderBy('attempt.id').execute();
  const blind = prompts.filter(row => !(row.input ?? '').includes(description.trim())).map(row => row.id);
  checks.push(check("record: every agent prompt holds the ticket's description", prompts.length > 0 && blind.length === 0, blind.length === 0 ? `${String(prompts.length)} prompts` : `attempts ${blind.join(', ')} lack it`));
  const seen: string[] = [];
  for (const attempt of attempts.filter(entry => agentSteps.has(entry.step))) seen.push(...(await models(db, attempt.id)).map(model => `${attempt.id} ${model}`));
  const agentAttempts = attempts.filter(entry => agentSteps.has(entry.step)).length;
  checks.push(check(`record: every agent attempt ran on ${agentModel}`, seen.length === agentAttempts && seen.every(entry => entry.endsWith(` ${agentModel}`)), seen.join(', ') || 'no thread/start answer stored'));
  const environments = await db
    .selectFrom('verify_environment')
    .innerJoin('attempt', 'attempt.id', 'verify_environment.attempt_id')
    .select(['verify_environment.id', 'verify_environment.attempt_id', 'verify_environment.provider', 'verify_environment.called_at', 'verify_environment.stopped_at'])
    .where('attempt.task_id', '=', task.id)
    .orderBy('verify_environment.id')
    .execute();
  const verifyAttempts = attempts.filter(attempt => attempt.step === 'verify').map(attempt => attempt.id);
  checks.push(
    check(
      'record: each Verify attempt started and stopped its environment once',
      verifyAttempts.length > 0 && verifyAttempts.every(attempt => environments.filter(row => row.attempt_id === attempt && row.stopped_at !== null).length === 1) && environments.length === verifyAttempts.length,
      environments.map(row => `environment ${row.id} (${row.provider}) of attempt ${row.attempt_id} ${row.stopped_at === null ? 'never stopped' : 'stopped'}`).join(', ') || 'no environment rows',
    ),
  );
  const verifyPass = attempts.findLast(attempt => attempt.step === 'verify' && attempt.verdict === 'pass');
  const evidence = (await evidenceRows(db, task.id)).find(row => row.attempt === verifyPass?.id);
  const runs = reproduction.safeParse(evidence?.body);
  checks.push(
    check(
      'record: Verify evidence holds the reproduction script and its two runs, failing first and passing second',
      runs.success && runs.data.before.exitCode !== 0 && runs.data.before.exitCode !== null && runs.data.after.exitCode === 0,
      runs.success ? `before exited ${String(runs.data.before.exitCode)}, after exited ${String(runs.data.after.exitCode)}, script ${String(runs.data.script.length)} characters` : `attempt ${verifyPass?.id ?? 'none'} has no reproduction evidence`,
    ),
  );
  const replays: string[] = [];
  let matched = true;
  for (const attempt of attempts.filter(entry => entry.finishedAt !== null && agentSteps.has(entry.step))) {
    const found = await replayed(db, attempt.id);
    const same = JSON.stringify([...found.stored].sort()) === JSON.stringify([...found.replayed].sort());
    matched &&= same;
    replays.push(`${attempt.id} ${attempt.step}: ${String(found.replayed.length)} replayed, ${String(found.stored.length)} stored${same ? '' : ' (differ)'}`);
  }
  checks.push(check('record: replay through shared/items.ts matches the stored finished items one for one', matched && replays.length > 0, replays.join('; ')));
  return checks;
}

export async function agentTurnMs(db: Database, ticket: string): Promise<number> {
  const rows = await db
    .selectFrom('attempt_event')
    .innerJoin('attempt', 'attempt.id', 'attempt_event.attempt_id')
    .innerJoin('task', 'task.id', 'attempt.task_id')
    .select(['attempt.id', sql<Date | null>`min(attempt_event.stored_at) filter (where attempt_event.method = 'turn/started')`.as('began'), sql<Date | null>`max(attempt_event.stored_at) filter (where attempt_event.method = 'turn/completed')`.as('ended')])
    .where('task.key', '=', ticket)
    .groupBy('attempt.id')
    .execute();
  return rows.reduce((sum, row) => sum + (row.began === null || row.ended === null ? 0 : Math.max(0, new Date(row.ended).getTime() - new Date(row.began).getTime())), 0);
}

export async function plantedSecretCheck(sources: CleanSources, ticket: string): Promise<Check> {
  const name = 'the clean check fails on a planted Secret and names it';
  const task = await taskFor(sources.database, ticket);
  const attempt = task === undefined ? undefined : (await attemptsInOrder(sources.database, task.id)).findLast(entry => entry.finishedAt !== null);
  if (attempt === undefined) return fail(name, `${ticket} has no finished attempt to label a Secret for`);
  const secret = `autoworker-attempt-${attempt.id}-planted`;
  const { namespace } = sources.cluster;
  await sources.cluster.core.createNamespacedSecret({ namespace, body: { metadata: { name: secret, labels: { [labels.attempt]: attempt.id } }, stringData: { PLANTED: 'yes' } } });
  try {
    const found = await leftovers(sources, ticket);
    const named = found.length === 1 && found[0]?.place === 'cluster' && found[0].name === `Secret ${secret}`;
    return check(name, named, found.map(entry => `${entry.place}: ${entry.name} ${entry.detail}`).join('; ') || 'nothing left');
  } finally {
    await sources.cluster.core.deleteNamespacedSecret({ namespace, name: secret });
  }
}
