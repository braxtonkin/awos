import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import ts from 'typescript';
import { z } from 'zod';
import { parseWorkflow, workflowFile } from '../ci-local/workflow.ts';
import {
  budgetFile,
  budgetFolder,
  definitionOf,
  diskSource,
  effectiveCeilings,
  loadBudget,
  raisesFolder,
  roleKey,
  roleMeasures,
  secondsKey,
  stateKey,
  structureKey,
  structureNames,
  withCeilings,
  type Budget,
  type Ceilings,
  type Loaded,
  type Source,
  type StructureName,
} from './budget.ts';

type Widest = { readonly path: string; readonly line: number; readonly width: number };

type Measured = { readonly values: ReadonlyMap<string, number>; readonly widest: ReadonlyMap<string, readonly Widest[]>; readonly binary: readonly string[] };

const root = fileURLToPath(new URL('../../', import.meta.url));
const skipped = new Set(['.git', 'node_modules']);
const packageSchema = z.object({ dependencies: z.record(z.string(), z.string()).optional(), devDependencies: z.record(z.string(), z.string()).optional() });
const widestShown = 5;
const raiseCommand = 'npm run budget -- --raise <unit> --why "<why>"';

function* walk(prefix: string): Generator<string> {
  for (const dirent of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (skipped.has(dirent.name)) continue;
    const path = `${prefix}${dirent.name}`;
    if (dirent.isDirectory()) yield* walk(`${path}/`);
    else if (dirent.isFile()) yield path;
  }
}

const matchesAny = (path: string, globs: readonly string[]): boolean => globs.some(glob => matchesGlob(path, glob));

const read = (path: string): string => readFileSync(join(root, path), 'utf8');

const utf8 = new TextDecoder('utf-8', { fatal: true });

function textOf(path: string): string | undefined {
  const bytes = readFileSync(join(root, path));
  if (bytes.includes(0)) return undefined;
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

const upParts = (sql: string): string => sql.split(/^-- migrate:down.*$/m)[0] ?? '';

function schemaObjects(sql: string): { readonly tables: number; readonly named: number } {
  const tables = new Set<string>();
  const named = new Set<string>();
  const up = upParts(sql).toLowerCase();
  for (const [, table = ''] of up.matchAll(/\bcreate\s+table(?:\s+if\s+not\s+exists)?\s+([\w.]+)/g)) tables.add(table);
  for (const [, table = ''] of up.matchAll(/\bdrop\s+table(?:\s+if\s+exists)?\s+([\w.]+)/g)) tables.delete(table);
  for (const [, name = ''] of up.matchAll(/\b(?:constraint|create\s+(?:unique\s+)?index(?:\s+if\s+not\s+exists)?|create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger)\s+(\w+)/g)) named.add(name);
  for (const [, name = ''] of up.matchAll(/\bdrop\s+(?:constraint|index|trigger)(?:\s+if\s+exists)?\s+(\w+)/g)) named.delete(name);
  return { tables: tables.size, named: named.size };
}

function scenarioCount(paths: readonly string[]): number {
  let found = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const keys = new Set(node.properties.flatMap(property => (property.name !== undefined && ts.isIdentifier(property.name) ? [property.name.text] : [])));
      if (keys.has('name') && keys.has('summary') && keys.has('run')) found += 1;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineModel') found += 1;
    ts.forEachChild(node, visit);
  };
  for (const path of paths) visit(ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS));
  return found;
}

const folders = (parent: string): number => (existsSync(join(root, parent)) ? readdirSync(join(root, parent), { withFileTypes: true }).filter(dirent => dirent.isDirectory()).length : 0);

function structureOf(paths: readonly string[]): Readonly<Record<StructureName, number>> {
  const migrations = paths.filter(path => matchesGlob(path, 'db/migrations/*.sql'));
  const schema = migrations.map(path => schemaObjects(read(path)));
  const packages = packageSchema.parse(JSON.parse(read('package.json')));
  const workflow = existsSync(join(root, workflowFile)) ? parseWorkflow(read(workflowFile)) : { problems: [] };
  const jobs = 'workflow' in workflow ? Object.values(workflow.workflow.jobs) : [];
  return {
    features: folders('features'),
    services: folders('services'),
    migrations: migrations.length,
    tables: schema.reduce((sum, entry) => sum + entry.tables, 0),
    'named-constraints-indexes-triggers': schema.reduce((sum, entry) => sum + entry.named, 0),
    'tla-models': paths.filter(path => path.endsWith('.tla')).length,
    'runtime-dependencies': Object.keys(packages.dependencies ?? {}).length,
    'dev-dependencies': Object.keys(packages.devDependencies ?? {}).length,
    'verify-scenarios': scenarioCount(paths.filter(path => matchesAny(path, ['features/**/*.ts', 'tools/verify/**/*.ts']))),
    'ci-jobs': jobs.length,
    'ci-steps': jobs.reduce((sum, job) => sum + job.steps.length, 0),
  };
}

