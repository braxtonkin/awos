import { labels, type Cluster } from '../../shared/cluster.ts';
import type { Database } from '../../shared/db/client.ts';
import type { Verdict } from '../../shared/db/types.ts';
import { reduce } from '../../shared/items.ts';
import { fail, pass, type Check } from '../../tools/verify/check.ts';
import { taskFor } from './record.ts';

export const places = ['task', 'outbox', 'events', 'fragments', 'replay', 'cluster', 'environments', 'github'] as const;

export type Place = (typeof places)[number];

export type Leftover = { readonly place: Place; readonly name: string; readonly detail: string };

export type CleanSources = {
  readonly database: Database;
  readonly cluster: Cluster;
  readonly branchesStartingWith: (prefix: string) => Promise<readonly string[]>;
};

type Event = { readonly seq: number; readonly kind: string; readonly method: string | null; readonly itemId: string | null; readonly fragment: boolean; readonly body: unknown };

type Attempt = { readonly id: string; readonly verdict: Verdict | null; readonly finished: boolean; readonly highWater: number; readonly events: readonly Event[] };

type Scope = { readonly sources: CleanSources; readonly ticket: string; readonly task: string; readonly attempts: readonly Attempt[] };

const leftover = (place: Place, name: string, detail: string): Leftover => ({ place, name, detail });

const started = 'item/started';
const completed = 'item/completed';

async function eventsOf(db: Database, attempt: string): Promise<readonly Event[]> {
  const rows = await db.selectFrom('attempt_event').select(['seq', 'kind', 'method', 'item_id', 'fragment', 'body']).where('attempt_id', '=', attempt).orderBy('seq').execute();
  return rows.map(row => ({ seq: Number(row.seq), kind: row.kind, method: row.method, itemId: row.item_id, fragment: row.fragment, body: row.body }));
}

const seqsOf = (events: readonly Event[], method: string): ReadonlyMap<string, readonly number[]> => {
  const found = new Map<string, number[]>();
  for (const event of events) {
    if (event.method !== method || event.itemId === null) continue;
    found.set(event.itemId, [...(found.get(event.itemId) ?? []), event.seq]);
  }
  return found;
};

function eventLeftovers(attempt: Attempt): readonly Leftover[] {
  const { events } = attempt;
  const found: Leftover[] = [];
  const starts = seqsOf(events, started);
  const completions = seqsOf(events, completed);
  for (const [item, seqs] of completions) {
    if (seqs.length > 1) found.push(leftover('events', `attempt ${attempt.id} item ${item}`, `completed ${String(seqs.length)} times, at events ${seqs.join(', ')}`));
  }
  const ends = events.filter(event => event.kind === 'end').map(event => event.seq);
  if (ends.length > 1) found.push(leftover('events', `attempt ${attempt.id} end line`, `stored ${String(ends.length)} times, at events ${ends.join(', ')}`));
  const spans = [...completions].flatMap(([item, seqs]) => {
    const from = starts.get(item)?.[0];
    const to = seqs[0];
    return from === undefined || to === undefined ? [] : [{ from, to }];
  });
  const stored = new Set(events.map(event => event.seq));
  const top = events.at(-1)?.seq ?? 0;
  const missing: number[] = [];
  for (let seq = 1; seq <= Math.max(top, attempt.highWater); seq += 1) {
    if (!stored.has(seq) && !spans.some(span => span.from < seq && seq < span.to)) missing.push(seq);
  }
  if (missing.length > 0) found.push(leftover('events', `attempt ${attempt.id} events ${missing.join(', ')}`, `missing below the high water mark ${String(attempt.highWater)}, outside any completed item whose fragments were pruned`));
  if (top > attempt.highWater) found.push(leftover('events', `attempt ${attempt.id} event ${String(top)}`, `stored above the high water mark ${String(attempt.highWater)}`));
  return found;
}

function fragmentLeftovers({ id, events }: Attempt): readonly Leftover[] {
  const completions = seqsOf(events, completed);
  const left = new Map<string, number[]>();
  for (const event of events) {
    if (!event.fragment || event.itemId === null || !completions.has(event.itemId)) continue;
    left.set(event.itemId, [...(left.get(event.itemId) ?? []), event.seq]);
  }
  return [...left].map(([item, seqs]) => leftover('fragments', `attempt ${id} item ${item}`, `keeps fragments ${seqs.join(', ')} after the item completed at ${String(completions.get(item)?.[0])}`));
}

