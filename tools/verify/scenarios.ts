import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { accounts } from './accounts.ts';
import { fail, type Check, type Scenario } from './check.ts';
import { doctor } from './doctor.ts';
import { guardrails } from './guardrails.ts';
import { kind } from './kind.ts';
import { migrations } from './migrations.ts';

const modelSuffix = '-model';

const isScenario = (value: unknown): value is Scenario =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'summary' in value &&
  typeof value.summary === 'string' &&
  'run' in value &&
  typeof value.run === 'function';

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

async function featureScenarios(root: string): Promise<readonly Scenario[]> {
  const features = join(root, 'features');
  if (!(await exists(features))) return [];
  const found: Scenario[] = [];
  for (const folder of await readdir(features, { withFileTypes: true })) {
    const file = join(features, folder.name, 'verify.ts');
    if (!folder.isDirectory() || !(await exists(file))) continue;
    const loaded: unknown = await import(pathToFileURL(file).href);
    if (
      typeof loaded !== 'object' ||
      loaded === null ||
      !('scenarios' in loaded) ||
      !Array.isArray(loaded.scenarios) ||
      !loaded.scenarios.every(isScenario)
    ) {
      throw new Error(`${file} must export scenarios, a list of verify scenarios`);
    }
    found.push(...loaded.scenarios);
  }
  return found;
}

export async function runScenario(scenario: Scenario, args: readonly string[]): Promise<readonly Check[]> {
  try {
    const checks = await scenario.run(args);
    return checks.length === 0 ? [fail(`${scenario.name} produces at least one check`, 'it produced none')] : checks;
  } catch (error) {
    return [fail(`${scenario.name} runs to completion`, error instanceof Error ? error.message : String(error))];
  }
}

const models = (features: readonly Scenario[]): Scenario => ({
  name: 'models',
  summary: `runs every scenario whose name ends in ${modelSuffix}, with the arguments it is given`,
  run: async args => {
    const checks: Check[] = [];
    for (const model of features.filter(scenario => scenario.name.endsWith(modelSuffix))) {
      for (const check of await runScenario(model, args)) checks.push({ ...check, name: `${model.name}: ${check.name}` });
    }
    return checks;
  },
});

export async function loadScenarios(root: string): Promise<ReadonlyMap<string, Scenario>> {
  const features = await featureScenarios(root);
  const registry = new Map<string, Scenario>();
  for (const scenario of [guardrails, doctor, migrations, kind, accounts, models(features), ...features]) {
    if (registry.has(scenario.name)) throw new Error(`two scenarios are named ${scenario.name}`);
    registry.set(scenario.name, scenario);
  }
  return registry;
}
