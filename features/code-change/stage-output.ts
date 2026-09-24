import { z } from 'zod';
import { actionKinds, owe, ticket, type Owe, type OwedKinds } from '../../shared/actions.ts';
import type { AgentSteps, Earlier, Evidence, Ran, Reply, Settled, StepInput, Verdicted } from '../../shared/agent-step.ts';
import { review } from '../../shared/review.ts';
import { workflow } from './workflow.ts';

type Kind = OwedKinds<typeof workflow>;

export const reproduction = {
  script: '/tmp/autoworker-reproduce.sh',
  show: 'cat /tmp/autoworker-reproduce.sh',
  before: 'cd /tmp/autoworker-base && sh /tmp/autoworker-reproduce.sh',
  after: 'cd /workspace && sh /tmp/autoworker-reproduce.sh',
} as const;

const reproductionEvidence = z.object({
  script: z.string(),
  before: z.object({ command: z.string(), exitCode: z.int().nullable(), output: z.string() }),
  after: z.object({ command: z.string(), exitCode: z.int().nullable(), output: z.string() }),
});

const planEvidence = z.object({ plan: z.string().min(1) });

const textOf = (output: unknown): string | null => {
  const parsed = review.safeParse(output);
  if (!parsed.success) return null;
  const texts = parsed.data.blocks.flatMap(block => (block.kind === 'text' ? [block.body.trim()] : [])).filter(text => text !== '');
  return texts.length === 0 ? null : texts.join('\n\n');
};

const latest = (earlier: readonly Earlier[], step: string, verdict?: Earlier['verdict']): Earlier | undefined =>
  earlier.findLast(entry => entry.step === step && (verdict === undefined || entry.verdict === verdict));

const planOf = (earlier: readonly Earlier[]): string => {
  const plan = planEvidence.safeParse(latest(earlier, 'specify', 'pass')?.evidence);
  return plan.success ? plan.data.plan : 'No plan was recorded.';
};

const shownLimit = 4000;

const tokenShapes = /\b(?:gh[pousr]_\w+|github_pat_\w+|ATATT[\w=-]+|eyJ[\w-]+\.[\w.-]+)/g;

const shown = (text: string): string => {
  const redacted = text.trim().replace(tokenShapes, '[redacted]');
  return redacted.length <= shownLimit ? redacted : `${redacted.slice(0, shownLimit)}\n[cut after ${String(shownLimit)} characters]`;
};

const ranText = (what: string, ran: z.infer<typeof reproductionEvidence>['before']): string =>
  `${what}: \`${ran.command}\` exited ${ran.exitCode === null ? 'without a code' : String(ran.exitCode)}.\n\n\`\`\`\n${shown(ran.output)}\n\`\`\``;

const evidenceText = (evidence: Evidence | null): string | null => {
  const parsed = reproductionEvidence.safeParse(evidence);
  if (!parsed.success) return null;
  return [`Reproduction script:\n\n\`\`\`sh\n${shown(parsed.data.script)}\n\`\`\``, ranText('On the base commit', parsed.data.before), ranText('On the change', parsed.data.after)].join('\n\n');
};

function cameBack(earlier: readonly Earlier[]): string | null {
  const lastImplement = earlier.findLastIndex(entry => entry.step === 'implement');
  const after = earlier.slice(lastImplement + 1).findLast(entry => entry.step !== 'specify' && entry.step !== 'implement' && entry.verdict !== 'pass');
  if (after === undefined || lastImplement < 0) return null;
  const evidence = evidenceText(after.evidence);
  return [`The task came back from ${after.step} with ${after.verdict}.`, evidence ?? textOf(after.output) ?? JSON.stringify(after.output)].join('\n\n');
}

function input({ step, ticket: { key, title, description }, base, earlier }: StepInput): string {
  const named = description === null ? `Ticket ${key}: ${title}` : `Ticket ${key}: ${title}\n\n${description.trim()}`;
  switch (step) {
    case 'specify':
      return named;
    case 'implement': {
      const back = cameBack(earlier);
      return [named, `Plan:\n\n${planOf(earlier)}`, ...(back === null ? [] : [back])].join('\n\n');
    }
    case 'verify':
      return [named, `Plan:\n\n${planOf(earlier)}`, `Base commit: ${base ?? 'unknown'}`].join('\n\n');
    default:
      throw new Error(`Code change has no agent step ${step}.`);
  }
}

const wrapped = /^(?:\S*\/)?(?:ba)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/;

const unwrapped = (command: string): string => wrapped.exec(command.trim())?.[2] ?? command.trim();

const lastRun = (commands: readonly Ran[], text: string): number => commands.findLastIndex(ran => unwrapped(ran.command) === text);

