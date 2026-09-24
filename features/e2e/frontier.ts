import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Database } from '../../shared/db/client.ts';
import type { Entry } from './catalog.ts';
import type { GitHub, Pull } from './github.ts';
import type { Comment, Jira } from './jira.ts';
import { PayloadRejected } from './payload.ts';
import { baseEnvironment, execute, type Exit } from './process.ts';

export type Run = {
  readonly branch: string;
  readonly ticket: string;
  readonly label: string;
  readonly accountId: string;
  readonly entry: Entry;
  readonly jira: Jira;
  readonly github: GitHub;
  readonly database: Database;
  readonly workdir: string;
  readonly signal: AbortSignal;
};

type Link = { readonly label: string; readonly url: string };

type Outcome =
  | { readonly state: 'pending'; readonly note: string }
  | { readonly state: 'reached'; readonly detail: string; readonly links: readonly Link[] }
  | { readonly state: 'failed'; readonly reason: string };

type Step = { readonly name: string; readonly probe: (run: Run) => Promise<Outcome> };

type Evidence = { readonly script: string; readonly before: Exit; readonly after: Exit };

const pending = (note: string): Outcome => ({ state: 'pending', note });
const failed = (reason: string): Outcome => ({ state: 'failed', reason });
const reached = (detail: string, links: readonly Link[] = []): Outcome => ({ state: 'reached', detail, links });

const planHeading = 'h3. Plan';
const evidenceHeading = 'h3. Evidence';
const shownOutput = 4000;

export const planComment = (plan: string): string => `${planHeading}\n\n${plan.trim()}`;

export const evidenceComment = (evidence: Evidence): string =>
  [
    evidenceHeading,
    'Reproduction script:',
    `{code}\n${evidence.script.trim()}\n{code}`,
    `Before the change, exit ${String(evidence.before.code)}:`,
    `{noformat}\n${evidence.before.output.trim().slice(-shownOutput)}\n{noformat}`,
    `After the change, exit ${String(evidence.after.code)}:`,
    `{noformat}\n${evidence.after.output.trim().slice(-shownOutput)}\n{noformat}`,
  ].join('\n');

const startsWith = (heading: string) => (comment: Comment) => comment.body.trimStart().startsWith(heading);

function readEvidence(body: string): { readonly script: string; readonly before: number; readonly after: number } | undefined {
  const script = /Reproduction script:\s*\{code[^}]*\}([\s\S]*?)\{code\}/.exec(body)?.[1]?.trim();
  const before = /Before the change, exit (\d+):/.exec(body)?.[1];
  const after = /After the change, exit (\d+):/.exec(body)?.[1];
  if (script === undefined || before === undefined || after === undefined) return undefined;
  return { script, before: Number(before), after: Number(after) };
}

async function commentStep(run: Run, heading: string, judge: (comment: Comment) => Outcome): Promise<Outcome> {
  const found = (await run.jira.comments(run.ticket)).find(startsWith(heading));
  return found === undefined ? pending(`no comment starts with ${heading}`) : judge(found);
}

async function onePull(run: Run): Promise<Pull | Outcome> {
  const naming = (await run.github.pulls(run.branch)).filter(pull => pull.title.includes(run.ticket) || (pull.body ?? '').includes(run.ticket));
  const [pull, ...others] = naming;
  if (pull === undefined) return pending(`no pull request into ${run.branch} names ${run.ticket}`);
  if (others.length > 0) return failed(`${String(naming.length)} pull requests into ${run.branch} name ${run.ticket}`);
  return pull;
}

const isPull = (value: Pull | Outcome): value is Pull => 'number' in value;

