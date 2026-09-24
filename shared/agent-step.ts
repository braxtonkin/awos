import type { Owe } from './actions.ts';
import type { Verdict } from './db/types.ts';
import type { StepVerdict } from './workflow.ts';

export type Ran = { readonly command: string; readonly cwd: string | null; readonly exitCode: number | null; readonly output: string };

export type Evidence = Readonly<Record<string, unknown>>;

export type Earlier = { readonly step: string; readonly verdict: Verdict; readonly output: unknown; readonly evidence: Evidence | null };

export type Ticket = { readonly key: string; readonly title: string; readonly description: string | null };

export type StepInput = {
  readonly step: string;
  readonly ticket: Ticket;
  readonly base: string | null;
  readonly earlier: readonly Earlier[];
};

export type Reply = { readonly step: string; readonly output: unknown; readonly commands: readonly Ran[] };

export type Settled = { readonly output: unknown; readonly evidence: Evidence | null };

export type Verdicted = {
  readonly step: string;
  readonly verdict: StepVerdict;
  readonly ticket: Ticket;
  readonly repository: { readonly github: string; readonly branch: string };
  readonly taskBranch: { readonly name: string; readonly head: string | null };
  readonly attempt: { readonly branch: string; readonly start: string; readonly lastPushed: string | null };
  readonly branches: readonly string[];
  readonly pullRequestOwed: boolean;
  readonly firstPass: boolean;
  readonly startStatus: string | null;
  readonly output: unknown;
  readonly evidence: Evidence | null;
};

export type AgentSteps<K extends string = string> = {
  readonly input: (given: StepInput) => string;
  readonly settle: (reply: Reply) => Settled;
  readonly owes: (verdicted: Verdicted) => readonly Owe<K>[];
};
