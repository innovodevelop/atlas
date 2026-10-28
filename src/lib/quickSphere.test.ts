import { describe, expect, test } from 'bun:test';
import { DEF, QS_STATES, STATE_TINT, TINT, TINT_INK, hex, target } from './quickSphere';

describe('quickSphere state maths (port of atlas-quickstart-sphere.js)', () => {
  test('idle is the resting parameter set in every mode', () => {
    for (const mode of ['veil', 'tide', 'spiral'] as const) {
      const t = target(mode, 'idle');
      for (const k of Object.keys(DEF) as (keyof typeof DEF)[]) expect(t[k]).toBe(DEF[k]);
      expect(t.tint).toBeUndefined();
    }
  });

  test('every non-idle state carries its tint and a mix, so the colour change is never silent', () => {
    for (const st of QS_STATES) {
      if (st === 'idle') continue;
      const t = target('veil', st);
      expect(t.tint).toBe(STATE_TINT[st]);
      expect(t.mix).toBeGreaterThan(0);
    }
    // speaking mixes lighter than the rest (0.7 vs 0.8), as in the reference.
    expect(target('veil', 'speaking').mix).toBe(0.7);
    expect(target('veil', 'thinking').mix).toBe(0.8);
  });

  test('the hand-tuned veil table survived the port', () => {
    expect(target('veil', 'listening')).toMatchObject({ flow: 0.45, spin: 0.4, wav: 0.6, sway: 0.4, aF: 0.03, fF: 2.6, scale: 1.015 });
    expect(target('veil', 'alert')).toMatchObject({ flow: 1.3, wav: 1.5, sway: 1.8, aB: 0.04, bR: 1.0, b2: 0.8, turb: 0.04, mix: 0.9, tint: 'r' });
    expect(target('veil', 'waking')).toMatchObject({ wake: 1, fade: 0.92 });
    expect(target('veil', 'muted')).toMatchObject({ fade: 0.5, scale: 0.95, tint: 'n' });
  });

  test('a mode without its own table stays at the defaults, untinted — as in the reference', () => {
    // Only tide, spiral and veil have state tables; the tint loop only fills
    // those. The app uses veil everywhere, so this is a guard, not a feature.
    const t = target('contour', 'success');
    expect(t.flow).toBe(1);
    expect(t.tint).toBeUndefined();
  });

  test('ink grounds use the lighter tint of each colour', () => {
    for (const k of Object.keys(TINT) as (keyof typeof TINT)[]) {
      const lum = (c: readonly number[]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      expect(lum(TINT_INK[k])).toBeGreaterThan(lum(TINT[k]));
    }
  });

  test('hex parses 3- and 6-digit colours', () => {
    expect(hex('#3461f2')).toEqual([52, 97, 242]);
    expect(hex('#fff')).toEqual([255, 255, 255]);
    expect(hex('1e1e24')).toEqual([30, 30, 36]);
  });
});
