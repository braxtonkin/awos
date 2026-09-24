import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect } from '../../shared/db/client.ts';
import { evidenceComment, planComment } from './frontier.ts';
import type { GitHub, Pull } from './github.ts';
import type { Issue, Jira } from './jira.ts';
import { baseEnvironment, execute, succeed, type Command } from './process.ts';

const agentModel = 'gpt-6-luna';

const mountedLogin = '/codex/auth.json';
const agentTimeoutMs = 25 * 60_000;
const scriptTimeoutMs = 120_000;
const checkWaitMs = 20 * 60_000;
const checkPollMs = 10_000;

export type Assignment = {
  readonly ticket: string;
  readonly branch: string;
  readonly databaseUrl: string;
  readonly jira: Jira;
  readonly github: GitHub;
  readonly workdir: string;
  readonly signal: AbortSignal;
  readonly log: (line: string) => void;
};

type Workspace = { readonly clone: string; readonly script: string; readonly scratch: string; readonly assignment: Assignment };

type Change = { readonly plan: string; readonly script: string };

type Maker = (workspace: Workspace, issue: Issue) => Promise<Change>;

const command = (cwd: string, assignment: Assignment, timeoutMs = 300_000): Command => ({ cwd, env: baseEnvironment(assignment.workdir), timeoutMs, signal: assignment.signal });

async function recordTask(assignment: Assignment, issue: Issue): Promise<void> {
  const database = connect(assignment.databaseUrl, 1);
  try {
    await database.transaction().execute(async tx => {
      const person = await tx
        .insertInto('person')
        .values({ email: assignment.jira.email.toLowerCase(), name: 'Sandbox owner', jira_account_id: issue.fields.assignee?.accountId ?? null })
        .returning('id')
        .executeTakeFirstOrThrow();
      const routine = await tx.insertInto('routine').values({ creator_id: person.id }).returning('id').executeTakeFirstOrThrow();
      const action = randomUUID();
      await tx.insertInto('human_action').values({ id: action, at: new Date(), person_id: person.id, kind: 'edit_routine', routine_id: routine.id }).execute();
      const saved = randomUUID();
      const repository = await tx.insertInto('repository').values({ github: assignment.github.repository, branch: assignment.branch, saved_by: saved }).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('human_action').values({ id: saved, at: new Date(), person_id: person.id, kind: 'add_repository', repository_id: repository.id }).execute();
      await tx
        .insertInto('routine_version')
        .values({
          routine_id: routine.id,
          version: 1,
          name: 'end-to-end throwaway',
          goal: 'Take each sandbox ticket to a merged pull request',
          schedule: '* * * * *',
          repository_id: repository.id,
          action_id: action,
          workflow: 'code-change',
          source: JSON.stringify({ kind: 'jira-search', query: `key = ${issue.key}` }),
          needs_repository: true,
        })
        .execute();
      await tx
        .insertInto('task')
        .values({
          routine_id: routine.id,
          found_version: 1,
          repository_id: repository.id,
          key: issue.key,
          title: issue.fields.summary,
          found_at: new Date(),
          assignee_account_id: issue.fields.assignee?.accountId ?? null,
          workflow: 'code-change',
          needs_repository: true,
          step: 'specify',
        })
        .execute();
    });
  } finally {
    await database.destroy();
  }
}

function modelsIn(value: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(value)) for (const item of value) modelsIn(item, into);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'model' && typeof item === 'string') into.add(item);
      else modelsIn(item, into);
    }
  }
  return into;
}

async function sessionModels(codexHome: string): Promise<ReadonlySet<string>> {
  const models = new Set<string>();
  const sessions = join(codexHome, 'sessions');
  const files = (await readdir(sessions, { recursive: true }).catch(() => [])).filter(file => file.endsWith('.jsonl'));
  for (const file of files) {
    for (const line of (await readFile(join(sessions, file), 'utf8')).split('\n')) {
      if (line.trim() !== '') modelsIn(JSON.parse(line), models);
    }
  }
  return models;
}

const inputTokens = (events: string): number =>
  events
    .split('\n')
    .map(line => /"type":"turn\.completed".*"input_tokens":(\d+)/.exec(line)?.[1])
    .reduce((sum: number, tokens) => sum + (tokens === undefined ? 0 : Number(tokens)), 0);

const agentPrompt = (issue: Issue, script: string): string =>
  [
    'You are working in a clone of a small TypeScript library. Node 24 runs .ts files directly, and `npm test` runs the Vitest tests.',
    '',
    `Ticket ${issue.key}: ${issue.fields.summary}`,
    '',
    issue.fields.description ?? '',
    '',
    'Do this:',
    `1. Before you change the library, write a reproduction script for the ticket at ${script}. It is a bash script that runs from the repository root, uses node and no npm packages, exits non-zero while the ticket is not done, and exits 0 once it is done. Keep it outside the repository.`,
    '2. Implement the ticket in the repository, with Vitest tests under test/.',
    '3. Run `npm ci` and `npm test`, and fix what fails.',
    '4. Do not commit, push, or create branches.',
    '',
    'End with a short plan of the change: what you changed and why, in at most five plain sentences.',
  ].join('\n');

