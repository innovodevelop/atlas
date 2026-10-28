import { describe, expect, test } from 'bun:test';
import { FRAME_BUDGET, SPHERE_BUDGET, SPHERE_MAX, clampCount, fitToBox, particleBudget, type SphereSize } from './sphereBudget';
import { DOCK_SPHERE } from './betaDock';
import { SPHERE } from './betaTokens';

const SIZES = Object.keys(SPHERE_BUDGET) as SphereSize[];

describe('the sphere budget table', () => {
  test('every size carries the handoff count from betaTokens', () => {
    expect(SPHERE_BUDGET.band.count).toBe(SPHERE.bandCount);
    expect(SPHERE_BUDGET.hero.count).toBe(SPHERE.heroCount);
    expect(SPHERE_BUDGET.short.count).toBe(SPHERE.shortBandCount);
    expect(SPHERE_BUDGET.panel.count).toBe(SPHERE.panelCount);
    expect(SPHERE_BUDGET.orb.count).toBe(SPHERE.orbCount);
    expect(SPHERE_BUDGET.mini.count).toBe(SPHERE.miniCount);
  });

  test('every row is sane: floor below count, a real box, at most the band', () => {
    for (const s of SIZES) {
      const b = SPHERE_BUDGET[s];
      expect(b.floor).toBeGreaterThan(0);
      expect(b.floor).toBeLessThan(b.count);
      expect(b.box).toBeGreaterThan(0);
      expect(b.count).toBeLessThanOrEqual(SPHERE_MAX);
      expect(b.where.length).toBeGreaterThan(0);
    }
  });

  // The hub and capsule dock styles add a fourth live sphere to that moment.
  test("the shell's heaviest moment (band + Talk panel + orb + dock sphere) fits the frame budget", () => {
    const heaviest = SPHERE_BUDGET.band.count + SPHERE_BUDGET.panel.count + SPHERE_BUDGET.orb.count + DOCK_SPHERE.count;
    expect(heaviest).toBeLessThanOrEqual(FRAME_BUDGET);
  });

  test('the frame budget is one and a half of the reference engine\'s 24 k sphere', () => {
    expect(FRAME_BUDGET).toBe(24000 * 1.5);
  });
});

describe('fitToBox', () => {
  test('a box at or above the tuned size, or not laid out yet, gets the full count', () => {
    for (const s of SIZES) {
      const b = SPHERE_BUDGET[s];
      expect(fitToBox(b, b.box)).toBe(b.count);
      expect(fitToBox(b, b.box * 3)).toBe(b.count);
      expect(fitToBox(b, 0)).toBe(b.count);
      expect(fitToBox(b, undefined)).toBe(b.count);
      expect(fitToBox(b, Number.NaN)).toBe(b.count);
      expect(fitToBox(b, -10)).toBe(b.count);
    }
  });

  test('a smaller box follows its area in quarter steps, rounded to hundreds', () => {
    const band = SPHERE_BUDGET.band; // 20 000 at 264 px
    // Half the side is a quarter of the area: exactly the first step.
    expect(fitToBox(band, 132)).toBe(6000); // 5 000, held up by the floor
    // 0.8 of the side is 0.64 of the area, which rounds up to the 0.75 step.
    expect(fitToBox(band, 264 * 0.8)).toBe(15000);
    // Just under full size is still the 1.0 step.
    expect(fitToBox(band, 263)).toBe(20000);
  });

  test('only four counts are possible below the tuned box, so a dragged window re-seeds rarely', () => {
    for (const s of SIZES) {
      const b = SPHERE_BUDGET[s];
      const seen = new Set<number>();
      for (let box = 1; box <= b.box; box++) seen.add(fitToBox(b, box));
      expect(seen.size).toBeLessThanOrEqual(4);
    }
  });

  test('the count never drops under the floor and never grows as the box shrinks', () => {
    for (const s of SIZES) {
      const b = SPHERE_BUDGET[s];
      let prev = Infinity;
      for (let box = b.box; box >= 1; box--) {
        const n = fitToBox(b, box);
        expect(n).toBeGreaterThanOrEqual(b.floor);
        expect(n).toBeLessThanOrEqual(prev);
        prev = n;
      }
    }
  });

  test('the band at phone width (120 px) draws the floor, not its desktop count', () => {
    expect(fitToBox(SPHERE_BUDGET.band, 120)).toBe(SPHERE_BUDGET.band.floor);
  });
});

describe('particleBudget and clampCount', () => {
  test("a page's own count is kept, only bounded", () => {
    expect(particleBudget('mini', { count: 3000, box: 20 })).toBe(3000);
    expect(particleBudget('band', { count: 999999 })).toBe(SPHERE_MAX);
    expect(particleBudget('band', { count: 0 })).toBe(1);
    expect(particleBudget('band', { count: 1234.6 })).toBe(1235);
  });

  test('without a count the size row decides, fitted to the box', () => {
    expect(particleBudget('orb')).toBe(SPHERE.orbCount);
    expect(particleBudget('band', { box: 120 })).toBe(SPHERE_BUDGET.band.floor);
  });

  test('a non-finite count falls back to the mini count', () => {
    expect(clampCount(Number.NaN)).toBe(SPHERE.miniCount);
    expect(clampCount(Infinity)).toBe(SPHERE.miniCount);
  });
});
