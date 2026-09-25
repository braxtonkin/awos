import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import {
  appMessage,
  batchLimit,
  bridgeRequestIds,
  commandFrame,
  eventsAnswer,
  headers,
  pinned,
  protocolVersion,
  refusalAnswer,
  refusalStatus,
  turnCompleted,
  type AttemptId,
  type CommandFrame,
  type EventsAnswer,
  type Line,
  type LineBody,
  type Refused,
  type TurnCompleted,
} from './protocol.ts';

export type Outbox = {
  readonly push: (body: LineBody) => number;
  readonly batch: () => readonly Line[];
  readonly acked: (stored: number) => void;
  readonly pending: () => number;
  readonly emitted: () => number;
};

export function outbox(): Outbox {
  let emitted = 0;
  let unacked: Line[] = [];
  return {
    push: body => {
      emitted += 1;
      unacked.push({ ...body, seq: emitted });
      return emitted;
    },
    batch: () => unacked.slice(0, batchLimit),
    acked: stored => {
      unacked = unacked.filter(line => line.seq > stored);
    },
    pending: () => unacked.length,
    emitted: () => emitted,
  };
}

export type Accepted = 'apply' | 'duplicate' | 'gap';

export type Applier = { readonly accept: (frame: CommandFrame) => Accepted; readonly applied: () => number };

export function applier(): Applier {
  let applied = 0;
  return {
    accept: frame => {
      if (frame.seq <= applied) return 'duplicate';
      if (frame.seq !== applied + 1) return 'gap';
      applied = frame.seq;
      return 'apply';
    },
    applied: () => applied,
  };
}

export type AfterTurn = (turn: TurnCompleted) => Promise<readonly LineBody[]>;

export type BridgeSettings = {
  readonly engineUrl: URL;
  readonly attempt: AttemptId;
  readonly token: string;
  readonly image: string;
  readonly workspace: string;
  readonly codexHome: string;
  readonly codexUser: { readonly uid: number; readonly gid: number } | undefined;
  readonly codexCommand: string;
  readonly heartbeatMs: number;
  readonly callTimeoutMs: number;
  readonly retryMs: number;
  readonly streamQuietMs: number;
  readonly stopGraceMs: number;
};

export type Ending = { readonly code: 0 } | { readonly code: 1; readonly reason: string };

export const threadStart = (workspace: string): unknown => ({
  id: bridgeRequestIds.threadStart,
  method: 'thread/start',
  params: {
    model: pinned.model,
    modelProvider: 'openai',
    approvalPolicy: pinned.approvalPolicy,
    sandbox: pinned.sandbox,
    cwd: workspace,
    config: {
      model: pinned.model,
      model_provider: 'openai',
      model_reasoning_effort: pinned.effort,
      approval_policy: pinned.approvalPolicy,
      sandbox_mode: pinned.sandbox,
    },
  },
});

const initialize = { id: bridgeRequestIds.initialize, method: 'initialize', params: { clientInfo: { name: 'autoworker-bridge', version: String(protocolVersion) }, capabilities: null } };

type Wake = { readonly nudge: () => void; readonly sleep: (ms: number) => Promise<void> };

function waker(): Wake {
  let wake: (() => void) | undefined;
  let nudged = false;
  return {
    nudge: () => {
      nudged = true;
      wake?.();
    },
    sleep: async ms => {
      if (nudged) {
        nudged = false;
        return;
      }
      const stop = new AbortController();
      await Promise.race([new Promise<void>(resolve => (wake = resolve)), wait(ms, undefined, { signal: stop.signal }).catch(() => undefined)]);
      stop.abort();
      wake = undefined;
      nudged = false;
    },
  };
}

type Posted = { readonly answer: EventsAnswer } | { readonly refused: Refused } | { readonly failed: string };

