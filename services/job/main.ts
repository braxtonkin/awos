import { z } from 'zod';
import { runBridge } from '../../features/bridge/job.ts';
import { attemptId } from '../../features/bridge/protocol.ts';
import { accounts, layout, prepareWorkspace, pushStep, readJobEnvironment } from '../../features/jobs/workspace.ts';

const bridgeSettings = z.object({ ATTEMPT_IMAGE: z.string().min(1).max(500) });

const timing = { heartbeatMs: 5_000, callTimeoutMs: 15_000, retryMs: 500, streamQuietMs: 20_000, stopGraceMs: 5_000 } as const;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const env = readJobEnvironment(process.env);
const tuning = bridgeSettings.safeParse(process.env);
if ('problems' in env) {
  process.stderr.write(`The attempt did not start, because its Secret is missing a key or holds a wrong value.\n${env.problems.join('\n')}\n`);
  process.exitCode = 1;
} else if (!tuning.success) {
  process.stderr.write(`The attempt did not start, because a bridge setting is wrong.\n${z.prettifyError(tuning.error)}\n`);
  process.exitCode = 1;
} else {
  try {
    const ready = await prepareWorkspace(env);
    say(`workspace ready at ${ready.commit} on ${ready.branch}`);
    const { codex } = await accounts();
    const ending = await runBridge(
      {
        engineUrl: new URL(env.ENGINE_URL.endsWith('/') ? env.ENGINE_URL : `${env.ENGINE_URL}/`),
        attempt: attemptId.parse(env.ATTEMPT_ID),
        token: env.ATTEMPT_TOKEN,
        image: tuning.data.ATTEMPT_IMAGE,
        workspace: layout.workspace,
        codexHome: layout.codexHome,
        codexUser: { uid: codex.uid, gid: codex.gid },
        codexCommand: 'codex',
        ...timing,
      },
      async () => {
        const pushed = await pushStep(env, `AutoWorker attempt ${env.ATTEMPT_ID}`, undefined);
        if ('unchanged' in pushed) {
          say(`the step changed nothing, so the bridge pushed nothing past ${pushed.unchanged}`);
          return undefined;
        }
        say(`pushed ${pushed.pushed} to ${env.ATTEMPT_BRANCH}`);
        return { commit: pushed.pushed, branch: env.ATTEMPT_BRANCH };
      },
      say,
    );
    if (ending.code !== 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Attempt ${env.ATTEMPT_ID} stopped. ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
