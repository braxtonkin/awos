import { prepareWorkspace, readJobEnvironment } from '../../features/jobs/workspace.ts';

const env = readJobEnvironment(process.env);
if ('problems' in env) {
  process.stderr.write(`The attempt did not start, because its Secret is missing a key or holds a wrong value.\n${env.problems.join('\n')}\n`);
  process.exitCode = 1;
} else {
  try {
    const ready = await prepareWorkspace(env);
    process.stdout.write(`workspace ready at ${ready.commit} on ${ready.branch}\n`);
  } catch (error) {
    process.stderr.write(`The workspace of attempt ${env.ATTEMPT_ID} was not set up. ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
