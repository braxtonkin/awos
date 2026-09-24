import { expect, test } from 'vitest';
import { withPostgres } from '../../tools/verify/postgres.ts';
import { simulate, type Plan, type Run } from './simulate.ts';

const gate: Plan = { profile: 'default', seeds: Array.from({ length: 20 }, (_, index) => index + 1), steps: 300 };

function problems(run: Run): readonly string[] {
  const where = `${run.plan.profile} seed ${String(run.seed)}`;
  return [
    ...(run.failure === undefined ? [] : [`${where} broke ${[...new Set(run.failure.broken.map(found => found.property))].join(', ') || 'the quiet phase'} at step ${String(run.failure.step)}`]),
    ...(run.left === 0 ? [] : [`${where} left ${String(run.left)} environments running`]),
    ...(run.unstopped.length === 0 ? [] : [`${where} started environments that were never stopped for attempts ${run.unstopped.join(', ')}`]),
    ...(run.starts > 0 ? [] : [`${where} started no environment`]),
  ];
}

test('20 seeds of 300 steps break no property, start environments, and leave none running after the quiet phase', { timeout: 600_000 }, async () => {
  const runs = await withPostgres(postgres => simulate(postgres, [gate]));
  expect(runs.flatMap(problems)).toEqual([]);
});
