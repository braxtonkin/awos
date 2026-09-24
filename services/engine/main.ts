import { startProblems } from '../../features/tasks/start.ts';
import { connect, databaseUrl } from '../../shared/db/client.ts';
import { workflows } from './workflows.ts';

const db = connect(databaseUrl(process.env), 2);
try {
  const problems = await startProblems(db, workflows);
  if (problems.length > 0) {
    process.stderr.write(`The engine did not start, because its routines and tasks do not fit the workflows it was given.\n${problems.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`The engine runs the workflows ${[...workflows.keys()].join(', ')}.\n`);
  }
} finally {
  await db.destroy();
}
