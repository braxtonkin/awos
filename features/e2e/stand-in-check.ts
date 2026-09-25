import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { behaviorOf, outputLimit, reproductionPath, type Behavior, type RanScript, type Reproduction, type Side } from '../../shared/reproduction.ts';
import { review as reviewSchema } from '../../shared/review.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { catalog, scripts, type Entry, type Script, type ScriptName } from './catalog.ts';
import { answeredHeading, scriptFiles, scriptPlan, standInPlan, steerReply, ticking } from './codex-stand-in.ts';
import { execute, type Exit } from './process.ts';
import { tokenUsageMethod } from './report.ts';
import { sandboxCommands, writeSandbox } from './sandbox-seed.ts';
import { identity, reproductionScript, solutions, type Solution } from './solutions.ts';

const standIn = fileURLToPath(new URL('codex-stand-in.ts', import.meta.url));
const prompts = new URL('../code-change/prompts/', import.meta.url);
const workspace = '/workspace';
const sessionTimeoutMs = 120_000;

const environment = (): Readonly<Record<string, string>> => ({
  ...Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => (value === undefined || key === 'FORCE_COLOR' ? [] : [[key, value]]))),
  NO_COLOR: '1',
});

const shell = (command: string, cwd: string): Promise<Exit> => execute('sh', ['-c', command], { cwd, env: environment(), timeoutMs: 300_000, signal: new AbortController().signal });

async function shellOk(command: string, cwd: string): Promise<string> {
  const exit = await shell(command, cwd);
  if (exit.code !== 0) throw new Error(`${command} exited ${String(exit.code)}: ${exit.output.slice(-1500)}`);
  return exit.output.trim();
}

const line = z.looseObject({ method: z.string().optional(), params: z.unknown().optional() });

const completedItem = z.object({ method: z.literal('item/completed'), params: z.object({ item: z.looseObject({ type: z.string() }) }) });

const commandItem = z.looseObject({ type: z.literal('commandExecution'), command: z.string(), exitCode: z.int(), aggregatedOutput: z.string() });

const fileItem = z.looseObject({ type: z.literal('fileChange'), changes: z.array(z.looseObject({ path: z.string() })) });

const messageItem = z.looseObject({ type: z.literal('agentMessage'), text: z.string() });

const usageLine = z.object({ params: z.object({ tokenUsage: z.object({ total: z.object({ inputTokens: z.int().positive() }) }) }) });

const stepReview = reviewSchema.extend({ behavior: z.enum(['fixed', 'still_wrong']).nullable().optional() });

type Session = {
  readonly ms: number;
  readonly items: readonly z.infer<typeof completedItem>['params']['item'][];
  readonly usage: readonly number[];
  readonly ended: boolean;
};

type Steer = { readonly id: string; readonly text: string };

function session(prompt: string, steer?: Steer): Promise<Session> {
  return new Promise((resolve, reject) => {
    const began = performance.now();
    const child = spawn(process.execPath, [standIn, 'app-server', '--listen', 'stdio://'], { cwd: workspace, stdio: ['pipe', 'pipe', 'inherit'] });
    const items: Session['items'][number][] = [];
    const usage: number[] = [];
    let steered = false;
    const finish = (ended: boolean): void => {
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve({ ms: performance.now() - began, items, usage, ended });
    };
    const timer = setTimeout(() => {
      finish(false);
    }, sessionTimeoutMs);
    child.on('error', reject);
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', text => {
      const parsed = line.safeParse(JSON.parse(text));
      if (!parsed.success) return;
      const done = completedItem.safeParse(parsed.data);
      if (done.success) items.push(done.data.params.item);
      if (done.success && steer !== undefined && !steered && done.data.params.item.type === 'agentMessage') {
        steered = true;
        child.stdin.write(`${JSON.stringify({ id: 4, method: 'turn/steer', params: { threadId: 'stand-in-thread', expectedTurnId: 'stand-in-turn', clientUserMessageId: steer.id, input: [{ type: 'text', text: steer.text, text_elements: [] }] } })}\n`);
      }
      if (parsed.data.method === tokenUsageMethod) usage.push(usageLine.parse(parsed.data).params.tokenUsage.total.inputTokens);
      if (parsed.data.method === 'turn/completed') finish(true);
    });
    const requests = [
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'stand-in-check', version: '1' }, capabilities: null } },
      { method: 'initialized' },
      { id: 2, method: 'thread/start', params: { model: 'gpt-6-luna', cwd: workspace } },
      { id: 3, method: 'turn/start', params: { threadId: 'stand-in-thread', input: [{ type: 'text', text: prompt, text_elements: [] }] } },
    ];
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

