import { z } from 'zod';
import { reaper } from '../../features/tasks/reaper.ts';
import { startProblems } from '../../features/tasks/start.ts';
import { connect } from '../../shared/db/client.ts';
import { realClock, runLoop, type Loop } from '../../shared/loop.ts';
import { workflows } from './workflows.ts';

const milliseconds = z.coerce.number().int().positive();

const settings = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(2).default(10),
  DATABASE_CONNECT_TIMEOUT_MS: milliseconds.default(10_000),
  LEASE_MS: milliseconds.default(60_000),
  REAPER_EVERY_MS: milliseconds.default(30_000),
});

type Settings = z.infer<typeof settings>;

const loopsFor = (given: Settings): readonly Loop[] => [reaper({ everyMs: given.REAPER_EVERY_MS, leaseMs: given.LEASE_MS })];

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function run(given: Settings): Promise<void> {
  const stop = new AbortController();
  const stopping = (signal: NodeJS.Signals): void => {
    say(stop.signal.aborted ? `The engine got ${signal} again and still finishes its pass.` : `The engine got ${signal}, so each loop finishes its pass and stops.`);
    stop.abort();
  };
  process.on('SIGTERM', stopping).on('SIGINT', stopping);
  const db = connect(given.DATABASE_URL, given.DATABASE_POOL_SIZE, given.DATABASE_CONNECT_TIMEOUT_MS);
  try {
    const problems = await startProblems(db, workflows);
    if (problems.length > 0) {
      process.stderr.write(`The engine did not start, because its routines and tasks do not fit the workflows it was given.\n${problems.join('\n')}\n`);
      process.exitCode = 1;
      return;
    }
    const loops = loopsFor(given);
    say(`The engine runs the workflows ${[...workflows.keys()].join(', ')}, and the loops ${loops.map(loop => `${loop.name} every ${String(loop.everyMs)} ms`).join(', ')}.`);
    await Promise.all(loops.map(loop => runLoop(loop, db, realClock, stop.signal, say)));
    say('The engine stopped.');
  } finally {
    await db.destroy();
  }
}

const parsed = settings.safeParse(process.env);
if (parsed.success) {
  await run(parsed.data);
} else {
  process.stderr.write(`The engine did not start, because a setting is missing or wrong.\n${z.prettifyError(parsed.error)}\n`);
  process.exitCode = 1;
}
