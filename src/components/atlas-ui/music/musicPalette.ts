/**
 * Artwork → chrome. Every colour on the full player comes from this file.
 *
 * The rule from the handoff (README §5): "every chrome value is derived from
 * the artwork palette each time it changes". `--acc2` / `#ff6a00` is reserved
 * for the voice indicator and is never touched here; `#1ed760` is Spotify's
 * brand mark on the source chip, not a palette value.
 *
 * Ported from `paintChrome` in `Atlas Music Player v2.dc.html`. Two deliberate
 * decisions the handoff leaves ambiguous:
 *
 * 1. LUMINANCE. `paintChrome` defines its OWN `lum` with Rec.709 weights
 *    (0.2126 / 0.7152 / 0.0722) and uses it for the tint-alpha driver `L`,
 *    while `atlas-cover.js` exports a Rec.601 `lum` (0.299 / 0.587 / 0.114)
 *    used for bucketing. Both are in the bundle and they disagree by up to
 *    ~0.1 on saturated green/red sleeves — roughly 0.05 of tint alpha and 0.12
 *    of wash brightness. We keep `paintChrome`'s Rec.709 here, because that is
 *    the formula the tint constants were tuned against. Importing
 *    `atlasCover.lum` because it exists would silently retune the surface.
 *
 * 2. BASE PALETTE. The crossfade ORIGIN below is `[16,17,24] / [52,97,242] /
 *    [196,214,255]`, which is NOT `atlasCover.FALLBACK_PALETTE`
 *    (`[24,24,30] / [52,97,242] / [206,219,255]`). They are near-identical and
 *    look like a bug; they are not the same thing. `FALLBACK_PALETTE` is the
 *    answer to "sampling failed"; `ATLAS_BASE` is the colour the surface starts
 *    from and crosses *away* from when a record loads. Named apart on purpose.
 */
import { hex, rgba, toward, type CoverPalette, type RGB } from '@/lib/atlasCover';

/** The crossfade origin — Atlas ink, Atlas Blue, blue tint. See note 2 above. */
export const ATLAS_BASE: CoverPalette = {
  deep: [16, 17, 24],
  mid: [52, 97, 242],
  light: [196, 214, 255],
};

/**
 * How far the displayed palette travels from Atlas Blue toward the record.
 * A prototype editor knob (`coverColor`, default 0.9) with no app equivalent —
 * frozen at its default rather than exposed as a control nobody would move.
 */
export const COVER_BLEND = 0.9;

/** Rec.709 luminance, 0–1. Deliberately not `atlasCover.lum`; see note 1. */
function lum709(c: readonly number[]): number {
  return (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
}

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);

/**
 * The brightness ladder the wash filters step along. 0.05 over the 1–1.55
 * range is 12 rungs.
 *
 * THIS QUANTISATION IS A PERFORMANCE CONTRACT, NOT A ROUNDING CONVENIENCE, and
 * it is the reason `liftFor` exists instead of an inline `.toFixed(3)`.
 *
 * `lift` is baked into `wash1` / `wash2` / `washS` / `washC`, and every one of
 * those is a `filter` on a full-bleed image blurred by 44–130px. The chrome is
 * repainted on every change of the palette signature, and the signature moves
 * on nearly every frame of the 1.5s crossfade out of Atlas Blue — so an
 * unquantised lift rewrote `style.filter` on the 96px and 130px layers 59 times
 * in a row per track change (measured: 59 distinct strings over 109 frames
 * crossfading into a dark sleeve). Each distinct value invalidates the cached
 * blur of a layer 160–180 % of the viewport, which is the exact per-frame
 * re-raster this surface's one performance rule forbids. Bright sleeves clamp
 * to 1 and produced a single string, which is why the fault was invisible on
 * white artwork.
 *
 * On the ladder a full crossfade crosses a handful of rungs instead of sixty,
 * and 0.05 of brightness on a 96px blur is below the noise floor of the wash.
 */
const LIFT_STEP = 0.05;

/**
 * `brightness()` argument for the wash layers, from the tint driver `L`.
 * Dark sleeves keep their light, bright ones are held back at 1.
 */
export function liftFor(L: number): string {
  const raw = 1 + (0.52 - L) * 1.15;
  const stepped = Math.round(raw / LIFT_STEP) * LIFT_STEP;
  return Math.max(1, Math.min(1.55, stepped)).toFixed(2);
}

/** A live, mutable palette the crossfade writes into every frame. */
export function freshPalette(): CoverPalette {
  return {
    deep: [...ATLAS_BASE.deep] as RGB,
    mid: [...ATLAS_BASE.mid] as RGB,
    light: [...ATLAS_BASE.light] as RGB,
  };
}

/**
 * One crossfade step, in place. `k = min(1, dt * 3.4)` settles a track change
 * over roughly half a second.
 */
