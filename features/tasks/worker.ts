import type { Database } from '../../shared/db/client.ts';
import type { Loop } from '../../shared/loop.ts';
import type { Instruction } from '../../shared/workflow.ts';
import { abandon, advance } from './advance.ts';
import { claim, claimable, park, renew, unlaunched, type Start } from './claim.ts';
import { continuation } from './continuation.ts';
import type { RunAsRule } from './run-as.ts';
import { promptFor, stepOf, type Prompt, type StepRunner } from './step-runner.ts';

export type JobRequest = {
  readonly attempt: string;
  readonly taskKey: string;
  readonly branch: string;
  readonly step: string;
  readonly image: string | null;
  readonly repository: string;
  readonly startCommit: string;
  readonly attemptToken: string;
  readonly runAs: { readonly id: string; readonly name: string; readonly email: string };
};

export type Launched = { readonly launched: string } | { readonly refused: Instruction };

export type Ready = { readonly ready: true } | { readonly refused: Instruction } | { readonly later: string };

export type Environment = { readonly started: string } | { readonly parks: Instruction } | { readonly failed: string } | { readonly ended: true };

export type WorkerSettings = {
  readonly everyMs: number;
  readonly startLeaseMs: number;
  readonly runner: StepRunner;
  readonly runAs: RunAsRule;
  readonly branchHead: (actsAs: string, github: string, branch: string) => Promise<{ readonly head: string } | { readonly refused: Instruction }>;
  readonly startEnvironment: (db: Database, attempt: string) => Promise<Environment>;
  readonly issueToken: (db: Database, attempt: string) => Promise<string | undefined>;
  readonly startTurn: (db: Database, attempt: string, prompt: Prompt, now: Date) => Promise<void>;
  readonly ready: (db: Database, runAs: string) => Promise<Ready>;
  readonly describeTicket: (key: string, actsAs: string) => Promise<string | null>;
  readonly launch: (db: Database, request: JobRequest) => Promise<Launched>;
};

const noRepository: Instruction = 'This task has no repository, and its step runs an agent in one. Stop the task, then save the routine with a repository so new tasks can run.';

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function startOf(db: Database, branchHead: WorkerSettings['branchHead'], task: string, runAs: string): Promise<Start | { readonly refused: Instruction } | null> {
  const found = await continuation(db, task);
  switch (found.from) {
    case 'lost':
      return { commit: found.commit, inherited: true };
    case 'task':
      return { commit: found.commit, inherited: false };
    case 'repository': {
      const read = await branchHead(runAs, found.github, found.branch);
      return 'refused' in read ? read : { commit: read.head, inherited: false };
    }
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
  const ready = await settings.ready(db, step.runAs.id);
  if ('refused' in ready) {
    await abandon(db, attempt, ready.refused, now);
    return `parked task ${step.key}: ${ready.refused}`;
  }
  if ('later' in ready) return `attempt ${attempt} of task ${step.key} waits to launch, because ${ready.later}`;
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
  if (environment !== null && (await renew(db, attempt, new Date(), settings.startLeaseMs)) === 'lost') return `attempt ${attempt} of task ${step.key} ended while its environment started`;
  const prompt = await promptFor(db, step, environment?.started ?? null, await settings.describeTicket(step.key, step.runAs.id));
  const token = await settings.issueToken(db, attempt);
  if (token === undefined) return `attempt ${attempt} of task ${step.key} ended before its Job launched, so this pass launched nothing`;
  await settings.startTurn(db, attempt, prompt, now);
  const launched = await settings.launch(db, {
    attempt,
    taskKey: step.key,
    branch: step.branch,
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
  const runAs = await settings.runAs(db, task);
  const start = runAs === null ? null : await startOf(db, settings.branchHead, task, runAs);
  if (start !== null && 'refused' in start) return `parked task ${task} before its claim: ${(await park(db, task, start.refused)) ? start.refused : 'it was no longer ready'}`;
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
      for (const attempt of await unlaunched(db, settings.runner.workflows)) {
        lines.push(await launchAttempt(db, settings, attempt, now).catch((error: unknown) => `did not launch attempt ${attempt}: ${reason(error)}`));
      }
      for (const task of await claimable(db, settings.runner.workflows, ['agent'])) {
        lines.push(await take(db, settings, task, now).catch((error: unknown) => `did not claim task ${task}: ${reason(error)}`));
      }
      return lines;
    },
  };
}
