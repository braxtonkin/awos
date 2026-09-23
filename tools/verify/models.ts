import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail, pass, type Check, type Scenario } from './check.ts';
import { checkModel, type TlcRun } from './tlc.ts';

type Section = 'INVARIANTS' | 'PROPERTIES';

export type Shape = { readonly label: string; readonly holds: (run: TlcRun) => boolean };

type Config<Bound extends string> = { readonly file: string; readonly floors: Readonly<Record<Bound, number>> };

type Mutant<Guard extends string, Property extends string, Bound extends string> = {
  readonly guard: Guard;
  readonly property: Property;
  readonly overrides?: Readonly<Partial<Record<Bound, string>>>;
  readonly shape?: Shape;
};

type Declaration<Guard extends string, Property extends string, Bound extends string> = {
  readonly name: string;
  readonly module: URL;
  readonly configs: { readonly pr: Config<Bound>; readonly nightly: Config<Bound> };
  readonly guards: readonly Guard[];
  readonly properties: Readonly<Record<Property, Section>>;
  readonly liveness?: readonly NoInfer<Property>[];
  readonly mutants: readonly [Mutant<NoInfer<Guard>, NoInfer<Property>, NoInfer<Bound>>, ...Mutant<NoInfer<Guard>, NoInfer<Property>, NoInfer<Bound>>[]];
};

type Model = Declaration<string, string, string>;

type Kind = 'invariant' | 'action' | 'liveness';

const kinds: Readonly<Record<Kind, { readonly section: Section; readonly violation: (property: string) => string; readonly workers: 'auto' | '1' }>> = {
  invariant: { section: 'INVARIANTS', violation: property => `Invariant ${property} is violated`, workers: '1' },
  action: { section: 'PROPERTIES', violation: property => `Action property ${property} is violated`, workers: '1' },
  liveness: { section: 'PROPERTIES', violation: () => 'Temporal properties were violated', workers: 'auto' },
};

const kindOf = (model: Model, property: string): Kind =>
  model.properties[property] === 'INVARIANTS' ? 'invariant' : model.liveness?.includes(property) === true ? 'liveness' : 'action';

type Heading = 'CONSTANTS' | Section;

type ParsedConfig = {
  readonly constants: ReadonlyMap<string, string>;
  readonly listed: Readonly<Record<Section, ReadonlySet<string>>>;
  readonly problems: readonly string[];
};

const headings: readonly Heading[] = ['CONSTANTS', 'INVARIANTS', 'PROPERTIES'];

const isHeading = (line: string): line is Heading => headings.some(heading => heading === line);

