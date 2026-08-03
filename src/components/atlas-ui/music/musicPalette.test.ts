import { describe, expect, it } from 'bun:test';
import { hex, toward, type CoverPalette } from '@/lib/atlasCover';
import {
  ATLAS_BASE, COVER_BLEND, chromeFor, freshPalette, liftFor, paletteSignature, particlePalette,
  settlePalette, stepPalette,
} from './musicPalette';

const DARK: CoverPalette = { deep: [8, 8, 12], mid: [30, 24, 40], light: [90, 80, 110] };
const BRIGHT: CoverPalette = { deep: [90, 88, 84], mid: [240, 232, 210], light: [255, 252, 246] };

/** The `brightness(x)` argument out of a filter string. */
const lift = (filter: string) => Number(/brightness\(([\d.]+)\)/.exec(filter)?.[1]);

describe('chromeFor', () => {
  it('gives every presentation the SAME brightness lift', () => {
    // The three washes differ only in blur radius. If they ever disagree on
    // brightness the same record reads as two different records depending on
    // which presentation you are looking at.
    const c = chromeFor(DARK);
    expect(lift(c.wash1)).toBe(lift(c.wash2));
    expect(lift(c.wash1)).toBe(lift(c.washS));
    expect(lift(c.wash1)).toBe(lift(c.washC));
  });

  it('lifts a dark sleeve and holds a bright one back', () => {
    // `lift = clamp(1 + (0.52 - L) * 1.15, 1, 1.55)` — dark artwork keeps its
    // light, bright artwork is clamped at 1 rather than blown out.
    expect(lift(chromeFor(DARK).wash1)).toBeGreaterThan(1);
    expect(lift(chromeFor(BRIGHT).wash1)).toBe(1);
    expect(lift(chromeFor(DARK).wash1)).toBeLessThanOrEqual(1.55);
  });

  it('keeps the handoff blur radii, including the two paintChrome overrides', () => {
    const c = chromeFor(DARK);
    expect(c.wash1).toContain('blur(96px) saturate(1.75)');
    expect(c.wash2).toContain('blur(130px) saturate(1.5)');
    // 58 and 44, not the .dc.html markup's 70 and 52 — see the note on the
    // fields themselves.
    expect(c.washS).toContain('blur(58px) saturate(1.7)');
    expect(c.washC).toContain('blur(44px) saturate(1.7)');
  });

  it('derives the play-button ink from mid, not from a constant', () => {
    expect(chromeFor(DARK).ink).toBe(hex(toward(DARK.mid, [0, 0, 0], 0.62)));
    expect(chromeFor(DARK).ink).not.toBe(chromeFor(BRIGHT).ink);
  });

  it('builds all three scrims from deep', () => {
    const a = chromeFor(DARK);
    const b = chromeFor(BRIGHT);
    for (const k of ['scrim', 'scrimS', 'scrimC'] as const) {
      expect(a[k]).not.toBe(b[k]);
      expect(a[k]).toContain('rgba(8,8,12');
    }
  });

  it('never emits --acc2, which belongs to the voice indicator alone', () => {
    const all = Object.values(chromeFor(DARK)).join(' ');
    expect(all).not.toContain('--acc2');
    expect(all.toLowerCase()).not.toContain('ff6a00');
  });
});

