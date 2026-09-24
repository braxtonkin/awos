import { expect, test } from 'vitest';
import { runScenario } from '../../tools/verify/scenarios.ts';
import { scenarios } from './verify.ts';

test('the credentials scenario passes every check, with no arguments and with --mutant all', { timeout: 600_000 }, async () => {
  const scenario = scenarios.find(candidate => candidate.name === 'credentials');
  if (scenario === undefined) throw new Error('features/credentials/verify.ts exports no scenario named credentials');
  const failed: string[] = [];
  for (const args of [[], ['--mutant', 'all']]) {
    const checks = await runScenario(scenario, args);
    failed.push(...checks.filter(check => !check.passed).map(check => `${args.join(' ') || 'no arguments'}: ${check.name} (${check.detail})`));
  }
  expect(failed).toEqual([]);
});
