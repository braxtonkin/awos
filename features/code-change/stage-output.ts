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

const ranText = (what: string, ran: z.infer<typeof reproductionEvidence>['before']): string =>
  `${what}: \`${ran.command}\` exited ${ran.exitCode === null ? 'without a code' : String(ran.exitCode)}.\n\n\`\`\`\n${ran.output.trim()}\n\`\`\``;

const evidenceText = (evidence: Evidence | null): string | null => {
  const parsed = reproductionEvidence.safeParse(evidence);
  if (!parsed.success) return null;
  return [`Reproduction script:\n\n\`\`\`sh\n${parsed.data.script.trim()}\n\`\`\``, ranText('On the base commit', parsed.data.before), ranText('On the change', parsed.data.after)].join('\n\n');
};

function cameBack(earlier: readonly Earlier[]): string | null {
  const lastImplement = earlier.findLastIndex(entry => entry.step === 'implement');
  const after = earlier.slice(lastImplement + 1).findLast(entry => entry.step !== 'specify' && entry.step !== 'implement' && entry.verdict !== 'pass');
  if (after === undefined || lastImplement < 0) return null;
  const evidence = evidenceText(after.evidence);
  return [`The task came back from ${after.step} with ${after.verdict}.`, evidence ?? textOf(after.output) ?? JSON.stringify(after.output)].join('\n\n');
}

function input({ step, ticket: { key, title }, base, earlier }: StepInput): string {
  const named = `Ticket ${key}: ${title}`;
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

const lastRun = (commands: readonly Ran[], text: string): Ran | undefined => commands.findLast(ran => ran.command.includes(text));

const behaviorOf = (before: Ran, after: Ran): 'fixed' | 'still_wrong' | null => {
  if (before.exitCode === null || after.exitCode === null || before.exitCode === 0) return null;
  return after.exitCode === 0 ? 'fixed' : 'still_wrong';
};

function settleVerify(output: unknown, commands: readonly Ran[]): Settled {
  const shown = lastRun(commands, reproduction.show);
  const before = lastRun(commands, reproduction.before);
  const after = lastRun(commands, reproduction.after);
  const evidence =
    shown === undefined || before === undefined || after === undefined
      ? null
      : {
          script: shown.output,
          before: { command: before.command, exitCode: before.exitCode, output: before.output },
          after: { command: after.command, exitCode: after.exitCode, output: after.output },
        };
  const behavior = before === undefined || after === undefined ? null : behaviorOf(before, after);
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

function owes(verdicted: Verdicted): readonly Owe<Kind>[] {
  const { step, verdict, ticket: named, evidence } = verdicted;
  switch (step) {
    case 'specify': {
      if (verdict !== 'pass') return [];
      const plan = planEvidence.safeParse(evidence);
      return [...(plan.success ? comment(named.key, `AutoWorker's plan:\n\n${plan.data.plan}`, false) : []), ...deletions(verdicted)];
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
