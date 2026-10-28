/**
 * Run: bun test src/lib/atlasHealth.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { computeErrorRate, computeHealthScore } from './atlasHealth';

describe('computeHealthScore', () => {
  test('a clean log with no research is 100', () => {
    expect(computeHealthScore(0, 0)).toBe(100);
    expect(computeHealthScore(0, null)).toBe(100);
    expect(computeHealthScore(0, undefined)).toBe(100);
  });

  // The regression: `activeResearch || 0 > 10` parsed as
  // `activeResearch || (0 > 10)`, so any running topic cost 5 points.
  test('a few running research topics cost nothing', () => {
    expect(computeHealthScore(0, 1)).toBe(100);
    expect(computeHealthScore(0, 10)).toBe(100);
  });

  test('more than 10 running topics costs 5', () => {
    expect(computeHealthScore(0, 11)).toBe(95);
    expect(computeHealthScore(20, 11)).toBe(75);
  });

  test('errors subtract one point per percent', () => {
    expect(computeHealthScore(12.5, 0)).toBe(88);
    expect(computeHealthScore(30, 3)).toBe(70);
  });

  test('never drops below 0', () => {
    expect(computeHealthScore(100, 50)).toBe(0);
  });
});

describe('computeErrorRate', () => {
  test('missing or zero counts are 0', () => {
    expect(computeErrorRate(null)).toBe(0);
    expect(computeErrorRate(undefined)).toBe(0);
    expect(computeErrorRate(0)).toBe(0);
  });

  test('caps at 100', () => {
    expect(computeErrorRate(7)).toBe(7);
    expect(computeErrorRate(250)).toBe(100);
  });
});
