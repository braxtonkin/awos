import { expect, test } from 'vitest';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { simulate, type Plan, type Run } from './simulate.ts';

const gate: Plan = { seeds: Array.from({ length: 20 }, (_, index) => index + 1), steps: 150, checkers: 3 };

function problems(run: Run): readonly string[] {
  const where = `seed ${String(run.seed)}`;
  return [
    ...(run.failure === undefined ? [] : [`${where} broke ${[...new Set(run.failure.broken.map(found => found.property))].join(', ')} at step ${String(run.failure.step)}`]),
    ...(run.refreshed > 0 ? [] : [`${where} wrote no refreshed login back`]),
  ];
}

test('20 seeds of 150 steps with 3 checkers break no property of the Checks model, and each writes a refreshed login back', { timeout: 600_000 }, async () => {
  const runs = await withPostgres(postgres => simulate(postgres, [gate]));
  expect(runs.flatMap(problems)).toEqual([]);
});
