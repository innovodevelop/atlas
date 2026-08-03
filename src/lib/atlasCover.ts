/**
 * Atlas cover art — the bridge between a record and the Sphere.
 *
 * Ported from the design handoff's `atlas-cover.js`
 * (`design_handoff_atlas_suite_v2`, README §4). Two jobs:
 *
 *   make(seed, tone)   → a 512² abstract sleeve as a data URL, deterministic
 *                        per seed. Stands in when a track has no artwork.
 *   read(img, tone)    → `{ deep, mid, light }` sampled from real artwork, so
 *                        the music surface is coloured by the record and never
 *                        hardcoded. Everything downstream — wash, scrims,
 *                        particles, vinyl, chrome — reads that trio.
 *
 * `read` is deliberately total: it returns the supplied fallback rather than
 * throwing. The common failure is a *tainted canvas* — Spotify CDN artwork
 * loaded without CORS — which is an expected runtime state, not a bug, and it
 * must not be able to take a render down. It needs a same-origin or CORS-clean
 * image to succeed. Sample the artwork the player already holds; do not refetch.
 *
 * What changed from the handoff, and why:
 *
 * 1. SEED RANGE. The handoff's LCG seeds with `seed * 9301 + 49297` un-reduced,
 *    then multiplies that value by 9301 again before the first `% 233280`.
 *    Past a seed of ~1e8 that product exceeds 2^53 and rounds, so the stream
 *    starts from an *approximation* of the seed — and since an LCG is fully
 *    determined by its first state, two seeds that round together share an
 *    entire sleeve. At `Date.now()` scale they do: 1700000000000 and
 *    1700000000457 generate the identical image (measured; ~3 % of consecutive
 *    seeds collide there). The seed is reduced mod 233280 up front instead.
 *    Because `(a * 9301 + 49297) mod m` depends only on `a mod m`, this
 *    produces the *same* stream for every seed the handoff's arithmetic was
 *    exact for — verified identical for 1…233279 — it only removes the cliff.
 *    Strings are hashed into the same domain, so a Spotify track id can be
 *    passed as the seed directly.
 *
 * 2. NaN SAFETY. `clamp` folds NaN to the low bound, so `hex([NaN, …])` yields
 *    `#000000` rather than the string `#NaNNaNNaN` — an invalid colour that
 *    voids the whole CSS declaration wherever it lands, with no error.
 *
 * 3. `rgba` CLAMPS. The handoff emitted `(c[0] | 0)` raw. An out-of-range
 *    channel is easy to produce (`toward` extrapolates for k > 1) and yields
 *    `rgba(-9,…)`, which is not a valid colour — the paint silently vanishes.
 *    Channels are clamped to 0–255 and alpha to 0–1. In-range values are
 *    byte-identical to the handoff, truncation included.
 *
 * 4. TRANSPARENT PIXELS ARE SKIPPED when sampling. The handoff read RGB and
 *    ignored alpha, so a sleeve with transparency contributed pure black and
 *    dragged `deep` to black regardless of the art. Opaque artwork — every JPEG
 *    cover — samples identically.
 *
 * 5. NO SHARED PALETTE OBJECT. The handoff returned its default fallback *by
 *    reference*, so one caller mutating a channel corrupted the default for
 *    every later caller. Both fallback paths return a fresh copy.
 *
 * 6. FAILURES ARE REPORTED, not swallowed. The handoff's `catch (e)` hid every
 *    cause behind an identical fallback. Each distinct failure is logged once
 *    (never per frame) and the last one is readable via `lastCoverFailure()`.
 *
 * Not changed, deliberately: the weighting, bucketing and tone-separation maths
 * in `read`, and every constant in `make`. That is the tuned part.
 *
 * `make` is not cheap — ~262k RNG steps for the grain pass plus two large
 * blurs. Memoise it per track at the call site. It holds no cache of its own,
 * on purpose, so the determinism guarantee stays testable.
 */

/** A colour as `[r, g, b]`, each 0–255. Not clamped in transit; clamped on output. */
export type RGB = [number, number, number];

/** The palette in the order `make` and the sphere's `palette` option want it. */
export type Tone = [RGB, RGB, RGB];

export interface CoverPalette {
  deep: RGB;
  mid: RGB;
  light: RGB;
}

/** What `read` returns when it cannot sample: Atlas ink, Atlas Blue, blue tint. */
export const FALLBACK_PALETTE: CoverPalette = {
  deep: [24, 24, 30],
  mid: [52, 97, 242],
  light: [206, 219, 255],
};

