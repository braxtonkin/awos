import { z } from 'zod';
import { actionKinds, owe, ticket, type Owe, type OwedKinds } from '../../shared/actions.ts';
import type { AgentSteps, Change, Earlier, History, Reply, Settled, StepInput, Verdicted, Workspace } from '../../shared/agent-step.ts';
import { behaviorOf, evidenceText, type Reproduction } from '../../shared/reproduction.ts';
import { review, type Review } from '../../shared/review.ts';
import { demandsChange, type Demanding, type FailedCheck, type ReworkObligation, type SendBack } from '../../shared/rework.ts';
import type { Instruction } from '../../shared/workflow.ts';
import { landStep, redCheckSentBack } from './land.ts';
import { workflow } from './workflow.ts';

type Kind = OwedKinds<typeof workflow>;

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

const sinceLastPass = (earlier: readonly Earlier[]): readonly Earlier[] => earlier.slice(earlier.findLastIndex(entry => entry.step === 'implement' && entry.verdict === 'pass') + 1);

const reportOf = ({ evidence, output }: Earlier): string => evidenceText(evidence) ?? textOf(output) ?? JSON.stringify(output);

function lastFailure(earlier: readonly Earlier[], step: string, verdict: Earlier['verdict']): string | null {
  const last = sinceLastPass(earlier).findLast(entry => entry.step === step);
  return last?.verdict === verdict ? ['Your last attempt at this step failed.', reportOf(last)].join('\n\n') : null;
}

const workspace = ({ step }: History): Workspace => ({ setup: step === 'implement' || step === 'verify' });

function sentBack(sender: Earlier): SendBack {
  if (sender.step === landStep && sender.verdict === 'conflict') return { kind: 'conflict' };
  if (sender.step === landStep && sender.verdict === 'red_check') return redCheckSentBack(sender.output);
  if (sender.step === landStep && sender.verdict === 'changes_requested') return { kind: 'review', review: reportOf(sender) };
  if (sender.step === 'verify' && sender.verdict === 'behavior_fail') return { kind: 'behavior', evidence: reportOf(sender) };
  throw new Error(`Code change never sends a task back from ${sender.step} with ${sender.verdict}.`);
}

const fenced = (text: string): string => `\`\`\`\n${text.trim()}\n\`\`\``;

function checkLine(check: FailedCheck): string {
  switch (check.kind) {
    case 'logged':
      return [`The check \`${check.name}\` ended ${check.conclusion}${check.step === null ? '' : ` at the step \`${check.step}\``}. The last lines of its log:`, fenced(check.log)].join('\n\n');
    case 'described':
      return `The check \`${check.name}\` ended ${check.conclusion}${check.description === null ? '' : `, and says: ${check.description}`}${check.url === null ? '' : `. Its details are at ${check.url}`}.`;
    case 'unread':
      return `The check \`${check.name}\` failed, and AutoWorker could not read its log, because ${check.why}.`;
  }
}

function sentBackFor(obligation: ReworkObligation): string | null {
  switch (obligation.kind) {
    case 'conflict':
      return [
        'Land sent the task back, because the pull request conflicts with its base branch.',
        `AutoWorker started merging \`${obligation.head}\`, the head of \`${obligation.branch}\` when this attempt started, into this branch before your turn, and left the merge uncommitted. Finish that merge first, as your instructions say.`,
      ].join('\n\n');
    case 'check':
      return [`Land sent the task back, because checks failed on \`${obligation.head}\`, the head of the pull request. Fix what made each one fail.`, ...obligation.checks.map(checkLine)].join('\n\n');
    case 'behavior':
      return ["Verify sent the task back, because it found the behavior still wrong. Fix what its evidence shows.", obligation.evidence].join('\n\n');
    case 'review':
      return ['Land sent the task back, because a review asked for changes. Make them.', obligation.review].join('\n\n');
    case 'note':
      return null;
  }
}

function input({ step, ticket: { key, title, description }, earlier, obligation }: StepInput): string {
  const named = description === null ? `Ticket ${key}: ${title}` : `Ticket ${key}: ${title}\n\n${description.trim()}`;
  switch (step) {
    case 'specify':
      return named;
    case 'implement':
      return [named, `Plan:\n\n${planOf(earlier)}`, obligation === null ? null : sentBackFor(obligation), lastFailure(earlier, 'implement', 'fail')].filter(part => part !== null).join('\n\n');
    case 'verify':
      return [named, `Plan:\n\n${planOf(earlier)}`, lastFailure(earlier, 'verify', 'environment_fail')].filter(part => part !== null).join('\n\n');
    default:
      throw new Error(`Code change has no agent step ${step}.`);
  }
}

function settleVerify(output: unknown, reproduced: Reproduction | null): Settled {
  const behavior = reproduced === null ? null : behaviorOf(reproduced);
  const judged = typeof output === 'object' && output !== null && !Array.isArray(output) ? { ...output, behavior } : output;
  return { output: judged, evidence: reproduced, observed: null };
}

