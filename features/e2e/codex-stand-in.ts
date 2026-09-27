import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
import type { Review as StepReview } from '../../shared/review.ts';
import { catalog, scriptOf, type Entry, type Script, type ScriptName } from './catalog.ts';
import { execute } from './process.ts';
import { tokenUsageMethod } from './report.ts';
import {
  askOnConflict,
  checksPass,
  coverageScript,
  favicon,
  forbidden,
  identity,
  rehearsalOf,
  reproductionScript,
  smokeTest,
  solutions,
  stillWrongSign,
  untouchable,
  type RehearsalName,
  type Solution,
} from './solutions.ts';

export const standInPlan = 'Stand-in plan: change src/words.ts so titleCase capitalizes each word, then prove it with one reproduction script.';

export const ticking = (ticks: number, everyMs: number): string => `stand-in ticks ${String(ticks)} every ${String(everyMs)}`;

export const implementPace = { progressItems: 20, everyMs: 1000 } as const;

export const setupProbe = { item: 'stand-in-setup', steps: ['implement', 'verify'], command: 'test -d node_modules && echo "node_modules present" || echo "node_modules missing"', present: 'node_modules present' } as const;

export const catalogPlan = (entry: Entry): string =>
  `Stand-in plan: add \`${entry.name}\` in \`${entry.file}\`, exported by name, as the ticket's acceptance criteria describe. Verify proves it with one reproduction script that fails on the base commit, where \`${entry.file}\` does not exist, and passes on the change.`;

const thread = 'stand-in-thread';

const turn = 'stand-in-turn';

const commandTimeoutMs = 120_000;

const fields = z.record(z.string(), z.unknown()).catch({});

const record = (value: unknown): Readonly<Record<string, unknown>> => fields.parse(value);

type Message = Readonly<Record<string, unknown>>;

type Behavior = 'fixed' | 'still_wrong' | null;

type Review = StepReview & { readonly behavior?: Behavior };

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

const turnState: { interrupted: boolean; abort: AbortController; items: number; readonly steers: string[] } = { interrupted: false, abort: new AbortController(), items: 0, steers: [] };

const stopped = (): boolean => turnState.interrupted;

const nextId = (kind: string): string => {
  turnState.items += 1;
  return `stand-in-${kind}-${String(turnState.items)}`;
};

export const steerReply = (text: string): string => `Acting on your message: ${text}`;

const answerSteers = (): void => {
  for (const text of turnState.steers.splice(0)) item(nextId('reply'), { type: 'agentMessage', text: steerReply(text) });
};

const quoted = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

const environment = (): Readonly<Record<string, string>> => Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])));

type Ran = { readonly command: string; readonly exitCode: number; readonly output: string };

type CommandAction = { readonly type: 'unknown'; readonly command: string } | { readonly type: 'read'; readonly command: string; readonly name: string; readonly path: string };

