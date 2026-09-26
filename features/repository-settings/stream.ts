import { setTimeout as wait } from 'node:timers/promises';
import type { Database } from '../../shared/db/client.ts';
import { answerFrom } from '../../shared/requests.ts';
import type { Event } from '../../shared/sse.ts';
import type { Frame } from './protocol.ts';

export type Pace = { readonly pollMs: number; readonly answersForMs: number };

export const pace: Pace = { pollMs: 250, answersForMs: 10 * 60_000 };

const answers = (db: Database, since: Date) =>
  db
    .selectFrom('person_request as request')
    .leftJoin('repository', 'repository.saved_by', 'request.id')
    .select(['request.id', 'request.answer', 'request.reason', 'request.action_id', 'repository.id as repository'])
    .where('request.kind', '=', 'save_repository')
    .where('request.at', '>=', since)
    .orderBy('request.position')
    .execute();

export async function* frames(db: Database, signal: AbortSignal, given: Pace = pace): AsyncGenerator<Event<Frame>, void> {
  const answered = new Map<string, string>();
  const since = new Date(Date.now() - given.answersForMs);
  while (!signal.aborted) {
    for (const row of await answers(db, since)) {
      const answer = answerFrom(row);
      const said = JSON.stringify([answer, row.repository]);
      if (answered.get(row.id) === said) continue;
      answered.set(row.id, said);
      yield { data: { kind: 'answer', request: row.id, answer, repository: row.repository } };
    }
    await wait(given.pollMs, undefined, { signal }).catch(() => undefined);
  }
}
