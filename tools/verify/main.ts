import { fileURLToPath } from 'node:url';
import { render } from './check.ts';
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
  const { text, exitCode } = render(await runScenario(scenario, args));
  process.stdout.write(text);
  process.exitCode = exitCode;
}