describe('the crossfade', () => {
  it('starts at Atlas Blue, not at a sampled colour', () => {
    expect(freshPalette()).toEqual(ATLAS_BASE);
  });

  it('hands back a fresh mutable copy each time', () => {
    const a = freshPalette();
    a.deep[0] = 200;
    expect(freshPalette().deep[0]).toBe(ATLAS_BASE.deep[0]);
  });

  it('travels toward the record and stops at COVER_BLEND, not at it', () => {
    // The displayed palette is 90 % of the way from Atlas Blue to the record.
    // A surface that landed ON the sample would lose the Atlas cast entirely.
    const live = freshPalette();
    settlePalette(live, DARK);
    expect(live.deep).toEqual(toward(ATLAS_BASE.deep, DARK.deep, COVER_BLEND));
    expect(live.deep).not.toEqual(DARK.deep);
  });

  it('is most of the way there in half a second', () => {
    // `k = min(1, dt * 3.4)` is exponential, so "settles over ~0.5s" means
    // ~83 % of the distance in 0.5s, not arrival. Asserted as the bound it
    // actually holds rather than as a round number that would need a fudge.
    const live = freshPalette();
    const settled = freshPalette();
    settlePalette(settled, DARK);
    for (let i = 0; i < 30; i++) stepPalette(live, DARK, 1 / 60);
    for (let j = 0; j < 3; j++) {
      const total = Math.abs(ATLAS_BASE.deep[j] - settled.deep[j]);
      const left = Math.abs(live.deep[j] - settled.deep[j]);
      if (total > 0) expect(left / total).toBeLessThan(0.2);
    }
    // And arrives — within a fraction of one 0–255 step — in a second and a half.
    for (let i = 0; i < 60; i++) stepPalette(live, DARK, 1 / 60);
    for (let j = 0; j < 3; j++) expect(live.deep[j]).toBeCloseTo(settled.deep[j], 0);
  });

  it('settles to the same place whatever the frame rate', () => {
    const a = freshPalette();
    const b = freshPalette();
    for (let i = 0; i < 600; i++) stepPalette(a, BRIGHT, 1 / 60);
    for (let i = 0; i < 1200; i++) stepPalette(b, BRIGHT, 1 / 120);
    for (let j = 0; j < 3; j++) expect(a.mid[j]).toBeCloseTo(b.mid[j], 3);
  });

  it('moves the signature when the palette moves, and not otherwise', () => {
    const live = freshPalette();
    const before = paletteSignature(live);
    expect(paletteSignature(live)).toBe(before);
    settlePalette(live, DARK);
    expect(paletteSignature(live)).not.toBe(before);
  });

  it('does not re-raster the blurred washes on its way there', () => {
    // THE ONE PERFORMANCE RULE. The chrome repaints on every change of the
    // palette signature, and the signature moves on nearly every frame of the
    // crossfade — so the `brightness()` baked into the wash filters must land
    // on a coarse ladder, or `style.filter` is rewritten on a 96px-blurred
    // full-bleed image dozens of times per track change.
    //
    // Measured before the ladder: 59 distinct `wash1` strings over the 109
    // frames of a crossfade into a dark sleeve. Bright artwork clamps to
    // `brightness(1.00)` and produced exactly one, which is why a spot check on
    // a white sleeve could not see this.
    for (const target of [DARK, BRIGHT]) {
      const live = freshPalette();
      const seen = new Set<string>();
      for (let i = 0; i < 140; i++) {
        stepPalette(live, target, 1 / 60);
        seen.add(chromeFor(live).wash1);
      }
      expect(seen.size).toBeLessThanOrEqual(12);
    }
  });
});

describe('liftFor', () => {
  it('is quantised to the 0.05 ladder', () => {
    for (const L of [0, 0.1, 0.23, 0.37, 0.41, 0.52, 0.66, 0.8, 1]) {
      const v = Number(liftFor(L));
      expect(Math.round(v * 100) % 5).toBe(0);
    }
  });

  it('clamps to 1 … 1.55 at both ends', () => {
    expect(liftFor(1)).toBe('1.00');    // a white sleeve is never dimmed
    expect(liftFor(0)).toBe('1.55');    // and a black one is never blown out
  });

  it('still lifts a dark record more than a bright one', () => {
    expect(Number(liftFor(0.15))).toBeGreaterThan(Number(liftFor(0.45)));
  });
});

describe('particlePalette', () => {
  it('lifts the tones toward white so they read on a dark wash', () => {
    const p = particlePalette(DARK);
    expect(p).toHaveLength(3);
    // Every channel of the lifted deep band is brighter than `mid` was.
    for (let j = 0; j < 3; j++) expect(p[0][j]).toBeGreaterThan(DARK.mid[j]);
    expect(p[2]).toEqual([255, 254, 248]);
  });

  it('leaves headroom — this is why `dark: true` is not also passed', () => {
    // The renderer's `dark` flag adds +62/+54/+36 per channel on top. Passing
    // both would double-lift an already-lifted palette to near-white.
    for (const v of particlePalette(BRIGHT)[1]) expect(v).toBeLessThanOrEqual(255);
  });
});