async function freshClone(run: Run, sha: string): Promise<Outcome> {
  const folder = await mkdtemp(join(run.workdir, 'clone-'));
  const command = { cwd: folder, env: baseEnvironment(folder), timeoutMs: 300_000, signal: run.signal };
  const clone = await execute('git', ['clone', '--quiet', '--branch', run.branch, '--single-branch', run.github.cloneUrl, 'repo'], command);
  if (clone.code !== 0) return pending(`git clone exited ${String(clone.code)}`);
  const repo = { ...command, cwd: join(folder, 'repo') };
  const checkout = await execute('git', ['checkout', '--quiet', sha], repo);
  if (checkout.code !== 0) return failed(`the fresh clone of ${run.branch} has no commit ${sha}`);
  const install = await execute('npm', ['ci', '--no-audit', '--no-fund'], repo);
  if (install.code !== 0) return failed(`npm ci failed on a fresh clone of ${run.branch}: ${install.output.slice(-500)}`);
  const tests = await execute('npm', ['test'], repo);
  if (tests.code !== 0) return failed(`the sandbox's tests failed on a fresh clone of ${run.branch}: ${tests.output.slice(-500)}`);
  const acceptanceFile = `test/acceptance-${run.entry.name}.test.ts`;
  await writeFile(join(repo.cwd, acceptanceFile), run.entry.acceptance);
  const acceptance = await execute('npx', ['vitest', 'run', acceptanceFile], repo);
  if (acceptance.code !== 0) return failed(`the acceptance test of ${run.entry.name} failed on a fresh clone of ${run.branch}: ${acceptance.output.slice(-800)}`);
  return reached(`a fresh clone passes the sandbox's tests and the acceptance test of ${run.entry.name}`);
}

const completedBefore = (time: string | null, limit: string): boolean => time !== null && Date.parse(time) <= Date.parse(limit);

export const steps = [
  {
    name: 'ticket filed',
    probe: async run => {
      const issue = await run.jira.issue(run.ticket);
      if (!issue.fields.labels.includes(run.label)) return failed(`${run.ticket} lacks the label ${run.label}`);
      if (issue.fields.assignee?.accountId !== run.accountId) return failed(`${run.ticket} is not assigned to the token's own account`);
      return reached(`${run.ticket}, labeled ${run.label}`, [{ label: 'ticket', url: run.jira.browse(run.ticket) }]);
    },
  },
  {
    name: 'task recorded',
    probe: async run => {
      const task = await run.database.selectFrom('task').select(['id', 'key']).where('key', '=', run.ticket).executeTakeFirst();
      return task === undefined ? pending(`no task row has the key ${run.ticket}`) : reached(`task ${task.id} has the key ${task.key}`);
    },
  },
  {
    name: 'plan posted',
    probe: run => commentStep(run, planHeading, comment => reached(`comment ${comment.id}`, [{ label: 'plan', url: run.jira.commentLink(run.ticket, comment) }])),
  },
  {
    name: 'draft pull request',
    probe: async run => {
      const pull = await onePull(run);
      if (!isPull(pull)) return pull;
      if (!(await run.github.wasDraft(pull))) return failed(`pull request ${String(pull.number)} was never a draft`);
      return reached(`pull request ${String(pull.number)} from ${pull.head.ref}`, [{ label: 'pull request', url: pull.html_url }]);
    },
  },
  {
    name: 'evidence posted',
    probe: run =>
      commentStep(run, evidenceHeading, comment => {
        const evidence = readEvidence(comment.body);
        if (evidence === undefined) return failed(`comment ${comment.id} lacks the reproduction script or one of its two runs`);
        if (evidence.before === 0) return failed('the reproduction script passed before the change, so it shows no bug');
        if (evidence.after !== 0) return failed(`the reproduction script still fails after the change, exit ${String(evidence.after)}`);
        return reached(`script failed before the change with exit ${String(evidence.before)} and passed after it`, [{ label: 'evidence', url: run.jira.commentLink(run.ticket, comment) }]);
      }),
  },
  {
    name: 'merged',
    probe: async run => {
      const pull = await onePull(run);
      if (!isPull(pull)) return pull;
      if (pull.merged_at === null || pull.merge_commit_sha === null) return pull.state === 'closed' ? failed(`pull request ${String(pull.number)} closed without merging`) : pending(`pull request ${String(pull.number)} is open`);
      const mergedAt = pull.merged_at;
      const onPull = (await run.github.checkRuns(pull.head.sha, 'sandbox')).find(check => check.conclusion === 'success' && completedBefore(check.completed_at, mergedAt));
      if (onPull === undefined) return failed(`pull request ${String(pull.number)} merged before its sandbox check passed`);
      const onBranch = (await run.github.checkRuns(pull.merge_commit_sha, 'sandbox')).find(check => check.status === 'completed');
      if (onBranch === undefined) return pending(`the sandbox run on ${run.branch} after the merge has not finished`);
      if (onBranch.conclusion !== 'success') return failed(`the sandbox run on ${run.branch} after the merge ended ${onBranch.conclusion ?? 'without a conclusion'}`);
      const clone = await freshClone(run, pull.merge_commit_sha);
      if (clone.state !== 'reached') return clone;
      return reached(`pull request ${String(pull.number)} merged as ${pull.merge_commit_sha.slice(0, 7)}, sandbox passed before the merge and on ${run.branch} after it, and ${clone.detail}`, [
        { label: 'merge commit', url: run.github.commitLink(pull.merge_commit_sha) },
        { label: 'pull request CI run', url: onPull.html_url },
        { label: 'run branch CI run', url: onBranch.html_url },
      ]);
    },
  },
] as const satisfies readonly Step[];

