import { expect, test } from 'vitest';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { failedSeeds } from './failed-seeds.ts';
import { fingerprint, mutants, simulate, type Plan, type Run } from './simulate.ts';

const gate: Plan = { profile: 'default', seeds: Array.from({ length: 20 }, (_, index) => index + 1), steps: 300 };

const label = (profile: string, seed: number, mutant: string | undefined): string => `${profile} seed ${String(seed)}${mutant === undefined ? '' : ` without ${mutant}`}`;

const stale = failedSeeds
  .filter(entry => entry.fingerprint !== fingerprint)
  .map(
    entry =>
      `${label(entry.profile, entry.seed, entry.mutant)} was recorded under simulator ${entry.fingerprint}, and moves or profiles have changed since, so the seed no longer replays the run that failed. Re-record it: find a seed that fails the same way under simulator ${fingerprint} with the fix reverted, and record that seed with this fingerprint.`,
  );

const replayed: readonly Plan[] = failedSeeds
  .filter(entry => entry.fingerprint === fingerprint)
  .map(({ profile, seed, steps, mutant }) => ({ profile, seeds: [seed], steps, ...(mutant === undefined ? {} : { mutant }) }));

function problems(run: Run): readonly string[] {
  const where = label(run.plan.profile, run.seed, run.plan.mutant);
  const broken = [...new Set(run.failure?.broken.map(found => found.property))];
  if (run.plan.mutant !== undefined) return broken.includes(mutants[run.plan.mutant]) ? [] : [`${where} did not break ${mutants[run.plan.mutant]}`];
  return [
    ...(run.failure === undefined ? [] : [`${where} broke ${broken.join(', ')} at step ${String(run.failure.step)}`]),
    ...(run.done > 0 ? [] : [`${where} took no task to done`]),
  ];
}

test('20 seeds of 300 steps break no property and each take a task to done, and every seed that once failed replays as fixed under the simulator it was recorded with', { timeout: 600_000 }, async () => {
  const runs = await withPostgres(postgres => simulate(postgres, [gate, ...replayed]));
  expect([...stale, ...runs.flatMap(problems)]).toEqual([]);
});