async function run(text: string, id: string = nextId('command'), action: CommandAction = { type: 'unknown', command: text }): Promise<Ran> {
  const cwd = process.cwd();
  const command = `sh -c ${quoted(text)}`;
  const shape = { type: 'commandExecution', command, cwd, processId: null, commandActions: [action] };
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

const writing = (path: string, content: string): Action => () => write(join(process.cwd(), path), content);

const firstWrites = ({ entry, solution }: Implementing, rehearsal: RehearsalName | undefined): readonly Action[] => [
  writing(entry.file, rehearsal === 'still-wrong' ? identity(entry) : solution.source),
  ...(rehearsal === 'red-check' || rehearsal === 'pushes-nothing' || rehearsal === 'stays-red' ? [writing(smokeTest.path, smokeTest.source)] : []),
];

const added = ({ entry }: Implementing): Review =>
  review(`The stand-in added ${entry.name} in ${entry.file}.`, `Added \`${entry.name}\` in \`${entry.file}\`, exported by name, and checked it against the ticket's acceptance criteria.`);

type Rework = { readonly writes: readonly Action[]; readonly reply: Review };

const unchangedRework: Rework = { writes: [], reply: review('All mandated checks pass.', checksPass) };

const staysRedNotes = 'notes/stays-red.md';

const conflictQuestion = (entry: Entry): Review => ({
  outcome: 'needs_input',
  summary: `The ticket says not to edit ${untouchable}, and Verify's evidence says the fix needs it.`,
  blocks: [
    {
      kind: 'choice',
      title: 'The ticket against what sent the task back',
      question: `The ticket says "${forbidden}" Verify's evidence says ${untouchable} does not test ${entry.name}, so the fix needs that file. Should Implement edit ${untouchable} anyway?`,
      options: [
        { id: 'edit', label: `Edit ${untouchable}` },
        { id: 'keep', label: `Keep ${untouchable} and change Verify's script` },
      ],
      recommended: null,
    },
  ],
});

function rework(work: Implementing, rehearsal: RehearsalName, prompt: string): Rework {
  switch (rehearsal) {
    case 'red-check':
      return prompt.includes('favicon.ico') ? { writes: [writing(favicon, 'icon\n')], reply: review(`The stand-in added ${favicon}.`, `Added \`${favicon}\`, which the smoke test's log said the page could not load.`) } : unchangedRework;
    case 'still-wrong':
      return prompt.includes(stillWrongSign) ? { writes: [writing(work.entry.file, work.solution.source)], reply: added(work) } : { writes: [], reply: review('The stand-in found nothing to change.', 'The change already does what the plan says.') };
    case 'ticket-conflict':
      return prompt.includes(askOnConflict) ? { writes: [], reply: conflictQuestion(work.entry) } : { writes: [], reply: review(`The stand-in left ${untouchable} alone.`, `Left \`${untouchable}\` alone, as the ticket says.`) };
    case 'pushes-nothing':
      return unchangedRework;
    case 'stays-red':
      return {
        writes: [writing(staysRedNotes, `A rework at ${new Date().toISOString()} left ${smokeTest.path} failing.\n`)],
        reply: review('The stand-in changed its notes and left the smoke test failing.', `Changed \`${staysRedNotes}\` and left \`${smokeTest.path}\` as it was.`),
      };
  }
}

async function implement(work: Implementing, prompt: string): Promise<Review | undefined> {
  const rehearsal = rehearsalOf(prompt);
  const again = rehearsal !== undefined && existsSync(join(process.cwd(), work.entry.file)) ? rework(work, rehearsal, prompt) : undefined;
  const writes = again?.writes ?? firstWrites(work, rehearsal);
  const actions: ReadonlyMap<number, Action> = new Map<number, Action>([
    [2, () => run('ls src test')],
    [8, async () => {
      for (const action of writes) await action(work);
    }],
    [14, ({ entry, solution }) => run(reproductionScript(entry, solution))],
    [18, () => run('git status --short')],
  ]);
  for (let at = 1; at <= implementPace.progressItems; at += 1) {
    await wait(implementPace.everyMs);
    if (stopped()) return undefined;
    answerSteers();
    item(nextId('progress'), { type: 'agentMessage', text: `progress ${String(at)} of ${String(implementPace.progressItems)}: ${work.entry.name}` });
    await actions.get(at)?.(work);
    if (stopped()) return undefined;
  }
  return again?.reply ?? added(work);
}

async function reproducing(prompt: string, content: string, summary: string, body: string): Promise<Review | undefined> {
  const script = /reproduction script at `([^`]+)`/.exec(prompt)?.[1];
  if (script === undefined) return { ...review('The Verify prompt did not name the script.', 'The stand-in could not read its instructions.', 'blocked'), behavior: null };
  await write(script, content);
  const tried = await run(`sh ${script}`);
  if (stopped()) return undefined;
  return { ...review(summary, `${body} Here it exited ${String(tried.exitCode)}.`), behavior: null };
}

const verify = (work: Implementing, prompt: string): Promise<Review | undefined> =>
  rehearsalOf(prompt) === 'ticket-conflict'
    ? reproducing(prompt, coverageScript(work.entry), `The stand-in wrote a script that checks ${untouchable} tests ${work.entry.name}.`, `The script fails while \`${untouchable}\` does not test \`${work.entry.name}\`.`)
    : reproducing(
        prompt,
        reproductionScript(work.entry, work.solution),
        `The stand-in wrote a script that checks ${work.entry.name}.`,
        `The script imports \`${work.entry.name}\` from \`${work.entry.file}\` and checks the ticket's examples.`,
      );

