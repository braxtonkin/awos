import type { Database } from '../../shared/db/client.ts';
import type { Loop } from '../../shared/loop.ts';
import type { Instruction } from '../../shared/workflow.ts';
import { abandon, advance } from './advance.ts';
import { claim, claimable, type Start } from './claim.ts';
import { continuation } from './continuation.ts';
import type { RunAsRule } from './run-as.ts';
import { promptFor, stepOf, type Prompt, type StepRunner } from './step-runner.ts';

export type JobRequest = {
  readonly attempt: string;
  readonly taskKey: string;
  readonly number: number;
  readonly step: string;
  readonly image: string | null;
  readonly repository: string;
  readonly startCommit: string;
  readonly attemptToken: string;
  readonly runAs: { readonly id: string; readonly name: string; readonly email: string };
};

export type Launched = { readonly launched: string } | { readonly refused: Instruction };

export type Environment = { readonly started: string } | { readonly parks: Instruction } | { readonly failed: string } | { readonly ended: true };

export type WorkerSettings = {
  readonly everyMs: number;
  readonly startLeaseMs: number;
  readonly runner: StepRunner;
  readonly runAs: RunAsRule;
  readonly branchHead: (actsAs: string, github: string, branch: string) => Promise<string>;
  readonly startEnvironment: (db: Database, attempt: string) => Promise<Environment>;
  readonly issueToken: (db: Database, attempt: string) => Promise<string | undefined>;
  readonly startTurn: (db: Database, attempt: string, prompt: Prompt, now: Date) => Promise<void>;
  readonly launch: (db: Database, request: JobRequest) => Promise<Launched>;
};

const noRepository: Instruction = 'This task has no repository, and its step runs an agent in one. Stop the task, then save the routine with a repository so new tasks can run.';

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function startOf(db: Database, settings: WorkerSettings, task: string, runAs: string): Promise<Start | null> {
  const found = await continuation(db, task);
  switch (found.from) {
    case 'lost':
    case 'task':
      return { commit: found.commit };
    case 'repository':
      return { commit: await settings.branchHead(runAs, found.github, found.branch) };
    case 'nowhere':
      return null;
  }
}

async function launchAttempt(db: Database, settings: WorkerSettings, attempt: string, now: Date): Promise<string> {
  const step = await stepOf(db, settings.runner, attempt);
  if (step.repository === null || step.branch === null || step.start === null) {
    await abandon(db, attempt, noRepository, now);
    return `parked task ${step.key}, which has no repository`;
  }
  const environment = step.kind.startsEnvironment ? await settings.startEnvironment(db, attempt) : null;
  if (environment !== null && 'parks' in environment) {
    await abandon(db, attempt, environment.parks, now);
    return `parked task ${step.key}: ${environment.parks}`;
  }
  if (environment !== null && 'failed' in environment) {
    await advance(db, settings.runner.workflows, attempt, { output: { environment: environment.failed }, observed: step.kind.blocked }, now);
    return `attempt ${attempt} of task ${step.key} ended ${step.kind.blocked}, because ${environment.failed}`;
  }
  if (environment !== null && 'ended' in environment) return `attempt ${attempt} of task ${step.key} ended before its environment started`;
  const prompt = await promptFor(db, step, environment?.started ?? null);
  const token = await settings.issueToken(db, attempt);
  if (token === undefined) return `attempt ${attempt} of task ${step.key} already has its bridge token, so this pass launched nothing`;
  await settings.startTurn(db, attempt, prompt, now);
  const launched = await settings.launch(db, {
    attempt,
    taskKey: step.key,
    number: step.number,
    step: step.kind.name,
    image: step.repository.jobImage,
    repository: step.repository.github,
    startCommit: step.start,
    attemptToken: token,
    runAs: step.runAs,
  });
  if ('refused' in launched) {
    await abandon(db, attempt, launched.refused, now);
    return `parked task ${step.key}: ${launched.refused}`;
  }
  return `launched ${launched.launched} for attempt ${attempt} of task ${step.key} at ${step.kind.name} on ${step.branch} from ${step.start} as ${step.runAs.email}`;
}

async function take(db: Database, settings: WorkerSettings, task: string, now: Date): Promise<string> {
  let runAs: string | null;
  let start: Start | null;
  try {
    runAs = await settings.runAs(db, task);
    start = runAs === null ? null : await startOf(db, settings, task, runAs);
  } catch (error) {
    return `did not claim task ${task}, because who it runs as or where it starts could not be read: ${reason(error)}`;
  }
  const claimed = await claim(db, task, now, settings.startLeaseMs, runAs, start);
  if ('refused' in claimed) return `did not claim task ${task}: ${claimed.refused}${'parked' in claimed && claimed.parked ? ', and parked it' : ''}`;
  try {
    return await launchAttempt(db, settings, claimed.attempt, now);
  } catch (error) {
    return `did not launch attempt ${claimed.attempt} of task ${task}, so its lease lapses and the reaper releases it: ${reason(error)}`;
  }
}

export function worker(settings: WorkerSettings): Loop {
  return {
    name: 'worker',
    everyMs: settings.everyMs,
    pass: async (db, { now }) => {
      const lines: string[] = [];
      for (const task of await claimable(db, settings.runner.workflows, ['agent'])) lines.push(await take(db, settings, task, now));
      return lines;
    },
  };
}