const commandsOf = (run: Session): readonly z.infer<typeof commandItem>[] => run.items.flatMap(entry => (commandItem.safeParse(entry).success ? [commandItem.parse(entry)] : []));

const messagesOf = (run: Session): readonly string[] => run.items.flatMap(entry => (messageItem.safeParse(entry).success ? [messageItem.parse(entry).text] : []));

function reviewOf(run: Session): z.infer<typeof stepReview> | undefined {
  const last = messagesOf(run).at(-1);
  if (last === undefined) return undefined;
  const parsed = stepReview.safeParse(JSON.parse(last));
  return parsed.success ? parsed.data : undefined;
}

const planOf = (run: Session): string => reviewOf(run)?.blocks.flatMap(block => (block.kind === 'text' ? [block.body] : [])).join('\n\n') ?? '';

async function promptFor(step: 'specify' | 'implement' | 'verify', input: string): Promise<string> {
  const head = await readFile(new URL(`${step}.md`, prompts), 'utf8');
  const section = (title: string, body: string): string => `## ${title}\n\n${body.trim()}`;
  return `${[head.trim(), section('Goal', 'Take each sandbox ticket to a merged pull request.'), section('Fast test command', `\`${sandboxCommands.fastTest}\``), section('Input', input)].join('\n\n')}\n`;
}

const ticketOf = (entry: Entry): string => `Ticket SBX-1: ${entry.summary}\n\n${entry.description.trim()}`;

async function freshWorkspace(): Promise<string> {
  await rm(workspace, { recursive: true, force: true });
  await rm(reproductionPath, { force: true });
  await writeSandbox(workspace);
  await shellOk('git init -q -b main && git config user.name Sandbox && git config user.email sandbox@example.com && git add -A && git commit -q -m "Seed the sandbox"', workspace);
  return shellOk('git rev-parse HEAD', workspace);
}

const commit = (message: string): Promise<string> => shellOk(`git add -A && git commit -q -m "${message}"`, workspace);

const turnChecks = (label: string, run: Session): readonly Check[] => [
  run.ended ? pass(`${label}: the turn completes`, `${String(Math.round(run.ms))} ms`) : fail(`${label}: the turn completes`, `no turn/completed within ${String(sessionTimeoutMs)} ms`),
  run.usage.length === 1 ? pass(`${label}: one token usage update`, `${String(run.usage[0] ?? 0)} input tokens`) : fail(`${label}: one token usage update`, `${String(run.usage.length)} updates`),
];

const ranScript = (exit: Exit): RanScript => ({ exitCode: exit.code, timedOut: false, output: exit.output.slice(-outputLimit) });

async function side(at: string, script: string, npmCache: string): Promise<Side> {
  const folder = await mkdtemp(join(tmpdir(), 'stand-in-side-'));
  try {
    const [tree, home, temporary] = [join(folder, 'tree'), join(folder, 'home'), join(folder, 'tmp')];
    for (const made of [tree, home, temporary]) await mkdir(made);
    const checkout = await shell(`git archive --format=tar -o "${folder}/tree.tar" ${at} && tar -x -C "${tree}" -f "${folder}/tree.tar"`, workspace);
    if (checkout.code !== 0) return { commit: at, checkout: checkout.output.slice(-outputLimit), setup: null, run: null };
    await writeFile(join(folder, 'reproduce.sh'), script);
    const env = { PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, TMPDIR: temporary, LANG: 'C.UTF-8', CI: 'true', npm_config_cache: npmCache };
    const given = { cwd: tree, env, timeoutMs: 300_000, signal: new AbortController().signal };
    const setup = await execute('sh', ['-c', sandboxCommands.setup], given);
    const ran = setup.code === 0 ? await execute('sh', [join(folder, 'reproduce.sh')], given) : null;
    return { commit: at, checkout: null, setup: ranScript(setup), run: ran === null ? null : ranScript(ran) };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

async function reproduce(base: string, change: string, npmCache: string): Promise<Reproduction> {
  const script = await readFile(reproductionPath, 'utf8').catch(() => '');
  if (script.trim() === '') return { state: 'no_script', reason: `the agent left no script at ${reproductionPath}` };
  return { state: 'ran', script, base: await side(base, script, npmCache), change: await side(change, script, npmCache) };
}

const sideLine = (where: string, given: Side): string =>
  `${where} ${given.commit.slice(0, 7)}: ${given.checkout === null ? `setup exited ${String(given.setup?.exitCode ?? 'never')}, script exited ${String(given.run?.exitCode ?? 'never')}` : 'checkout failed'}`;

async function verifyChecks(label: string, run: Session, base: string, npmCache: string, behavior: Exclude<Behavior, null>): Promise<readonly Check[]> {
  const change = await shellOk('git rev-parse HEAD', workspace);
  const found = reviewOf(run);
  const reproduction = await reproduce(base, change, npmCache);
  const ran = reproduction.state === 'ran' ? `${sideLine('base', reproduction.base)}; ${sideLine('change', reproduction.change)}` : reproduction.reason;
  const settled = behaviorOf(reproduction);
  return [
    ...turnChecks(label, run),
    found?.outcome === 'done' && found.behavior === null ? pass(`${label}: the review is done and leaves behavior to AutoWorker`, found.summary) : fail(`${label}: the review is done and leaves behavior to AutoWorker`, JSON.stringify(found ?? messagesOf(run).at(-1) ?? null).slice(0, 500)),
    settled === behavior ? pass(`${label}: the script on fresh base and change checkouts settles ${behavior}`, ran) : fail(`${label}: the script on fresh base and change checkouts settles ${behavior}`, `settled ${String(settled)}: ${ran}`),
  ];
}

async function drive(entry: Entry, solution: Solution, npmCache: string): Promise<readonly Check[]> {
  const base = await freshWorkspace();
  const specify = await session(await promptFor('specify', ticketOf(entry)));
  const plan = planOf(specify);
  const checks: Check[] = [
    ...turnChecks(`${entry.name} Specify`, specify),
    plan.includes(`\`${entry.name}\``) && plan.includes(`\`${entry.file}\``) ? pass(`${entry.name} Specify: the plan names the function and file`, plan) : fail(`${entry.name} Specify: the plan names the function and file`, plan),
    (await shellOk('git status --porcelain', workspace)) === '' ? pass(`${entry.name} Specify: changes no file`, 'clean') : fail(`${entry.name} Specify: changes no file`, await shellOk('git status --porcelain', workspace)),
  ];
  const implement = await session(await promptFor('implement', `${ticketOf(entry)}\n\nPlan:\n\n${plan}`));
  const written = await readFile(join(workspace, entry.file), 'utf8').catch(() => '');
  const progress = messagesOf(implement).filter(text => text.startsWith('progress ')).length;
  const files = implement.items.flatMap(found => (fileItem.safeParse(found).success ? fileItem.parse(found).changes.map(change => change.path) : []));
  checks.push(
    ...turnChecks(`${entry.name} Implement`, implement),
    implement.ms >= 20_000 && progress >= 20 ? pass(`${entry.name} Implement: paced over at least 20 s with a progress item each second`, `${String(Math.round(implement.ms))} ms, ${String(progress)} progress items`) : fail(`${entry.name} Implement: paced over at least 20 s with a progress item each second`, `${String(Math.round(implement.ms))} ms, ${String(progress)} progress items`),
    files.includes(join(workspace, entry.file)) ? pass(`${entry.name} Implement: a fileChange item names the file`, files.join(', ')) : fail(`${entry.name} Implement: a fileChange item names the file`, files.join(', ')),
    written === solution.source ? pass(`${entry.name} Implement: the file holds the solution`, entry.file) : fail(`${entry.name} Implement: the file holds the solution`, written.slice(0, 300)),
    commandsOf(implement).length >= 3 ? pass(`${entry.name} Implement: commands are commandExecution items`, commandsOf(implement).map(ran => ran.command.slice(0, 60)).join('; ')) : fail(`${entry.name} Implement: commands are commandExecution items`, String(commandsOf(implement).length)),
    reviewOf(implement)?.outcome === 'done' ? pass(`${entry.name} Implement: the review is done`, reviewOf(implement)?.summary ?? '') : fail(`${entry.name} Implement: the review is done`, messagesOf(implement).at(-1) ?? ''),
  );
  await commit(`AutoWorker implements ${entry.name}`);
  const verifyPrompt = await promptFor('verify', `${ticketOf(entry)}\n\nPlan:\n\n${plan}\n\nBase commit: ${base}`);
  const verify = await session(verifyPrompt);
  checks.push(
    ...(await verifyChecks(`${entry.name} Verify`, verify, base, npmCache, 'fixed')),
    (await shellOk('git status --porcelain', workspace)) === '' ? pass(`${entry.name} Verify: changes no file in the repository`, 'clean') : fail(`${entry.name} Verify: changes no file in the repository`, await shellOk('git status --porcelain', workspace)),
  );
  await writeFile(join(workspace, entry.file), identity(entry));
  await commit(`Plant an identity ${entry.name}`);
  await rm(reproductionPath, { force: true });
  checks.push(...(await verifyChecks(`${entry.name} Verify of an identity`, await session(verifyPrompt), base, npmCache, 'still_wrong')));
  return checks;
}

