import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fail, pass, type Check, type Scenario } from '../../tools/verify/check.ts';
import { checkModel, type TlcRun } from '../../tools/verify/tlc.ts';

type Mutant = {
  readonly guard: string;
  readonly without: string;
  readonly kind: 'INVARIANT' | 'PROPERTY';
  readonly property: string;
  readonly violation: string;
};

const folder = fileURLToPath(new URL('.', import.meta.url));

const invariant = (guard: string, without: string, property: string): Mutant => ({
  guard,
  without,
  kind: 'INVARIANT',
  property,
  violation: `Invariant ${property} is violated`,
});

const action = (guard: string, without: string, property: string): Mutant => ({
  guard,
  without,
  kind: 'PROPERTY',
  property,
  violation: `Action property ${property} is violated`,
});

const mutants: readonly Mutant[] = [
  invariant('ClaimIsExclusive', 'a checker can claim while another check is live', 'OneLiveCheck'),
  invariant('RefreshIsClaimedOnce', 'a checker can claim a login whose refresh an earlier check already claimed', 'NoRefreshTokenReused'),
  action('WriteBackNeedsOpenedLogin', 'a checker writes its fresh pair back over a login it did not open', 'StoredLoginIsNewest'),
  invariant('JobCopyIsAccessOnly', "a Job's copy keeps the refresh token", 'JobsNeverRefresh'),
  invariant('DeathKeepsRefreshClaim', 'a check that presented the refresh token and then died releases its refresh claim', 'NoRefreshTokenReused'),
  invariant('ClaimNeedsDueLogin', 'a checker claims a login it read before another check finished it or someone replaced it', 'OneCheckPerLogin'),
  action('FinishNeedsClaim', 'a checker finishes a check after its claim was reaped', 'FinishedCheckIsFinal'),
];

const readConfig = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8');

const typeInvariant = 'TypeOK';

const bounds = ['Checkers', 'MaxLogins', 'MaxRefreshes', 'MaxChecks', 'MaxCrashes', 'MaxJobs'] as const;

type Bound = (typeof bounds)[number];

const floors: Readonly<Record<string, Readonly<Record<Bound, number>>>> = {
  'Checks.cfg': { Checkers: 3, MaxLogins: 2, MaxRefreshes: 3, MaxChecks: 4, MaxCrashes: 1, MaxJobs: 1 },
};

type Section = 'CONSTANTS' | 'INVARIANTS' | 'PROPERTIES';

type ConfigShape = {
  readonly constants: ReadonlyMap<string, string>;
  readonly listed: Readonly<Record<Mutant['kind'], ReadonlySet<string>>>;
  readonly problems: readonly string[];
};

const sections: readonly Section[] = ['CONSTANTS', 'INVARIANTS', 'PROPERTIES'];

const isSection = (line: string): line is Section => sections.some(section => section === line);

