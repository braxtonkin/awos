import type { WaitingOn } from '../../shared/db/types.ts';
import type { Failure, Instruction, StepKind, StepVerdict, Workflow } from '../../shared/workflow.ts';
import { caps } from './claim.ts';

type Counts = Readonly<Record<string, number>>;

type Task = {
  readonly key: string;
  readonly step: string;
  readonly retries: number;
  readonly inputWaits: number;
  readonly counts: Counts;
  readonly approved: readonly string[];
  readonly gates: readonly string[];
  readonly end: string;
  readonly ignoreLaterReviews: boolean;
  readonly hasRepository: boolean;
};

type Standing =
  | { readonly state: 'ready' | 'done' }
  | { readonly state: 'stopped'; readonly review: string | null }
  | { readonly state: 'waiting'; readonly on: 'retry' | 'outside_approval'; readonly reason: Instruction }
  | { readonly state: 'waiting'; readonly on: 'approval' | 'answer'; readonly reason: Instruction; readonly review: string };

export type Next = Omit<Task, 'key' | 'gates' | 'end' | 'ignoreLaterReviews' | 'hasRepository'> & { readonly standing: Standing };

type Charged = Extract<Failure, { readonly counter: string }>;

const titled = (step: string): string => `${step.charAt(0).toUpperCase()}${step.slice(1)}`;

const failedTooOften = (step: string): Instruction =>
  `${titled(step)} failed ${String(caps.stageRetries + 1)} times in a row. Read its attempts on this page, fix what stopped them, then press Retry to run it again.`;

const gatesFirst = (step: string): Instruction =>
  `${titled(step)} owes an action that cannot be undone, and a gate before it was never approved, so AutoWorker holds it. Stop this task and report it, because only a fault lets a task pass a gate without Approve.`;

const approveOrSendBack = (step: string, next: string): Instruction =>
  `Approve ${titled(step)} to go on to ${titled(next)}, or send it back with a note to run ${titled(step)} again.`;

const answerAndApprove = (step: string): Instruction =>
  `Answer the question ${titled(step)} asked, then press Approve to run it again, or send it back with a note.`;

const after = (workflow: Workflow, name: string): string | undefined => workflow.steps[workflow.steps.findIndex(kind => kind.name === name) + 1]?.name;

const positionOf = (workflow: Workflow, name: string): number => workflow.steps.findIndex(kind => kind.name === name);

const charges = (kind: StepKind, which: Charged['kind']): readonly string[] =>
  Object.values(kind.failures).flatMap(failure => (failure.kind === which ? [failure.counter] : []));

const countOf = (counts: Counts, counter: string): number => counts[counter] ?? 0;

const withCount = (counts: Counts, counter: string, value: number): Counts => ({ ...counts, [counter]: value });

const without = (counts: Counts, counters: readonly string[]): Counts => Object.fromEntries(Object.entries(counts).filter(([counter]) => !counters.includes(counter)));

const kept = (task: Task): Next => ({ step: task.step, retries: task.retries, inputWaits: task.inputWaits, counts: task.counts, approved: task.approved, standing: { state: 'ready' } });

const park = (next: Next, reason: Instruction): Next => ({ ...next, standing: { state: 'waiting', on: 'retry', reason } });

const gateWait = (task: Task, next: string, review: string): Standing => ({ state: 'waiting', on: 'approval', reason: approveOrSendBack(task.step, next), review });

function passed(workflow: Workflow, task: Task, kind: StepKind, attempt: string): Next {
  const base: Next = { ...kept(task), counts: without(task.counts, [...charges(kind, 'return'), ...charges(kind, 'rerun')]), retries: 0, inputWaits: 0 };
  const next = after(workflow, kind.name);
  if (next === undefined || kind.name === task.end) return { ...base, standing: { state: 'done' } };
  if (task.gates.includes(kind.name) && !task.approved.includes(kind.name)) return { ...base, standing: gateWait(task, next, attempt) };
  return { ...base, step: next };
}

