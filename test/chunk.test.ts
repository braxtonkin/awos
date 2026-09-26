import { expect, test } from 'vitest';
import { chunk } from '../src/chunk.ts';

test('splits items in order with a shorter final chunk', () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
});

test('splits evenly divisible input', () => {
  expect(chunk(['a', 'b', 'c', 'd'], 2)).toEqual([['a', 'b'], ['c', 'd']]);
});

test('returns an empty list for empty input', () => {
  expect(chunk([], 3)).toEqual([]);
});

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  'throws RangeError for invalid size %s',
  size => {
    expect(() => chunk([1, 2, 3], size)).toThrow(RangeError);
  },
);
