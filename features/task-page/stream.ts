import { setTimeout as wait } from 'node:timers/promises';
import type { Database } from '../../shared/db/client.ts';
import type { Event } from '../../shared/sse.ts';
import { textOf, type Cursor, type Frame } from './protocol.ts';
import { snapshot } from './read.ts';

export type Pace = { readonly pollMs: number; readonly linesPerPoll: number };

export const pace: Pace = { pollMs: 250, linesPerPoll: 500 };

export async function* frames(db: Database, task: string, after: Cursor | undefined, signal: AbortSignal, given: Pace = pace): AsyncGenerator<Event<Frame>, void> {
  let cursor = after;
  let evidenceAfter: string | undefined;
  let live = '';
  let said = '';
  while (!signal.aborted) {
    const found = await snapshot(db, task, { after: cursor, limit: given.linesPerPoll, evidenceAfter });
    if (found === undefined) return;
    const seenLive = JSON.stringify(found.live);
    if (seenLive !== live) {
      live = seenLive;
      yield { data: { kind: 'task', task: found.live } };
    }
    for (const line of found.lines) {
      cursor = { attempt: line.attempt, line: line.seq };
      yield { id: textOf(cursor), data: { kind: 'line', ...line } };
    }
    const recorded = found.evidence.at(-1);
    if (recorded !== undefined) {
      evidenceAfter = recorded.attempt;
      yield { data: { kind: 'evidence', evidence: [...found.evidence] } };
    }
    const seenSaid = JSON.stringify(found.said);
    if (seenSaid !== said) {
      said = seenSaid;
      yield { data: { kind: 'said', said: [...found.said] } };
    }
    if (found.lines.length < given.linesPerPoll) await wait(given.pollMs, undefined, { signal }).catch(() => undefined);
  }
}