function replayLeftovers(attempt: Attempt): readonly Leftover[] {
  const { events } = attempt;
  const transcript = reduce(events);
  const replayed = new Map(transcript.items.map(item => [item.id, item]));
  const stored = new Set(seqsOf(events, completed).keys());
  const found: Leftover[] = [];
  for (const item of stored) {
    if (replayed.get(item)?.completed !== true) found.push(leftover('replay', `attempt ${attempt.id} item ${item}`, 'is stored as completed but does not replay as a completed item through shared/items.ts'));
  }
  for (const item of transcript.items) {
    if (item.completed && !stored.has(item.id)) found.push(leftover('replay', `attempt ${attempt.id} item ${item.id}`, 'replays as completed with no stored item/completed event'));
    if (!item.completed && attempt.verdict === 'pass') found.push(leftover('replay', `attempt ${attempt.id} item ${item.id}`, `replays unfinished in an attempt that passed, from ${item.type === 'unknown' ? 'fragments alone' : `its ${item.type} item, which never completed`}`));
  }
  for (const turn of transcript.turns) {
    if (turn.status === 'inProgress' && attempt.verdict === 'pass') found.push(leftover('replay', `attempt ${attempt.id} turn ${turn.id}`, 'replays in progress in an attempt that passed'));
  }
  return found;
}

const probes: Readonly<Record<Exclude<Place, 'task'>, (scope: Scope) => Promise<readonly Leftover[]>>> = {
  outbox: async ({ sources, task }) => {
    const rows = await sources.database.selectFrom('outbox').select(['id', 'kind', 'state', 'tries', 'last_error']).where('task_id', '=', task).where('state', 'in', ['owed', 'failed']).orderBy('position').execute();
    return rows.map(row => leftover('outbox', `outbox row ${row.id} (${row.kind})`, `is ${row.state} after ${String(row.tries)} tries${row.last_error === null ? '' : `, last error: ${row.last_error.slice(0, 200)}`}`));
  },
  events: ({ attempts }) => Promise.resolve(attempts.flatMap(eventLeftovers)),
  fragments: ({ attempts }) => Promise.resolve(attempts.flatMap(fragmentLeftovers)),
  replay: ({ attempts }) => Promise.resolve(attempts.filter(attempt => attempt.finished).flatMap(replayLeftovers)),
  cluster: async ({ sources, attempts }) => {
    if (attempts.length === 0) return [];
    const { namespace } = sources.cluster;
    const labelSelector = `${labels.attempt} in (${attempts.map(attempt => attempt.id).join(',')})`;
    const [jobs, secrets] = await Promise.all([sources.cluster.batch.listNamespacedJob({ namespace, labelSelector }), sources.cluster.core.listNamespacedSecret({ namespace, labelSelector })]);
    return [
      ...jobs.items.map(job => ({ kind: 'Job', metadata: job.metadata })),
      ...secrets.items.map(secret => ({ kind: 'Secret', metadata: secret.metadata })),
    ].map(({ kind, metadata }) => leftover('cluster', `${kind} ${metadata?.name ?? 'without a name'}`, `in namespace ${namespace}, labeled for attempt ${metadata?.labels?.[labels.attempt] ?? 'unknown'}`));
  },
  environments: async ({ sources, task }) => {
    const rows = await sources.database
      .selectFrom('verify_environment')
      .innerJoin('attempt', 'attempt.id', 'verify_environment.attempt_id')
      .select(['verify_environment.id', 'verify_environment.attempt_id', 'verify_environment.provider'])
      .where('attempt.task_id', '=', task)
      .where('verify_environment.stopped_at', 'is', null)
      .execute();
    return rows.map(row => leftover('environments', `Verify environment ${row.id} (${row.provider})`, `of attempt ${row.attempt_id} was never stopped`));
  },
  github: async ({ sources, ticket }) => (await sources.branchesStartingWith(`autoworker/${ticket}-`)).map(branch => leftover('github', `branch ${branch}`, `is still on GitHub for ${ticket}`)),
};

export async function leftovers(sources: CleanSources, ticket: string): Promise<readonly Leftover[]> {
  const task = await taskFor(sources.database, ticket);
  if (task === undefined) return [leftover('task', ticket, 'has no task row')];
  const rows = await sources.database.selectFrom('attempt').select(['id', 'verdict', 'finished_at', 'high_water']).where('task_id', '=', task.id).orderBy('id').execute();
  const attempts: Attempt[] = [];
  for (const row of rows) attempts.push({ id: row.id, verdict: row.verdict, finished: row.finished_at !== null, highWater: Number(row.high_water), events: await eventsOf(sources.database, row.id) });
  const scope = { sources, ticket, task: task.id, attempts };
  const found: Leftover[] = [];
  for (const probe of Object.values(probes)) found.push(...(await probe(scope)));
  return found;
}

export function cleanChecks(found: readonly Leftover[]): readonly Check[] {
  return places.map(place => {
    const here = found.filter(entry => entry.place === place);
    const name = `clean: nothing left in ${place}`;
    return here.length === 0 ? pass(name, '') : fail(name, here.map(entry => `${entry.name} ${entry.detail}`).join('; '));
  });
}