const madeNoChange = "Implement made no change: the attempt pushed no commit, and it did not start from a lost attempt's push. Verify can only compare a change with the base, so the attempt failed.";

const noChange = 'The agent made no change.';

const failed = (summary: string, body: string): Review => ({ outcome: 'blocked', summary, blocks: [{ kind: 'text', title: null, body }] });

function askedFor(obligation: Demanding): string {
  switch (obligation.kind) {
    case 'check':
      return `the task came back to fix the failed ${obligation.checks.length === 1 ? 'check' : 'checks'} ${obligation.checks.map(check => `\`${check.name}\``).join(', ')}`;
    case 'behavior':
      return 'the task came back to fix the behavior Verify found still wrong';
    case 'review':
      return 'the task came back to make the changes a review asked for';
  }
}

const quoteLimit = 300;

function lastWords(output: unknown): string {
  const words = output === null ? null : (textOf(output) ?? review.safeParse(output).data?.summary ?? (typeof output === 'string' ? output : JSON.stringify(output)));
  const line = (words ?? '').replace(/\s+/g, ' ').trim();
  if (line === '') return 'It ended without a final message.';
  const quoted = line.length <= quoteLimit ? line : `${line.slice(0, quoteLimit)}...`;
  return /[.!?]$/.test(quoted) ? `Its last message said: "${quoted}"` : `Its last message said: "${quoted}".`;
}

const endsRework = (asked: string, said: string): Instruction =>
  `Implement pushed nothing, though ${asked}. ${said} Running it again with the same input would push nothing again, so read its attempt on this page, then press Retry with a note that says what to change, and Implement gets your note.`;

const asksAPerson = (output: unknown): boolean => review.safeParse(output).data?.outcome === 'needs_input';

function settleImplement(output: unknown, change: Change, obligation: ReworkObligation | null): Settled {
  if (change.declined !== null) return { output: failed('AutoWorker pushed nothing.', `AutoWorker pushed nothing, because ${change.declined}.`), evidence: null, observed: 'fail' };
  if (change.pushed !== null || change.carried !== null || asksAPerson(output)) return { output, evidence: null, observed: null };
  if (obligation === null || !demandsChange(obligation)) return { output: failed(noChange, madeNoChange), evidence: null, observed: 'fail' };
  const asked = askedFor(obligation);
  const said = lastWords(output);
  return { output: failed(noChange, `Implement pushed nothing, though ${asked}. ${said}`), evidence: null, observed: 'fail', ends: endsRework(asked, said) };
}

function settle({ step, output, change, reproduction: reproduced, obligation }: Reply): Settled {
  switch (step) {
    case 'specify': {
      const plan = textOf(output);
      return { output, evidence: plan === null ? null : { plan }, observed: null };
    }
    case 'implement':
      return settleImplement(output, change, obligation);
    case 'verify':
      return settleVerify(output, reproduced);
    default:
      throw new Error(`Code change has no agent step ${step}.`);
  }
}

const isTicket = (key: string): boolean => ticket.safeParse(key).success;

const comment = (key: string, text: string, linkPullRequest: boolean): readonly Owe<Kind>[] =>
  isTicket(key) ? [owe(actionKinds.ticketComment, { ticket: key, text, linkPullRequest })] : [];

const deletions = ({ repository, branches }: Verdicted): readonly Owe<Kind>[] => branches.map(branch => owe(actionKinds.branchDelete, { repository: repository.github, branch }));

function implemented(verdicted: Verdicted): readonly Owe<Kind>[] {
  const { ticket: named, repository, taskBranch, attempt, pullRequest, output } = verdicted;
  const head = attempt.lastPushed ?? taskBranch.head;
  if (head === null) return deletions(verdicted);
  const advanced = head === taskBranch.head ? [] : [owe(actionKinds.branchAdvance, { repository: repository.github, branch: taskBranch.name, from: taskBranch.head, to: head })];
  const opened = pullRequest.kind !== 'none'
    ? []
    : [owe(actionKinds.prOpenDraft, { repository: repository.github, head: taskBranch.name, base: repository.branch, title: `${named.key}: ${named.title}`, body: textOf(output) ?? named.title })];
  return [...advanced, ...opened, ...comment(named.key, `AutoWorker pushed ${head} to its draft pull request.`, true), ...deletions(verdicted)];
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
      const onPull = verdict === 'pass' && text !== null && verdicted.pullRequest.kind === 'opened' ? [owe(actionKinds.prEvidence, { repository: verdicted.repository.github, number: verdicted.pullRequest.number, evidence: text })] : [];
      return [...(text === null ? [] : comment(named.key, `AutoWorker's evidence:\n\n${text}`, true)), ...onPull, ...(verdict === 'pass' ? deletions(verdicted) : [])];
    }
    default:
      throw new Error(`Code change has no agent step ${step}.`);
  }
}

export const agentSteps: AgentSteps<Kind> = { workspace, sentBack, input, settle, owes };
