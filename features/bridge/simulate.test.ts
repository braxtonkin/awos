import { expect, test } from 'vitest';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { failedSeeds } from './failed-seeds.ts';
import { fingerprint, simulate, type Plan, type Run } from './simulate.ts';

const gate: Plan = { seeds: Array.from({ length: 20 }, (_, index) => index + 1), steps: 300 };

const stale = failedSeeds
  .filter(entry => entry.fingerprint !== fingerprint)
  .map(
    entry =>
      `seed ${String(entry.seed)} was recorded under simulator ${entry.fingerprint}, and moves or weights have changed since, so the seed no longer replays the run that failed. Re-record it: revert the fix, run npm run verify -- bridge-sim --seeds 1000 --steps ${String(entry.steps)} until a seed fails the same way under simulator ${fingerprint}, and record that seed with this fingerprint.`,
  );

const replayed: readonly Plan[] = failedSeeds.filter(entry => entry.fingerprint === fingerprint).map(({ seed, steps }) => ({ seeds: [seed], steps }));

function problems(run: Run): readonly string[] {
  const where = `seed ${String(run.seed)}`;
  return [
    ...(run.failure === undefined ? [] : [`${where} broke ${[...new Set(run.failure.broken.map(found => found.property))].join(', ')} at step ${String(run.failure.step)} after ${run.failure.move}: ${run.failure.said}`]),
    ...(run.ended > 0 ? [] : [`${where} finished no attempt through its end line`]),
    ...run.errors.map(error => `${where} met an unexpected engine error: ${error}`),
  ];
}

test('20 seeds of 300 steps break no property of the Bridge model and each finish an attempt through its end line, and every seed that once failed replays as fixed under the simulator it was recorded with', { timeout: 600_000 }, async () => {
  const runs = await withPostgres(postgres => simulate(postgres, [gate, ...replayed]));
  expect([...stale, ...runs.flatMap(problems)]).toEqual([]);
});
