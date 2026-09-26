import { setTimeout as wait } from 'node:timers/promises';
import type { Database } from '../../shared/db/client.ts';
import type { Event } from '../../shared/sse.ts';
import type { Frame } from './protocol.ts';
import { readNeedsYou } from './read.ts';

const pollMs = 250;

export async function* frames(db: Database, person: string | undefined, signal: AbortSignal): AsyncGenerator<Event<Frame>, void> {
  let sent = '';
  while (!signal.aborted) {
    const needs = await readNeedsYou(db, person, new Date());
    const seen = JSON.stringify({ ...needs, at: '' });
    if (seen !== sent) {
      sent = seen;
      yield { data: { kind: 'needs-you', needs } };
    }
    await wait(pollMs, undefined, { signal }).catch(() => undefined);
  }
}
