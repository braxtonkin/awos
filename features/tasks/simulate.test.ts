import { expect, test } from 'vitest';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { failedSeeds } from './failed-seeds.ts';
import { fingerprint, laterReviews, mutants, simulate, unfiredFaults, type Plan, type Run } from './simulate.ts';

const seeds = (count: number): readonly number[] => Array.from({ length: count }, (_, index) => index + 1);

const gates: readonly Plan[] = [
  { profile: 'mixed', seeds: seeds(20), steps: 300 },
  { profile: 'verdicts', seeds: seeds(10), steps: 300 },
  { profile: 'reviews', seeds: seeds(10), steps: 300 },
];

const label = (profile: string, seed: number, mutant: string | undefined): string => `${profile} seed ${String(seed)}${mutant === undefined ? '' : ` without ${mutant}`}`;

const stale = failedSeeds
  .filter(entry => entry.fingerprint !== fingerprint)
  .map(
    entry =>
      `${label(entry.profile, entry.seed, entry.mutant)} was recorded under simulator ${entry.fingerprint}, and moves or profiles have changed since, so the seed no longer replays the run that failed. Re-record it: revert the fix, run npm run verify -- tasks-sim ${entry.mutant === undefined ? `--profile ${entry.profile}` : `--mutant ${entry.mutant}`} --seeds 60 --steps ${String(entry.steps)} until a seed fails the same way under simulator ${fingerprint}, and record that seed with this fingerprint.`,
  );

const replayed: readonly Plan[] = failedSeeds
  .filter(entry => entry.fingerprint === fingerprint)
  .map(({ profile, seed, steps, mutant }) => ({ profile, seeds: [seed], steps, ...(mutant === undefined ? {} : { mutant }) }));

function problems(run: Run): readonly string[] {
  const where = label(run.plan.profile, run.seed, run.plan.mutant);
  const broken = [...new Set(run.failure?.broken.map(found => found.property))];
  if (run.plan.mutant !== undefined) {
    const expected: readonly string[] = mutants[run.plan.mutant];
    return broken.some(property => expected.includes(property)) ? [] : [`${where} did not break ${expected.join(' or ')}`];
  }
  return [
    ...(run.failure === undefined ? [] : [`${where} broke ${broken.join(', ')} at step ${String(run.failure.step)}`]),
    ...(run.done > 0 ? [] : [`${where} took no task to done`]),
  ];
}

function coverage(runs: readonly Run[]): readonly string[] {
  return gates.flatMap(gate => {
    const ofGate = runs.filter(run => run.plan === gate);
    const unfired = unfiredFaults(gate.profile, ofGate);
    return [
      ...(unfired.length === 0 ? [] : [`${gate.profile} weights ${unfired.join(', ')} above 0, and none fired in ${String(ofGate.length)} seeds`]),
      ...(gate.profile === 'reviews' && laterReviews(ofGate) === 0 ? [`reviews reached no review past the cap in ${String(ofGate.length)} seeds`] : []),
    ];
  });
}

test('mixed, verdicts, and reviews seeds break no property, fire every fault they weight, and each take a task to done, and every seed that once failed replays as fixed under the simulator it was recorded with', { timeout: 600_000 }, async () => {
  const runs = await withPostgres(postgres => simulate(postgres, [...gates, ...replayed]));
  expect([...stale, ...runs.flatMap(problems), ...coverage(runs)]).toEqual([]);
});