const userItem = z.looseObject({ type: z.literal('userMessage'), clientId: z.string().nullable() });

async function steerChecks(): Promise<readonly Check[]> {
  await freshWorkspace();
  const steer = { id: randomUUID(), text: 'Also log the start time once.' };
  const run = await session(`Ticket stand-in-steer: Keep streaming.\n\n${ticking(4, 300)}`, steer);
  const echoed = run.items.findIndex(found => userItem.safeParse(found).data?.clientId === steer.id);
  const answered = run.items.findIndex((found, index) => index > echoed && messageItem.safeParse(found).data?.text === steerReply(steer.text));
  const name = "a turn/steer yields a userMessage whose clientId is the steer's id, followed by an agent message that answers it";
  return [
    ...turnChecks('steer', run),
    echoed >= 0 && answered > echoed ? pass(name, `userMessage at item ${String(echoed)}, answer at item ${String(answered)}`) : fail(name, `userMessage at ${String(echoed)}, answer at ${String(answered)}: ${JSON.stringify(run.items).slice(0, 600)}`),
  ];
}

const scriptTicket = (script: Script): string => `Ticket LOCAL-1: ${script.summary}\n\n${script.description}`;

const scriptNamed = (name: ScriptName): Script => {
  const found = scripts.find(script => script.name === name);
  if (found === undefined) throw new Error(`no script is named ${name}`);
  return found;
};