/** The handoff LCG's modulus. */
const M = 233280;

/** The handoff's full-turn constant. Slightly over 2π, so `arc` closes. */
const TAU = 6.2832;

// --- diagnostics ------------------------------------------------------------

let lastFailure: unknown = null;
const warned = new Set<string>();

/**
 * Log a failure once per distinct cause — never per call. Both entry points can
 * run on every artwork change, and a tainted sleeve fails identically forever;
 * logging each time would bury the first, genuinely new failure. The key is
 * bounded so a pathological stream of unique messages cannot grow the set.
 */
function noteFailure(where: string, err: unknown): void {
  lastFailure = err;
  const key = `${where}|${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`;
  if (warned.has(key) || warned.size > 32) return;
  warned.add(key);
  console.warn(`[atlasCover] ${where}`, err);
}

/** The most recent caught failure, or null. A diagnostic seam, not control flow. */
export function lastCoverFailure(): unknown {
  return lastFailure;
}

// --- colour helpers ---------------------------------------------------------

/**
 * Written as `v > a` rather than `v < a` so NaN falls to the low bound instead
 * of propagating into a colour string. Finite values behave exactly as the
 * handoff's version does.
 */
function clamp(v: number, a: number, b: number): number {
  return v > a ? (v < b ? v : b) : a;
}

/** Perceptual-ish luminance, 0–1. Rec.601 weights, as the handoff uses. */
export function lum(c: readonly number[]): number {
  return (c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114) / 255;
}

/**
 * Linear colour blend: `k = 0` is `c`, `k = 1` is `t`. Always returns a new
 * array — aliasing a palette entry here would let one surface's tween mutate
 * another's colour. Not clamped: `read`'s separation pass relies on plain
 * lerping, and extrapolation (k > 1) is a legitimate caller choice. Output goes
 * through `hex`/`rgba`, which clamp.
 */
export function toward(c: readonly number[], t: readonly number[], k: number): RGB {
  return [
    c[0] + (t[0] - c[0]) * k,
    c[1] + (t[1] - c[1]) * k,
    c[2] + (t[2] - c[2]) * k,
  ];
}

/** `#rrggbb`, rounded and clamped. */
export function hex(c: readonly number[]): string {
  let s = '#';
  for (let i = 0; i < 3; i++) {
    const v = clamp(Math.round(c[i]), 0, 255).toString(16);
    s += v.length < 2 ? '0' + v : v;
  }
  return s;
}

/** `rgba(r,g,b,a)` — channels truncated (as the handoff) and clamped to 0–255. */
export function rgba(c: readonly number[], a: number): string {
  const r = clamp(c[0], 0, 255) | 0;
  const g = clamp(c[1], 0, 255) | 0;
  const b = clamp(c[2], 0, 255) | 0;
  return `rgba(${r},${g},${b},${clamp(a, 0, 1)})`;
}

/** Palette → the `[deep, mid, light]` tuple `make` and the sphere want. */
export function toTone(p: CoverPalette): Tone {
  const q = clonePalette(p);
  return [q.deep, q.mid, q.light];
}

function copyRGB(c: readonly number[] | undefined | null, dflt: RGB): RGB {
  return c && c.length >= 3 ? [c[0], c[1], c[2]] : [dflt[0], dflt[1], dflt[2]];
}

/** Total: a missing or malformed palette yields the default, never a throw. */
function clonePalette(p: CoverPalette | null | undefined): CoverPalette {
  return {
    deep: copyRGB(p?.deep, FALLBACK_PALETTE.deep),
    mid: copyRGB(p?.mid, FALLBACK_PALETTE.mid),
    light: copyRGB(p?.light, FALLBACK_PALETTE.light),
  };
}

function normTone(tone: Tone | CoverPalette | null | undefined): Tone {
  const p = Array.isArray(tone)
    ? ({ deep: tone[0], mid: tone[1], light: tone[2] } as CoverPalette)
    : (tone as CoverPalette);
  const q = clonePalette(p);
  return [q.deep, q.mid, q.light];
}

// --- deterministic RNG ------------------------------------------------------

/**
 * Reduce any seed into [1, M) so the LCG below stays in exact-integer range.
 * See header note 1: reducing first is arithmetically identical to the
 * handoff's stream, it just cannot lose precision. A seed of 0 (or any
 * multiple of M) becomes 1, matching the handoff's `seed || 1`.
 */
