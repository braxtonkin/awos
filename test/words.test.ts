import { expect, test } from 'vitest';
import { words } from '../src/words.ts';

test('splits on any run of whitespace', () => {
  expect(words('  the quick\tbrown\nfox  ')).toEqual(['the', 'quick', 'brown', 'fox']);
});

test('finds no words in blank text', () => {
  expect(words(' \n ')).toEqual([]);
});