async function scriptChecks(npmCache: string): Promise<readonly Check[]> {
  const question = scriptNamed('question');
  await freshWorkspace();
  const asked = await session(await promptFor('specify', scriptTicket(question)));
  const choices = reviewOf(asked)?.blocks.filter(block => block.kind === 'choice') ?? [];
  const answered = await session(`${await promptFor('specify', scriptTicket(question))}\n${answeredHeading}\n\n{"kind":"pick","block":1,"option":"backoff"}\n`);
  const checks: Check[] = [
    ...turnChecks('question Specify', asked),
    reviewOf(asked)?.outcome === 'needs_input' && choices.length === 1 && choices.every(block => block.recommended !== null)
      ? pass('question Specify: needs input with one choice block and a recommended option', JSON.stringify(choices))
      : fail('question Specify: needs input with one choice block and a recommended option', JSON.stringify(reviewOf(asked) ?? messagesOf(asked).at(-1) ?? null).slice(0, 500)),
    reviewOf(answered)?.outcome === 'done' && planOf(answered) === scriptPlan(question) ? pass('question Specify with an answer: writes its plan', planOf(answered)) : fail('question Specify with an answer: writes its plan', planOf(answered)),
  ];
  for (const name of ['stillWrong', 'brokenEnvironment'] as const) {
    const script = scriptNamed(name);
    const base = await freshWorkspace();
    const implement = await session(await promptFor('implement', `${scriptTicket(script)}\n\nPlan:\n\n${scriptPlan(script)}`));
    const written = await readFile(join(workspace, scriptFiles[name]), 'utf8').catch(() => '');
    checks.push(...turnChecks(`${name} Implement`, implement), written === '' ? fail(`${name} Implement: changes ${scriptFiles[name]}`, 'no file') : pass(`${name} Implement: changes ${scriptFiles[name]}`, written.trim()));
    await commit(`AutoWorker implements ${name}`);
    await rm(reproductionPath, { force: true });
    const verify = await session(await promptFor('verify', `${scriptTicket(script)}\n\nPlan:\n\n${scriptPlan(script)}\n\nBase commit: ${base}`));
    if (name === 'stillWrong') checks.push(...(await verifyChecks(`${name} Verify`, verify, base, npmCache, 'still_wrong')));
    else checks.push(...turnChecks(`${name} Verify`, verify), reviewOf(verify)?.outcome === 'blocked' ? pass(`${name} Verify: the review is blocked, which Verify judges an environment failure`, reviewOf(verify)?.summary ?? '') : fail(`${name} Verify: the review is blocked, which Verify judges an environment failure`, messagesOf(verify).at(-1) ?? ''));
  }
  return checks;
}

