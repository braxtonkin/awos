import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type Source = { readonly path: string; readonly firstLine: number; readonly text: string; readonly allowedLines: ReadonlySet<string> };

type Span =
  | { readonly kind: 'comment' | 'quoted'; readonly end: number }
  | { readonly kind: 'dollar'; readonly bodyStart: number; readonly bodyEnd: number; readonly end: number };

type Finding = { readonly line: number; readonly problem: string };

type Violation = Finding & { readonly path: string };

const root = fileURLToPath(new URL('../../', import.meta.url));
const skipped = new Set(['.git', 'node_modules', '.claude']);
const dbmateMarkers: ReadonlySet<string> = new Set(['-- migrate:up', '-- migrate:down', '-- migrate:up transaction:false', '-- migrate:down transaction:false']);
const nothingAllowed: ReadonlySet<string> = new Set();
const unquotedName = /^[A-Za-z_\u{80}-\u{10FFFF}][\w$\u{80}-\u{10FFFF}]*/u;
const dollarDelimiter = /^\$(?:[A-Za-z_\u{80}-\u{10FFFF}][\w\u{80}-\u{10FFFF}]*)?\$/u;
const commentOn = /(?:^|;)\s*(comment\s+on)\b/gi;

const commentProblem = (comment: string): string =>
  `holds the SQL comment "${comment}". AGENTS.md rule B1 forbids comments, except the lines -- migrate:up and -- migrate:down that dbmate needs in a .sql file, each alone or followed by transaction:false. Put the meaning in a name, or open an issue for a workaround.`;

const commentOnProblem =
  'holds a COMMENT ON statement, which stores a comment in the schema that kysely-codegen copies into shared/db/types.ts. AGENTS.md rule B1 forbids comments. Put the meaning in a name.';

function* walk(prefix: string): Generator<string> {
  for (const dirent of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (skipped.has(dirent.name)) continue;
    const path = `${prefix}${dirent.name}`;
    if (dirent.isDirectory()) yield* walk(`${path}/`);
    else if (dirent.isFile()) yield path;
  }
}

const templateText = (template: ts.TemplateLiteral): string =>
  ts.isNoSubstitutionTemplateLiteral(template) ? template.text : [template.head, ...template.templateSpans.map(span => span.literal)].map(part => part.text).join(' ');

function sqlTags(file: ts.SourceFile): ReadonlySet<string> {
  const bindings = file.statements
    .filter(ts.isImportDeclaration)
    .filter(({ moduleSpecifier }) => ts.isStringLiteral(moduleSpecifier) && moduleSpecifier.text === 'kysely')
    .flatMap(({ importClause }) => importClause?.namedBindings ?? []);
  const tags = bindings.flatMap(binding =>
    ts.isNamespaceImport(binding)
      ? [`${binding.name.text}.sql`]
      : binding.elements.filter(element => (element.propertyName ?? element.name).text === 'sql').map(element => element.name.text),
  );
  return new Set(['sql', ...tags]);
}

function sqlTemplates(path: string, source: string): readonly Source[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const tags = sqlTags(file);
  const templates: Source[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node) && tags.has(node.tag.getText(file))) {
      const firstLine = file.getLineAndCharacterOfPosition(node.template.getStart(file)).line + 1;
      templates.push({ path, firstLine, text: templateText(node.template), allowedLines: nothingAllowed });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return templates;
}

const sourcesOf: Readonly<Record<string, (path: string, text: string) => readonly Source[]>> = {
  '.sql': (path, text) => [{ path, firstLine: 1, text, allowedLines: dbmateMarkers }],
  '.ts': sqlTemplates,
  '.tsx': sqlTemplates,
};

function lineCommentEnd(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  return newline === -1 ? text.length : newline;
}