function seedInt(seed: number | string): number {
  if (typeof seed === 'string') {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % M) || 1;
  }
  const n = Number.isFinite(seed) ? Math.trunc(seed) : 1;
  return (((n % M) + M) % M) || 1;
}

function rnd(seed: number | string): () => number {
  let s = (seedInt(seed) * 9301 + 49297) % M;
  return () => {
    s = (s * 9301 + 49297) % M;
    return s / M;
  };
}

// --- canvas plumbing --------------------------------------------------------

interface Surface {
  el: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

function surface(size: number, opts?: CanvasRenderingContext2DSettings): Surface | null {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null;
  const el = document.createElement('canvas');
  el.width = size;
  el.height = size;
  const ctx = el.getContext('2d', opts);
  return ctx ? { el, ctx } : null;
}

/** Assignment to an unsupported `filter` is a no-op, but stay defensive. */
function setFilter(ctx: CanvasRenderingContext2D, v: string): void {
  try {
    ctx.filter = v;
  } catch {
    // No canvas filter support: the sleeve reads harder-edged, not broken.
  }
}

// --- make -------------------------------------------------------------------

/**
 * A 512² procedural sleeve as a JPEG data URL — deterministic for a given seed
 * and tone. Returns `''` (never throws) when no 2D canvas is available, so the
 * caller can fall back to "no art" rather than handle an exception in render.
 *
 * @param seed  Any stable per-track value. Numbers and strings (a track id)
 *              both work; equal seeds always produce an equal image.
 * @param tone  `[deep, mid, light]` or a `CoverPalette`.
 */
export function make(seed: number | string, tone: Tone | CoverPalette = FALLBACK_PALETTE): string {
  try {
    // Inside the guard: `document.createElement` itself is a call that can fail
    // in a non-browser host, and a sleeve must never throw into a render.
    const s = surface(512);
    if (!s) {
      noteFailure('make: no 2D canvas — returning no art', new Error('no 2D canvas'));
      return '';
    }
    const { el, ctx } = s;
    const N = 512;
    const R = rnd(seed);
    const [deep, mid, light] = normTone(tone);

    ctx.fillStyle = hex(deep);
    ctx.fillRect(0, 0, N, N);

    // Soft colour masses — blurred hard, so the sleeve reads as light, not shapes.
    setFilter(ctx, 'blur(46px)');
    const blobs: Array<[number, number, number, RGB, number]> = [
      [0.26, 0.22, 0.56, mid, 1],
      [0.76, 0.34, 0.5, light, 0.9],
      [0.5, 0.84, 0.62, mid, 0.8],
      [0.14, 0.7, 0.4, light, 0.55],
      [0.86, 0.86, 0.36, deep, 0.85],
    ];
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      // R() is consumed in this exact order — changing it changes every sleeve.
      const bx = (b[0] + (R() - 0.5) * 0.16) * N;
      const by = (b[1] + (R() - 0.5) * 0.16) * N;
      const br = b[2] * N * (0.8 + R() * 0.4);
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, rgba(b[3], b[4]));
      g.addColorStop(1, rgba(b[3], 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, TAU);
      ctx.fill();
    }

    // One hard-edged mark keeps it from reading as a pure gradient.
    setFilter(ctx, 'blur(2px)');
    const mx = (0.34 + R() * 0.3) * N;
    const my = (0.3 + R() * 0.34) * N;
    const mr = (0.2 + R() * 0.1) * N;
    const mg = ctx.createLinearGradient(mx - mr, my - mr, mx + mr, my + mr);
    mg.addColorStop(0, rgba(toward(light, [255, 255, 255], 0.5), 0.5));
    mg.addColorStop(1, rgba(light, 0.04));
    ctx.fillStyle = mg;
    ctx.beginPath();
    ctx.arc(mx, my, mr, 0, TAU);
    ctx.fill();
    setFilter(ctx, 'none');

    // Sweep.
    const sw = ctx.createLinearGradient(0, N, N, 0);
    sw.addColorStop(0, rgba(deep, 0.38));
    sw.addColorStop(0.55, rgba(deep, 0));
    sw.addColorStop(1, rgba(light, 0.16));
    ctx.fillStyle = sw;
    ctx.fillRect(0, 0, N, N);

    // Grain. Optional: a context without pixel access still returns a sleeve.
    if (typeof ctx.getImageData === 'function') {
      try {
        const im = ctx.getImageData(0, 0, N, N);
        const d = im.data;
        for (let p = 0; p < d.length; p += 4) {
          const n = (R() - 0.5) * 15;
          d[p] = clamp(d[p] + n, 0, 255);
          d[p + 1] = clamp(d[p + 1] + n, 0, 255);
          d[p + 2] = clamp(d[p + 2] + n, 0, 255);
        }
        ctx.putImageData(im, 0, 0);
      } catch (err) {
        noteFailure('make: grain pass skipped (no pixel access)', err);
      }
    } else {
      noteFailure('make: grain pass skipped (context has no getImageData)', new Error('no getImageData'));
    }

    if (typeof el.toDataURL !== 'function') return '';
    return el.toDataURL('image/jpeg', 0.9);
  } catch (err) {
    // A sleeve is decoration. Never let it throw into a render.
    noteFailure('make: sleeve generation failed — returning no art', err);
    return '';
  }
}