function measure(budget: Budget): Measured {
  const paths = [...walk('')].filter(path => !matchesAny(path, budget.exclude));
  const values = new Map<string, number>();
  const widest = new Map<string, Widest[]>();
  const binary: string[] = [];
  const breakable = budget.breakable ?? ['**'];
  for (const entry of budget.roles) for (const measureName of roleMeasures) if (entry[measureName] !== undefined) values.set(roleKey(measureName, entry.name), 0);
  for (const path of paths) {
    const owner = budget.roles.find(entry => matchesAny(path, entry.files));
    if (owner === undefined) continue;
    const text = textOf(path);
    if (text === undefined) {
      binary.push(path);
      continue;
    }
    const lines = text.split('\n').map(line => line.replace(/\r$/, ''));
    const add = (measureName: 'lines' | 'characters', amount: number): void => {
      const key = roleKey(measureName, owner.name);
      values.set(key, (values.get(key) ?? 0) + amount);
    };
    add('lines', lines.filter(line => line.trim() !== '').length);
    add('characters', lines.reduce((sum, line) => sum + line.replace(/\s/g, '').length, 0));
    const ceiling = owner['longest-line'];
    if (ceiling === undefined || !matchesAny(path, breakable)) continue;
    const longest = roleKey('longest-line', owner.name);
    lines.forEach((line, index) => {
      if (line.length > (values.get(longest) ?? 0)) values.set(longest, line.length);
      if (line.length > ceiling) widest.set(owner.name, [...(widest.get(owner.name) ?? []), { path, line: index + 1, width: line.length }]);
    });
  }
  const structure = structureOf(paths);
  for (const entry of structureNames) values.set(structureKey(entry), structure[entry]);
  return { values, widest, binary };
}

function coverage(budget: Budget, ceilings: Ceilings): readonly string[] {
  if (!existsSync(join(root, workflowFile))) return [];
  const workflow = parseWorkflow(read(workflowFile));
  if ('problems' in workflow) return workflow.problems;
  const jobs = Object.keys(workflow.workflow.jobs);
  return [
    ...jobs.filter(job => !ceilings.has(secondsKey(job))).map(job => `${workflowFile} job ${job} has no ${secondsKey(job)} ceiling. Add one of about twice its measured time in a commit of its own, through ${raiseCommand} --add ${secondsKey(job)}=<seconds>.`),
    ...Object.keys(budget.seconds.ceilings).filter(job => !jobs.includes(job)).map(job => `${budgetFile} ${secondsKey(job)} names a job that ${workflowFile} does not have. Delete the ceiling.`),
  ];
}

function overruns(loaded: Loaded, measured: Measured): readonly string[] {
  const ceilings = effectiveCeilings(loaded.budget, loaded.raises);
  const found: string[] = [];
  for (const [key, value] of measured.values) {
    const ceiling = ceilings.get(key) ?? 0;
    if (value <= ceiling) continue;
    const [kind = '', subject = ''] = key.split('/');
    const wide = kind === 'longest-line' ? (measured.widest.get(subject) ?? []).filter(line => line.width > ceiling) : [];
    if (wide.length > 0) {
      for (const line of wide.slice(0, widestShown)) found.push(`${line.path}:${String(line.line)} is ${String(line.width)} characters wide, over the ${key} ceiling of ${String(ceiling)}. Break the line, because this ceiling only goes down.`);
      if (wide.length > widestShown) found.push(`${budgetFile} ${key} is also passed by ${String(wide.length - widestShown)} more lines`);
    } else {
      found.push(`${budgetFile} ${key} is ${String(value)}, over its ceiling of ${String(ceiling)} by ${String(value - ceiling)}. Shrink the change, or raise the ceiling in a commit of its own: ${raiseCommand}`);
    }
  }
  return found;
}

const loadedOrReported = (source: Source): Loaded | undefined => {
  const loaded = loadBudget(source);
  if ('unreadable' in loaded) {
    process.stdout.write(`${loaded.unreadable}\n`);
    return undefined;
  }
  for (const problem of loaded.problems) process.stdout.write(`${problem}\n`);
  return loaded.problems.length === 0 ? loaded : undefined;
};

