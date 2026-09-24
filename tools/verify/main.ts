import { fileURLToPath } from 'node:url';
import { loadScenarios, runScenario } from './scenarios.ts';

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
  const checks = await runScenario(scenario, args);
  for (const check of checks) {
    process.stdout.write(`${check.passed ? 'PASS' : 'FAIL'}  ${check.name}${check.detail === '' ? '' : `  (${check.detail})`}\n`);
  }
  const passed = checks.filter(check => check.passed).length;
  process.stdout.write(`${String(passed)} of ${String(checks.length)} checks passed\n`);
  process.exitCode = passed === checks.length ? 0 : 1;
}