function parseConfig(text: string): ParsedConfig {
  const constants = new Map<string, string>();
  const listed = { INVARIANTS: new Set<string>(), PROPERTIES: new Set<string>() };
  const problems: string[] = [];
  let heading: Heading | undefined;
  for (const line of text.split('\n').map(raw => raw.trimEnd())) {
    const assignment = /^ {4}(\w+) = (\S.*)$/.exec(line);
    const entry = /^ {4}(\w+)$/.exec(line)?.[1];
    if (line === '' || line === 'SPECIFICATION Spec') continue;
    if (/\\\*|\(\*/.test(line)) problems.push(`comment in "${line}"`);
    else if (isHeading(line)) heading = line;
    else if (heading === 'CONSTANTS' && assignment !== null) {
      const [, name = '', value = ''] = assignment;
      if (constants.has(name)) problems.push(`${name} is assigned twice`);
      constants.set(name, value.trim());
    } else if ((heading === 'INVARIANTS' || heading === 'PROPERTIES') && entry !== undefined) listed[heading].add(entry);
    else problems.push(`unexpected line "${line}"`);
  }
  return { constants, listed, problems };
}

const membersOf = (set: string): readonly string[] => set.replace(/[{}\s]/g, '').split(',').filter(member => member !== '');

function boundOf(constants: ReadonlyMap<string, string>, bound: string): number | undefined {
  const value = constants.get(bound);
  if (value === undefined) return undefined;
  return value.startsWith('{') ? new Set(membersOf(value)).size : Number(value);
}

const typeInvariant = 'TypeOK';

function reviewConfig(model: Model, config: Config<string>, text: string): readonly string[] {
  const { constants, listed, problems } = parseConfig(text);
  const broken = new Set(model.mutants.map(mutant => mutant.property));
  const mutated = new Set(model.mutants.map(mutant => mutant.guard));
  const properties = [...Object.keys(model.properties), ...listed.INVARIANTS, ...listed.PROPERTIES];
  const guards = [...model.guards, ...[...constants].filter(([, value]) => value === 'TRUE').map(([name]) => name)];
  const findings = [
    ...problems,
    ...(listed.INVARIANTS.has(typeInvariant) ? [] : [`${typeInvariant} is not listed under INVARIANTS`]),
    ...Object.entries(model.properties).filter(([property, section]) => !listed[section].has(property)).map(([property, section]) => `${property} is not listed under ${section}`),
    ...properties.filter(property => property !== typeInvariant && !broken.has(property)).map(property => `${property} has no mutant`),
    ...model.guards.filter(guard => constants.get(guard) !== 'TRUE').map(guard => `guard ${guard} is not set to TRUE`),
    ...guards.filter(guard => !mutated.has(guard)).map(guard => `guard ${guard} has no mutant`),
    ...Object.entries(config.floors).flatMap(([bound, floor]) => {
      const value = boundOf(constants, bound);
      return value !== undefined && value >= floor ? [] : [`${bound} is ${String(value)}, below its floor of ${String(floor)}`];
    }),
  ];
  return [...new Set(findings)];
}

function checkConfig(model: Model, config: Config<string>, text: string): Check {
  const findings = reviewConfig(model, config, text);
  const name = `${config.file} lists each property in its section with a mutant, every guard with a mutant, and bounds no lower than its floors`;
  return findings.length === 0 ? pass(name, `${String(Object.keys(model.properties).length)} properties, ${String(model.guards.length)} guards`) : fail(name, findings.join('; '));
}

type Plant = { readonly change: string; readonly harmful: boolean; readonly edit: (text: string) => string };

const assignmentOf = (name: string): RegExp => new RegExp(`^ {4}${name} = .*$`, 'm');

const entryOf = (name: string): RegExp => new RegExp(`^ {4}${name}$\\n?`, 'm');

const rewrite = (name: string, replacement: string) => (text: string): string => text.replace(assignmentOf(name), replacement);

function listUnder(text: string, section: Section, name: string): string {
  const heading = new RegExp(`^${section}$`, 'm');
  return heading.test(text) ? text.replace(heading, `$&\n    ${name}`) : `${text}\n${section}\n    ${name}\n`;
}

function repeatFirst(set: string): string {
  const members = membersOf(set);
  const [first = ''] = members;
  return `{${members.map(() => first).join(', ')}}`;
}

function plantsFor(model: Model, config: Config<string>, constants: ReadonlyMap<string, string>): readonly Plant[] {
  const [{ guard, property }] = model.mutants;
  const other = model.properties[property] === 'INVARIANTS' ? 'PROPERTIES' : 'INVARIANTS';
  const floored = Object.entries(config.floors).map(([bound, floor]) => ({ bound, floor, value: constants.get(bound) ?? '' }));
  return [
    { change: `a comment follows ${guard}`, harmful: true, edit: rewrite(guard, `$& \\* ${guard}`) },
    { change: `${guard} is assigned twice`, harmful: true, edit: rewrite(guard, '$&\n$&') },
    { change: `${guard} is set to FALSE`, harmful: true, edit: rewrite(guard, `    ${guard} = FALSE`) },
    { change: 'an undeclared guard is set to TRUE', harmful: true, edit: rewrite(guard, '$&\n    UndeclaredGuard = TRUE') },
    { change: `${property} moves under ${other}`, harmful: true, edit: text => listUnder(text.replace(entryOf(property), ''), other, property) },
    { change: 'an undeclared property is listed', harmful: true, edit: text => listUnder(text, 'INVARIANTS', 'UndeclaredProperty') },
    { change: `${typeInvariant} is dropped`, harmful: true, edit: text => text.replace(entryOf(typeInvariant), '') },
    ...floored
      .filter(({ value }) => /^\d+$/.test(value))
      .slice(0, 1)
      .map(({ bound, floor }) => ({ change: `${bound} drops below its floor`, harmful: true, edit: rewrite(bound, `    ${bound} = ${String(floor - 1)}`) })),
    ...floored
      .filter(({ value, floor }) => value.startsWith('{') && floor >= 2)
      .slice(0, 1)
      .map(({ bound, value }) => ({ change: `${bound} repeats a member`, harmful: true, edit: rewrite(bound, `    ${bound} = ${repeatFirst(value)}`) })),
    { change: 'a line ends in a tab', harmful: false, edit: text => text.replace(`    ${typeInvariant}\n`, `    ${typeInvariant}\t\n`) },
    { change: 'a blank line holds spaces', harmful: false, edit: text => text.replace('\nINVARIANTS', '\n    \nINVARIANTS') },
    { change: 'lines end in CRLF', harmful: false, edit: text => text.replace(/\n/g, '\r\n') },
  ];
}

function checkPlants(model: Model, config: Config<string>, text: string): Check {
  const name = `the review of ${config.file} rejects each harmful plant and accepts each harmless one`;
  if (reviewConfig(model, config, text).length > 0) return fail(name, `${config.file} must pass its review before its plants can be judged`);
  const plants = plantsFor(model, config, parseConfig(text).constants);
  const misses = plants.flatMap(plant => {
    const planted = plant.edit(text);
    if (planted === text) return [`${plant.change} no longer changes ${config.file}`];
    const rejected = reviewConfig(model, config, planted).length > 0;
    return rejected === plant.harmful ? [] : [`${plant.change} is ${rejected ? 'rejected' : 'accepted'}`];
  });
  return misses.length === 0 ? pass(name, `${String(plants.length)} plants`) : fail(name, misses.join('; '));
}

const moduleNameOf = (module: URL): string => basename(fileURLToPath(module), '.tla');

const runTlc = (module: URL, text: string, workers?: 'auto' | '1'): TlcRun => checkModel(fileURLToPath(new URL('.', module)), moduleNameOf(module), text, workers);

const traceLine = (run: TlcRun): string => {
  const actions = run.trace.map(state => state.action);
  const shown = actions.length > 8 ? ['...', ...actions.slice(-8)] : actions;
  const ending = run.loop.length > 0 ? `, then loops back over the last ${String(run.loop.length)} states` : '';
  return `${shown.join(' -> ')}${ending}`;
};

function checkHolds(module: URL, file: string, text: string): Check {
  const run = runTlc(module, text);
  const name = `${file} holds every property`;
  return run.clean
    ? pass(name, `No error has been found in ${String(run.distinctStates)} distinct states, checked in ${run.seconds.toFixed(1)} s`)
    : fail(name, run.error ?? run.output.trim().split('\n').slice(-3).join(' | '));
}

function mutantConfig(text: string, mutant: Mutant<string, string, string>, section: Section): string {
  const constants = [...parseConfig(text).constants].map(([name, value]) => `    ${name} = ${name === mutant.guard ? 'FALSE' : (mutant.overrides?.[name] ?? value)}`);
  return ['SPECIFICATION Spec', 'CONSTANTS', ...constants, section, `    ${mutant.property}`, ''].join('\n');
}

function checkMutant(model: Model, text: string, mutant: Mutant<string, string, string>): Check {
  const kind = kinds[kindOf(model, mutant.property)];
  const violation = kind.violation(mutant.property);
  const run = runTlc(model.module, mutantConfig(text, mutant, kind.section), kind.workers);
  const name = `${mutant.property} fails without ${mutant.guard}${mutant.shape === undefined ? '' : `, ${mutant.shape.label}`}`;
  const violated = run.error?.includes(violation) === true;
  const shaped = mutant.shape === undefined || mutant.shape.holds(run);
  const got = run.error ?? (run.clean ? 'no violation' : (run.output.trim().split('\n').at(-1) ?? 'no output'));
  return violated && shaped ? pass(name, traceLine(run)) : fail(name, `expected ${violation}${shaped ? '' : ' with that trace'}, got ${got}`);
}

const readConfig = (module: URL, config: Config<string>): string => readFileSync(new URL(config.file, module), 'utf8');

export function defineModel<Guard extends string, Property extends string, Bound extends string>(declaration: Declaration<Guard, Property, Bound>): Scenario {
  const { module, configs, mutants } = declaration;
  return {
    name: `${declaration.name}-model`,
    summary: `model-checks ${moduleNameOf(module)}.tla in TLC, and proves each property fails without its guard`,
    run: args => {
      const nightlyText = readConfig(module, configs.nightly);
      const nightlyReview = [checkConfig(declaration, configs.nightly, nightlyText), checkPlants(declaration, configs.nightly, nightlyText)];
      if (args.includes('nightly')) return Promise.resolve([...nightlyReview, checkHolds(module, configs.nightly.file, nightlyText)]);
      const prText = readConfig(module, configs.pr);
      return Promise.resolve([
        checkConfig(declaration, configs.pr, prText),
        checkPlants(declaration, configs.pr, prText),
        ...nightlyReview,
        checkHolds(module, configs.pr.file, prText),
        ...mutants.map(mutant => checkMutant(declaration, prText, mutant)),
      ]);
    },
  };
}
