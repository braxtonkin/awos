import { fileURLToPath } from 'node:url';
import { fail, type Check } from './check.ts';
import { loadScenarios } from './scenarios.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [name, ...args] = process.argv.slice(2);
const scenarios = await loadScenarios(root);
const scenario = name === undefined ? undefined : scenarios.get(name);

if (scenario === undefined) {
  const listing = [...scenarios.values()].map(entry => `  ${entry.name.padEnd(12)}${entry.summary}`).join('\n');
  const problem = name === undefined ? 'Name a scenario to run.' : `There is no scenario named ${name}.`;
  process.stderr.write(`${problem}\n\nScenarios:\n${listing}\n`);
  process.exitCode = 2;
} else {
  const checks: readonly Check[] = await scenario
    .run(args)
    .catch((error: unknown) => [fail(`${scenario.name} runs to completion`, error instanceof Error ? error.message : String(error))]);
  const all = checks.length === 0 ? [fail(`${scenario.name} produces at least one check`, 'it produced none')] : checks;
  for (const check of all) {
    process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}${check.detail === '' ? '' : `  (${check.detail})`}\n`);
  }
  const passed = all.filter(check => check.passed).length;
  process.stdout.write(`${String(passed)} of ${String(all.length)} checks passed\n`);
  process.exitCode = passed === all.length ? 0 : 1;
}
