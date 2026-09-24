import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fail, pass, type Check, type Scenario } from './check.ts';
import { checkModel, traceLine, type TlcOptions, type TlcRun } from './tlc.ts';

type Section = 'INVARIANTS' | 'PROPERTIES';

export type Shape = { readonly label: string; readonly holds: (run: TlcRun) => boolean };

type Config<Bound extends string> = { readonly file: string; readonly floors: Readonly<Record<Bound, number>> };

type Mutant<Guard extends string, Property extends string, Setting extends string> = {
  readonly guard: Guard;
  readonly property: Property;
  readonly without?: string;
  readonly overrides?: Readonly<Partial<Record<Setting, string>>>;
  readonly shape?: Shape;
};

type Listed<Properties, Wanted extends Section> = { readonly [Property in keyof Properties]: Properties[Property] extends Wanted ? Property : never }[keyof Properties] & string;

type Declaration<Guard extends string, Properties extends Readonly<Record<string, Section>>, Bound extends string, Setting extends string> = {
  readonly name: string;
  readonly module: URL;
  readonly configs: { readonly pr: Config<Bound>; readonly nightly: Config<Bound> };
  readonly guards: readonly Guard[];
  readonly properties: Properties;
  readonly liveness?: readonly NoInfer<Listed<Properties, 'PROPERTIES'>>[];
  readonly settings?: readonly Setting[];
  readonly mutants: readonly [
    Mutant<NoInfer<Guard>, NoInfer<keyof Properties & string>, NoInfer<Bound | Setting>>,
    ...Mutant<NoInfer<Guard>, NoInfer<keyof Properties & string>, NoInfer<Bound | Setting>>[],
  ];
};

type AnyMutant = Mutant<string, string, string>;

type Model = {
  readonly name: string;
  readonly module: URL;
  readonly configs: { readonly pr: Config<string>; readonly nightly: Config<string> };
  readonly guards: readonly string[];
  readonly properties: Readonly<Record<string, Section>>;
  readonly liveness?: readonly string[];
  readonly mutants: readonly AnyMutant[];
};

type Kind = 'invariant' | 'action' | 'liveness';

const kinds: Readonly<Record<Kind, { readonly section: Section; readonly violation: (property: string) => string; readonly tlc: TlcOptions }>> = {
  invariant: { section: 'INVARIANTS', violation: property => `Invariant ${property} is violated`, tlc: { workers: '1' } },
  action: { section: 'PROPERTIES', violation: property => `Action property ${property} is violated`, tlc: { workers: '1' } },
  liveness: { section: 'PROPERTIES', violation: () => 'Temporal properties were violated', tlc: { workers: 'auto' } },
};

const isLiveness = (model: Model, property: string): boolean => model.liveness?.includes(property) === true;

function kindOf(model: Model, property: string): Kind {
  const section = model.properties[property];
  if (isLiveness(model, property) && section !== 'PROPERTIES') throw new Error(`${property} is a liveness property, so TLC checks it only under PROPERTIES`);
  return section === 'INVARIANTS' ? 'invariant' : isLiveness(model, property) ? 'liveness' : 'action';
}

type Heading = 'CONSTANTS' | Section;

type Operator = '=' | '<-';

type ParsedConfig = {
  readonly constants: ReadonlyMap<string, string>;
  readonly operators: ReadonlyMap<string, Operator>;
  readonly listed: Readonly<Record<Section, ReadonlySet<string>>>;
  readonly problems: readonly string[];
};

const headings: readonly Heading[] = ['CONSTANTS', 'INVARIANTS', 'PROPERTIES'];

const isHeading = (line: string): line is Heading => headings.some(heading => heading === line);

