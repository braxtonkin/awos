import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import { catalog, type Entry } from './catalog.ts';
import { execute } from './process.ts';
import { tokenUsageMethod } from './report.ts';
import { reproductionScript, solutions, type Solution } from './solutions.ts';

export const standInPlan = 'Stand-in plan: change src/words.ts so titleCase capitalizes each word, then prove it with one reproduction script.';

export const ticking = (ticks: number, everyMs: number): string => `stand-in ticks ${String(ticks)} every ${String(everyMs)}`;

export const implementPace = { progressItems: 20, everyMs: 1000 } as const;

export const catalogPlan = (entry: Entry): string =>
  `Stand-in plan: add \`${entry.name}\` in \`${entry.file}\`, exported by name, as the ticket's acceptance criteria describe. Verify proves it with one reproduction script that fails on the base commit, where \`${entry.file}\` does not exist, and passes on the change.`;

const thread = 'stand-in-thread';

const turn = 'stand-in-turn';

const commandTimeoutMs = 120_000;

const fields = z.record(z.string(), z.unknown()).catch({});

const record = (value: unknown): Readonly<Record<string, unknown>> => fields.parse(value);

type Message = Readonly<Record<string, unknown>>;

type Behavior = 'fixed' | 'still_wrong' | null;

type Review = {
  readonly outcome: 'done' | 'blocked';
  readonly summary: string;
  readonly blocks: readonly { readonly kind: 'text'; readonly title: null; readonly body: string }[];
  readonly behavior?: Behavior;
};

const send = (message: object): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const notify = (method: string, params: object): void => {
  send({ method, params });
};

const started = (id: string, body: object): void => {
  notify('item/started', { threadId: thread, turnId: turn, item: { id, ...body } });
};

const completed = (id: string, body: object): void => {
  notify('item/completed', { threadId: thread, turnId: turn, item: { id, ...body } });
};

const item = (id: string, body: object): void => {
  started(id, body);
  completed(id, body);
};

const promptOf = (params: Readonly<Record<string, unknown>>): string => {
  const input = Array.isArray(params['input']) ? params['input'] : [];
  return input.map(part => z.string().catch('').parse(record(part)['text'])).join('\n');
};

const review = (summary: string, body: string, outcome: Review['outcome'] = 'done'): Review => ({ outcome, summary, blocks: [{ kind: 'text', title: null, body }] });

const turnState = { interrupted: false, abort: new AbortController(), items: 0 };

const stopped = (): boolean => turnState.interrupted;

const nextId = (kind: string): string => {
  turnState.items += 1;
  return `stand-in-${kind}-${String(turnState.items)}`;
};

const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

const environment = (): Readonly<Record<string, string>> => Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])));

type Ran = { readonly command: string; readonly exitCode: number; readonly output: string };

async function run(text: string): Promise<Ran> {
  const id = nextId('command');
  const cwd = process.cwd();
  const command = `sh -c ${quoted(text)}`;
  const shape = { type: 'commandExecution', command, cwd, processId: null, commandActions: [{ type: 'unknown', command: text }] };
  started(id, { ...shape, status: 'inProgress', aggregatedOutput: null, exitCode: null, durationMs: null });
  const began = performance.now();
  const exit = await execute('sh', ['-c', text], { cwd, env: environment(), timeoutMs: commandTimeoutMs, signal: turnState.abort.signal }).catch((error: unknown) => ({
    code: 1,
    output: error instanceof Error ? error.message : String(error),
  }));
  completed(id, { ...shape, status: exit.code === 0 ? 'completed' : 'failed', aggregatedOutput: exit.output, exitCode: exit.code, durationMs: Math.round(performance.now() - began) });
  return { command: text, exitCode: exit.code, output: exit.output };
}

async function write(path: string, content: string): Promise<void> {
  const kind = existsSync(path) ? { type: 'update', move_path: null } : { type: 'add' };
  const id = nextId('file');
  const shape = { type: 'fileChange', changes: [{ path, kind, diff: content }] };
  started(id, { ...shape, status: 'inProgress' });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  completed(id, { ...shape, status: 'completed' });
}

const tokenUsage = (prompt: string): void => {
  const inputTokens = 8_000 + Math.ceil(prompt.length / 4);
  const usage = { totalTokens: inputTokens + 900, inputTokens, cachedInputTokens: 6_000, outputTokens: 900, reasoningOutputTokens: 300 };
  notify(tokenUsageMethod, { threadId: thread, turnId: turn, tokenUsage: { total: usage, last: usage, modelContextWindow: 272_000 } });
};

const entryIn = (prompt: string): Entry | undefined => catalog.find(entry => prompt.includes(`\`${entry.name}\``) && prompt.includes(`\`${entry.file}\``));

type Implementing = { readonly entry: Entry; readonly solution: Solution };

type Action = (work: Implementing) => Promise<unknown>;

const implementActions: ReadonlyMap<number, Action> = new Map<number, Action>([
  [2, () => run('ls src test')],
  [8, ({ entry, solution }) => write(join(process.cwd(), entry.file), solution.source)],
  [14, ({ entry, solution }) => run(reproductionScript(entry, solution))],
  [18, () => run('git status --short')],
]);