function failed(task: Task, kind: StepKind): Next {
  return task.retries >= caps.stageRetries ? park(kept(task), failedTooOften(kind.name)) : { ...kept(task), retries: task.retries + 1 };
}

function sentBack(workflow: Workflow, task: Task, kind: StepKind, to: string): Next {
  return {
    ...kept(task),
    step: to,
    approved: task.approved.filter(gate => positionOf(workflow, gate) < positionOf(workflow, to)),
    counts: without(task.counts, charges(kind, 'rerun')),
    retries: 0,
    inputWaits: 0,
  };
}

function judged(workflow: Workflow, task: Task, kind: StepKind, failure: Failure, attempt: string): Next {
  switch (failure.kind) {
    case 'fail':
      return failed(task, kind);
    case 'ask':
      return task.inputWaits >= caps.inputWaits
        ? failed(task, kind)
        : { ...kept(task), inputWaits: task.inputWaits + 1, standing: { state: 'waiting', on: 'answer', reason: answerAndApprove(kind.name), review: attempt } };
    case 'return': {
      const rounds = countOf(task.counts, failure.counter) + 1;
      return rounds >= failure.cap
        ? park({ ...kept(task), counts: withCount(task.counts, failure.counter, rounds) }, failure.parks)
        : { ...sentBack(workflow, task, kind, failure.to), counts: withCount(without(task.counts, charges(kind, 'rerun')), failure.counter, rounds) };
    }
    case 'rerun': {
      const reruns = countOf(task.counts, failure.counter);
      return reruns >= failure.cap ? park(kept(task), failure.parks) : { ...kept(task), counts: withCount(task.counts, failure.counter, reruns + 1) };
    }
    case 'review': {
      const reviews = countOf(task.counts, failure.counter);
      if (reviews < failure.cap) {
        const back = sentBack(workflow, task, kind, failure.to);
        return { ...back, counts: withCount(without(back.counts, charges(kind, 'return')), failure.counter, reviews + 1) };
      }
      return task.ignoreLaterReviews ? { ...kept(task), standing: { state: 'waiting', on: 'outside_approval', reason: failure.ignored } } : park(kept(task), failure.parks);
    }
    case 'await':
      return { ...kept(task), standing: { state: 'waiting', on: 'outside_approval', reason: failure.waits } };
  }
}

function versionProblem(workflow: Workflow, task: Task): Instruction | undefined {
  const names = workflow.steps.map(kind => kind.name);
  const end = workflow.steps.find(kind => kind.name === task.end);
  if (end?.canEnd !== true) return `The routine that found task ${task.key} ends at ${titled(task.end)}, where ${workflow.name} cannot end. Stop this task, because it keeps that version, then fix the routine so new tasks can run.`;
  const gate = task.gates.find(named => !names.includes(named) || names.indexOf(named) >= names.indexOf(task.end));
  if (gate !== undefined) return `The routine that found task ${task.key} gates ${titled(gate)}, which is not a step of ${workflow.name} before its end. Stop this task, because it keeps that version, then fix the routine so new tasks can run.`;
  if (workflow.steps.some(kind => kind.needsRepository) && !task.hasRepository) {
    return `Task ${task.key} has no repository, and ${workflow.name} needs one. Stop this task, then save the routine with a repository so new tasks can run.`;
  }
  return undefined;
}