function parseConfig(config: string): ConfigShape {
  const constants = new Map<string, string>();
  const invariants = new Set<string>();
  const properties = new Set<string>();
  const problems: string[] = [];
  let section: Section | undefined;
  for (const line of config.split('\n').map(raw => raw.trimEnd())) {
    const assignment = /^ {4}(\w+) = (\S.*)$/.exec(line);
    const listed = /^ {4}(\w+)$/.exec(line)?.[1];
    if (line === '' || line === 'SPECIFICATION Spec') continue;
    if (/\\\*|\(\*/.test(line)) problems.push(`comment in "${line}"`);
    else if (isSection(line)) section = line;
    else if (section === 'CONSTANTS' && assignment !== null) {
      const [, name = '', value = ''] = assignment;
      if (constants.has(name)) problems.push(`${name} is assigned twice`);
      constants.set(name, value.trim());
    } else if (section === 'INVARIANTS' && listed !== undefined) invariants.add(listed);
    else if (section === 'PROPERTIES' && listed !== undefined) properties.add(listed);
    else problems.push(`unexpected line "${line}"`);
  }
  return { constants, listed: { INVARIANT: invariants, PROPERTY: properties }, problems };
}

function boundOf(constants: ReadonlyMap<string, string>, bound: Bound): number | undefined {
  const value = constants.get(bound);
  if (value === undefined) return undefined;
  return value.startsWith('{') ? new Set(value.replace(/[{}\s]/g, '').split(',').filter(item => item !== '')).size : Number(value);
}

type ConfigReview = { readonly findings: readonly string[]; readonly summary: string };

function reviewConfig(file: string, config: string): ConfigReview {
  const { constants, listed, problems } = parseConfig(config);
  const floor = floors[file];
  const everyListed = [...listed.INVARIANT, ...listed.PROPERTY];
  const broken = new Set(mutants.map(mutant => mutant.property));
  const mutated = new Set(mutants.map(mutant => mutant.guard));
  const guards = [...constants].filter(([, value]) => value === 'TRUE').map(([name]) => name);
  const findings = [
    ...problems,
    ...(listed.INVARIANT.has(typeInvariant) ? [] : [`${typeInvariant} is not listed under INVARIANTS`]),
    ...mutants.filter(mutant => !listed[mutant.kind].has(mutant.property)).map(mutant => `${mutant.property} is not listed under ${mutant.kind === 'INVARIANT' ? 'INVARIANTS' : 'PROPERTIES'}`),
    ...mutants.filter(mutant => constants.get(mutant.guard) !== 'TRUE').map(mutant => `guard ${mutant.guard} is not set to TRUE`),
    ...everyListed.filter(property => property !== typeInvariant && !broken.has(property)).map(property => `${property} has no mutant`),
    ...guards.filter(guard => !mutated.has(guard)).map(guard => `guard ${guard} has no mutant`),
    ...(floor === undefined
      ? [`${file} has no floors`]
      : bounds.flatMap(bound => {
          const value = boundOf(constants, bound);
          return value !== undefined && value >= floor[bound] ? [] : [`${bound} is ${String(value)}, below its floor of ${String(floor[bound])}`];
        })),
  ];
  return { findings: [...new Set(findings)], summary: `${String(broken.size)} properties, ${String(guards.length)} guards` };
}

function checkConfig(file: string): Check {
  const { findings, summary } = reviewConfig(file, readConfig(file));
  const name = `${file} lists each property in its section with a mutant, every guard with a mutant, and bounds no lower than its floors`;
  return findings.length === 0 ? pass(name, summary) : fail(name, findings.join('; '));
}

type Plant = { readonly change: string; readonly harmful: boolean; readonly edit: (config: string) => string };

const plants: readonly Plant[] = [
  { change: 'a comment hides a smaller Checkers', harmful: true, edit: config => config.replace('    Checkers = {c1, c2, c3}', '    Checkers = {c1} \\* {c1, c2, c3}') },
  { change: 'a comment follows a guard', harmful: true, edit: config => config.replace('    JobCopyIsAccessOnly = TRUE', '    JobCopyIsAccessOnly = TRUE \\* access only') },
  { change: 'an invariant moves under PROPERTIES', harmful: true, edit: config => config.replace('    OneLiveCheck\n', '').replace('PROPERTIES\n', 'PROPERTIES\n    OneLiveCheck\n') },
  { change: 'Checkers is assigned twice', harmful: true, edit: config => config.replace('    MaxLogins =', '    Checkers = {c1}\n    MaxLogins =') },
  { change: 'Checkers repeats a member', harmful: true, edit: config => config.replace('{c1, c2, c3}', '{c1, c1, c3}') },
  { change: 'MaxChecks drops below its floor', harmful: true, edit: config => config.replace('    MaxChecks = 4', '    MaxChecks = 2') },
  { change: 'a guard is set to FALSE', harmful: true, edit: config => config.replace('    WriteBackNeedsOpenedLogin = TRUE', '    WriteBackNeedsOpenedLogin = FALSE') },
  { change: 'TypeOK is dropped', harmful: true, edit: config => config.replace('    TypeOK\n', '') },
  { change: 'a line ends in a tab', harmful: false, edit: config => config.replace('    TypeOK\n', '    TypeOK\t\n') },
  { change: 'a blank line holds spaces', harmful: false, edit: config => config.replace('\nINVARIANTS', '\n    \nINVARIANTS') },
  { change: 'lines end in CRLF', harmful: false, edit: config => config.replace(/\n/g, '\r\n') },
];

function checkPlants(file: string): Check {
  const config = readConfig(file);
  const misses = plants.flatMap(plant => {
    const planted = plant.edit(config);
    if (planted === config) return [`${plant.change} no longer changes ${file}`];
    const rejected = reviewConfig(file, planted).findings.length > 0;
    return rejected === plant.harmful ? [] : [`${plant.change} is ${rejected ? 'rejected' : 'accepted'}`];
  });
  const name = `the review of ${file} rejects each harmful plant and accepts each harmless one`;
  return misses.length === 0 ? pass(name, `${String(plants.length)} plants`) : fail(name, misses.join('; '));
}

function mutantConfig(config: string, mutant: Mutant): string {
  const [constants = '', properties] = config.split('\nINVARIANTS');
  if (properties === undefined || !constants.includes(`${mutant.guard} = TRUE`)) throw new Error(`Checks.cfg must set ${mutant.guard} = TRUE before its INVARIANTS`);
  return `${constants.replace(`${mutant.guard} = TRUE`, `${mutant.guard} = FALSE`)}\n${mutant.kind}\n    ${mutant.property}\n`;
}

const traceLine = (run: TlcRun): string => run.trace.map(state => state.action).join(' -> ');

function checkHolds(file: string): Check {
  const run = checkModel(folder, 'Checks', readConfig(file));
  const name = `${file} holds every property`;
  return run.clean
    ? pass(name, `${String(run.distinctStates)} distinct states in ${run.seconds.toFixed(1)} s, no error has been found`)
    : fail(name, run.error ?? run.output.trim().split('\n').slice(-3).join(' | '));
}

function checkMutant(config: string, mutant: Mutant): Check {
  const run = checkModel(folder, 'Checks', mutantConfig(config, mutant), '1');
  const name = `${mutant.property} fails when ${mutant.without}`;
  const got = run.error ?? (run.clean ? 'no violation' : (run.output.trim().split('\n').at(-1) ?? 'no output'));
  return run.error?.includes(mutant.violation) === true ? pass(name, traceLine(run)) : fail(name, `expected ${mutant.violation}, got ${got}`);
}

export const checksModel: Scenario = {
  name: 'checks-model',
  summary: 'model-checks how checkers claim, refresh, and write back one shared credential in TLC, and proves each property fails without its guard',
  run: args => {
    const file = 'Checks.cfg';
    if (args.includes('nightly')) return Promise.resolve([checkConfig(file), checkPlants(file), checkHolds(file)]);
    const config = readConfig(file);
    return Promise.resolve([checkConfig(file), checkPlants(file), checkHolds(file), ...mutants.map(mutant => checkMutant(config, mutant))]);
  },
};
