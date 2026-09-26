import { expect, test } from 'vitest';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { simulate, type Plan, type Run } from './simulate.ts';

const gate: Plan = { profile: 'default', seeds: Array.from({ length: 10 }, (_, index) => index + 1), steps: 200 };

const broken = (run: Run): readonly string[] =>
  run.failure === undefined
    ? []
    : [`default seed ${String(run.seed)} broke ${[...new Set(run.failure.broken.map(found => found.property))].join(', ')} at step ${String(run.failure.step)} after ${run.failure.move}`];

test('10 seeds of 200 steps break no Requests.tla property and each record a request', { timeout: 600_000 }, async () => {
  const runs = await withPostgres(postgres => simulate(postgres, [gate]));
  expect(runs.flatMap(run => [...broken(run), ...(run.summary.recorded > 0 ? [] : [`default seed ${String(run.seed)} recorded no request`])])).toEqual([]);
});
