import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { review as reviewSchema } from '../../shared/review.ts';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { catalog, type Entry } from './catalog.ts';
import { standInPlan } from './codex-stand-in.ts';
import { execute, type Exit } from './process.ts';
import { tokenUsageMethod } from './report.ts';
import { writeSandbox } from './sandbox-seed.ts';
import { identity, reproductionScript, solutions, type Solution } from './solutions.ts';

const standIn = fileURLToPath(new URL('codex-stand-in.ts', import.meta.url));
const prompts = new URL('../code-change/prompts/', import.meta.url);
const workspace = '/workspace';
const baseFolder = '/tmp/autoworker-base';
const sessionTimeoutMs = 120_000;
const expected = {
  show: "sh -c 'cat /tmp/autoworker-reproduce.sh'",
  before: "sh -c 'cd /tmp/autoworker-base && sh /tmp/autoworker-reproduce.sh'",
  after: "sh -c 'cd /workspace && sh /tmp/autoworker-reproduce.sh'",
} as const;

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

function session(prompt: string): Promise<Session> {
  return new Promise((resolve, reject) => {
    const began = performance.now();
    const child = spawn(process.execPath, [standIn, 'app-server', '--listen', 'stdio://'], { cwd: workspace, stdio: ['pipe', 'pipe', 'inherit'] });
    const items: Session['items'][number][] = [];
    const usage: number[] = [];
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
  return `${[head.trim(), section('Goal', 'Take each sandbox ticket to a merged pull request.'), section('Fast test command', '`npm ci && npm test`'), section('Input', input)].join('\n\n')}\n`;
}

const ticketOf = (entry: Entry): string => `Ticket SBX-1: ${entry.summary}\n\n${entry.description.trim()}`;

async function freshWorkspace(): Promise<string> {
  await rm(workspace, { recursive: true, force: true });
  await rm(baseFolder, { recursive: true, force: true });
  await writeSandbox(workspace);
  await shellOk('git init -q -b main && git config user.name Sandbox && git config user.email sandbox@example.com && git add -A && git commit -q -m "Seed the sandbox"', workspace);
  return shellOk('git rev-parse HEAD', workspace);
}

const commit = (message: string): Promise<string> => shellOk(`git add -A && git commit -q -m "${message}"`, workspace);

const turnChecks = (label: string, run: Session): readonly Check[] => [
  run.ended ? pass(`${label}: the turn completes`, `${String(Math.round(run.ms))} ms`) : fail(`${label}: the turn completes`, `no turn/completed within ${String(sessionTimeoutMs)} ms`),
  run.usage.length === 1 ? pass(`${label}: one token usage update`, `${String(run.usage[0] ?? 0)} input tokens`) : fail(`${label}: one token usage update`, `${String(run.usage.length)} updates`),
];

function verifyChecks(label: string, run: Session, before: number, after: number, behavior: 'fixed' | 'still_wrong'): readonly Check[] {
  const commands = commandsOf(run);
  const at = (text: string): number => commands.findIndex(ran => ran.command === text);
  const [show, beforeAt, afterAt] = [at(expected.show), at(expected.before), at(expected.after)];
  const [beforeRan, afterRan] = [commands[beforeAt], commands[afterAt]];
  const ran = commands.map(entry => `${entry.command} exited ${String(entry.exitCode)}`).join('; ');
  const found = reviewOf(run);
  return [
    ...turnChecks(label, run),
    show >= 0 && show < beforeAt && beforeAt < afterAt ? pass(`${label}: the three runs come in order`, ran) : fail(`${label}: the three runs come in order`, ran),
    beforeRan?.exitCode === before && afterRan?.exitCode === after
      ? pass(`${label}: before exits ${String(before)} and after exits ${String(after)}`, afterRan.aggregatedOutput.trim().slice(0, 300))
      : fail(`${label}: before exits ${String(before)} and after exits ${String(after)}`, ran),
    found?.behavior === behavior ? pass(`${label}: the review says ${behavior}`, found.summary) : fail(`${label}: the review says ${behavior}`, JSON.stringify(found ?? messagesOf(run).at(-1) ?? null).slice(0, 500)),
  ];
}

async function drive(entry: Entry, solution: Solution): Promise<readonly Check[]> {
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
  const baseHead = await shellOk('git rev-parse HEAD', baseFolder).catch((error: unknown) => String(error));
  checks.push(
    ...verifyChecks(`${entry.name} Verify`, verify, 1, 0, 'fixed'),
    baseHead === base ? pass(`${entry.name} Verify: ${baseFolder} is a worktree at the base commit`, base) : fail(`${entry.name} Verify: ${baseFolder} is a worktree at the base commit`, baseHead),
    (await shellOk('git status --porcelain', workspace)) === '' ? pass(`${entry.name} Verify: changes no file in the repository`, 'clean') : fail(`${entry.name} Verify: changes no file in the repository`, await shellOk('git status --porcelain', workspace)),
  );
  await writeFile(join(workspace, entry.file), identity(entry));
  await commit(`Plant an identity ${entry.name}`);
  checks.push(...verifyChecks(`${entry.name} Verify of an identity`, await session(verifyPrompt), 1, 1, 'still_wrong'));
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
  summary: "proves the Codex stand-in's solution for every catalog entry with the sandbox's vitest, then drives the stand-in over stdio through Specify, Implement, and Verify in a sandbox repository at /workspace",
  run: async () => {
    const checks: Check[] = [...(await solutionChecks())];
    checks.push(await roundTripPlan());
    for (const entry of catalog) {
      const solution = solutions[entry.name];
      if (solution !== undefined) checks.push(...(await drive(entry, solution)));
    }
    return checks;
  },
};