export const answeredHeading = '## Your last review, and the answers to it';

export const scriptFiles: Readonly<Record<ScriptName, string>> = {
  question: 'src/retry.ts',
  stillWrong: 'src/prices.ts',
  brokenEnvironment: 'src/rates.ts',
  longStream: 'src/logging.ts',
};

export const scriptPlan = (script: Script): string => `Stand-in plan for "${script.summary}": change \`${scriptFiles[script.name]}\`, then let Verify judge the change with one reproduction script.`;

type Block = StepReview['blocks'][number];

export const retryQuestion: Block = {
  kind: 'choice',
  title: 'Retry policy',
  question: 'Which retry policy should the sandbox client use?',
  options: [
    { id: 'fixed', label: 'Retry 3 times, 1 s apart' },
    { id: 'backoff', label: 'Back off exponentially, capped at 30 s' },
  ],
  recommended: 'backoff',
};

type ScriptStep = (prompt: string, script: Script) => Promise<Review | undefined>;

const planned: ScriptStep = (_prompt, script) => Promise.resolve(review('The stand-in wrote its plan.', scriptPlan(script)));

const changed: ScriptStep = async (_prompt, script) => {
  const file = scriptFiles[script.name];
  await write(join(process.cwd(), file), `export const changedBy = '${script.name} at ${new Date().toISOString()}';\n`);
  return stopped() ? undefined : review(`The stand-in changed ${file}.`, `Changed \`${file}\` as the plan says.`);
};

const fileExists: ScriptStep = (prompt, script) =>
  reproducing(prompt, `test -f ${scriptFiles[script.name]}\n`, `The stand-in wrote a script that checks ${scriptFiles[script.name]}.`, `The script fails while \`${scriptFiles[script.name]}\` is missing.`);

const asked: ScriptStep = (prompt, script) =>
  prompt.includes(answeredHeading)
    ? planned(prompt, script)
    : Promise.resolve({ outcome: 'needs_input', summary: 'Which retry policy should the sandbox client use? The ticket leaves it open.', blocks: [{ kind: 'text', title: null, body: 'The service documents no retry policy, so the stand-in needs a person to pick one.' }, retryQuestion] });

const stillWrong: ScriptStep = prompt => reproducing(prompt, 'echo "prices still keep fractions of a cent"\nexit 1\n', 'The stand-in wrote a script that checks the rounding.', 'The script fails while any price keeps a fraction of a cent.');

const environmentDown: ScriptStep = () =>
  Promise.resolve({ ...review('The Verify environment did not start.', 'The rates service the ticket names did not answer, so the stand-in could not run the change.', 'blocked'), behavior: null });

type AgentStep = Exclude<Step, 'other'>;

const scriptSteps: Readonly<Record<ScriptName, Readonly<Record<AgentStep, ScriptStep>>>> = {
  question: { specify: asked, implement: changed, verify: fileExists },
  stillWrong: { specify: planned, implement: changed, verify: stillWrong },
  brokenEnvironment: { specify: planned, implement: changed, verify: environmentDown },
  longStream: { specify: planned, implement: changed, verify: fileExists },
};

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
  const script = scriptOf(prompt);
  if (script !== undefined && step !== 'other') return scriptSteps[script.name][step](prompt, script);
  const entry = entryIn(prompt);
  if (step === 'specify') return review('The stand-in wrote its plan.', entry === undefined ? standInPlan : catalogPlan(entry));
  if (entry === undefined || (step !== 'implement' && step !== 'verify')) return unchanged(step);
  const solution = solutions[entry.name];
  if (solution === undefined) return { ...review(`The stand-in has no solution for ${entry.name}.`, `Add one to the stand-in's solutions.`, 'blocked'), ...(step === 'verify' ? { behavior: null } : {}) };
  return step === 'implement' ? implement({ entry, solution }, prompt) : verify({ entry, solution }, prompt);
}

