import { expect, test } from 'vitest';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { simulate, type Plan, type Run } from './simulate.ts';

const gate: Plan = { profile: 'mixed', seeds: Array.from({ length: 20 }, (_, index) => index + 1), steps: 300 };

function problems(run: Run): readonly string[] {
  const where = `${run.plan.profile} seed ${String(run.seed)}`;
  const broken = [...new Set(run.failure?.broken.map(found => found.property))];
  return [
    ...(run.failure === undefined ? [] : [`${where} broke ${broken.join(', ')} at step ${String(run.failure.step)} after ${run.failure.move}`]),
    ...(run.duplicates === 0 ? [] : [`${where} took effect twice on ${String(run.duplicates)} markers`]),
    ...(run.done > 0 ? [] : [`${where} took no task to done`]),
  ];
}

test('20 seeds of 300 steps break no outbox property, take no action twice, and each take a task to done', { timeout: 600_000 }, async () => {
  const runs = await withPostgres(postgres => simulate(postgres, [gate]));
  expect(runs.flatMap(problems)).toEqual([]);
});