function parseConfig(text: string): ParsedConfig {
  const constants = new Map<string, string>();
  const operators = new Map<string, Operator>();
  const listed = { INVARIANTS: new Set<string>(), PROPERTIES: new Set<string>() };
  const problems: string[] = [];
  let heading: Heading | undefined;
  for (const line of text.split('\n').map(raw => raw.trimEnd())) {
    const assignment = /^ {4}(\w+) (=|<-) (\S.*)$/.exec(line);
    const entry = /^ {4}(\w+)$/.exec(line)?.[1];
    if (line === '' || line === 'SPECIFICATION Spec') continue;
    if (/\\\*|\(\*/.test(line)) problems.push(`comment in "${line}"`);
    else if (isHeading(line)) heading = line;
    else if (heading === 'CONSTANTS' && assignment !== null) {
      const [, name = '', operator = '', value = ''] = assignment;
      if (constants.has(name)) problems.push(`${name} is assigned twice`);
      constants.set(name, value.trim());
      operators.set(name, operator === '<-' ? '<-' : '=');
    } else if ((heading === 'INVARIANTS' || heading === 'PROPERTIES') && entry !== undefined) listed[heading].add(entry);
    else problems.push(`unexpected line "${line}"`);
  }
  return { constants, operators, listed, problems };
}

const membersOf = (set: string): readonly string[] => set.replace(/[{}\s]/g, '').split(',').filter(member => member !== '');

function boundOf(constants: ReadonlyMap<string, string>, bound: string): number | undefined {
  const value = constants.get(bound);
  if (value === undefined) return undefined;
  return value.startsWith('{') ? new Set(membersOf(value)).size : Number(value);
}

const typeInvariant = 'TypeOK';

function overrideFindings(model: Model, mutants: readonly AnyMutant[], constants: ReadonlyMap<string, string>): readonly string[] {
  const guards = new Set([...model.guards, ...[...constants].filter(([, value]) => value === 'TRUE').map(([name]) => name)]);
  return mutants.flatMap(mutant =>
    Object.keys(mutant.overrides ?? {}).flatMap(name => [
      ...(constants.has(name) ? [] : [`the mutant of ${mutant.guard} overrides ${name}, which the config does not assign`]),
      ...(guards.has(name) ? [`the mutant of ${mutant.guard} also turns off guard ${name}`] : []),
    ]),
  );
}

function reviewConfig(model: Model, config: Config<string>, text: string, mutants: readonly AnyMutant[] = model.mutants): readonly string[] {
  const { constants, listed, problems } = parseConfig(text);
  const broken = new Set(mutants.map(mutant => mutant.property));
  const mutated = new Set(mutants.map(mutant => mutant.guard));
  const properties = [...Object.keys(model.properties), ...listed.INVARIANTS, ...listed.PROPERTIES];
  const guards = [...model.guards, ...[...constants].filter(([, value]) => value === 'TRUE').map(([name]) => name)];
  const findings = [
    ...problems,
    ...(listed.INVARIANTS.has(typeInvariant) ? [] : [`${typeInvariant} is not listed under INVARIANTS`]),
    ...[...listed.INVARIANTS].filter(property => isLiveness(model, property)).map(property => `${property} is a liveness property, so TLC checks it only under PROPERTIES`),
    ...Object.entries(model.properties).filter(([property, section]) => !listed[section].has(property)).map(([property, section]) => `${property} is not listed under ${section}`),
    ...properties.filter(property => property !== typeInvariant && !broken.has(property)).map(property => `${property} has no mutant`),
    ...model.guards.filter(guard => constants.get(guard) !== 'TRUE').map(guard => `guard ${guard} is not set to TRUE`),
    ...guards.filter(guard => !mutated.has(guard)).map(guard => `guard ${guard} has no mutant`),
    ...overrideFindings(model, mutants, constants),
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

type Plant = {
  readonly change: string;
  readonly harmful: boolean;
  readonly edit: (text: string) => string;
  readonly mutants?: (mutants: readonly AnyMutant[]) => readonly AnyMutant[];
};

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

const overriding = (name: string, value: string) => (mutants: readonly AnyMutant[]): readonly AnyMutant[] =>
  mutants.map((mutant, index) => (index === 0 ? { ...mutant, overrides: { ...mutant.overrides, [name]: value } } : mutant));

function plantsFor(model: Model, config: Config<string>, constants: ReadonlyMap<string, string>): readonly Plant[] {
  const [first] = model.mutants;
  if (first === undefined) return [];
  const { guard, property } = first;
  const other = model.properties[property] === 'INVARIANTS' ? 'PROPERTIES' : 'INVARIANTS';
  const otherGuard = model.guards.find(candidate => candidate !== guard);
  const [liveness] = model.liveness ?? [];
  const floored = Object.entries(config.floors).map(([bound, floor]) => ({ bound, floor, value: constants.get(bound) ?? '' }));
  return [
    { change: `a comment follows ${guard}`, harmful: true, edit: rewrite(guard, `$& \\* ${guard}`) },
    { change: `${guard} is assigned twice`, harmful: true, edit: rewrite(guard, '$&\n$&') },
    { change: `${guard} is set to FALSE`, harmful: true, edit: rewrite(guard, `    ${guard} = FALSE`) },
    { change: 'an undeclared guard is set to TRUE', harmful: true, edit: rewrite(guard, '$&\n    UndeclaredGuard = TRUE') },
    { change: `${property} moves under ${other}`, harmful: true, edit: text => listUnder(text.replace(entryOf(property), ''), other, property) },
    ...(liveness === undefined
      ? []
      : [{ change: `the liveness property ${liveness} moves under INVARIANTS`, harmful: true, edit: (text: string) => listUnder(text.replace(entryOf(liveness), ''), 'INVARIANTS', liveness) }]),
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
    { change: `the mutant of ${guard} overrides a constant the config does not assign`, harmful: true, edit: text => text, mutants: overriding('UnassignedConstant', '0') },
    ...(otherGuard === undefined
      ? []
      : [{ change: `the mutant of ${guard} also turns off guard ${otherGuard}`, harmful: true, edit: (text: string) => text, mutants: overriding(otherGuard, 'FALSE') }]),
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
    const mutants = plant.mutants?.(model.mutants) ?? model.mutants;
    if (planted === text && mutants === model.mutants) return [`${plant.change} no longer changes ${config.file}`];
    const rejected = reviewConfig(model, config, planted, mutants).length > 0;
    return rejected === plant.harmful ? [] : [`${plant.change} is ${rejected ? 'rejected' : 'accepted'}`];
  });
  return misses.length === 0 ? pass(name, `${String(plants.length)} plants`) : fail(name, misses.join('; '));
}

const moduleNameOf = (module: URL): string => basename(fileURLToPath(module), '.tla');

const runTlc = (module: URL, text: string, options?: TlcOptions): TlcRun => checkModel(fileURLToPath(new URL('.', module)), moduleNameOf(module), text, options);

const failure = (run: TlcRun): string => run.error ?? run.output.trim().split('\n').slice(-3).join(' | ');

const constantLines = (parsed: ParsedConfig, value: (name: string, current: string) => string): readonly string[] =>
  [...parsed.constants].map(([name, current]) => `    ${name} ${parsed.operators.get(name) ?? '='} ${value(name, current)}`);

const configOf = (parsed: ParsedConfig, lines: readonly string[], value: (name: string, current: string) => string = (_name, current) => current): string =>
  ['SPECIFICATION Spec', 'CONSTANTS', ...constantLines(parsed, value), ...lines, ''].join('\n');

const listing = (section: Section, properties: readonly string[]): readonly string[] => (properties.length === 0 ? [] : [section, ...properties.map(property => `    ${property}`)]);

function checkHolds(model: Model, file: string, text: string): Check {
  const name = `${file} holds every property`;
  const parsed = parseConfig(text);
  const liveness = [...parsed.listed.PROPERTIES].filter(property => isLiveness(model, property));
  if (liveness.length === 0) {
    const run = runTlc(model.module, text);
    return run.clean ? pass(name, `No error has been found in ${String(run.distinctStates)} distinct states, checked in ${run.seconds.toFixed(1)} s`) : fail(name, failure(run));
  }
  const safety = runTlc(model.module, configOf(parsed, [...listing('INVARIANTS', [...parsed.listed.INVARIANTS]), ...listing('PROPERTIES', [...parsed.listed.PROPERTIES].filter(property => !isLiveness(model, property)))]));
  const settles = runTlc(model.module, configOf(parsed, listing('PROPERTIES', liveness)), kinds.liveness.tlc);
  const failed = [safety, settles].find(run => !run.clean);
  if (failed !== undefined) return fail(name, failure(failed));
  return pass(
    name,
    `No error has been found in ${String(safety.distinctStates)} distinct states, safety checked in ${safety.seconds.toFixed(1)} s and ${liveness.join(', ')} in ${settles.seconds.toFixed(1)} s over ${String(settles.distinctStates)} distinct states`,
  );
}

const mutantConfig = (text: string, mutant: AnyMutant, section: Section): string =>
  configOf(parseConfig(text), listing(section, [mutant.property]), (name, current) => (name === mutant.guard ? 'FALSE' : (mutant.overrides?.[name] ?? current)));

function checkMutant(model: Model, text: string, mutant: AnyMutant): Check {
  const kind = kinds[kindOf(model, mutant.property)];
  const violation = kind.violation(mutant.property);
  const run = runTlc(model.module, mutantConfig(text, mutant, kind.section), kind.tlc);
  const name = `${mutant.property} fails ${mutant.without === undefined ? `without ${mutant.guard}` : `when ${mutant.without}`}${mutant.shape === undefined ? '' : `, ${mutant.shape.label}`}`;
  const violated = run.error?.includes(violation) === true;
  const shaped = mutant.shape === undefined || mutant.shape.holds(run);
  const got = run.error ?? (run.clean ? 'no violation' : (run.output.trim().split('\n').at(-1) ?? 'no output'));
  const detail = `${traceLine(run)} (${run.seconds.toFixed(1)} s)`;
  return violated && shaped ? pass(name, detail) : fail(name, `expected ${violation}${shaped ? '' : ' with that trace'}, got ${got}; ${detail}`);
}

const readConfig = (module: URL, config: Config<string>): string => readFileSync(new URL(config.file, module), 'utf8');

function parseModelArgs(args: readonly string[]): { readonly nightly: boolean; readonly mutant: string | undefined } {
  const { values, positionals } = parseArgs({ args: [...args], options: { mutant: { type: 'string' } }, strict: true, allowPositionals: true });
  const unknown = positionals.filter(positional => positional !== 'nightly');
  if (unknown.length > 0) throw new Error(`a model scenario takes only nightly and --mutant <guard>, not ${unknown.join(' ')}`);
  return { nightly: positionals.includes('nightly'), mutant: values.mutant };
}

function runModel(model: Model, args: readonly string[]): readonly Check[] {
  const { configs, mutants } = model;
  const { nightly, mutant } = parseModelArgs(args);
  const prText = readConfig(model.module, configs.pr);
  if (mutant !== undefined) {
    const chosen = mutants.filter(candidate => candidate.guard === mutant);
    if (chosen.length === 0) throw new Error(`${model.name} has no mutant of a guard named ${mutant}; its guards are ${model.guards.join(', ')}`);
    return [checkConfig(model, configs.pr, prText), ...chosen.map(candidate => checkMutant(model, prText, candidate))];
  }
  const nightlyText = readConfig(model.module, configs.nightly);
  const nightlyReview = [checkConfig(model, configs.nightly, nightlyText), checkPlants(model, configs.nightly, nightlyText)];
  if (nightly) return [...nightlyReview, checkHolds(model, configs.nightly.file, nightlyText)];
  return [
    checkConfig(model, configs.pr, prText),
    checkPlants(model, configs.pr, prText),
    ...(configs.nightly.file === configs.pr.file ? [] : nightlyReview),
    checkHolds(model, configs.pr.file, prText),
    ...mutants.map(candidate => checkMutant(model, prText, candidate)),
  ];
}

export function defineModel<Guard extends string, Properties extends Readonly<Record<string, Section>>, Bound extends string, Setting extends string = never>(
  declaration: Declaration<Guard, Properties, Bound, Setting>,
): Scenario {
  const model: Model = declaration;
  return {
    name: `${declaration.name}-model`,
    summary: `model-checks ${moduleNameOf(declaration.module)}.tla in TLC, and proves each property fails without its guard; --mutant <guard> runs only that guard's mutants`,
    run: args => Promise.resolve(runModel(model, args)),
  };
}
