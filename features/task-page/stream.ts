import { setTimeout as wait } from 'node:timers/promises';
import type { Database } from '../../shared/db/client.ts';
import { answerFrom } from '../../shared/requests.ts';
import type { Event } from '../../shared/sse.ts';
import { textOf, type Cursor, type Frame } from './protocol.ts';
import { snapshot } from './read.ts';

export type Pace = { readonly pollMs: number; readonly linesPerPoll: number; readonly answersForMs: number };

export const pace: Pace = { pollMs: 250, linesPerPoll: 500, answersForMs: 10 * 60_000 };

export async function* frames(db: Database, task: string, after: Cursor | undefined, signal: AbortSignal, given: Pace = pace): AsyncGenerator<Event<Frame>, void> {
  let cursor = after;
  let live = '';
  const answered = new Map<string, string>();
  const since = new Date(Date.now() - given.answersForMs);
  while (!signal.aborted) {
    const found = await snapshot(db, task, { after: cursor, limit: given.linesPerPoll, answersSince: since });
    if (found === undefined) return;
    const seen = JSON.stringify(found.live);
    if (seen !== live) {
      live = seen;
      yield { data: { kind: 'task', task: found.live } };
    }
    for (const line of found.lines) {
      cursor = { attempt: line.attempt, line: line.seq };
      yield { id: textOf(cursor), data: { kind: 'line', ...line } };
    }
    for (const row of found.answers) {
      const answer = answerFrom(row);
      const said = JSON.stringify(answer);
      if (answered.get(row.id) === said) continue;
      answered.set(row.id, said);
      yield { data: { kind: 'answer', request: row.id, answer } };
    }
    if (found.lines.length < given.linesPerPoll) await wait(given.pollMs, undefined, { signal }).catch(() => undefined);
  }
}