// --- read -------------------------------------------------------------------

/**
 * Sample a three-tone palette from artwork.
 *
 * Never throws. Returns a copy of `fallback` (or `FALLBACK_PALETTE`) when the
 * image is cross-origin and taints the canvas, has not decoded yet, or is too
 * flat to yield two colours.
 */
export function read(
  src: CanvasImageSource | null | undefined,
  fallback?: CoverPalette | null,
): CoverPalette {
  try {
    if (!src) throw new Error('no image');
    // An <img> that has not decoded draws nothing; drawImage does not throw for
    // it, so without this the sampler silently returns an all-transparent read.
    const nw = (src as HTMLImageElement).naturalWidth;
    if (typeof nw === 'number' && nw === 0) throw new Error('image has not decoded yet');

    const N = 40;
    const s = surface(N, { willReadFrequently: true });
    if (!s) throw new Error('no 2D canvas available');
    const { ctx } = s;
    ctx.drawImage(src, 0, 0, N, N);
    const d = ctx.getImageData(0, 0, N, N).data;

    // Bucket by 3 bits per channel, weighting saturated mid-luminance pixels up
    // — a Map rather than an object literal, but the maths is the handoff's.
    const box = new Map<number, [number, number, number, number]>();
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 8) continue;   // see header note 4
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx ? (mx - mn) / mx : 0;
      const L = lum([r, g, b]);
      const wgt = 0.3 + sat * 1.7 + (L > 0.12 && L < 0.94 ? 0.45 : 0);
      const k = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      let e = box.get(k);
      if (!e) { e = [0, 0, 0, 0]; box.set(k, e); }
      e[0] += r * wgt; e[1] += g * wgt; e[2] += b * wgt; e[3] += wgt;
    }

    const list: Array<[number, number, number, number]> = [];
    for (const v of box.values()) {
      if (v[3] > 1.2) list.push([v[0] / v[3], v[1] / v[3], v[2] / v[3], v[3]]);
    }
    if (list.length < 2) throw new Error('image yields fewer than two colours');

    list.sort((a, b) => b[3] - a[3]);
    const top = list.slice(0, 7).sort((a, b) => lum(a) - lum(b));
    const hi = top[top.length - 1];
    const mi = Math.max(0, Math.min(top.length - 1, Math.round((top.length - 1) * 0.55)));

    let deep: RGB = [top[0][0], top[0][1], top[0][2]];
    let light: RGB = [hi[0], hi[1], hi[2]];
    let mid: RGB = [top[mi][0], top[mi][1], top[mi][2]];

    // Guarantee the three tones separate, whatever the artwork. Order matters:
    // mid is pulled toward the ALREADY-adjusted deep/light.
    const ld = lum(deep);
    if (ld > 0.2) deep = toward(deep, [10, 9, 14], (ld - 0.16) / Math.max(0.2, ld));
    const ll = lum(light);
    if (ll < 0.74) light = toward(light, [255, 252, 246], (0.78 - ll) / 0.78);
    const lm = lum(mid);
    if (lm < 0.3) mid = toward(mid, light, 0.4);
    else if (lm > 0.66) mid = toward(mid, deep, 0.32);

    return { deep, mid, light };
  } catch (err) {
    // Expected whenever the sleeve is cross-origin: reading pixels off a
    // tainted canvas throws SecurityError. Logged once per cause, then quiet.
    noteFailure('read: could not sample the artwork — using the fallback tone', err);
    return clonePalette(fallback || FALLBACK_PALETTE);
  }
}