const behaviorOf = (before: Ran, after: Ran): 'fixed' | 'still_wrong' | null => {
  if (before.exitCode === null || after.exitCode === null || before.exitCode === 0) return null;
  return after.exitCode === 0 ? 'fixed' : 'still_wrong';
};

type Runs = { readonly script: Ran; readonly before: Ran; readonly after: Ran };

function runsOf(commands: readonly Ran[]): Runs | undefined {
  const at = { script: lastRun(commands, reproduction.show), before: lastRun(commands, reproduction.before), after: lastRun(commands, reproduction.after) };
  const [script, before, after] = [commands[at.script], commands[at.before], commands[at.after]];
  if (script === undefined || before === undefined || after === undefined || !(at.script < at.before && at.before < at.after)) return undefined;
  return { script, before, after };
}

function settleVerify(output: unknown, commands: readonly Ran[]): Settled {
  const runs = runsOf(commands);
  const evidence =
    runs === undefined
      ? null
      : {
          script: runs.script.output,
          before: { command: runs.before.command, exitCode: runs.before.exitCode, output: runs.before.output },
          after: { command: runs.after.command, exitCode: runs.after.exitCode, output: runs.after.output },
        };
  const behavior = runs === undefined ? null : behaviorOf(runs.before, runs.after);
  const judged = typeof output === 'object' && output !== null && !Array.isArray(output) ? { ...output, behavior } : output;
  return { output: judged, evidence };
}

function settle({ step, output, commands }: Reply): Settled {
  switch (step) {
    case 'specify': {
      const plan = textOf(output);
      return { output, evidence: plan === null ? null : { plan } };
    }
    case 'implement':
      return { output, evidence: null };
    case 'verify':
      return settleVerify(output, commands);
    default:
      throw new Error(`Code change has no agent step ${step}.`);
  }
}

const isTicket = (key: string): boolean => ticket.safeParse(key).success;

const comment = (key: string, text: string, linkPullRequest: boolean): readonly Owe<Kind>[] =>
  isTicket(key) ? [owe(actionKinds.ticketComment, { ticket: key, text, linkPullRequest })] : [];

const deletions = ({ repository, branches }: Verdicted): readonly Owe<Kind>[] => branches.map(branch => owe(actionKinds.branchDelete, { repository: repository.github, branch }));

function implemented(verdicted: Verdicted): readonly Owe<Kind>[] {
  const { ticket: named, repository, taskBranch, attempt, pullRequestOwed, output } = verdicted;
  const head = attempt.lastPushed ?? taskBranch.head;
  if (head === null) return deletions(verdicted);
  const advanced = head === taskBranch.head ? [] : [owe(actionKinds.branchAdvance, { repository: repository.github, branch: taskBranch.name, from: taskBranch.head, to: head })];
  const opened = pullRequestOwed
    ? []
    : [owe(actionKinds.prOpenDraft, { repository: repository.github, head: taskBranch.name, base: repository.branch, title: `${named.key}: ${named.title}`, body: textOf(output) ?? named.title })];
  return [...advanced, ...opened, ...comment(named.key, 'AutoWorker pushed the change to its draft pull request.', true), ...deletions(verdicted)];
}

const ended = ({ ends, endStatus, startStatus, ticket: named }: Verdicted): readonly Owe<Kind>[] =>
  ends && endStatus !== null && isTicket(named.key) ? [owe(actionKinds.ticketTransition, { ticket: named.key, status: endStatus, from: startStatus })] : [];

function owes(verdicted: Verdicted): readonly Owe<Kind>[] {
  return [...stepOwes(verdicted), ...ended(verdicted)];
}

function stepOwes(verdicted: Verdicted): readonly Owe<Kind>[] {
  const { step, verdict, ticket: named, evidence } = verdicted;
  switch (step) {
    case 'specify': {
      if (verdict !== 'pass') return [];
      const plan = planEvidence.safeParse(evidence);
      const moved =
        verdicted.firstPass && verdicted.startStatus !== null && isTicket(named.key) ? [owe(actionKinds.ticketTransition, { ticket: named.key, status: verdicted.startStatus, from: null })] : [];
      return [...(plan.success ? comment(named.key, `AutoWorker's plan:\n\n${plan.data.plan}`, false) : []), ...moved, ...deletions(verdicted)];
    }
    case 'implement':
      return verdict === 'pass' ? implemented(verdicted) : [];
    case 'verify': {
      const text = evidenceText(evidence);
      return [...(text === null ? [] : comment(named.key, `AutoWorker's evidence:\n\n${text}`, true)), ...(verdict === 'pass' ? deletions(verdicted) : [])];
    }
    default:
      throw new Error(`Code change has no agent step ${step}.`);
  }
}

export const agentSteps: AgentSteps<Kind> = { input, settle, owes };
