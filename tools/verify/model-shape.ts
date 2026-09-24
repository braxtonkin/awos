import { readFileSync } from 'node:fs';

export type ModelShape = {
  readonly steps: readonly string[];
  readonly endSteps: readonly string[];
  readonly checks: readonly string[];
  readonly merges: readonly string[];
  readonly returnsTo: readonly string[];
  readonly asking: readonly string[];
};

const strings = (text: string): readonly string[] => [...text.matchAll(/"([^"]*)"/g)].map(([, value = '']) => value);

function constant(config: string, name: string): string {
  const value = new RegExp(`^\\s+${name} (?:=|<-) (.+)$`, 'm').exec(config)?.[1];
  if (value === undefined) throw new Error(`The model config assigns no ${name}.`);
  return value.trim();
}

export function modelShape(model: URL, config: URL): ModelShape {
  const tla = readFileSync(model, 'utf8');
  const cfg = readFileSync(config, 'utf8');
  const stepsName = constant(cfg, 'Steps');
  const steps = new RegExp(`^${stepsName} == <<(.*)>>$`, 'm').exec(tla)?.[1];
  if (steps === undefined) throw new Error(`The model defines no ${stepsName} as a sequence of step names.`);
  return {
    steps: strings(steps),
    endSteps: strings(constant(cfg, 'EndSteps')),
    checks: strings(constant(cfg, 'Checks')),
    merges: strings(constant(cfg, 'Merges')),
    returnsTo: strings(constant(cfg, 'ReturnsTo')),
    asking: strings(constant(cfg, 'Asking')),
  };
}

const same = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every(value => right.includes(value));

const fields = [
  ['steps in order', 'steps'],
  ['steps that can end the task', 'endSteps'],
  ['steps that check behavior', 'checks'],
  ['steps that merge', 'merges'],
  ['steps a failure returns to', 'returnsTo'],
] as const;

export function shapeDrift(model: ModelShape, declared: ModelShape): readonly string[] {
  const listed = (values: readonly string[]): string => (values.length === 0 ? 'none' : values.join(', '));
  const differs = (key: (typeof fields)[number][1]): boolean => (key === 'steps' ? model.steps.join() !== declared.steps.join() : !same(model[key], declared[key]));
  return [
    ...fields.filter(([, key]) => differs(key)).map(([what, key]) => `${what}: the model has ${listed(model[key])}, the declaration has ${listed(declared[key])}`),
    ...model.asking.filter(step => !declared.asking.includes(step)).map(step => `the model lets ${step} ask for input, and the declaration does not`),
  ];
}
