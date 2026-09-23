import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Scenario } from './check.ts';
import { doctor } from './doctor.ts';
import { guardrails } from './guardrails.ts';

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

export async function loadScenarios(root: string): Promise<ReadonlyMap<string, Scenario>> {
  const registry = new Map<string, Scenario>();
  for (const scenario of [guardrails, doctor, ...(await featureScenarios(root))]) {
    if (registry.has(scenario.name)) throw new Error(`two scenarios are named ${scenario.name}`);
    registry.set(scenario.name, scenario);
  }
  return registry;
}
