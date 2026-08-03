import { describe, expect, it } from 'bun:test';
import { BARS, EQ_BARS, eqStep, seedFromId, waveFor } from './musicWave';

describe('seedFromId', () => {
  it('is deterministic', () => {
    expect(seedFromId('4cOdK2wGLETKBW3PvgPWqT')).toBe(seedFromId('4cOdK2wGLETKBW3PvgPWqT'));
  });

  it('separates ids that differ in one character', () => {
    // The whole point of hashing rather than reusing a truncated id: real
    // Spotify ids share long prefixes, and neighbours must not share a
    // silhouette. The handoff's `seed * 2654435761` lost the low bits past
    // ~2^22, which is why this uses Math.imul.
    const a = seedFromId('4cOdK2wGLETKBW3PvgPWqT');
    const b = seedFromId('4cOdK2wGLETKBW3PvgPWqU');
    expect(a).not.toBe(b);
  });

  it('never returns 0 — the LCG collapses every zero seed onto one stream', () => {
    expect(seedFromId('')).not.toBe(0);
  });

  it('stays in the uint32 domain', () => {
    for (const id of ['a', 'zzzzzzzzzzzzzzzzzzzzzz', '0000000000000000000000']) {
      const s = seedFromId(id);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('waveFor', () => {
  it('returns the requested length', () => {
    expect(waveFor(7, BARS)).toHaveLength(108);
    expect(waveFor(7, 24)).toHaveLength(24);
  });

  it('is deterministic per seed', () => {
    expect(waveFor(19, BARS)).toEqual(waveFor(19, BARS));
  });

  it('gives different seeds different silhouettes', () => {
    const a = waveFor(7, BARS);
    const b = waveFor(19, BARS);
    expect(a).not.toEqual(b);
  });

  it('keeps every bar inside the drawable range', () => {
    for (const seed of [1, 7, 19, 31, 0xffffffff, seedFromId('4cOdK2wGLETKBW3PvgPWqT')]) {
      for (const v of waveFor(seed, BARS)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('tapers in and out — the first and last bars are the quietest', () => {
    const w = waveFor(31, BARS);
    const peak = Math.max(...w);
    expect(w[0]).toBeLessThan(peak * 0.5);
    expect(w[w.length - 1]).toBeLessThan(peak * 0.5);
  });

  it('matches the handoff for its own seeds', () => {
    // Guards the port: the smoothing pass is an in-place, one-directional IIR
    // (it reads the already-smoothed out[k-1]). Rewriting it as a symmetric
    // blur is the obvious "cleanup" and it changes every silhouette.
    const w = waveFor(7, 8);
    expect(w.map((v) => Number(v.toFixed(6)))).toEqual([
      0.55911, 0.519862, 0.338818, 0.318938, 0.511718, 0.868878, 0.760139, 0.434174,
    ]);
  });
});

describe('eqStep', () => {
  const fresh = () => new Array<number>(EQ_BARS).fill(0);

  it('draws the handoff\'s five bars', () => {
    expect(EQ_BARS).toBe(5);
    expect(eqStep(fresh(), 1, 0, 1 / 60)).toHaveLength(5);
  });

  it('is the handoff\'s 0.32 at 60fps', () => {
    // amp 0 makes every target 0 whatever the phase, so this measures the
    // coefficient alone: 1 → 0.68 in one 60fps frame.
    const bars = new Array<number>(EQ_BARS).fill(1);
    eqStep(bars, 0, 12.34, 1 / 60);
    for (const v of bars) expect(v).toBeCloseTo(0.68, 6);
  });

  it('settles at the same SPEED at any frame rate', () => {
    // The reason the constant became a rate. At 0.32-per-frame the bars would
    // fall twice as fast on a 120Hz display and crawl on a loaded one.
    const at60 = new Array<number>(EQ_BARS).fill(1);
    const at120 = new Array<number>(EQ_BARS).fill(1);
    for (let i = 0; i < 30; i++) eqStep(at60, 0, 0, 1 / 60);
    for (let i = 0; i < 60; i++) eqStep(at120, 0, 0, 1 / 120);
    expect(at120[0]).toBeCloseTo(at60[0], 2);
  });

  it('never overshoots on a long frame', () => {
    // `min(1, dt * k)` is what stops a 2s stall from inverting the bar.
    const bars = new Array<number>(EQ_BARS).fill(1);
    eqStep(bars, 0, 0, 2);
    for (const v of bars) expect(v).toBe(0);
  });

  it('rises toward the amplitude and stays inside the box', () => {
    const bars = fresh();
    for (let i = 0; i < 200; i++) eqStep(bars, 1, i / 60, 1 / 60);
    for (const v of bars) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(Math.max(...bars)).toBeGreaterThan(0.2);
  });

  it('gives the bars different phases — five identical bars are one bar', () => {
    const bars = fresh();
    for (let i = 0; i < 40; i++) eqStep(bars, 1, 3 + i / 60, 1 / 60);
    expect(new Set(bars.map((v) => v.toFixed(4))).size).toBeGreaterThan(1);
  });
});