async function roundTripPlan(): Promise<Check> {
  await freshWorkspace();
  const specify = await session(await promptFor('specify', 'Ticket stand-in-a: Change titleCase in src/words.ts so it returns the text with the first letter of each space-separated word in upper case.'));
  const plan = planOf(specify);
  return plan === standInPlan ? pass('the round-trip ticket keeps the fixed plan', plan) : fail('the round-trip ticket keeps the fixed plan', plan);
}

async function solutionChecks(): Promise<readonly Check[]> {
  const names = catalog.map(entry => entry.name).sort();
  const solved = Object.keys(solutions).sort();
  const checks: Check[] = [
    JSON.stringify(names) === JSON.stringify(solved) ? pass('every catalog entry has one solution', solved.join(', ')) : fail('every catalog entry has one solution', `catalog ${names.join(', ')}; solutions ${solved.join(', ')}`),
  ];
  const folder = await mkdtemp(join(tmpdir(), 'stand-in-sandbox-'));
  try {
    await writeSandbox(folder);
    await shellOk('npm ci --no-audit --no-fund', folder);
    const typecheck = await shell('npm run typecheck', folder);
    checks.push(typecheck.code === 0 ? pass("the seeded sandbox passes its own CI's typecheck", 'tsc --noEmit exit 0') : fail("the seeded sandbox passes its own CI's typecheck", typecheck.output.slice(-1500)));
    for (const entry of catalog) {
      const solution = solutions[entry.name];
      if (solution === undefined) continue;
      const acceptance = `test/acceptance-${entry.name}.test.ts`;
      const script = reproductionScript(entry, solution);
      await writeFile(join(folder, acceptance), entry.acceptance);
      await writeFile(join(folder, entry.file), solution.source);
      const passing = await shell('npx vitest run', folder);
      const scriptPasses = await shell(script, folder);
      await writeFile(join(folder, entry.file), identity(entry));
      const identityRun = await shell(`npx vitest run ${acceptance}`, folder);
      const scriptRejects = await shell(script, folder);
      await rm(join(folder, entry.file));
      await rm(join(folder, acceptance));
      checks.push(
        passing.code === 0 ? pass(`${entry.name}: the sandbox tests and the acceptance test pass`, passing.output.trim().split('\n').slice(-4).join(' | ')) : fail(`${entry.name}: the sandbox tests and the acceptance test pass`, passing.output.slice(-1500)),
        identityRun.code !== 0 && identityRun.output.includes(`> ${entry.name}`)
          ? pass(`${entry.name}: an identity implementation fails the acceptance test by name`, identityRun.output.split('\n').find(text => text.includes(`> ${entry.name}`))?.trim() ?? '')
          : fail(`${entry.name}: an identity implementation fails the acceptance test by name`, `exit ${String(identityRun.code)}: ${identityRun.output.slice(-1500)}`),
        scriptPasses.code === 0 && scriptRejects.code !== 0
          ? pass(`${entry.name}: the reproduction script passes the solution and rejects the identity`, scriptPasses.output.trim())
          : fail(`${entry.name}: the reproduction script passes the solution and rejects the identity`, `solution exit ${String(scriptPasses.code)}: ${scriptPasses.output.slice(-500)}; identity exit ${String(scriptRejects.code)}`),
      );
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
  return checks;
}

export const standInSolutionsScenario: Scenario = {
  name: 'stand-in-solutions',
  summary: "proves the Codex stand-in's solution for every catalog entry with the sandbox's vitest, then drives the stand-in over stdio through Specify, Implement, and Verify in a sandbox repository at /workspace, runs Verify's script on fresh base and change checkouts as the Job does, checks that a turn/steer comes back as a userMessage with the steer's id and then an answer, and drives the question, still-wrong, and broken-environment scripts",
  run: async () => {
    const checks: Check[] = [...(await solutionChecks())];
    checks.push(await roundTripPlan());
    checks.push(...(await steerChecks()));
    const npmCache = await mkdtemp(join(tmpdir(), 'stand-in-npm-'));
    try {
      checks.push(...(await scriptChecks(npmCache)));
      for (const entry of catalog) {
        const solution = solutions[entry.name];
        if (solution !== undefined) checks.push(...(await drive(entry, solution, npmCache)));
      }
    } finally {
      await rm(npmCache, { recursive: true, force: true });
    }
    return checks;
  },
};
