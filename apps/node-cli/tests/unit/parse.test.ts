import { describe, expect, it } from 'vitest';
import { parseNonNegativeInteger, parsePositiveInteger } from '../../src/utils/parse.js';

describe('numeric option parsers', () => {
  it('parses positive integers', () => {
    expect(parsePositiveInteger('1', '--timeout')).toBe(1);
    expect(parsePositiveInteger('300', '--timeout')).toBe(300);
  });

  it('rejects non-positive and partial positive integers', () => {
    expect(() => parsePositiveInteger('0', '--timeout')).toThrow('Invalid --timeout');
    expect(() => parsePositiveInteger('-1', '--timeout')).toThrow('Invalid --timeout');
    expect(() => parsePositiveInteger('1abc', '--timeout')).toThrow('Invalid --timeout');
    expect(() => parsePositiveInteger('abc', '--timeout')).toThrow('Invalid --timeout');
  });

  it('parses non-negative integers', () => {
    expect(parseNonNegativeInteger('0', '--offset')).toBe(0);
    expect(parseNonNegativeInteger('25', '--offset')).toBe(25);
  });

  it('rejects negative and partial non-negative integers', () => {
    expect(() => parseNonNegativeInteger('-1', '--offset')).toThrow('Invalid --offset');
    expect(() => parseNonNegativeInteger('2.5', '--offset')).toThrow('Invalid --offset');
    expect(() => parseNonNegativeInteger('2x', '--offset')).toThrow('Invalid --offset');
  });
});
