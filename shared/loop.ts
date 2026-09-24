import { setTimeout as wait } from 'node:timers/promises';
import type { Database } from './db/client.ts';

export type Clock = {
  readonly now: () => Date;
  readonly sleep: (ms: number, stop: AbortSignal) => Promise<void>;
};

export type Pass = { readonly now: Date; readonly late: () => boolean; readonly stop: AbortSignal };

export type Loop = {
  readonly name: string;
  readonly everyMs: number;
  readonly resume?: (db: Database, now: Date) => Promise<readonly string[]>;
  readonly pass: (db: Database, pass: Pass) => Promise<readonly string[]>;
};

export const neverStops: AbortSignal = new AbortController().signal;

export const realClock: Clock = {
  now: () => new Date(),
  sleep: async (ms, stop) => {
    try {
      await wait(Math.max(0, ms), undefined, { signal: stop });
    } catch (error) {
      if (!stop.aborted) throw error;
    }
  },
};

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runLoop(loop: Loop, db: Database, clock: Clock, stop: AbortSignal, log: (line: string) => void): Promise<void> {
  const say = (line: string): void => {
    log(`${loop.name}: ${line}`);
  };
  let resuming = true;
  let passes = 0;
  let failed = 0;
  let due = clock.now().getTime();
  while (!stop.aborted) {
    let now = clock.now();
    const elapsed = (): number => clock.now().getTime() - now.getTime();
    try {
      if (resuming && loop.resume !== undefined) {
        (await loop.resume(db, now)).forEach(say);
        now = clock.now();
      }
      resuming = false;
      (await loop.pass(db, { now, late: () => elapsed() > loop.everyMs, stop })).forEach(say);
    } catch (error) {
      failed += 1;
      resuming = true;
      say(`the pass that began at ${now.toISOString()} failed after ${String(elapsed())} ms, so the loop resumes before its next pass. ${reason(error)}`);
    }
    passes += 1;
    due = Math.max(due + loop.everyMs, clock.now().getTime());
    await clock.sleep(due - clock.now().getTime(), stop);
  }
  say(`stopped after ${String(passes)} passes, ${String(failed)} of them failed`);
}
