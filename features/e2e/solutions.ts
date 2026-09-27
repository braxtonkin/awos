import type { Entry } from './catalog.ts';

export type Solution = { readonly source: string; readonly checks: readonly string[] };

export const solutions: Readonly<Record<string, Solution>> = {
  titleCase: {
    source: [
      'export function titleCase(text: string): string {',
      '  return text.replace(/\\S+/g, word => word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase());',
      '}',
      '',
    ].join('\n'),
    checks: ['assert.equal(titleCase("hello wORLD"), "Hello World");', 'assert.equal(titleCase("  a  bC\\td "), "  A  Bc\\tD ");', 'assert.equal(titleCase(""), "");'],
  },
  slugify: {
    source: [
      'export function slugify(text: string): string {',
      "  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');",
      '}',
      '',
    ].join('\n'),
    checks: ['assert.equal(slugify("Hello, World!"), "hello-world");', 'assert.equal(slugify("  --Already--Slugged 2  "), "already-slugged-2");', 'assert.equal(slugify("?!"), "");'],
  },
  clamp: {
    source: [
      'export function clamp(value: number, min: number, max: number): number {',
      '  if (min > max) throw new RangeError(`min ${String(min)} is greater than max ${String(max)}`);',
      '  return Math.min(Math.max(value, min), max);',
      '}',
      '',
    ].join('\n'),
    checks: ['assert.equal(clamp(15, 0, 10), 10);', 'assert.equal(clamp(-3, 0, 10), 0);', 'assert.equal(clamp(4, 0, 10), 4);', 'assert.throws(() => clamp(1, 5, 2), RangeError);'],
  },
  chunk: {
    source: [
      'export function chunk<T>(items: readonly T[], size: number): T[][] {',
      '  if (!Number.isInteger(size) || size <= 0) throw new RangeError(`size must be a positive whole number, not ${String(size)}`);',
      '  const lists: T[][] = [];',
      '  for (let start = 0; start < items.length; start += size) lists.push(items.slice(start, start + size));',
      '  return lists;',
      '}',
      '',
    ].join('\n'),
    checks: [
      'assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);',
      'assert.deepEqual(chunk([], 3), []);',
      'assert.throws(() => chunk([1], 0), RangeError);',
      'assert.throws(() => chunk([1], 1.5), RangeError);',
    ],
  },
};

export const identity = (entry: Pick<Entry, 'name'>): string => `export function ${entry.name}(value: unknown): unknown {\n  return value;\n}\n`;

export const rehearsalNames = ['red-check', 'still-wrong', 'ticket-conflict', 'pushes-nothing'] as const;

export type RehearsalName = (typeof rehearsalNames)[number];

const rehearsalLine = (name: RehearsalName): string => `The Codex stand-in rehearses ${name} on this ticket.`;

export const rehearsalOf = (text: string): RehearsalName | undefined => rehearsalNames.find(name => text.includes(rehearsalLine(name)));

export const untouchable = 'test/words.test.ts';

export const forbidden = `Do not edit \`${untouchable}\`.`;

export const rehearsedTicket = (description: string, name: RehearsalName): string => [description, rehearsalLine(name), ...(name === 'ticket-conflict' ? [forbidden] : [])].join('\n\n');

export const favicon = 'public/favicon.ico';

export const smokeTest = {
  path: 'test/smoke.test.ts',
  source: [
    "import { existsSync } from 'node:fs';",
    "import { expect, test } from 'vitest';",
    '',
    "test('the page loads every resource it links', () => {",
    `  expect(existsSync('${favicon}'), 'console error: Failed to load resource: the server responded with a status of 404 (Not Found) /favicon.ico').toBe(true);`,
    '});',
    '',
  ].join('\n'),
} as const;

export const checksPass = 'All mandated checks pass: typecheck, test, and build. The smoke test needs a browser, which this Job lacks.';

export const stillWrongSign = 'Expected values to be strictly equal';

export const coverageScript = (entry: Pick<Entry, 'name'>): string =>
  `grep -q ${entry.name} ${untouchable} || { echo "${untouchable} does not test ${entry.name}, and every export needs a test there"; exit 1; }\n`;

export const askOnConflict = "the ticket's own words";

export const reproductionScript = (entry: Entry, solution: Solution): string =>
  [
    `test -f ${entry.file} || { echo "${entry.file} does not exist"; exit 1; }`,
    "node --input-type=module -e '",
    'import assert from "node:assert/strict";',
    'import { pathToFileURL } from "node:url";',
    `const { ${entry.name} } = await import(pathToFileURL("${entry.file}").href);`,
    `assert.equal(typeof ${entry.name}, "function", "${entry.file} exports no function ${entry.name}");`,
    ...solution.checks,
    `console.log("${entry.name} does what the ticket asks");`,
    "'",
    '',
  ].join('\n');