export function stepPalette(live: CoverPalette, target: CoverPalette, dt: number): void {
  const k = Math.min(1, dt * 3.4);
  for (const key of ['deep', 'mid', 'light'] as const) {
    const c = live[key];
    const g = toward(ATLAS_BASE[key], target[key], COVER_BLEND);
    for (let j = 0; j < 3; j++) c[j] += (g[j] - c[j]) * k;
  }
}

/** Snap straight to the settled palette — the reduced-motion path. */
export function settlePalette(live: CoverPalette, target: CoverPalette): void {
  for (const key of ['deep', 'mid', 'light'] as const) {
    const g = toward(ATLAS_BASE[key], target[key], COVER_BLEND);
    live[key][0] = g[0]; live[key][1] = g[1]; live[key][2] = g[2];
  }
}

/**
 * The sphere's `palette` option: the live tones lifted toward white so the
 * particles read on a dark wash. `dark: true` is deliberately NOT passed to the
 * renderer alongside this — it would add another +62/+54/+36 per channel and
 * multiply alpha by 1.25, double-lifting an already-lifted palette.
 */
export function particlePalette(live: CoverPalette): RGB[] {
  return [
    toward(live.mid, [255, 255, 255], 0.26),
    toward(live.light, [255, 255, 255], 0.12),
    [255, 254, 248],
  ];
}

/** A cheap change key. The chrome repaints only when this moves. */
export function paletteSignature(live: CoverPalette): string {
  return hex(live.deep) + hex(live.mid);
}

/**
 * Every CSS value the player derives from the record — all three
 * presentations, computed together.
 *
 * They are computed together rather than per surface because they share `lift`
 * and `L`, and because a surface that recomputed its own would be free to drift
 * from the others. Each presentation applies only the fields it owns; the rest
 * cost three template strings on a signature change, which happens a handful of
 * times per track and never per frame.
 */
export interface MusicChrome {
  /** Play/pause glyph ink. Full player and sleeve. */
  ink: string;
  /** Full player: bottom scrim gradient. */
  scrim: string;
  /** Full player: the tint whose alpha follows the artwork's luminance. */
  tint: string;
  /** Full player: `filter` for the 96px wash layer. */
  wash1: string;
  /** Full player: `filter` for the 130px wash layer. */
  wash2: string;
  /** Full player: the vinyl disc, label from `light`, body from `deep`. */
  disc: string;
  /** Sleeve: `filter` for its single wash. */
  washS: string;
  /** Sleeve: the 105° scrim. */
  scrimS: string;
  /** Compact: `filter` for its single wash. */
  washC: string;
  /** Compact: the 100° scrim. */
  scrimC: string;
}

export function chromeFor(live: CoverPalette): MusicChrome {
  const d = live.deep;
  const m = live.mid;
  // Bright sleeves get held back, dark ones keep their light.
  const L = clamp01(lum709(m) * 0.62 + lum709(live.light) * 0.38);
  const lift = liftFor(L);
  return {
    ink: hex(toward(m, [0, 0, 0], 0.62)),
    scrim: `linear-gradient(to bottom,transparent,${rgba(d, 0.9)} 84%)`,
    tint:
      `linear-gradient(178deg,rgba(0,0,0,${(0.14 + L * 0.46).toFixed(3)}),` +
      `rgba(0,0,0,${(0.04 + L * 0.3).toFixed(3)}) 50%,` +
      `rgba(0,0,0,${(0.16 + L * 0.5).toFixed(3)}))`,
    wash1: `blur(96px) saturate(1.75) brightness(${lift})`,
    wash2: `blur(130px) saturate(1.5) brightness(${lift})`,
    disc:
      'repeating-radial-gradient(circle at 50% 50%,rgba(255,253,250,.055) 0 1px,transparent 1px 5px),' +
      `radial-gradient(circle at 50% 50%,${hex(toward(live.light, [255, 253, 250], 0.35))} 0 5.5%,` +
      `${hex(toward(d, [0, 0, 0], 0.55))} 6% 15%,${hex(toward(d, [0, 0, 0], 0.2))} 15% 100%)`,
    // 58 and 44, not the 70 and 52 the .dc.html puts in its markup. The
    // prototype's `paintChrome` overwrites the markup values on the first
    // signature change, which lands a frame or two after mount, so 58/44 are
    // the values the surface actually wears — the markup pair is a pre-palette
    // state nobody sees for longer than a blink. Ours start at 58/44 in CSS so
    // there is no visible step at all.
    washS: `blur(58px) saturate(1.7) brightness(${lift})`,
    scrimS: `linear-gradient(105deg,${rgba(d, 0.9)} 8%,${rgba(d, 0.34)} 62%,${rgba(d, 0.62)})`,
    washC: `blur(44px) saturate(1.7) brightness(${lift})`,
    scrimC: `linear-gradient(100deg,${rgba(d, 0.88)},${rgba(d, 0.4)})`,
  };
}