export const tickPrefix = 'stand-in-tick-';

type Working = (id: string) => Promise<unknown>;

const said = (body: object): Working => id => {
  item(id, body);
  return Promise.resolve();
};

const reasoning = (summary: string): Working => said({ type: 'reasoning', summary: [summary], content: [] });

const saying = (text: string): Working => said({ type: 'agentMessage', text });

const reading = (path: string, text: string): Working => id => run(text, id, { type: 'read', command: text, name: basename(path), path });

const opening: readonly Working[] = [
  reasoning('Finding where the sandbox logs on start.'),
  id => run('ls src test', id),
  reading('src/words.ts', "sed -n '1,40p' src/words.ts"),
  saying('Nothing in src logs a start line yet. Checking the package scripts next.'),
  reading('package.json', 'cat package.json'),
  saying('I will add src/logging.ts to log the line once, with a test that counts it.'),
];

const checks: readonly Working[] = [id => run('git status --short', id), reading('test/words.test.ts', "sed -n '1,40p' test/words.test.ts"), id => run('ls src test', id), id => run('git diff --stat', id)];

const thoughts: readonly string[] = [
  'Checking the tests for a start test.',
  'Comparing the start output with the ticket.',
  'Looking for other places that log.',
  'Confirming the package has no logger yet.',
  'Deciding where the logging helper goes.',
  'Checking how the tests import src.',
  'Reading the last few commits.',
  'Checking the working tree is clean.',
  'Drafting the test that counts start lines.',
  'Checking the ticket for other asks.',
  'Making sure the plan covers the ticket.',
  'Rereading the example in the ticket.',
  'Listing the files the change will touch.',
  'Checking nothing else prints on start.',
  'Reviewing the plan once more.',
  'Checking the test runner prints nothing extra.',
];

const workAt = (tick: number): Working | undefined => {
  const after = tick - 1 - opening.length;
  if (after < 0) return opening[tick - 1];
  const turn = Math.floor(after / 2);
  return after % 2 === 0 ? checks[turn % checks.length] : reasoning(thoughts[turn % thoughts.length] ?? '');
};

async function runTurn(params: Readonly<Record<string, unknown>>): Promise<void> {
  const prompt = promptOf(params);
  notify('turn/started', { threadId: thread, turn: { id: turn, status: 'inProgress', items: [] } });
  item('stand-in-user', { type: 'userMessage', clientId: params['clientUserMessageId'] ?? null, content: [{ type: 'text', text: prompt }] });
  tokenUsage(prompt);
  if (setupProbe.steps.some(step => step === stepOf(prompt))) await run(setupProbe.command, setupProbe.item);
  const found = /stand-in ticks (\d+) every (\d+)/.exec(prompt);
  const ticks = Number(found?.[1] ?? '0');
  const everyMs = Number(found?.[2] ?? '0');
  for (let tick = 1; tick <= ticks; tick += 1) {
    await wait(everyMs);
    if (stopped()) return;
    answerSteers();
    await workAt(tick)?.(`${tickPrefix}${String(tick)}`);
  }
  if (stopped()) return;
  const final = await work(prompt);
  if (final === undefined || stopped()) return;
  answerSteers();
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
    case 'turn/steer': {
      const text = promptOf(params);
      send({ id, result: { turnId: turn } });
      item(nextId('steer'), { type: 'userMessage', clientId: params['clientUserMessageId'] ?? null, content: [{ type: 'text', text }] });
      turnState.steers.push(text);
      return;
    }
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
