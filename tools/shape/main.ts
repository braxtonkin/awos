import { readdirSync, readFileSync, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type Entry = { readonly path: string; readonly dirent: Dirent };

type Rule = { readonly breaks: (entry: Entry) => boolean; readonly problem: string };

const root = fileURLToPath(new URL('../../', import.meta.url));
const skippedAtRoot = new Set(['.git', 'node_modules']);
const packagesFolder = 'node_modules';
const buildFolder = '.next';
const sandboxConfig = 'features/e2e/sandbox/tsconfig.json';
const dashboardConfig = 'services/dashboard/tsconfig.dashboard.json';
const allowedConfigs: ReadonlySet<string> = new Set(['tsconfig.json', dashboardConfig, sandboxConfig]);
const dashboardOptions: ReadonlySet<string> = new Set(['lib', 'module', 'moduleResolution']);
const dashboardKeys: ReadonlySet<string> = new Set(['extends', 'compilerOptions', 'include', 'exclude']);
const agentToolingFolder = '.claude/';
const folderName = /^[a-z][a-z0-9-]*$/;
const configFile = /\.(json|ya?ml)$/;
const libCheckFlag = /skiplibcheck/i;

function* walk(prefix: string): Generator<Entry> {
  for (const dirent of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = `${prefix}${dirent.name}`;
    if (skippedAtRoot.has(path)) continue;
    yield { path, dirent };
    if (dirent.isDirectory() && dirent.name !== packagesFolder && dirent.name !== buildFolder) yield* walk(`${path}/`);
  }
}

const withoutFileLists: ts.ParseConfigHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: () => [],
  fileExists: path => ts.sys.fileExists(path),
  readFile: path => ts.sys.readFile(path),
};

function inheritsSkipLibCheck(file: string): boolean {
  const config: unknown = ts.readConfigFile(file, path => ts.sys.readFile(path)).config;
  if (typeof config !== 'object' || config === null || !('extends' in config)) return false;
  return ts.parseJsonConfigFileContent(config, withoutFileLists, dirname(file), undefined, file).options.skipLibCheck === true;
}

function skipsLibCheck({ path, dirent }: Entry): boolean {
  if (!dirent.isFile() || !configFile.test(path) || path.startsWith(agentToolingFolder)) return false;
  const file = join(root, path);
  return libCheckFlag.test(readFileSync(file, 'utf8')) || (path.endsWith('.json') && inheritsSkipLibCheck(file));
}

const isConfig = ({ path, dirent }: Entry): boolean => dirent.isFile() && /(^|\/)tsconfig[^/]*\.json$/.test(path) && !path.startsWith(agentToolingFolder);

function loosensDashboard(entry: Entry): boolean {
  if (entry.path !== dashboardConfig) return false;
  const config: unknown = ts.readConfigFile(join(root, entry.path), path => ts.sys.readFile(path)).config;
  if (typeof config !== 'object' || config === null) return true;
  const options = 'compilerOptions' in config && typeof config.compilerOptions === 'object' && config.compilerOptions !== null ? Object.keys(config.compilerOptions) : [];
  const extendsRoot = 'extends' in config && config.extends === '../../tsconfig.json';
  return !extendsRoot || Object.keys(config).some(key => !dashboardKeys.has(key)) || options.some(option => !dashboardOptions.has(option));
}

const rules: readonly Rule[] = [
  {
    breaks: ({ dirent }) => dirent.isSymbolicLink(),
    problem: 'is a symbolic link. Replace it with the real file or folder, because a link can hide its target from the import rules and lint (AGENTS.md rules A5 and B2).',
  },
  {
    breaks: ({ path, dirent }) => dirent.name === packagesFolder && !path.startsWith(agentToolingFolder),
    problem: 'is a node_modules folder below the root. Install packages only at the root, because the import rules and lint skip the code inside it (AGENTS.md rules A5 and B2).',
  },
  {
    breaks: ({ path, dirent }) => dirent.isDirectory() && /^(features|services)\/[^/]+$/.test(path) && !folderName.test(dirent.name),
    problem: `must match ${folderName.source}, because the import rules put each folder name under features/ and services/ into a pattern (AGENTS.md rule A5)`,
  },
  {
    breaks: entry => isConfig(entry) && !allowedConfigs.has(entry.path),
    problem: `is a tsconfig beside the root one, ${dashboardConfig}, and the end-to-end sandbox's own ${sandboxConfig}. Type-check code with one of those, because a nested config can loosen a strict flag for the files it covers (AGENTS.md rule A7).`,
  },
  {
    breaks: loosensDashboard,
    problem: 'must extend ../../tsconfig.json and change only lib, module, and moduleResolution, besides include and exclude, so the dashboard keeps every strict flag of the root config (AGENTS.md rule A7).',
  },
  {
    breaks: skipsLibCheck,
    problem: "names skipLibCheck or extends a config that turns it on. Declare the names a package's types miss in a .d.ts named for that package instead, because skipLibCheck hides every error in every package's declarations (AGENTS.md Package types, rule A7).",
  },
];

const violations = [...walk('')].flatMap(entry => rules.filter(rule => rule.breaks(entry)).map(rule => `${entry.path} ${rule.problem}`));
for (const violation of violations) process.stdout.write(`${violation}\n`);
process.exitCode = violations.length === 0 ? 0 : 1;
