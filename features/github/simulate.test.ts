import { expect, test } from 'vitest';
import { simulate, type Run } from './simulate.ts';

function problems(run: Run): readonly string[] {
  const where = `seed ${String(run.seed)}`;
  return [
    ...(run.failure === undefined ? [] : [`${where} broke ${[...new Set(run.failure.broken.map(found => found.property))].join(', ')} at step ${String(run.failure.step)} after ${run.failure.move}`]),
    ...(run.settled > 0 ? [] : [`${where} settled no task`]),
  ];
}

test('20 seeds of 1000 steps against the fake GitHub break no Land property, and each settles a task', { timeout: 300_000 }, async () => {
  const runs = await simulate([{ seeds: Array.from({ length: 20 }, (_, index) => index + 1), steps: 1000 }]);
  expect(runs.flatMap(problems)).toEqual([]);
});
