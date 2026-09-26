import { issueToken, sendCommand } from '../../features/bridge/engine.ts';
import { attemptId } from '../../features/bridge/protocol.ts';
import { loginForJob, type CheckLoopSettings } from '../../features/credentials/check-loop.ts';
import { open } from '../../features/credentials/store.ts';
import { startEnvironment } from '../../features/environments/lifecycle.ts';
import { describe, type Providers } from '../../features/environments/provider.ts';
import { imageFor, jobName, launch, manifests } from '../../features/jobs/launch.ts';
import { connectCluster } from '../../shared/cluster.ts';
import { remoteHead, repositoryUrl } from '../../features/jobs/remote.ts';
import { imageReference, type JobSettings } from '../../features/jobs/settings.ts';
import type { RunAsRule } from '../../features/tasks/run-as.ts';
import type { StepRunner } from '../../features/tasks/step-runner.ts';
import { worker, type Environment, type Launched, type Ready } from '../../features/tasks/worker.ts';
import type { Database } from '../../shared/db/client.ts';
import type { Loop } from '../../shared/loop.ts';
import type { Instruction } from '../../shared/workflow.ts';

export type AttemptSettings = {
  readonly everyMs: number;
  readonly startLeaseMs: number;
  readonly runner: StepRunner;
  readonly runAs: RunAsRule;
  readonly db: Database;
  readonly checks: CheckLoopSettings;
  readonly jobs: JobSettings;
  readonly engineUrl: string;
  readonly gitBaseUrl: string;
  readonly providers: Providers;
  readonly startDeadlineMs: number;
  readonly describeTicket: (key: string, actsAs: string) => Promise<string | null>;
};

const isInstruction = (text: string): text is Instruction => /^[A-Z][\s\S]*\.$/.test(text);

const unexplained: Instruction = 'The engine could not open a login for this attempt. Check the logins of the person it runs as, then press Retry.';

const sentence = (text: string): Instruction => {
  const trimmed = text.trim();
  const said = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}${trimmed.endsWith('.') ? '' : '.'}`;
  return isInstruction(said) ? said : unexplained;
};

async function githubToken(settings: AttemptSettings, owner: string): Promise<{ readonly token: string } | { readonly refused: Instruction }> {
  const opened = await open(settings.db, settings.checks.key, { connector: 'github', owner });
  return 'secret' in opened ? { token: opened.secret } : { refused: sentence(opened.reason) };
}

const environmentOf =
  (settings: AttemptSettings) =>
  async (db: Database, attempt: string): Promise<Environment> => {
    const started = await startEnvironment(db, settings.providers, attempt, { now: () => new Date(), startDeadlineMs: settings.startDeadlineMs });
    switch (started.kind) {
      case 'started':
        return { started: describe(started.environment) };
      case 'unknown-provider':
        return { parks: started.note };
      case 'failed':
        return { failed: started.reason };
      case 'attempt-ended':
        return { ended: true };
    }
  };

export function attempts(settings: AttemptSettings): Loop {
  const cluster = connectCluster(settings.jobs.namespace);
  return worker({
    everyMs: settings.everyMs,
    startLeaseMs: settings.startLeaseMs,
    runner: settings.runner,
    runAs: settings.runAs,
    branchHead: async (actsAs, github, branch) => {
      const token = await githubToken(settings, actsAs);
      return 'refused' in token ? token : { head: await remoteHead(repositoryUrl(settings.gitBaseUrl, github), branch, token.token) };
    },
    startEnvironment: environmentOf(settings),
    describeTicket: settings.describeTicket,
    issueToken: (db, attempt) => issueToken(db, attemptId.parse(attempt)),
    startTurn: async (db, attempt, { prompt, outputSchema }, now) => {
      const sent = await sendCommand(db, attemptId.parse(attempt), { kind: 'turn.start', prompt, outputSchema }, now);
      if (sent === 'ended') throw new Error(`attempt ${attempt} ended before its turn was sent`);
    },
    ready: async (db, runAs): Promise<Ready> => {
      const state = await db.selectFrom('credential').select('credential.state').where('credential.connector', '=', 'codex').where('credential.person_id', '=', runAs).executeTakeFirst();
      if (state !== undefined && state.state === null) return { later: 'its Codex login has not been checked yet' };
      const login = await loginForJob(db, settings.checks, runAs, settings.jobs.deadlineSeconds * 1000);
      if ('refused' in login) return { refused: sentence(login.reason) };
      const token = await githubToken(settings, runAs);
      return 'refused' in token ? token : { ready: true };
    },
    launch: async (db, request): Promise<Launched> => {
      const login = await loginForJob(db, settings.checks, request.runAs.id, settings.jobs.deadlineSeconds * 1000);
      if ('refused' in login) return { refused: sentence(login.reason) };
      const token = await githubToken(settings, request.runAs.id);
      if ('refused' in token) return token;
      const image = imageFor(settings.jobs, request.image === null ? null : imageReference.parse(request.image));
      await launch(
        cluster,
        manifests(
          {
            attempt: request.attempt,
            taskKey: request.taskKey,
            branch: request.branch,
            step: request.step,
            image,
            repositoryUrl: repositoryUrl(settings.gitBaseUrl, request.repository),
            startCommit: request.startCommit,
            plan: request.plan,
            attemptToken: request.attemptToken,
            engineUrl: settings.engineUrl,
            runAs: { name: request.runAs.name, email: request.runAs.email, githubToken: token.token, codexLogin: login.login },
          },
          settings.jobs,
        ),
      );
      return { launched: jobName(request.attempt) };
    },
  });
}