function git(args: readonly string[]): { readonly ok: boolean; readonly out: string; readonly err: string } {
  const result = spawnSync('git', ['-c', `safe.directory=${root.replace(/[\\/]$/, '')}`, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, out: result.stdout, err: result.stderr.trim() };
}

function gitSource(commit: string): Source {
  return {
    read: path => {
      const shown = git(['show', `${commit}:${path}`]);
      return shown.ok ? shown.out : undefined;
    },
    list: folder => git(['ls-tree', '--name-only', commit, `${folder}/`]).out.split('\n').filter(line => line !== '').map(path => basename(path)),
  };
}

type Snapshot = { readonly ceilings: Ceilings; readonly definition: string } | undefined;

function snapshotAt(commit: string): Snapshot {
  const loaded = loadBudget(gitSource(commit));
  return 'unreadable' in loaded ? undefined : { ceilings: effectiveCeilings(loaded.budget, loaded.raises), definition: definitionOf(loaded.budget) };
}

function raisesBetween(before: Snapshot, after: Snapshot): readonly string[] {
  if (after === undefined) return before === undefined ? [] : [`leaves ${budgetFile} unreadable`];
  if (before === undefined) return [`adds ${budgetFile}`];
  const raised = [...after.ceilings].filter(([key, ceiling]) => ceiling > (before.ceilings.get(key) ?? -1)).map(([key, ceiling]) => `raises ${key} from ${before.ceilings.has(key) ? String(before.ceilings.get(key)) : 'nothing'} to ${String(ceiling)}`);
  return [...raised, ...(before.definition === after.definition ? [] : [`changes the roles, whys, or exclusions in ${budgetFile}`])];
}

function checkRange(since: string): number {
  const listed = git(['rev-list', '--no-merges', '--reverse', `${since}..HEAD`]);
  if (!listed.ok) {
    process.stdout.write(`${budgetFile} could not list the commits in ${since}..HEAD: ${listed.err}\n`);
    return 1;
  }
  const commits = listed.out.split('\n').filter(line => line !== '');
  const found: string[] = [];
  for (const commit of commits) {
    const parent = git(['rev-parse', '--verify', '--quiet', `${commit}^`]);
    const changes = raisesBetween(parent.ok ? snapshotAt(parent.out.trim()) : undefined, snapshotAt(commit));
    if (changes.length === 0) continue;
    const others = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', commit]).out.split('\n').filter(path => path !== '' && !path.startsWith(`${budgetFolder}/`));
    if (others.length > 0) found.push(`${commit.slice(0, 12)} ${changes.join(', ')}, and also changes ${others.join(', ')}. A commit that raises a ceiling changes only files under ${budgetFolder}/, so a reviewer sees each growth decision on its own.`);
  }
  for (const line of found) process.stdout.write(`${line}\n`);
  if (found.length === 0) process.stdout.write(`${String(commits.length)} commits in ${since}..HEAD raise a ceiling only in commits of their own.\n`);
  return found.length === 0 ? 0 : 1;
}

function report(loaded: Loaded, measured: Measured): void {
  const ceilings = effectiveCeilings(loaded.budget, loaded.raises);
  const keys = [...new Set([...measured.values.keys(), ...ceilings.keys()])];
  for (const key of keys) process.stdout.write(`${key.padEnd(44)}${String(measured.values.get(key) ?? '-').padStart(10)}${String(ceilings.get(key) ?? '-').padStart(10)}\n`);
}

function statesFrom(log: string): ReadonlyMap<string, number> {
  return new Map([...readFileSync(log, 'utf8').matchAll(/\b(\w+) explores (\d+) distinct states\b/g)].map(([, model = '', states = '']): [string, number] => [stateKey(model), Number(states)]));
}

function lower(loaded: Loaded, measured: Measured, statesLog: string | undefined): number {
  const dirty = git(['status', '--porcelain']);
  if (!dirty.ok || dirty.out.trim() !== '') {
    process.stdout.write(`${budgetFile} is lowered only from a clean, committed worktree, so the ceilings match what landed:\n${dirty.ok ? dirty.out : dirty.err}\n`);
    return 1;
  }
  const over = overruns(loaded, measured);
  const states = statesLog === undefined ? new Map<string, number>() : statesFrom(statesLog);
  const ceilings = effectiveCeilings(loaded.budget, loaded.raises);
  const overStates = [...states].filter(([key, value]) => value > (ceilings.get(key) ?? 0)).map(([key, value]) => `${budgetFile} ${key} is ${String(value)}, over its ceiling of ${String(ceilings.get(key) ?? 0)}`);
  if (over.length + overStates.length > 0) {
    for (const line of [...over, ...overStates]) process.stdout.write(`${line}\n`);
    process.stdout.write('Nothing was lowered, because what landed is over budget.\n');
    return 1;
  }
  const next = new Map([...ceilings, ...measured.values, ...states]);
  const changed = [...next].filter(([key, value]) => value !== ceilings.get(key)).map(([key, value]) => `${key} ${String(ceilings.get(key) ?? '-')} -> ${String(value)}`);
  writeFileSync(join(root, budgetFile), `${JSON.stringify(withCeilings(loaded.budget, next), null, 2)}\n`);
  for (const raise of loaded.raises) rmSync(join(root, raise.file));
  process.stdout.write(`Lowered ${String(changed.length)} ceilings to what landed${changed.length === 0 ? '.' : `:\n  ${changed.join('\n  ')}`}\n`);
  if (loaded.raises.length > 0) process.stdout.write(`Folded ${String(loaded.raises.length)} raises:\n${loaded.raises.map(raise => `  ${raise.file}: ${raise.why}`).join('\n')}\n`);
  process.stdout.write(`Commit ${budgetFolder}/ on its own.\n`);
  return 0;
}

function raise(loaded: Loaded, measured: Measured, unit: string, why: string, adds: readonly string[]): number {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(unit)) {
    process.stdout.write(`--raise takes a unit name of lowercase letters, digits, and dashes, not ${unit}\n`);
    return 2;
  }
  const ceilings = effectiveCeilings(loaded.budget, loaded.raises);
  const amounts = new Map<string, number>();
  for (const [key, value] of measured.values) if (value > (ceilings.get(key) ?? 0) && !key.startsWith('longest-line/')) amounts.set(key, value - (ceilings.get(key) ?? 0));
  for (const add of adds) {
    const [, key = '', amount = ''] = /^([\w-]+\/[\w-]+)=(\d+)$/.exec(add) ?? [];
    if (key === '' || Number(amount) <= 0) {
      process.stdout.write(`--add takes <area>=<positive amount>, such as ${stateKey('Tasks')}=1000, not ${add}\n`);
      return 2;
    }
    amounts.set(key, (amounts.get(key) ?? 0) + Number(amount));
  }
  if (amounts.size === 0) {
    process.stdout.write('Every area is within its ceiling, so there is nothing to raise.\n');
    return 0;
  }
  const wide = overruns(loaded, measured).filter(line => !line.startsWith(budgetFile));
  for (const line of wide) process.stdout.write(`${line}
`);
  const file = `${raisesFolder}/${unit}.json`;
  const earlier = loaded.raises.find(entry => entry.file === file);
  const total = new Map(Object.entries(earlier?.raise ?? {}));
  for (const [key, amount] of amounts) total.set(key, (total.get(key) ?? 0) + amount);
  mkdirSync(join(root, raisesFolder), { recursive: true });
  writeFileSync(join(root, file), `${JSON.stringify({ why, raise: Object.fromEntries([...total].toSorted(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`);
  process.stdout.write(`Wrote ${file}:\n${[...amounts].map(([key, amount]) => `  ${key} +${String(amount)}`).join('\n')}\nCommit it on its own: git add ${file} && git commit -m "budget: raise for ${unit}"\n`);
  const check = loadBudget(diskSource(root));
  return 'unreadable' in check || check.problems.length > 0 ? 1 : 0;
}

