import { z } from 'zod';
import { runBridge } from '../../features/bridge/job.ts';
import { attemptId } from '../../features/bridge/protocol.ts';
import { reproduce } from '../../features/jobs/reproduce.ts';
import { accounts, layout, prepareWorkspace, pushStep, readJobEnvironment, setUp } from '../../features/jobs/workspace.ts';

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
    say(`workspace ready at ${ready.commit} on ${ready.branch}${ready.merging === null ? '' : `, merging ${ready.merging}`}`);
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
      {
        beforeTurn: async () => {
          const setup = await setUp(env);
          if (setup !== null) say(`before the turn, the setup command ${setup.ended}`);
          return setup?.baseline ?? null;
        },
        afterTurn: async (_turn, baseline) => {
          if (env.AFTER_TURN === 'reproduce') {
            const reproduction = await reproduce(env, { base: env.BASE_COMMIT, change: env.START_COMMIT, setup: env.SETUP_COMMAND });
            say(reproduction.state === 'ran' ? `reproduced on ${env.BASE_COMMIT} and ${env.START_COMMIT}` : `reproduced nothing: ${reproduction.reason}`);
            return { lines: [{ kind: 'reproduced', reproduction }], declined: null };
          }
          const pushed = await pushStep(env, `AutoWorker attempt ${env.ATTEMPT_ID}`, undefined, baseline);
          if ('declined' in pushed) {
            say(`the bridge pushed nothing, because ${pushed.declined}`);
            return { lines: [], declined: pushed.declined };
          }
          if ('unchanged' in pushed) {
            say(`the step changed nothing, so the bridge pushed nothing past ${pushed.unchanged}`);
            return { lines: [], declined: null };
          }
          say(`pushed ${pushed.pushed} to ${env.ATTEMPT_BRANCH}`);
          return { lines: [{ kind: 'pushed', commit: pushed.pushed, branch: env.ATTEMPT_BRANCH }], declined: null };
        },
      },
      say,
    );
    if (ending.code !== 0) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`Attempt ${env.ATTEMPT_ID} stopped. ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
