import { expect, test } from 'vitest';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { simulate, type Plan, type Run } from './simulate.ts';

const gate: Plan = { seeds: Array.from({ length: 20 }, (_, index) => index + 1), steps: 300 };

function problems(run: Run): readonly string[] {
  const where = `seed ${String(run.seed)}`;
  return [
    ...(run.failure === undefined ? [] : [`${where} broke ${[...new Set(run.failure.broken.map(found => found.property))].join(', ')} at step ${String(run.failure.step)} after ${run.failure.move}: ${run.failure.said}`]),
    ...(run.ended > 0 ? [] : [`${where} finished no attempt through its end line`]),
    ...run.errors.map(error => `${where} met an unexpected engine error: ${error}`),
  ];
}

test('20 seeds of 300 steps break no property of the Bridge model, and each finishes an attempt through its end line', { timeout: 600_000 }, async () => {
  const runs = await withPostgres(postgres => simulate(postgres, [gate]));
  expect(runs.flatMap(problems)).toEqual([]);
});