export async function runBridge(settings: BridgeSettings, afterTurn: AfterTurn, say: (line: string) => void): Promise<Ending> {
  const box = outbox();
  const commands = applier();
  const posting = waker();
  const stop = new AbortController();
  let ending: Ending | undefined;
  let finishing = false;
  let fenced = false;
  let endLine: number | undefined;
  let settle = (): void => undefined;
  const settled = new Promise<void>(resolve => (settle = resolve));
  const end = (result: Ending): void => {
    ending ??= result;
    settle();
    stop.abort();
    posting.nudge();
  };
  let turnDone = (): void => undefined;
  const turnEnded = new Promise<void>(resolve => (turnDone = resolve));
  const refusedBy = (from: string, refusal: Refused): void => {
    const result: Ending = { code: 1, reason: `the engine refused the ${from} (${refusal.refused}): ${refusal.reason}` };
    fenced ||= refusal.refused === 'ended';
    if (refusal.refused !== 'ended') {
      end(result);
      return;
    }
    void Promise.race([turnEnded, wait(settings.stopGraceMs)]).then(() => {
      end(result);
    });
  };
  const identity = {
    authorization: `Bearer ${settings.token}`,
    [headers.attempt]: settings.attempt,
    [headers.protocol]: String(protocolVersion),
    [headers.process]: randomUUID(),
    [headers.image]: settings.image,
  };

  const app = spawn(settings.codexCommand, ['app-server', '--listen', 'stdio://'], {
    cwd: settings.workspace,
    env: { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', HOME: settings.codexHome, CODEX_HOME: settings.codexHome, LANG: 'C.UTF-8' },
    stdio: ['pipe', 'pipe', 'inherit'],
    ...(settings.codexUser === undefined ? {} : { uid: settings.codexUser.uid, gid: settings.codexUser.gid }),
  });
  const write = (message: unknown): void => {
    app.stdin.write(`${JSON.stringify(message)}\n`);
  };
  app.on('exit', (code, signal) => {
    if (!finishing) end({ code: 1, reason: `codex app-server exited with ${signal ?? String(code)} before the turn finished` });
  });
  app.on('error', error => {
    end({ code: 1, reason: `codex app-server did not start: ${error.message}` });
  });

  let initialized = false;
  const reader = createInterface({ input: app.stdout, crlfDelay: Infinity });
  const drained = new Promise<void>(resolve => reader.once('close', () => {
    resolve();
  }));
  const quiet = async (): Promise<void> => {
    app.kill('SIGTERM');
    await Promise.race([drained, wait(settings.stopGraceMs)]);
  };
  const storedOrFenced = async (): Promise<void> => {
    posting.nudge();
    while (box.pending() > 0 && !fenced && ending === undefined) await wait(settings.retryMs);
  };
  reader.on('line', text => {
    if (endLine !== undefined) return;
    box.push({ kind: 'app', text });
    posting.nudge();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const message = appMessage.safeParse(json);
    if (!initialized && message.success && message.data.id === bridgeRequestIds.initialize && message.data.method === undefined) {
      initialized = true;
      write({ method: 'initialized' });
      write(threadStart(settings.workspace));
    }
    const completed = turnCompleted.safeParse(json);
    if (completed.success) turnDone();
    if (completed.success && !finishing) {
      finishing = true;
      const interrupted = completed.data.params.turn.status === 'interrupted';
      void quiet()
        .then(() => storedOrFenced())
        .then(() => (interrupted || fenced ? [] : afterTurn(completed.data.params)))
        .then(
          lines => {
            for (const body of lines) box.push(body);
            endLine = box.push({ kind: 'end' });
            posting.nudge();
          },
          (error: unknown) => {
            end({ code: 1, reason: `the step after the turn failed: ${error instanceof Error ? error.message : String(error)}` });
          },
        );
    }
  });
  write(initialize);

  const post = async (): Promise<Posted> => {
    const lines = box.batch();
    try {
      const response = await fetch(new URL('events', settings.engineUrl), {
        method: 'POST',
        headers: { ...identity, 'content-type': 'application/json' },
        body: JSON.stringify({ received: commands.applied(), lines }),
        signal: AbortSignal.timeout(settings.callTimeoutMs),
      });
      const json: unknown = await response.json().catch(() => undefined);
      if (response.ok) {
        const answer = eventsAnswer.safeParse(json);
        return answer.success ? { answer: answer.data } : { failed: 'the answer was not an acknowledgement' };
      }
      const refusal = refusalAnswer.safeParse(json);
      if (refusal.success && response.status === refusalStatus[refusal.data.refused]) return { refused: refusal.data };
      return { failed: `the engine answered ${String(response.status)}` };
    } catch (error) {
      return { failed: error instanceof Error ? error.message : String(error) };
    }
  };

  const postLoop = async (): Promise<void> => {
    let failures = 0;
    let reported = -1;
    let lastPost = 0;
    while (ending === undefined) {
      const due = box.pending() > 0 || commands.applied() !== reported || Date.now() - lastPost >= settings.heartbeatMs;
      if (!due) {
        await posting.sleep(settings.heartbeatMs - (Date.now() - lastPost));
        continue;
      }
      const receivedNow = commands.applied();
      const result = await post();
      lastPost = Date.now();
      if ('refused' in result) {
        refusedBy('bridge', result.refused);
        return;
      }
      if ('failed' in result) {
        if (failures === 0) say(`posting failed, so the bridge keeps ${String(box.pending())} lines and resends from line ${String(box.batch()[0]?.seq ?? box.emitted() + 1)}: ${result.failed}`);
        failures += 1;
        await wait(Math.min(settings.retryMs * failures, 2000));
        continue;
      }
      if (failures > 0) say(`posting works again after ${String(failures)} failures, and the engine has stored up to line ${String(result.answer.stored)}`);
      failures = 0;
      reported = receivedNow;
      box.acked(result.answer.stored);
      if (endLine !== undefined && result.answer.stored >= endLine) end({ code: 0 });
    }
  };

  const streamOnce = async (): Promise<Refused | undefined> => {
    const connection = new AbortController();
    const signal = AbortSignal.any([connection.signal, stop.signal]);
    const response = await fetch(new URL(`commands?after=${String(commands.applied())}`, settings.engineUrl), { headers: identity, signal });
    if (!response.ok) {
      const refusal = refusalAnswer.safeParse(await response.json().catch(() => undefined));
      return refusal.success ? refusal.data : undefined;
    }
    if (response.body === null) return undefined;
    let heard = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - heard > settings.streamQuietMs) connection.abort();
    }, Math.max(100, Math.floor(settings.streamQuietMs / 4)));
    try {
      const decoder = new TextDecoder();
      let pending = '';
      const reader = response.body.getReader();
      for (let read = await reader.read(); !read.done; read = await reader.read()) {
        heard = Date.now();
        pending += decoder.decode(z.instanceof(Uint8Array).parse(read.value), { stream: true });
        for (let cut = pending.indexOf('\n\n'); cut >= 0; cut = pending.indexOf('\n\n')) {
          const frame = pending.slice(0, cut);
          pending = pending.slice(cut + 2);
          if (!frame.startsWith('data: ')) continue;
          const parsed = commandFrame.safeParse(JSON.parse(frame.slice('data: '.length)));
          if (!parsed.success) {
            connection.abort();
            break;
          }
          if (finishing) continue;
          const accepted = commands.accept(parsed.data);
          if (accepted === 'gap') {
            say(`command ${String(parsed.data.seq)} arrived after ${String(commands.applied())}, so the bridge reconnects from ${String(commands.applied())}`);
            connection.abort();
            break;
          }
          if (accepted === 'apply') {
            write(parsed.data.request);
            posting.nudge();
          }
        }
      }
    } finally {
      clearInterval(watchdog);
    }
    return undefined;
  };

  const streamLoop = async (): Promise<void> => {
    while (ending === undefined) {
      const refusal = await streamOnce().catch(() => undefined);
      if (refusal?.refused === 'ended' && endLine !== undefined) return;
      if (refusal !== undefined) {
        refusedBy('command stream', refusal);
        return;
      }
      await wait(settings.retryMs, undefined, { signal: stop.signal }).catch(() => undefined);
    }
  };

  await Promise.all([postLoop(), streamLoop(), settled]);
  finishing = true;
  const exited = app.exitCode !== null || app.signalCode !== null ? Promise.resolve() : new Promise<void>(resolve => app.once('exit', () => { resolve(); }));
  app.kill('SIGTERM');
  await Promise.race([exited, wait(5000)]);
  const result = ending ?? { code: 1, reason: 'the bridge stopped without an ending' };
  say(result.code === 0 ? `the bridge posted ${String(box.emitted())} lines, and the engine stored every one` : `the bridge stops: ${result.reason}`);
  return result;
}
