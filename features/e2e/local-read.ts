import { parseArgs } from 'node:util';
import { sql } from 'kysely';
import { connectCluster, labels } from '../../shared/cluster.ts';
import { connect } from '../../shared/db/client.ts';
import { deliveries } from '../../shared/deliveries.ts';
import { fail, info, pass, type Line, type Scenario } from '../../tools/verify/check.ts';
import { eventGaps } from './clean.ts';

const logLines = 12;

async function readWorld(url: string, namespace: string | undefined, logs: boolean): Promise<readonly Line[]> {
  const db = connect(url, 2);
  const lines: Line[] = [];
  try {
    const clock = await sql<{ now: Date }>`select now() as now`.execute(db);
    lines.push(info('Postgres clock', 'passed', clock.rows[0]?.now.toISOString() ?? 'unknown'));
    const tasks = await db.selectFrom('task').select(['id', 'key', 'state', 'step', 'waiting_on', 'waiting_reason']).orderBy('id').execute();
    for (const task of tasks) {
      lines.push(info(`task ${task.key}`, 'passed', `${task.state} at ${task.step}${task.waiting_on === null ? '' : `, waiting on ${task.waiting_on}: ${task.waiting_reason ?? ''}`}`));
      const attempts = await db
        .selectFrom('attempt')
        .select(eb => [
          'attempt.id',
          'attempt.step',
          'attempt.verdict',
          'attempt.finished_at',
          'attempt.high_water',
          eb.selectFrom('attempt_event').select(inner => inner.fn.countAll<string>().as('events')).whereRef('attempt_event.attempt_id', '=', 'attempt.id').as('events'),
          eb
            .selectFrom('attempt_event')
            .select(sql<string>`body -> 'params' -> 'turn' ->> 'status'`.as('turn'))
            .whereRef('attempt_event.attempt_id', '=', 'attempt.id')
            .where('attempt_event.method', '=', 'turn/completed')
            .orderBy('attempt_event.seq', 'desc')
            .limit(1)
            .as('turn'),
        ])
        .where('attempt.task_id', '=', task.id)
        .orderBy('attempt.id')
        .execute();
      for (const attempt of attempts) {
        const gaps = await eventGaps(db, { id: attempt.id, verdict: attempt.verdict, finished: attempt.finished_at !== null, highWater: Number(attempt.high_water) });
        const name = `attempt ${attempt.id} of ${task.key} stores its events with no gap`;
        const detail = `${attempt.step} ${attempt.verdict ?? 'live'}, turn ${attempt.turn ?? 'not completed'}, ${attempt.events ?? '0'} events, high water ${attempt.high_water}, finished ${attempt.finished_at?.toISOString() ?? 'not yet'}`;
        lines.push(gaps.length === 0 ? pass(name, detail) : fail(name, `${detail}; ${gaps.map(gap => `${gap.name} ${gap.detail}`).join('; ')}`));
        for (const command of await deliveries(db, attempt.id)) {
          const by = command.action === null ? undefined : await db.selectFrom('human_action').innerJoin('person', 'person.id', 'human_action.person_id').select(['human_action.kind', 'person.email']).where('human_action.id', '=', command.action).executeTakeFirst();
          const inOrder = (command.receivedAt === null || command.sentAt <= command.receivedAt) && (command.actedAt === null || (command.receivedAt !== null && command.receivedAt <= command.actedAt));
          lines.push(
            (inOrder ? pass : fail)(
              `${command.kind} ${String(command.seq)} to attempt ${attempt.id}${by === undefined ? '' : `, a ${by.kind} by ${by.email}`}`,
              `${command.state}; sent ${command.sentAt.toISOString()}, received ${command.receivedAt?.toISOString() ?? 'not yet'}, acted on ${command.actedAt?.toISOString() ?? 'not yet'}`,
            ),
          );
        }
      }
    }
  } finally {
    await db.destroy();
  }
  if (namespace !== undefined) {
    const cluster = connectCluster(namespace);
    const [jobs, pods] = await Promise.all([cluster.batch.listNamespacedJob({ namespace }), cluster.core.listNamespacedPod({ namespace })]);
    lines.push(info(`Jobs in ${namespace}`, 'passed', jobs.items.map(job => `${job.metadata?.name ?? ''} for attempt ${job.metadata?.labels?.[labels.attempt] ?? 'unknown'}, active ${String(job.status?.active ?? 0)}`).join('; ') || 'none'));
    lines.push(info(`Pods in ${namespace}`, 'passed', pods.items.map(pod => `${pod.metadata?.name ?? ''} ${pod.status?.phase ?? ''}`).join('; ') || 'none'));
    for (const name of logs ? pods.items.flatMap(pod => (pod.metadata?.name === undefined ? [] : [pod.metadata.name])) : []) {
      const log = await cluster.core.readNamespacedPodLog({ name, namespace, tailLines: logLines }).catch((error: unknown) => `no log: ${error instanceof Error ? error.message : String(error)}`);
      lines.push(info(`last ${String(logLines)} log lines of ${name}`, 'passed', log.trim().split('\n').join(' | ')));
    }
  }
  return lines;
}

export const localReadScenario: Scenario = {
  name: 'local-engine-read',
  summary: [
    "reads a held local-engine world by its --database and --namespace: the Postgres clock, each task's state, step, and waiting reason,",
    "each attempt's verdict, last turn status, and stored events, which fail on a gap as the clean check does,",
    'each command from deliveries in shared/deliveries.ts, a start, a steer, or a stop,',
    'with the person action a steer names, its state, and its times, which fail when out of order,',
    "and the Jobs and Pods in the namespace, with each Pod's last log lines under --logs",
  ].join(' '),
  run: async args => {
    const { values } = parseArgs({ args: [...args], options: { database: { type: 'string' }, namespace: { type: 'string' }, logs: { type: 'boolean', default: false } }, strict: true });
    if (values.database === undefined) return [fail('database named', 'pass --database with the DATABASE_URL that local-engine printed')];
    return readWorld(values.database, values.namespace, values.logs);
  },
};