async function implement(work: Implementing): Promise<Review | undefined> {
  for (let at = 1; at <= implementPace.progressItems; at += 1) {
    await wait(implementPace.everyMs);
    if (stopped()) return undefined;
    item(nextId('progress'), { type: 'agentMessage', text: `progress ${String(at)} of ${String(implementPace.progressItems)}: ${work.entry.name}` });
    await implementActions.get(at)?.(work);
    if (stopped()) return undefined;
  }
  return review(`The stand-in added ${work.entry.name} in ${work.entry.file}.`, `Added \`${work.entry.name}\` in \`${work.entry.file}\`, exported by name, and checked it against the ticket's acceptance criteria.`);
}

type VerifyPlan = { readonly script: string; readonly show: string; readonly base: string; readonly baseFolder: string; readonly before: string; readonly after: string };

function verifyPlan(prompt: string): VerifyPlan | undefined {
  const script = /reproduction script at `([^`]+)`/.exec(prompt)?.[1];
  const [show, before, after] = [...prompt.matchAll(/Run exactly `([^`]+)`/g)].map(found => found[1]);
  const baseFolder = /Run `git worktree add --detach (\S+) <base commit>`/.exec(prompt)?.[1];
  const base = /^Base commit: ([0-9a-f]{7,64})$/m.exec(prompt)?.[1];
  if (script === undefined || show === undefined || before === undefined || after === undefined || baseFolder === undefined || base === undefined) return undefined;
  return { script, show, base, baseFolder, before, after };
}

const behaviorOf = (before: Ran, after: Ran): Behavior => {
  if (before.exitCode === 0) return null;
  return after.exitCode === 0 ? 'fixed' : 'still_wrong';
};

const ranText = (what: string, ran: Ran): string => `${what}: \`${ran.command}\` exited ${String(ran.exitCode)}.\n\n\`\`\`\n${ran.output.trim()}\n\`\`\``;

async function verify(work: Implementing, prompt: string): Promise<Review | undefined> {
  const plan = verifyPlan(prompt);
  if (plan === undefined) return { ...review('The Verify prompt did not name the script, the three runs, and the base commit.', 'The stand-in could not read its instructions.', 'blocked'), behavior: null };
  const script = reproductionScript(work.entry, work.solution);
  await write(plan.script, script);
  const shown = await run(plan.show);
  if (existsSync(plan.baseFolder)) await run(`rm -rf ${plan.baseFolder} && git worktree prune`);
  const worktree = await run(`git worktree add --detach ${plan.baseFolder} ${plan.base}`);
  if (stopped()) return undefined;
  if (worktree.exitCode !== 0) return { ...review('The stand-in could not check out the base commit.', ranText('Checking out the base commit', worktree)), behavior: null };
  const before = await run(plan.before);
  const after = await run(plan.after);
  if (stopped()) return undefined;
  const behavior = behaviorOf(before, after);
  const body = [`Reproduction script:\n\n\`\`\`sh\n${shown.output.trim()}\n\`\`\``, ranText('On the base commit', before), ranText('On the change', after)].join('\n\n');
  const summaries = {
    fixed: `${work.entry.name} fails on the base commit and passes on the change.`,
    still_wrong: `${work.entry.name} still fails on the change.`,
    none: `The reproduction script already passes on the base commit.`,
  } as const;
  return { ...review(summaries[behavior ?? 'none'], body), behavior };
}

type Step = 'specify' | 'implement' | 'verify' | 'other';

const stepOf = (prompt: string): Step => {
  if (prompt.startsWith('# Specify')) return 'specify';
  if (prompt.startsWith('# Implement')) return 'implement';
  if (prompt.startsWith('# Verify')) return 'verify';
  return 'other';
};

const unchanged = (step: Step): Review => ({ ...review('The stand-in finished the step.', 'The stand-in changed nothing.'), ...(step === 'verify' ? { behavior: null } : {}) });

async function work(prompt: string): Promise<Review | undefined> {
  const step = stepOf(prompt);
  const entry = entryIn(prompt);
  if (step === 'specify') return review('The stand-in wrote its plan.', entry === undefined ? standInPlan : catalogPlan(entry));
  if (entry === undefined || (step !== 'implement' && step !== 'verify')) return unchanged(step);
  const solution = solutions[entry.name];
  if (solution === undefined) return { ...review(`The stand-in has no solution for ${entry.name}.`, `Add one to the stand-in's solutions.`, 'blocked'), ...(step === 'verify' ? { behavior: null } : {}) };
  return step === 'implement' ? implement({ entry, solution }) : verify({ entry, solution }, prompt);
}

async function runTurn(params: Readonly<Record<string, unknown>>): Promise<void> {
  const prompt = promptOf(params);
  notify('turn/started', { threadId: thread, turn: { id: turn, status: 'inProgress', items: [] } });
  item('stand-in-user', { type: 'userMessage', clientId: params['clientUserMessageId'] ?? null, content: [{ type: 'text', text: prompt }] });
  tokenUsage(prompt);
  const found = /stand-in ticks (\d+) every (\d+)/.exec(prompt);
  const ticks = Number(found?.[1] ?? '0');
  const everyMs = Number(found?.[2] ?? '0');
  for (let tick = 1; tick <= ticks; tick += 1) {
    await wait(everyMs);
    if (stopped()) return;
    item(`stand-in-tick-${String(tick)}`, { type: 'agentMessage', text: `tick ${String(tick)}` });
  }
  if (stopped()) return;
  const final = await work(prompt);
  if (final === undefined || stopped()) return;
  item('stand-in-review', { type: 'agentMessage', text: JSON.stringify(final) });
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
      turnState.abort.abort();
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
