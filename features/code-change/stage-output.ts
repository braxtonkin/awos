import { z } from 'zod';
import { actionKinds, owe, ticket, type Owe, type OwedKinds } from '../../shared/actions.ts';
import type { AgentSteps, BaseMerge, Change, Earlier, History, Reply, Settled, StepInput, Verdicted, Workspace } from '../../shared/agent-step.ts';
import { behaviorOf, evidenceText, type Reproduction } from '../../shared/reproduction.ts';
import { review, type Review } from '../../shared/review.ts';
import { isConflictSendBack, landStep } from './land.ts';
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

const textOrJson = (output: unknown): string => textOf(output) ?? JSON.stringify(output);

function cameBack(earlier: readonly Earlier[]): string | null {
  const after = sinceLastPass(earlier).findLast(entry => entry.step !== 'specify' && entry.step !== 'implement' && entry.verdict !== 'pass');
  if (after === undefined) return null;
  return [`The task came back from ${after.step} with ${after.verdict}.`, evidenceText(after.evidence) ?? textOrJson(after.output)].join('\n\n');
}

function lastFailure(earlier: readonly Earlier[]): string | null {
  const last = sinceLastPass(earlier).findLast(entry => entry.step === 'implement');
  return last?.verdict === 'fail' ? ['Your last attempt at this step failed.', textOrJson(last.output)].join('\n\n') : null;
}

const workspace = ({ step, earlier }: History): Workspace => ({
  setup: step === 'implement',
  mergesBase: step === 'implement' && sinceLastPass(earlier).some(entry => entry.step === landStep && entry.verdict === 'red_check' && isConflictSendBack(entry.output)),
});

const mergeFirst = ({ branch, head }: BaseMerge): string =>
  `AutoWorker started merging \`${head}\`, the head of \`${branch}\` when this attempt started, into this branch before your turn, and left the merge uncommitted. Finish that merge first, as your instructions say.`;

function input({ step, ticket: { key, title, description }, earlier, merge }: StepInput): string {
  const named = description === null ? `Ticket ${key}: ${title}` : `Ticket ${key}: ${title}\n\n${description.trim()}`;
  switch (step) {
    case 'specify':
      return named;
    case 'implement':
      return [named, `Plan:\n\n${planOf(earlier)}`, cameBack(earlier), merge === null ? null : mergeFirst(merge), lastFailure(earlier)].filter(part => part !== null).join('\n\n');
    case 'verify':
      return [named, `Plan:\n\n${planOf(earlier)}`].join('\n\n');
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

const failed = (summary: string, body: string): Review => ({ outcome: 'blocked', summary, blocks: [{ kind: 'text', title: null, body }] });

function settleImplement(output: unknown, change: Change): Settled {
  if (change.declined !== null) return { output: failed('AutoWorker pushed nothing.', `AutoWorker pushed nothing, because ${change.declined}.`), evidence: null, observed: 'fail' };
  const changed = change.pushed !== null || change.carried !== null;
  return changed ? { output, evidence: null, observed: null } : { output: failed('The agent made no change.', madeNoChange), evidence: null, observed: 'fail' };
}

function settle({ step, output, change, reproduction: reproduced }: Reply): Settled {
  switch (step) {
    case 'specify': {
      const plan = textOf(output);
      return { output, evidence: plan === null ? null : { plan }, observed: null };
    }
    case 'implement':
      return settleImplement(output, change);
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

export const agentSteps: AgentSteps<Kind> = { workspace, input, settle, owes };