type StepName = (typeof steps)[number]['name'];

export type Reached = { readonly name: StepName; readonly at: Date; readonly detail: string; readonly links: readonly Link[] };

export type DriverEnd = { readonly ok: true } | { readonly ok: false; readonly reason: string };

type Stop =
  | { readonly kind: 'complete' }
  | { readonly kind: 'failed'; readonly step: StepName; readonly reason: string }
  | { readonly kind: 'timed out'; readonly step: StepName; readonly note: string }
  | { readonly kind: 'driver failed'; readonly step: StepName; readonly reason: string };

export type Walk = { readonly reached: readonly Reached[]; readonly stop: Stop; readonly busyMs: number };

type Watch = {
  readonly deadline: number;
  readonly pollMs: number;
  readonly driverEnd: () => DriverEnd | undefined;
  readonly onReach: (step: Reached) => void;
};

async function probe(step: Step, run: Run): Promise<Outcome> {
  try {
    return await step.probe(run);
  } catch (error) {
    if (error instanceof PayloadRejected) return failed(error.message);
    return pending(error instanceof Error ? error.message : String(error));
  }
}

export async function walk(run: Run, watch: Watch): Promise<Walk> {
  const found: Reached[] = [];
  let busyMs = 0;
  for (const step of steps) {
    for (;;) {
      const driverBefore = watch.driverEnd();
      const began = performance.now();
      const outcome = await probe(step, run);
      busyMs += performance.now() - began;
      if (outcome.state === 'reached') {
        const entry: Reached = { name: step.name, at: new Date(), detail: outcome.detail, links: outcome.links };
        found.push(entry);
        watch.onReach(entry);
        break;
      }
      if (outcome.state === 'failed') return { reached: found, stop: { kind: 'failed', step: step.name, reason: outcome.reason }, busyMs };
      if (driverBefore?.ok === false) return { reached: found, stop: { kind: 'driver failed', step: step.name, reason: driverBefore.reason }, busyMs };
      const left = watch.deadline - Date.now();
      if (left <= 0) return { reached: found, stop: { kind: 'timed out', step: step.name, note: outcome.note }, busyMs };
      await sleep(Math.min(watch.pollMs, left), undefined, { signal: run.signal });
    }
  }
  return { reached: found, stop: { kind: 'complete' }, busyMs };
}