export function decide(workflow: Workflow, task: Task, verdict: StepVerdict, attempt: string): Next {
  const kind = workflow.steps.find(candidate => candidate.name === task.step);
  if (kind === undefined) return park(kept(task), `Task ${task.key} is at ${titled(task.step)}, which ${workflow.name} no longer has. Stop the task, because AutoWorker cannot run a step its code lacks.`);
  const problem = versionProblem(workflow, task);
  if (problem !== undefined) return park(kept(task), problem);
  if (verdict === 'pass') {
    const ungated = kind.owes.some(owed => owed.irreversible) && !task.gates.every(gate => task.approved.includes(gate));
    return ungated ? park({ ...kept(task), retries: 0 }, gatesFirst(kind.name)) : passed(workflow, task, kind, attempt);
  }
  const failure = kind.failures[verdict];
  if (failure === undefined) throw new Error(`The ${kind.name} step of ${workflow.name} declares no verdict ${verdict}.`);
  return judged(workflow, task, kind, failure, attempt);
}

export function waitingOn(standing: Standing): WaitingOn | null {
  if (standing.state === 'waiting') return standing.on;
  return standing.state === 'stopped' && standing.review !== null ? 'approval' : null;
}

export type Held = Task & {
  readonly state: 'ready' | 'waiting' | 'stopped' | 'done';
  readonly waitingOn: WaitingOn | null;
  readonly review: string | null;
};

type Decision = 'stop' | 'retry' | 'approve' | 'record';

type Offer = { readonly kind: 'stop' } | { readonly kind: 'retry' } | { readonly kind: 'send_back' | 'approve' | 'answer'; readonly review: string };

type Refused = 'not-now' | 'stale';

const waitsOnReview = (task: Held): boolean => task.state === 'waiting' && (task.waitingOn === 'approval' || task.waitingOn === 'answer');

export function allows(task: Held, offer: Offer): Decision | Refused {
  switch (offer.kind) {
    case 'stop':
      return task.state === 'ready' || task.state === 'waiting' ? 'stop' : 'not-now';
    case 'retry':
      return task.state === 'ready' || task.state === 'stopped' || (task.state === 'waiting' && task.waitingOn !== 'approval') ? 'retry' : 'not-now';
    case 'send_back':
    case 'approve':
    case 'answer':
      if (!waitsOnReview(task)) return 'not-now';
      if (task.review !== offer.review) return 'stale';
      return offer.kind === 'send_back' ? 'retry' : offer.kind === 'approve' ? 'approve' : 'record';
  }
}

function afterGate(task: Held, workflow: Workflow): string {
  const next = after(workflow, task.step);
  if (next === undefined) throw new Error(`Task ${task.key} waits at a gate on ${task.step}, the last step of ${workflow.name}, which no gate can follow.`);
  return next;
}

function restarted(workflow: Workflow, task: Task): Next {
  const kind = workflow.steps.find(candidate => candidate.name === task.step);
  if (kind === undefined) return kept(task);
  const [to] = Object.values(kind.failures).flatMap(failure => (failure.kind === 'return' && countOf(task.counts, failure.counter) >= failure.cap ? [failure.to] : []));
  return to === undefined ? kept(task) : sentBack(workflow, task, kind, to);
}

export function retried(task: Held, workflow: Workflow): Next {
  if (task.state === 'stopped' && task.waitingOn === 'approval' && task.review !== null) return { ...kept(task), standing: gateWait(task, afterGate(task, workflow), task.review) };
  const reviewCounters = workflow.steps.flatMap(kind => charges(kind, 'review'));
  return { ...restarted(workflow, task), counts: Object.fromEntries(Object.entries(task.counts).filter(([counter]) => reviewCounters.includes(counter))), retries: 0, inputWaits: 0 };
}

export const stopped = (task: Held): Next => ({ ...kept(task), standing: { state: 'stopped', review: task.state === 'waiting' && task.waitingOn === 'approval' ? task.review : null } });

export const lastStepOf = (workflow: Workflow): string => workflow.steps.at(-1)?.name ?? workflow.steps[0].name;

export function approved(task: Held, workflow: Workflow): Next {
  if (task.waitingOn !== 'approval') return { ...kept(task), retries: 0 };
  return { ...kept(task), step: afterGate(task, workflow), approved: [...task.approved, task.step] };
}
