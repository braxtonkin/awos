import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type Reason = 'does not exist' | 'exports no properties object literal';

type SimulatorChecks = ReadonlySet<string> | Reason;

const root = fileURLToPath(new URL('../../', import.meta.url));
const features = join(root, 'features');
const configKeywords: ReadonlySet<string> = new Set([
  'SPECIFICATION',
  'INIT',
  'NEXT',
  'CONSTANT',
  'CONSTANTS',
  'INVARIANT',
  'INVARIANTS',
  'PROPERTY',
  'PROPERTIES',
  'SYMMETRY',
  'VIEW',
  'CONSTRAINT',
  'CONSTRAINTS',
  'ACTION_CONSTRAINT',
  'ACTION_CONSTRAINTS',
  'CHECK_DEADLOCK',
  'POSTCONDITION',
  'ALIAS',
]);
const propertyKeywords: ReadonlySet<string> = new Set(['INVARIANT', 'INVARIANTS', 'PROPERTY', 'PROPERTIES']);
const propertyName = /^[A-Za-z_]\w*$/;
const modelScenario = 'verify.ts';

function listedNames(config: string): readonly string[] {
  const names: string[] = [];
  let inPropertySection = false;
  for (const word of config.split(/\s+/)) {
    if (configKeywords.has(word)) inPropertySection = propertyKeywords.has(word);
    else if (inPropertySection && propertyName.test(word)) names.push(word);
  }
  return names;
}

const unwrapped = (expression: ts.Expression): ts.Expression =>
  ts.isSatisfiesExpression(expression) || ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression) ? unwrapped(expression.expression) : expression;

function simulatorChecks(path: string): SimulatorChecks {
  if (!existsSync(join(root, path))) return 'does not exist';
  const file = ts.createSourceFile(path, readFileSync(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true);
  const initializer = file.statements
    .filter(ts.isVariableStatement)
    .filter(statement => ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap(statement => statement.declarationList.declarations)
    .find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'properties')?.initializer;
  const literal = initializer === undefined ? undefined : unwrapped(initializer);
  if (literal === undefined || !ts.isObjectLiteralExpression(literal)) return 'exports no properties object literal';
  return new Set(literal.properties.flatMap(({ name }) => (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) ? [name.text] : [])));
}

const isCode = (path: string): boolean => /\.(?:ts|tsx|mts|cts)$/.test(path) && path !== modelScenario;

function uncheckedNames(folder: string): readonly string[] {
  const configs = readdirSync(join(features, folder), { withFileTypes: true })
    .filter(dirent => dirent.isFile() && dirent.name.endsWith('.cfg'))
    .map(dirent => dirent.name)
    .toSorted();
  if (configs.length === 0 || !readdirSync(join(features, folder), { recursive: true, encoding: 'utf8' }).some(isCode)) return [];
  const firstListings = new Map<string, string>();
  for (const config of configs) {
    for (const name of listedNames(readFileSync(join(features, folder, config), 'utf8'))) {
      if (!firstListings.has(name)) firstListings.set(name, config);
    }
  }
  const invariants = `features/${folder}/invariants.ts`;
  const checks = simulatorChecks(invariants);
  const because = typeof checks === 'string' ? `${checks}, so it ` : '';
  return [...firstListings]
    .filter(([name]) => typeof checks === 'string' || !checks.has(name))
    .map(([name, config]) => `${invariants} ${because}has no simulator check named ${name}, which features/${folder}/${config} lists (AGENTS.md rule C6).`);
}

const folders = existsSync(features) ? readdirSync(features, { withFileTypes: true }).filter(dirent => dirent.isDirectory()).map(dirent => dirent.name).toSorted() : [];
const violations = folders.flatMap(folder => uncheckedNames(folder));
for (const violation of violations) process.stdout.write(`${violation}\n`);
process.exitCode = violations.length === 0 ? 0 : 1;
