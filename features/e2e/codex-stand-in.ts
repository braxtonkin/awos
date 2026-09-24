import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';

export const standInPlan = 'Stand-in plan: change src/words.ts so titleCase capitalizes each word, then prove it with one reproduction script.';

export const ticking = (ticks: number, everyMs: number): string => `stand-in ticks ${String(ticks)} every ${String(everyMs)}`;

const thread = 'stand-in-thread';

const turn = 'stand-in-turn';

const fields = z.record(z.string(), z.unknown()).catch({});

const record = (value: unknown): Readonly<Record<string, unknown>> => fields.parse(value);

type Message = Readonly<Record<string, unknown>>;

const send = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const notify = (method: string, params: object): void => {
  send({ method, params });
};

const item = (id: string, body: object): void => {
  notify('item/started', { threadId: thread, turnId: turn, item: { id, ...body } });
  notify('item/completed', { threadId: thread, turnId: turn, item: { id, ...body } });
};

const promptOf = (params: Readonly<Record<string, unknown>>): string => {
  const input = Array.isArray(params['input']) ? params['input'] : [];
  return input.map(part => z.string().catch('').parse(record(part)['text'])).join('\n');
};

const review = (prompt: string): object => {
  const planning = prompt.startsWith('# Specify');
  return {
    outcome: 'done',
    summary: planning ? 'The stand-in wrote its fixed plan.' : 'The stand-in finished the step.',
    blocks: [{ kind: 'text', title: null, body: planning ? standInPlan : 'The stand-in changed nothing.' }],
    ...(prompt.startsWith('# Verify') ? { behavior: null } : {}),
  };
};

const turnState = { interrupted: false };

const stopped = (): boolean => turnState.interrupted;

async function runTurn(params: Readonly<Record<string, unknown>>): Promise<void> {
  const prompt = promptOf(params);
  notify('turn/started', { threadId: thread, turn: { id: turn, status: 'inProgress', items: [] } });
  item('stand-in-user', { type: 'userMessage', clientId: params['clientUserMessageId'] ?? null, content: [{ type: 'text', text: prompt }] });
  const found = /stand-in ticks (\d+) every (\d+)/.exec(prompt);
  const ticks = Number(found?.[1] ?? '0');
  const everyMs = Number(found?.[2] ?? '0');
  for (let tick = 1; tick <= ticks; tick += 1) {
    await wait(everyMs);
    if (stopped()) return;
    item(`stand-in-tick-${String(tick)}`, { type: 'agentMessage', text: `tick ${String(tick)}` });
  }
  if (stopped()) return;
  item('stand-in-review', { type: 'agentMessage', text: JSON.stringify(review(prompt)) });
  notify('turn/completed', { threadId: thread, turn: { id: turn, status: 'completed', items: [] } });
}

const answer = (message: Message): void => {
  const params = record(message['params']);
  const id = message['id'];
  switch (message['method']) {
    case 'initialize':
      send({ id, result: { userAgent: 'codex-stand-in' } });
      return;
    case 'thread/start':
      send({ id, result: { thread: { id: thread }, model: params['model'] ?? null } });
      notify('thread/started', { thread: { id: thread } });
      return;
    case 'turn/start':
      send({ id, result: { turn: { id: turn, status: 'inProgress', items: [] } } });
      void runTurn(params);
      return;
    case 'turn/steer':
      send({ id, result: { turnId: turn } });
      return;
    case 'turn/interrupt':
      turnState.interrupted = true;
      process.stderr.write('stand-in turn interrupted\n');
      send({ id, result: {} });
      notify('turn/completed', { threadId: thread, turn: { id: turn, status: 'interrupted', items: [] } });
      return;
    default:
      if (id !== undefined) send({ id, result: {} });
  }
};

if (process.argv[2] === 'app-server') {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', text => {
    try {
      answer(record(JSON.parse(text)));
    } catch {
      process.stderr.write(`the stand-in could not read ${text.slice(0, 200)}\n`);
    }
  });
  process.on('SIGTERM', () => process.exit(0));
}
