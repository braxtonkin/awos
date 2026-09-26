import { expect, test } from 'vitest';
import { slugify } from '../src/slugify.ts';

test('converts text to lowercase', () => {
  expect(slugify('Hello WORLD')).toBe('hello-world');
});

test('replaces runs of punctuation and whitespace with one hyphen', () => {
  expect(slugify('one,   two---three')).toBe('one-two-three');
});

test('removes leading and trailing hyphens', () => {
  expect(slugify('---hello world!!!')).toBe('hello-world');
});

test('preserves digits', () => {
  expect(slugify('Version 2.0 release')).toBe('version-2-0-release');
});

test('returns an empty string when there are no ASCII letters or digits', () => {
  expect(slugify('你好 — !!!')).toBe('');
});