const codex: Maker = async (workspace, issue) => {
  const { assignment } = workspace;
  const codexHome = join(workspace.scratch, 'codex');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await copyFile(mountedLogin, join(codexHome, 'auth.json'));
  await chmod(join(codexHome, 'auth.json'), 0o600);
  const planFile = join(workspace.scratch, 'plan.txt');
  const home = join(workspace.scratch, 'home');
  await mkdir(home, { recursive: true });
  try {
    const exit = await execute(
      'codex',
      ['exec', '--json', '--model', agentModel, '--sandbox', 'danger-full-access', '--config', 'approval_policy="never"', '--cd', workspace.clone, '--output-last-message', planFile, agentPrompt(issue, workspace.script)],
      { cwd: workspace.clone, env: { ...baseEnvironment(home), CODEX_HOME: codexHome }, timeoutMs: agentTimeoutMs, signal: assignment.signal },
    );
    const models = await sessionModels(codexHome);
    if (models.size === 0 || [...models].some(model => model !== agentModel)) throw new Error(`the agent's events name the models ${[...models].join(', ') || 'none'}, and only ${agentModel} is allowed`);
    if (exit.code !== 0) throw new Error(`codex exec exited ${String(exit.code)}: ${exit.output.slice(-1000)}`);
    assignment.log(`agent finished on ${agentModel}, ${String(inputTokens(exit.output))} input tokens`);
    const plan = await readFile(planFile, 'utf8').catch(() => '');
    const script = await readFile(workspace.script, 'utf8').catch(() => undefined);
    if (script === undefined) throw new Error(`the agent wrote no reproduction script at ${workspace.script}`);
    return { plan: plan.trim() === '' ? 'The agent gave no plan.' : plan, script };
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
};

const identity: Maker = async (workspace, issue) => {
  const named = /function `([A-Za-z]+)` in a new file `(src\/[a-z-]+\.ts)`/.exec(issue.fields.description ?? '');
  const [, name, file] = named ?? [];
  if (name === undefined || file === undefined) throw new Error(`${issue.key} names no function and file`);
  await writeFile(join(workspace.clone, file), `export const ${name} = (input: unknown): unknown => input;\n`);
  const script = `node --input-type=module -e "const found = await import('./${file}').catch(() => ({})); process.exit(typeof found.${name} === 'function' ? 0 : 1);"\n`;
  return { plan: `Export ${name} from ${file} as a function that returns its input unchanged, so the acceptance test must catch it.`, script };
};

async function waitForSandbox(github: GitHub, pull: Pull, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + checkWaitMs;
  while (Date.now() < deadline) {
    const done = (await github.checkRuns(pull.head.sha, 'sandbox')).find(check => check.status === 'completed');
    if (done?.conclusion === 'success') return;
    if (done !== undefined) throw new Error(`sandbox ended ${done.conclusion ?? 'without a conclusion'} on pull request ${String(pull.number)}: ${done.html_url}`);
    await sleep(checkPollMs, undefined, { signal });
  }
  throw new Error(`sandbox did not finish on pull request ${String(pull.number)} within ${String(checkWaitMs / 60_000)} minutes`);
}

const playAutoWorker =
  (make: Maker) =>
  async (assignment: Assignment): Promise<void> => {
    const { jira, github, ticket, branch, log } = assignment;
    const issue = await jira.issue(ticket);
    await recordTask(assignment, issue);
    log(`task recorded for ${ticket}`);
    const clone = join(assignment.workdir, 'work');
    const before = join(assignment.workdir, 'before');
    await succeed('git', ['clone', '--quiet', '--branch', branch, '--single-branch', github.cloneUrl, clone], command(assignment.workdir, assignment));
    await succeed('git', ['worktree', 'add', '--quiet', '--detach', before, 'HEAD'], command(clone, assignment));
    const scratch = join(assignment.workdir, 'scratch');
    await mkdir(scratch, { recursive: true });
    const scriptFile = join(scratch, 'repro.sh');
    const change = await make({ clone, script: scriptFile, scratch, assignment }, issue);
    await writeFile(scriptFile, change.script);
    const beforeRun = await execute('bash', [scriptFile], command(before, assignment, scriptTimeoutMs));
    const afterRun = await execute('bash', [scriptFile], command(clone, assignment, scriptTimeoutMs));
    log(`reproduction script exited ${String(beforeRun.code)} before the change and ${String(afterRun.code)} after it`);
    await jira.comment(ticket, planComment(change.plan));
    log('plan posted');
    const head = `${branch}-work/${ticket}`;
    const git = command(clone, assignment);
    await succeed('git', ['switch', '--quiet', '--create', head], git);
    await succeed('git', ['add', '--all'], git);
    await succeed('git', ['-c', 'user.name=AutoWorker end-to-end driver', '-c', 'user.email=e2e-driver@users.noreply.github.com', 'commit', '--quiet', '--message', `${ticket} ${issue.fields.summary}`], git);
    await succeed('git', ['push', '--quiet', 'origin', `HEAD:refs/heads/${head}`], { ...git, env: { ...git.env, ...github.pushEnvironment } });
    const opened = await github.openDraft({ head, base: branch, title: `${ticket} ${issue.fields.summary}`, body: `Resolves ${ticket}: ${jira.browse(ticket)}\n\n${change.plan.trim()}` });
    log(`draft pull request ${opened.html_url}`);
    await jira.comment(ticket, evidenceComment({ script: change.script, before: beforeRun, after: afterRun }));
    log('evidence posted');
    await github.markReady(opened);
    await waitForSandbox(github, opened, assignment.signal);
    const merged = await github.merge(await github.pull(opened.number));
    await github.deleteBranch(head);
    log(`merged as ${merged}`);
    await jira.comment(ticket, `Merged [pull request ${String(opened.number)}|${opened.html_url}] into ${branch} as [${merged.slice(0, 7)}|${github.commitLink(merged)}].`);
  };

export const driverNames = ['none', 'throwaway', 'identity'] as const;

export type DriverName = (typeof driverNames)[number];

export const drivers: Readonly<Record<DriverName, (assignment: Assignment) => Promise<void>>> = {
  none: async () => {},
  throwaway: playAutoWorker(codex),
  identity: playAutoWorker(identity),
};
