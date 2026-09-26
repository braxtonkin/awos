import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type Name = { readonly name: string; readonly what: string; readonly isWorkflow: boolean };

type Found = { readonly path: string; readonly line: number; readonly problem: string };

const root = fileURLToPath(new URL('../../', import.meta.url));
const executionFolders = ['features/tasks', 'services/engine', 'services/dashboard'] as const;
const verificationFiles: ReadonlySet<string> = new Set(['verify.ts', 'simulate.ts', 'invariants.ts', 'failed-seeds.ts', 'catalog.ts']);
const workflowList = 'services/engine/workflows.ts';
const declarationFile = 'workflow.ts';
const quoted = /'([^']*)'/g;
const buildFolder = '.next';

const holdsPage = (folder: string): boolean => readdirSync(join(root, folder), { recursive: true, encoding: 'utf8' }).some(path => path.endsWith('.tsx'));

const pageFeatures = (): readonly string[] =>
  readdirSync(join(root, 'features'), { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && holdsPage(`features/${dirent.name}`))
    .map(dirent => `features/${dirent.name}`);

const unwrapped = (expression: ts.Expression): ts.Expression =>
  ts.isSatisfiesExpression(expression) || ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression) ? unwrapped(expression.expression) : expression;

const property = (literal: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined =>
  literal.properties.filter(ts.isPropertyAssignment).find(entry => ts.isIdentifier(entry.name) && entry.name.text === key)?.initializer;

const literalText = (expression: ts.Expression | undefined): string | undefined =>
  expression !== undefined && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) ? expression.text : undefined;

function namesIn(path: string): { readonly names: readonly Name[]; readonly problems: readonly Found[] } {
  const file = ts.createSourceFile(path, readFileSync(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true);
  const unreadable = (problem: string): { readonly names: readonly Name[]; readonly problems: readonly Found[] } => ({ names: [], problems: [{ path, line: 1, problem }] });
  const initializer = file.statements
    .filter(ts.isVariableStatement)
    .filter(statement => ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
    .flatMap(statement => statement.declarationList.declarations)
    .find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'workflow')?.initializer;
  const workflow = initializer === undefined ? undefined : unwrapped(initializer);
  if (workflow === undefined || !ts.isObjectLiteralExpression(workflow)) return unreadable('exports no workflow object literal, so no one can check that the runner never names its steps');
  const name = literalText(property(workflow, 'name'));
  const steps = property(workflow, 'steps');
  const listed = steps === undefined ? undefined : unwrapped(steps);
  if (name === undefined || listed === undefined || !ts.isArrayLiteralExpression(listed)) return unreadable('must give the workflow a literal name and a literal list of steps');
  const stepNames = listed.elements.map(element => {
    const declared = ts.isCallExpression(element) && ts.isIdentifier(element.expression) && element.expression.text === 'step' ? element.arguments[0] : undefined;
    return declared !== undefined && ts.isObjectLiteralExpression(declared) ? literalText(property(declared, 'name')) : undefined;
  });
  if (stepNames.some(step => step === undefined)) return unreadable('must declare each step as step({ ... }) with a literal name');
  return {
    names: [{ name, what: 'the workflow', isWorkflow: true }, ...stepNames.flatMap(step => (step === undefined ? [] : [{ name: step, what: `the step of ${name}`, isWorkflow: false }]))],
    problems: [],
  };
}

function declaredNames(): { readonly names: readonly Name[]; readonly problems: readonly Found[] } {
  const features = join(root, 'features');
  const found = readdirSync(features, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory() && existsSync(join(features, dirent.name, declarationFile)))
    .map(dirent => namesIn(`features/${dirent.name}/${declarationFile}`));
  return { names: found.flatMap(entry => entry.names), problems: found.flatMap(entry => entry.problems) };
}

const isVerification = (path: string): boolean => (path.startsWith('features/') && verificationFiles.has(basename(path))) || /\.test\.tsx?$/.test(path);

function* executionFiles(prefix: string): Generator<string> {
  if (!existsSync(join(root, prefix))) return;
  for (const dirent of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = `${prefix}/${dirent.name}`;
    if (dirent.isDirectory() && dirent.name !== buildFolder) yield* executionFiles(path);
    else if (dirent.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(dirent.name) && !isVerification(path)) yield path;
  }
}

const textOf = (node: ts.Node): string | undefined =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.text : undefined;

const keyOf = (node: ts.Node): string | undefined => {
  const named = ts.isPropertyAssignment(node) || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node) || ts.isMethodDeclaration(node) ? node.name : undefined;
  if (named !== undefined) return ts.isIdentifier(named) || ts.isStringLiteral(named) ? named.text : undefined;
  if (ts.isShorthandPropertyAssignment(node)) return node.name.text;
  return ts.isPropertyAccessExpression(node) ? node.name.text : undefined;
};

function violationsIn(path: string, names: readonly Name[]): readonly Found[] {
  const file = ts.createSourceFile(path, readFileSync(join(root, path), 'utf8'), ts.ScriptTarget.Latest, true);
  const sought = path === workflowList ? names.filter(name => !name.isWorkflow) : names;
  const found: Found[] = [];
  const report = (node: ts.Node, word: string): void => {
    for (const name of sought.filter(candidate => candidate.name.toLowerCase() === word.trim().toLowerCase())) {
      found.push({
        path,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        problem: `names ${name.what} "${name.name}". Neither the runner nor the dashboard names a workflow or a step (docs/spec.md). The runner reads it from the task's workflow, which ${workflowList} lists, and the dashboard reads published_workflow_step.`,
      });
    }
  };
  const visit = (node: ts.Node): void => {
    const text = textOf(node);
    if (text !== undefined) {
      report(node, text);
      for (const [, word = ''] of text.matchAll(quoted)) report(node, word);
    }
    const key = keyOf(node);
    if (key !== undefined) report(node, key);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const { names, problems } = declaredNames();
const violations = [...problems, ...[...executionFolders, ...pageFeatures()].flatMap(folder => [...executionFiles(folder)]).flatMap(path => violationsIn(path, names))];
for (const { path, line, problem } of violations) process.stdout.write(`${path}:${String(line)} ${problem}\n`);
process.exitCode = violations.length === 0 ? 0 : 1;
