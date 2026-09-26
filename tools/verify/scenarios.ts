import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { accounts } from './accounts.ts';
import { dashboardGrants } from './dashboard-grants.ts';
import { batch, dashboardBatch, type Batch } from './batch.ts';
import { dashboardLane, isLane, type Lane } from './dashboard.ts';
import { checksOf, fail, pass, type Line, type Scenario } from './check.ts';
import { doctor } from './doctor.ts';
import { guardrails } from './guardrails.ts';
import { kind } from './kind.ts';
import { migrations } from './migrations.ts';
import { screenReview } from './screens/packet.ts';
import { screen, screenGates, screens, type Screen } from './screens/screens.ts';

const modelSuffix = '-model';

const simSuffix = '-sim';

const isScenario = (value: unknown): value is Scenario =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'summary' in value &&
  typeof value.summary === 'string' &&
  'run' in value &&
  typeof value.run === 'function' &&
  (!('nightly' in value) || typeof value.nightly === 'function');

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

type Declared = { readonly scenarios: readonly Scenario[]; readonly screens: readonly Screen[]; readonly lanes: readonly Lane[]; readonly batches: readonly Batch[] };

async function featureModules(root: string): Promise<Declared> {
  const features = join(root, 'features');
  if (!(await exists(features))) return { scenarios: [], screens: [], lanes: [], batches: [] };
  const found: Scenario[] = [];
  const declared: Screen[] = [];
  const lanes: Lane[] = [];
  const batches: Batch[] = [];
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
    if ('screens' in loaded) {
      const parsed = screen.array().safeParse(loaded.screens);
      if (!parsed.success) throw new Error(`${file} must export screens, a list of screens as tools/verify/screens/screens.ts declares them: ${parsed.error.message}`);
      declared.push(...parsed.data);
    }
    if ('lanes' in loaded) {
      if (!Array.isArray(loaded.lanes) || !loaded.lanes.every(isLane)) throw new Error(`${file} must export lanes, a list of dashboard lanes as tools/verify/dashboard.ts declares them`);
      lanes.push(...loaded.lanes);
    }
    if ('batch' in loaded) {
      const parsed = batch.safeParse(loaded.batch);
      if (!parsed.success) throw new Error(`${file} must export batch, the scenarios and engine checks dashboard-batch runs, as tools/verify/batch.ts declares it: ${parsed.error.message}`);
      batches.push(parsed.data);
    }
  }
  return { scenarios: found, screens: declared, lanes, batches };
}

export async function runScenario(scenario: Scenario, args: readonly string[]): Promise<readonly Line[]> {
  try {
    const checks = await scenario.run(args);
    return checksOf(checks).length === 0 ? [...checks, fail(`${scenario.name} produces at least one check`, 'it produced none')] : checks;
  } catch (error) {
    return [fail(`${scenario.name} runs to completion`, error instanceof Error ? error.message : String(error))];
  }
}

type Run = { readonly scenario: Scenario; readonly args: readonly string[]; readonly label: string };

async function runEach(runs: readonly Run[]): Promise<readonly Line[]> {
  const checks: Line[] = [];
  for (const { scenario, args, label } of runs) {
    for (const check of await runScenario(scenario, args)) checks.push({ ...check, name: `${label}: ${check.name}` });
  }
  return checks;
}

const models = (features: readonly Scenario[]): Scenario => ({
  name: 'models',
  summary: `runs every scenario whose name ends in ${modelSuffix}, with the arguments it is given`,
  run: args => runEach(features.filter(scenario => scenario.name.endsWith(modelSuffix)).map(scenario => ({ scenario, args, label: scenario.name }))),
});

const dayMs = 86_400_000;

function shardOf(args: readonly string[]): { readonly index: number; readonly count: number } {
  const { values, positionals } = parseArgs({ args: [...args], options: { shard: { type: 'string' } }, strict: true, allowPositionals: true });
  const [index = 1, count = 1] = (values.shard ?? '1/1').split('/').map(Number);
  if (positionals.join(' ') !== 'nightly' || !Number.isInteger(index) || !Number.isInteger(count) || index < 1 || index > count) {
    throw new Error('sims takes the arguments it passes to each simulator, or nightly with an optional --shard <k>/<n>, where 1 <= k <= n');
  }
  return { index, count };
}

function nightlyRuns(simulators: readonly Scenario[], args: readonly string[], now: number): { readonly runs: readonly Run[]; readonly undeclared: readonly string[] } {
  const { index, count } = shardOf(args);
  const day = Math.floor(now / dayMs);
  const every = simulators.flatMap(scenario => (scenario.nightly?.(day) ?? []).map(given => ({ scenario, args: given, label: [scenario.name, ...given].join(' ') })));
  return {
    runs: every.filter((_, position) => position % count === index - 1),
    undeclared: simulators.filter(scenario => scenario.nightly === undefined).map(scenario => scenario.name),
  };
}

const sims = (features: readonly Scenario[]): Scenario => ({
  name: 'sims',
  summary: `runs every scenario whose name ends in ${simSuffix}, with the arguments it is given; sims nightly [--shard <k>/<n>] runs share k of n of their nightly runs`,
  run: async args => {
    const simulators = features.filter(scenario => scenario.name.endsWith(simSuffix));
    const names = simulators.map(scenario => scenario.name).join(', ');
    if (args[0] !== 'nightly') return [pass(`sims runs every scenario named <name>${simSuffix}`, names), ...(await runEach(simulators.map(scenario => ({ scenario, args, label: scenario.name }))))];
    const { runs, undeclared } = nightlyRuns(simulators, args, Date.now());
    const declared = `every scenario named <name>${simSuffix} declares its nightly runs`;
    return [
      undeclared.length === 0 ? pass(declared, names) : fail(declared, `${undeclared.join(', ')} declare none`),
      pass(`sims ${args.join(' ')} takes its share of the nightly runs`, runs.map(run => run.label).join('; ')),
      ...(await runEach(runs)),
    ];
  },
});

export async function loadScenarios(root: string): Promise<ReadonlyMap<string, Scenario>> {
  const { scenarios: features, screens: declared, lanes, batches } = await featureModules(root);
  const registry = new Map<string, Scenario>();
  const runNamed = (name: string, args: readonly string[]): Promise<readonly Line[]> => {
    const scenario = registry.get(name);
    return scenario === undefined ? Promise.resolve([fail(`a scenario named ${name} exists`, 'a feature registered it in its batch, but no scenario has that name')]) : runScenario(scenario, args);
  };
  for (const scenario of [guardrails, doctor, migrations, kind, accounts, screens(declared), screenGates, screenReview(declared), dashboardLane(lanes), dashboardBatch({ screens: declared, lanes, batches }, runNamed), dashboardGrants, models(features), sims(features), ...features]) {
    if (registry.has(scenario.name)) throw new Error(`two scenarios are named ${scenario.name}`);
    registry.set(scenario.name, scenario);
  }
  return registry;
}