function blockCommentEnd(text: string, start: number): number {
  let depth = 0;
  for (const mark of text.slice(start).matchAll(/\/\*|\*\//g)) {
    depth += mark[0] === '/*' ? 1 : -1;
    if (depth === 0) return start + mark.index + mark[0].length;
  }
  return text.length;
}

function escapeStringEnd(text: string, start: number): number {
  let at = start + 2;
  while (at < text.length) {
    if (text.startsWith('\\', at) || text.startsWith("''", at)) at += 2;
    else if (text.startsWith("'", at)) return at + 1;
    else at += 1;
  }
  return text.length;
}

function quotedEnd(text: string, start: number): number {
  const closing = text.indexOf(text.charAt(start), start + 1);
  return closing === -1 ? text.length : closing + 1;
}

function dollarSpan(text: string, start: number): Span | undefined {
  const delimiter = dollarDelimiter.exec(text.slice(start))?.[0];
  if (delimiter === undefined) return undefined;
  const bodyStart = start + delimiter.length;
  const closing = text.indexOf(delimiter, bodyStart);
  return closing === -1
    ? { kind: 'dollar', bodyStart, bodyEnd: text.length, end: text.length }
    : { kind: 'dollar', bodyStart, bodyEnd: closing, end: closing + delimiter.length };
}

function spanAt(text: string, start: number): Span | undefined {
  const opening = text.charAt(start);
  if (text.startsWith('--', start)) return { kind: 'comment', end: lineCommentEnd(text, start) };
  if (text.startsWith('/*', start)) return { kind: 'comment', end: blockCommentEnd(text, start) };
  if ((opening === 'E' || opening === 'e') && text.startsWith("'", start + 1)) return { kind: 'quoted', end: escapeStringEnd(text, start) };
  if (opening === "'" || opening === '"') return { kind: 'quoted', end: quotedEnd(text, start) };
  if (opening === '$') return dollarSpan(text, start);
  return undefined;
}

const codeEnd = (text: string, start: number): number => start + (unquotedName.exec(text.slice(start))?.[0].length ?? 1);

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

const startsLine = (text: string, index: number): boolean => index === 0 || text.charAt(index - 1) === '\n';

const firstLineOf = (comment: string): string => (comment.split('\n', 1)[0] ?? '').replace(/\r$/, '');

function findingsIn(text: string, allowedLines: ReadonlySet<string>): readonly Finding[] {
  const findings: Finding[] = [];
  let code = '';
  let at = 0;
  while (at < text.length) {
    const span = spanAt(text, at);
    const end = span?.end ?? codeEnd(text, at);
    const part = text.slice(at, end);
    if (span?.kind === 'comment') {
      const comment = firstLineOf(part);
      if (!(startsLine(text, at) && allowedLines.has(comment))) findings.push({ line: lineAt(text, at), problem: commentProblem(comment) });
    }
    if (span?.kind === 'dollar') {
      const linesBefore = lineAt(text, span.bodyStart) - 1;
      for (const { line, problem } of findingsIn(text.slice(span.bodyStart, span.bodyEnd), nothingAllowed)) findings.push({ line: linesBefore + line, problem });
    }
    code += span === undefined ? part : part.replace(/[^\n]/g, ' ');
    at = end;
  }
  for (const match of code.matchAll(commentOn)) {
    const [statement, keywords = ''] = match;
    findings.push({ line: lineAt(code, match.index + statement.length - keywords.length), problem: commentOnProblem });
  }
  return findings;
}

const byPathThenLine = (a: Violation, b: Violation): number => {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.line - b.line;
};

const violations = [...walk('')]
  .flatMap(path => sourcesOf[extname(path)]?.(path, readFileSync(join(root, path), 'utf8')) ?? [])
  .flatMap(source => findingsIn(source.text, source.allowedLines).map(({ line, problem }) => ({ path: source.path, line: source.firstLine + line - 1, problem })))
  .toSorted(byPathThenLine);
for (const { path, line, problem } of violations) process.stdout.write(`${path}:${String(line)} ${problem}\n`);
process.exitCode = violations.length === 0 ? 0 : 1;