function main(): number {
  const { values } = parseArgs({
    options: {
      report: { type: 'boolean' },
      lower: { type: 'boolean' },
      states: { type: 'string' },
      raise: { type: 'string' },
      why: { type: 'string' },
      add: { type: 'string', multiple: true },
      since: { type: 'string' },
      'since-pr-base': { type: 'boolean' },
    },
    strict: true,
  });
  if (values['since-pr-base'] === true) {
    const base = process.env['GITHUB_BASE_REF'] ?? '';
    if (base === '') {
      process.stdout.write('GITHUB_BASE_REF is not set, so no pull request range was checked. Outside a pull request, run npm run budget -- --since <base>.\n');
      return 0;
    }
    return checkRange(`origin/${base}`);
  }
  if (values.since !== undefined) return checkRange(values.since);
  const loaded = loadedOrReported(diskSource(root));
  if (loaded === undefined) return 1;
  const measured = measure(loaded.budget);
  if (values.raise !== undefined) {
    if (values.why === undefined || values.why.trim() === '') {
      process.stdout.write('--raise needs --why "<why the codebase needs this room>"\n');
      return 2;
    }
    return raise(loaded, measured, values.raise, values.why, values.add ?? []);
  }
  if (values.lower === true) return lower(loaded, measured, values.states);
  if (values.report === true) report(loaded, measured);
  if (measured.binary.length > 0) process.stdout.write(`Skipped ${String(measured.binary.length)} binary files, which hold a NUL byte or are not UTF-8: ${measured.binary.join(', ')}\n`);
  const found = [...overruns(loaded, measured), ...coverage(loaded.budget, effectiveCeilings(loaded.budget, loaded.raises))];
  for (const line of found) process.stdout.write(`${line}\n`);
  return found.length === 0 ? 0 : 1;
}

process.exitCode = main();
