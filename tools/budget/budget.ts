import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const budgetFolder = 'budget';
export const budgetFile = `${budgetFolder}/budget.json`;
export const raisesFolder = `${budgetFolder}/raises`;

export const roleMeasures = ['lines', 'characters', 'longest-line'] as const;

export type RoleMeasure = (typeof roleMeasures)[number];

const count = z.number().int().nonnegative();
const why = z.string().trim().min(1);
const plainName = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

const area = z.strictObject({ why, ceiling: count });

const structure = z.strictObject({
  features: area,
  services: area,
  migrations: area,
  tables: area,
  'named-constraints-indexes-triggers': area,
  'tla-models': area,
  'runtime-dependencies': area,
  'dev-dependencies': area,
  'verify-scenarios': area,
  'ci-jobs': area,
  'ci-steps': area,
});

export const structureNames = structure.keyof().options;

export type StructureName = (typeof structureNames)[number];

const role = z.strictObject({
  name: z.string().regex(plainName),
  why,
  files: z.array(z.string().min(1)).min(1),
  lines: count,
  characters: count,
  'longest-line': count,
});

const keyed = z.strictObject({ why, ceilings: z.record(z.string().regex(plainName), count) });

const budgetSchema = z.strictObject({
  exclude: z.array(z.string().min(1)),
  roles: z.array(role).min(1),
  structure,
  states: keyed,
  seconds: keyed,
});

export type Budget = z.infer<typeof budgetSchema>;

export type Role = Budget['roles'][number];

const raiseSchema = z.strictObject({ why, raise: z.record(z.string(), z.number().int().positive()) });

export type Raise = z.infer<typeof raiseSchema> & { readonly file: string };

export type Ceilings = ReadonlyMap<string, number>;

export const roleKey = (measure: RoleMeasure, roleName: string): string => `${measure}/${roleName}`;
export const structureKey = (entry: StructureName): string => `structure/${entry}`;
export const stateKey = (model: string): string => `states/${model}`;
export const secondsKey = (job: string): string => `seconds/${job}`;

export function ceilingsOf(budget: Budget): Ceilings {
  return new Map([
    ...budget.roles.flatMap(entry => roleMeasures.map((measure): [string, number] => [roleKey(measure, entry.name), entry[measure]])),
    ...structureNames.map((entry): [string, number] => [structureKey(entry), budget.structure[entry].ceiling]),
    ...Object.entries(budget.states.ceilings).map(([model, ceiling]): [string, number] => [stateKey(model), ceiling]),
    ...Object.entries(budget.seconds.ceilings).map(([job, ceiling]): [string, number] => [secondsKey(job), ceiling]),
  ]);
}

function prefixed(ceilings: Ceilings, prefix: string): Record<string, number> {
  const entries = [...ceilings].filter(([key]) => key.startsWith(prefix)).map(([key, ceiling]): [string, number] => [key.slice(prefix.length), ceiling]);
  return Object.fromEntries(entries.toSorted(([a], [b]) => a.localeCompare(b)));
}

export function withCeilings(budget: Budget, ceilings: Ceilings): Budget {
  const at = (key: string, fallback: number): number => ceilings.get(key) ?? fallback;
  const nextStructure = { ...budget.structure };
  for (const entry of structureNames) nextStructure[entry] = { ...budget.structure[entry], ceiling: at(structureKey(entry), budget.structure[entry].ceiling) };
  return {
    exclude: budget.exclude,
    roles: budget.roles.map(entry => ({
      ...entry,
      lines: at(roleKey('lines', entry.name), entry.lines),
      characters: at(roleKey('characters', entry.name), entry.characters),
      'longest-line': at(roleKey('longest-line', entry.name), entry['longest-line']),
    })),
    structure: nextStructure,
    states: { why: budget.states.why, ceilings: prefixed(ceilings, 'states/') },
    seconds: { why: budget.seconds.why, ceilings: prefixed(ceilings, 'seconds/') },
  };
}

export const definitionOf = (budget: Budget): string => JSON.stringify(withCeilings(budget, new Map([...ceilingsOf(budget)].map(([key]) => [key, 0]))));

function raiseKeyProblem(budget: Budget, key: string): string | undefined {
  const [kind = '', ...rest] = key.split('/');
  const subject = rest.join('/');
  if (kind === 'states' || kind === 'seconds') return plainName.test(subject) ? undefined : `names ${key}, whose ${kind} subject is not a plain name`;
  if (kind === 'structure') return structureNames.some(entry => entry === subject) ? undefined : `names ${key}, which is not one of the counted structures: ${structureNames.join(', ')}`;
  if (kind === 'longest-line') return `names ${key}. A longest-line ceiling only goes down, so break the line instead`;
  if (roleMeasures.some(measure => measure === kind)) return budget.roles.some(entry => entry.name === subject) ? undefined : `names ${key}, but ${budgetFile} declares no role named ${subject}`;
  return `names ${key}, which is not a budget area. Areas are ${roleMeasures.join(', ')}/<role>, structure/<name>, states/<model>, and seconds/<ci job>`;
}

export function effectiveCeilings(budget: Budget, raises: readonly Raise[]): Ceilings {
  const ceilings = new Map(ceilingsOf(budget));
  for (const raise of raises) for (const [key, amount] of Object.entries(raise.raise)) ceilings.set(key, (ceilings.get(key) ?? 0) + amount);
  return ceilings;
}

export type Loaded = { readonly budget: Budget; readonly raises: readonly Raise[]; readonly problems: readonly string[] };

export type Source = { readonly read: (path: string) => string | undefined; readonly list: (folder: string) => readonly string[] };

export const diskSource = (root: string): Source => ({
  read: path => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : undefined),
  list: folder => (existsSync(join(root, folder)) ? readdirSync(join(root, folder)) : []),
});

function parsed<T>(schema: z.ZodType<T>, path: string, text: string): { readonly value: T } | { readonly problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { problem: `${path} is not JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const result = schema.safeParse(json);
  return result.success ? { value: result.data } : { problem: `${path} ${z.prettifyError(result.error).replaceAll('\n', ' ')}` };
}

export function loadBudget(source: Source): Loaded | { readonly unreadable: string } {
  const text = source.read(budgetFile);
  if (text === undefined) return { unreadable: `${budgetFile} does not exist` };
  const read = parsed(budgetSchema, budgetFile, text);
  if ('problem' in read) return { unreadable: read.problem };
  const problems: string[] = [];
  const raises: Raise[] = [];
  for (const entry of source.list(raisesFolder).toSorted()) {
    const file = `${raisesFolder}/${entry}`;
    const raise = entry.endsWith('.json') ? parsed(raiseSchema, file, source.read(file) ?? '') : { problem: `${file} is not a .json raise file` };
    if ('problem' in raise) {
      problems.push(raise.problem);
      continue;
    }
    for (const key of Object.keys(raise.value.raise)) {
      const problem = raiseKeyProblem(read.value, key);
      if (problem !== undefined) problems.push(`${file} ${problem}`);
    }
    raises.push({ ...raise.value, file });
  }
  const names = read.value.roles.map(entry => entry.name);
  for (const duplicate of new Set(names.filter((entry, index) => names.indexOf(entry) !== index))) problems.push(`${budgetFile} declares the role ${duplicate} twice`);
  return { budget: read.value, raises, problems };
}

export function ceilingsAt(root: string): Ceilings | string {
  const loaded = loadBudget(diskSource(root));
  if ('unreadable' in loaded) return loaded.unreadable;
  const [problem] = loaded.problems;
  return problem ?? effectiveCeilings(loaded.budget, loaded.raises);
}
