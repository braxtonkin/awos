import { z } from 'zod';
import { parsePayload } from './payload.ts';

const Entry = z
  .object({
    name: z.string().regex(/^[a-z][A-Za-z]*$/),
    file: z.string().regex(/^src\/[a-z][a-z-]*\.ts$/),
    summary: z.string().min(1),
    description: z.string().includes('Acceptance criteria:'),
    acceptance: z.string().min(1),
  })
  .refine(entry => entry.description.includes(`\`${entry.file}\``) && entry.description.includes(`\`${entry.name}\``), {
    error: 'the description must name the entry and its file',
  })
  .refine(entry => entry.acceptance.includes(`import { ${entry.name} } from '../${entry.file}';`), {
    error: "the acceptance test must import the entry's function from its file",
  });

export const Catalog = z.array(Entry).refine(entries => new Set(entries.map(entry => entry.name)).size === entries.length, { error: 'two entries share a name' });

export type Entry = z.infer<typeof Entry>;

export const catalog: readonly Entry[] = parsePayload('the catalog', Catalog, [
  {
    name: 'titleCase',
    file: 'src/title-case.ts',
    summary: 'Add titleCase to the sandbox library',
    description: [
      'Add a function `titleCase` in a new file `src/title-case.ts`, exported by name, with the signature `titleCase(text: string): string`.',
      '',
      'Acceptance criteria:',
      '- Each word starts with an uppercase letter and the rest of the word is lowercase. A word is a run of characters that are not whitespace.',
      '- Whitespace stays exactly as it was, including leading, trailing, and repeated whitespace.',
      '- An empty string returns an empty string.',
    ].join('\n'),
    acceptance: [
      "import { expect, test } from 'vitest';",
      "import { titleCase } from '../src/title-case.ts';",
      '',
      "test('titleCase', () => {",
      "  expect(titleCase('hello wORLD')).toBe('Hello World');",
      "  expect(titleCase('  a  bC\\td ')).toBe('  A  Bc\\tD ');",
      "  expect(titleCase('')).toBe('');",
      '});',
      '',
    ].join('\n'),
  },
  {
    name: 'slugify',
    file: 'src/slugify.ts',
    summary: 'Add slugify to the sandbox library',
    description: [
      'Add a function `slugify` in a new file `src/slugify.ts`, exported by name, with the signature `slugify(text: string): string`.',
      '',
      'Acceptance criteria:',
      '- The result is lowercase.',
      '- Every run of characters other than the ASCII letters a to z and the digits 0 to 9 becomes one hyphen.',
      '- The result never starts or ends with a hyphen.',
      '- Text with no letters or digits returns an empty string.',
    ].join('\n'),
    acceptance: [
      "import { expect, test } from 'vitest';",
      "import { slugify } from '../src/slugify.ts';",
      '',
      "test('slugify', () => {",
      "  expect(slugify('Hello, World!')).toBe('hello-world');",
      "  expect(slugify('  --Already--Slugged 2  ')).toBe('already-slugged-2');",
      "  expect(slugify('?!')).toBe('');",
      '});',
      '',
    ].join('\n'),
  },
  {
    name: 'clamp',
    file: 'src/clamp.ts',
    summary: 'Add clamp to the sandbox library',
    description: [
      'Add a function `clamp` in a new file `src/clamp.ts`, exported by name, with the signature `clamp(value: number, min: number, max: number): number`.',
      '',
      'Acceptance criteria:',
      '- A value below min returns min, a value above max returns max, and any other value returns itself.',
      '- When min is greater than max, it throws a RangeError.',
    ].join('\n'),
    acceptance: [
      "import { expect, test } from 'vitest';",
      "import { clamp } from '../src/clamp.ts';",
      '',
      "test('clamp', () => {",
      '  expect(clamp(15, 0, 10)).toBe(10);',
      '  expect(clamp(-3, 0, 10)).toBe(0);',
      '  expect(clamp(4, 0, 10)).toBe(4);',
      '  expect(() => clamp(1, 5, 2)).toThrow(RangeError);',
      '});',
      '',
    ].join('\n'),
  },
  {
    name: 'chunk',
    file: 'src/chunk.ts',
    summary: 'Add chunk to the sandbox library',
    description: [
      'Add a function `chunk` in a new file `src/chunk.ts`, exported by name, with the signature `chunk<T>(items: readonly T[], size: number): T[][]`.',
      '',
      'Acceptance criteria:',
      '- It splits the items, in order, into lists of size items each. Only the last list may be shorter.',
      '- An empty list returns an empty list.',
      '- When size is not a positive whole number, it throws a RangeError.',
    ].join('\n'),
    acceptance: [
      "import { expect, test } from 'vitest';",
      "import { chunk } from '../src/chunk.ts';",
      '',
      "test('chunk', () => {",
      '  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);',
      '  expect(chunk([], 3)).toEqual([]);',
      '  expect(() => chunk([1], 0)).toThrow(RangeError);',
      '  expect(() => chunk([1], 1.5)).toThrow(RangeError);',
      '});',
      '',
    ].join('\n'),
  },
]);
