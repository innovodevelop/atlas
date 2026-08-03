/**
 * Atlas particle sphere — canvas-2D renderer.
 *
 * Ported from the design handoff's `atlas-sphere.js` (2026-07-26 bundle) with
 * the defects found in docs/design-sync/2026-07-26-audit-sphere-mail-header.md
 * §3 fixed, then MERGED with the v3 bundle (2026-08-03 handoff) which adds a
 * second formation — the field — plus the morph that carries every particle
 * between the two:
 *
 *     morph = 1  → Atlas Sphere   (default; identical to v2 for every caller)
 *     morph = 0  → Particle Field (the sphere unrolled to a plane of waves)
 *     0 < m < 1  → in transit, per-particle staggered, on a bowed arc
 *
 * Every particle owns BOTH homes, so nothing is created or destroyed on a state
 * change: the cloud re-forms. Shading, dot-size and depth banding are one shared
 * pipeline, so a field dot and a sphere dot are the same dot.
 *
 * Rendering approach, unchanged from the handoff because it is the good part:
 * particles are bucketed into 8 depth × 3 shade × 11 alpha = 264 quantised
 * Path2D objects per frame and each is filled once — so a 26 000-particle
 * sphere costs ~264 draw calls, not 26 000. Measured at 0.84 ms/frame for the
 * per-particle maths on Apple silicon (3 % of the 26 ms frame budget), which is
 * why no device tier is needed: this app ships aarch64-only, macOS 13+, so the
 * floor is an M1.
 *
 * --- What this file keeps that BOTH handoff bundles get wrong -----------------
 *
 * v3 re-introduces all five Stage-1 defects. Each is kept fixed here; the v3
 * shape was NOT taken:
 *
 * 1. REMOUNT. The handoff pruned disconnected canvases from `entries` inside the
 *    frame loop but left `el.__atlasSphere` set, so a re-attached canvas hit the
 *    early-return in `mount()` and was never re-added — it stayed blank forever.
 *    Entries live in a WeakMap keyed by the canvas, and the prune path clears
 *    the registration.
 *
 * 2. WATCHDOG. The handoff called `frame()` directly from a setInterval, and
 *    `frame()` unconditionally re-queues itself — so a merely *slow* loop (not a
 *    dead one) grew a second concurrent chain, then a third. The watchdog here
 *    only ever *restarts* a dead pump (cancel, then re-request) and never paints
 *    from its own timer: painting there stacks a synchronous frame on top of a
 *    slow rAF frame and saturates the main thread. v3 additionally adds a
 *    `visibilitychange` listener that schedules a pump with no cancel — combined
 *    with the guard that permanently doubles the callback count, so it is
 *    deliberately NOT adopted; the guard already covers the un-hide case.
 *
 * 3. TEARDOWN. rAF and the interval were never cancelled; they ran for the life
 *    of the page even with zero canvases mounted. In a desktop app that never
 *    reloads, that is forever. Both stop when the last entry unmounts.
 *
 * 4. REDUCED MOTION. Honoured nowhere in either bundle. A `prefers-reduced-motion`
 *    user gets one frame, then stillness — not a slower spin, because continuous
 *    motion is the trigger regardless of speed. See `still` in `paint()` for the
 *    morph rule. Listens live, so toggling the OS setting takes effect without a
 *    reload.
 *
 * 5. ERRORS. The handoff's empty catch swallowed everything forever, so a
 *    missing Path2D (or any bug) produced a silently blank sphere. Now logged
 *    once per canvas.
 *
 * Also kept over v3: `??` defaulting (v3's `||` turns `count: 0`, `dens: 0` and
 * `maxDpr: 0` into their defaults), the frozen exports, the preallocated `paths`
 * array, the null-context guard, `aria-hidden`, and the horizontal half of the
 * off-screen test.
 *
 * --- Deliberate deviations from v3, with reasons ------------------------------
 *
 * A. CACHE KEY. v3 keys the cloud on `n|dens|ar.toFixed(2)` — ~350 distinct keys
 *    across the clamped aspect range, against a cache that holds 8. Dragging a
 *    window edge walks the aspect continuously, so a full-bleed field would
 *    rebuild the cloud (26 000 allocations + three O(n log n) sorts) many times
 *    per second at a near-zero hit rate. The lattice depends on the aspect only
 *    through `cols`, so the key is `n|dens|cols` with `cols` quantised to a ~6 %
 *    ladder: ~18 buckets over the whole aspect range, cells within ~3 % of
 *    square, and key and geometry cannot disagree because the same `cols` is
 *    passed into the lattice.
 *
 * B. EVICTION. The port already evicted one entry instead of v3's
 *    `clouds.clear()`, but it evicted in INSERTION order — so past 8 entries the
 *    hot 26 000-point default cloud, created first, was always the victim. Now a
 *    real LRU: a hit re-inserts.
 *
 * C. ADAPTIVE THINNING is applied to the FIELD only. Particles are sorted into
 *    bit-reversed row order so any prefix is a set of evenly-spaced whole lattice
 *    rows — an aligned sub-lattice on the plane, which is what makes thinning
 *    invisible there. On the sphere those same rows are latitude bands, so a
 *    prefix removes whole rings and the sphere visibly stripes. v3 thins both.
 *
 * D. VIEW-TRANSITION NAMING (v3's `atlas-orb` `viewTransitionName`) is not
 *    ported: the app does not use the View Transitions API, and
 *    `atlas-transition.js` is on the handoff's own do-not-port list.
 *
 * E. The alpha and wave maths are ported from the CODE, not from the README §3
 *    prose, which omits both the cubic crest weighting and the `aSoft` term and
 *    therefore overstates field alpha by up to ~2.5× at low crest. See
 *    `crestAlpha()`.
 */

export const PRESET = Object.freeze({ count: 26000, dens: 0.7, size: 0.6, soft: 0 } as const);

export const STATES = Object.freeze([
  'idle', 'listening', 'thinking', 'speaking', 'working',
  'success', 'alert', 'muted', 'waking', 'dissolving',
] as const);

export type SphereState = (typeof STATES)[number];

export type RGB = readonly [number, number, number];

export interface SphereOpts {
  state?: SphereState;
  dark?: boolean;
  count?: number;
  dens?: number;
  size?: number;
  soft?: number;
  countScale?: number;

  // --- v3: formation ---------------------------------------------------------
  /** 1 = sphere (default), 0 = field, in between = in transit. */
  morph?: number;
  /** Wave amplitude of the field, 0–1. Default 0.3. */
  amp?: number;
  /** Extra radial swell on the field, 0–1. Default 0. */
  pulse?: number;
  /** Field size as a fraction of the canvas. Default 1.06 (slight bleed). */
  fieldSpread?: number;
  /** Fraction of particles that belong to the sphere; the rest fade on the way in. */
  sphereFrac?: number;

  // --- v3: colour ------------------------------------------------------------
  /** [deep, mid, light] RGB triples — e.g. an artwork palette. Overrides the state tint. */
  palette?: readonly RGB[] | null;
  /** Multiplies every particle's alpha. Default 1. */
  alphaGain?: number;
  /** Backdrop glow alpha. Default 0.15 dark / 0.07 light; 0 disables it. */
  glow?: number;
  /** Blend every shade toward white, 0–1. Default 0. */
  whiten?: number;

  // --- v3: geometry / motion -------------------------------------------------
  /** Sphere radius as a fraction of the canvas's SHORT edge. Default 0.44. */
  radius?: number;
  /** Centre as a fraction of width / height. Default 0.5 / 0.5. */
  cx?: number;
  cy?: number;
  /** Overrides the per-state spin rate. */
  spin?: number;
  /** Backing-store density cap. Default 1.5. */
  maxDpr?: number;
}

/** Live values: pass a getter so the render loop never waits on a React commit. */
export type SphereOptsSource = SphereOpts | (() => SphereOpts);

/** Per-canvas render handle returned by `mount()`. Adaptive quality lives here. */
export interface SphereHandle {
  /** Draw fraction, 0.3–1. Thins the FIELD draw only; never reaches the cache key. */
  q: number;
  /** Whether the frame loop is allowed to trade density for frame time. */
  adaptive: boolean;
  /** Smoothed paint cost in ms, or null before the first measured frame. */
  ema: number | null;
}

const TINT: Partial<Record<SphereState, RGB>> = {
  thinking: [109, 75, 255],
  speaking: [22, 168, 122],
  working: [224, 122, 31],
  success: [30, 176, 128],
  alert: [208, 69, 58],
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

interface Particle {
  // Sphere home.
  x: number; y: number; z: number; r: number; rn: number;
  // Waking/dissolving scatter home.
  ox: number; oy: number; oz: number;
  // Shell coordinates, used once to hand out lattice cells.
  lon: number; lat: number;
  /** ±1 — which way this particle bows on the way across. */
  par: number;
  // Field home, assigned by the lattice pass.
  /** Bit-reversed row rank; the draw-order key. */
  rk: number;
  /** Cell centre, 0–1 across the field. */
  u: number;
  /** Cell centre, -1–1 down the field. */
  vy: number;
  /** Sub-cell jitter, so the lattice does not read as a grid. */
  jx: number; jy: number;
  /** Normalised distance from the field centre, 0–1. */
  fr: number;
}

const MAX_CLOUDS = 8;
const clouds = new Map<string, Particle[]>();

/**
 * Lattice width for a given particle count and canvas aspect, quantised to a
 * ~6 % ladder so a live resize walks a short list of cache keys rather than a
 * continuum. See deviation A in the file header.
 */
export function latticeCols(n: number, ar: number): number {
  const a = ar > 4 ? 4 : ar < 0.5 ? 0.5 : ar || 1;   // `|| 1` also catches NaN
  const step = Math.log(1.06);
  const exact = Math.sqrt(n * a);
  return Math.max(2, Math.round(Math.exp(Math.round(Math.log(exact) / step) * step)));
}

function cloud(n: number, dens: number, cols: number): Particle[] {
  const key = `${n}|${dens.toFixed(2)}|${cols}`;
  const hit = clouds.get(key);
  // Re-insert on a hit so the map's iteration order is genuine LRU. Reading
  // without touching made `keys().next()` insertion order, which evicted the
  // first-created cloud — normally the hot 26 000-point default — every time.
  if (hit) { clouds.delete(key); clouds.set(key, hit); return hit; }
  // Evict one entry rather than clearing the map: dragging the editor's count
  // slider walks through many values, and wiping every cached cloud made each
  // step re-allocate 26 000 objects.
  if (clouds.size >= MAX_CLOUDS) clouds.delete(clouds.keys().next().value as string);

  const P: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const th = Math.random() * 6.2832;
    const ph = Math.acos(2 * Math.random() - 1);
    const r = Math.pow(Math.random(), dens);
    const x = r * Math.sin(ph) * Math.cos(th);
    const y = r * Math.sin(ph) * Math.sin(th);
    const z = r * Math.cos(ph);
    // Longitude is measured in the x-z plane because the renderer spins about y.
    const lon = (Math.atan2(z, x) + Math.PI) / 6.2832;
    let sy = r > 1e-4 ? y / r : 0;
    if (sy > 1) sy = 1; else if (sy < -1) sy = -1;
    P.push({
      x, y, z, r, rn: Math.random(),
      ox: (Math.random() - 0.5) * 4.2,
      oy: (Math.random() - 0.5) * 4.2,
      oz: (Math.random() - 0.5) * 4.2,
      lon,
      // Gamma-shaped so equatorial rows are not over-packed.
      lat: (sy < 0 ? -1 : 1) * Math.pow(Math.abs(sy), 0.62),
      par: Math.random() < 0.5 ? -1 : 1,
      rk: 0, u: 0, vy: 0, jx: 0, jy: 0, fr: 0,
    });
  }

  /* Field home = an even, half-offset (hex-packed) lattice sized to the canvas
     aspect, so cells are square on screen and the plane reads clean rather than
     clumped. Cells are handed out in latitude→longitude order, so the sphere
     still UNROLLS into the field: neighbours on the shell stay neighbours here. */
  const rows = Math.max(2, Math.ceil(n / cols));
  let rb = 1;
  while ((1 << rb) < rows) rb++;
  const rev = (v: number): number => {
    let out = 0;
    for (let b = 0; b < rb; b++) { out = (out << 1) | (v & 1); v >>= 1; }
    return out;
  };
  const order = P.slice().sort((a, b) => a.lat - b.lat);
  for (let row = 0; row < rows; row++) {
    const slice = order.slice(row * cols, (row + 1) * cols);
    if (!slice.length) break;
    slice.sort((a, b) => a.lon - b.lon);
    const off = (row & 1) ? 0.5 : 0;
    for (let c = 0; c < slice.length; c++) {
      const q = slice[c];
      q.rk = rev(row);
      q.u = (c + 0.5 + off) / cols;
      q.vy = ((row + 0.5) / rows) * 2 - 1;
      q.jx = (Math.random() - 0.5) * (1.6 / cols);     // ±8 % of a cell
      q.jy = (Math.random() - 0.5) * (0.32 / rows);
      const ex = (q.u * 2 - 1) + q.jx, ey = (q.vy + q.jy) * 1.05;
      q.fr = Math.min(1, Math.sqrt(ex * ex + ey * ey) / 1.3);
    }
  }
  /* Draw order = complete rows in bit-reversed sequence, so ANY prefix of the
     array is a set of evenly-spaced whole rows — adaptive thinning stays an
     aligned sub-lattice instead of collapsing into Poisson clumps. (v3 carries a
     comment here claiming particles stay in creation order; its own sort below
     contradicts it, so the comment was not ported.) */
  P.sort((a, b) => (a.rk - b.rk) || (a.u - b.u));
  clouds.set(key, P);
  return P;
}

const NB = 8, NA = 11, NS = 3;
const STAG = 0.62;    // how much of the morph is spent staggering
const BOW = 0.17;     // arc height as a fraction of travel length

/**
 * Shared across every canvas, and safe ONLY because painting is synchronous and
 * single-threaded: `paint` nulls all 264 slots and fully consumes them before
 * returning, with no await and no yield in between. If this function ever gains
 * an `await`, two canvases will silently paint into each other's buckets —
 * move this into the entry at that point.
 */
const paths: (Path2D | null)[] = new Array(NB * NS * NA).fill(null);

interface Entry extends SphereHandle {
  el: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  opts: SphereOptsSource;
  warned: boolean;
}

function readOpts(entry: Entry): SphereOpts {
  return typeof entry.opts === 'function' ? entry.opts() || {} : entry.opts;
}

/**
 * Where the sphere sits on a canvas of any aspect. v2 derived every term from
 * `el.width`, so a 1200×400 tile centred the sphere 400 px below the canvas and
 * scaled the dots off the long edge. Radius follows the SHORT edge.
 */
export function sphereGeometry(W: number, H: number, o: SphereOpts = {}): {
  S: number; R: number; cx: number; cy: number;
} {
  const S = W < H ? W : H;
  return {
    S,
    R: S * (o.radius ?? 0.44),
    cx: W * (o.cx ?? 0.5),
    cy: H * (o.cy ?? 0.5),
  };
}

/**
 * Crest weighting for the field's alpha. The README gives `crest²`; the handoff
 * code is `crest² · (0.4 + 0.6·crest)` — a cubic-weighted square that pushes
 * troughs dark so the waves read as bands of light travelling through the plane
 * rather than as flat noise. Implementing the prose instead makes the field
 * visibly flatter and up to ~2.5× brighter at low crest.
 */
export function crestAlpha(crest: number): number {
  return 0.045 + 0.95 * (crest * crest * (0.4 + 0.6 * crest));
}

/** Test seam: the field alpha for one particle, whole formula in one place. */
export function fieldAlpha(wv: number, edge: number, amp: number, aSoft = 1): number {
  return edge * crestAlpha(wv * 0.5 + 0.5) * (0.58 + amp * 0.7) * aSoft;
}

/**
 * How far along its transit one particle is, 0 = field home, 1 = sphere home.
 * Staggered by `STAG`, so at any mid-morph value some particles have arrived and
 * others have not left. At morph 1 every particle returns exactly 1 and at
 * morph 0 exactly 0, which is what makes the endpoints identical to v2.
 */
export function morphTransit(morph: number, fr: number, rn: number): number {
  const wgt = fr * 0.55 + rn * 0.45;
  let e = morph * (1 + STAG) - wgt * STAG;
  if (e < 0) e = 0; else if (e > 1) e = 1;
  return e * e * (3 - 2 * e);
}

function paint(entry: Entry, t: number): void {
  const { el, ctx } = entry;
  const o = readOpts(entry);
  const st = (o.state || (el.getAttribute('data-state') as SphereState) || 'idle') as SphereState;
  const dark = !!o.dark;
  const still = reduceMotion();
  const count = Math.max(400, Math.round((o.count ?? PRESET.count) * (o.countScale ?? 1)));
  const dens = o.dens ?? PRESET.dens;
  const dotSize = o.size ?? PRESET.size;
  const sof = clamp01((o.soft ?? PRESET.soft) / 10);

  // Floored rather than defaulted: `maxDpr: 0` means "as cheap as possible", not
  // "I forgot to pass one" — v3's `||` silently turned it into 1.5.
  const dpr = Math.max(0.5, Math.min(o.maxDpr ?? 1.5, window.devicePixelRatio || 1));
  const cw = el.clientWidth || el.width;
  const ch = el.clientHeight || el.height;
  if (!cw || !ch) return;
  // Re-read every frame so moving the window to a different-density monitor
  // recovers on the next paint. Height is checked too: v2 tested the width
  // alone, so a canvas that resized vertically at constant width kept rendering
  // stretched from a stale backing store forever.
  const wantW = Math.round(cw * dpr), wantH = Math.round(ch * dpr);
  if (el.width !== wantW || el.height !== wantH) { el.width = wantW; el.height = wantH; }

  const W = el.width, H = el.height;
  const { S, R, cx, cy } = sphereGeometry(W, H, o);
  const T = still ? 0 : t * 0.001;

  // --- formation state -------------------------------------------------------
  // Reduced motion settles to the sphere: the morph does not animate and the
  // formation does not drift. A still field would still be a still *plane*, and
  // the plane only reads as Atlas while it is moving.
  const morph = still ? 1 : clamp01(o.morph ?? 1);
  const mixed = morph < 0.999;
  const amp = o.amp ?? 0.3;
  const pulse = o.pulse ?? 0;
  const aGain = o.alphaGain ?? 1;
  const whiten = o.whiten ?? 0;
  const pal = (o.palette && o.palette.length >= 3) ? o.palette : null;
  const spread = o.fieldSpread ?? 1.06;
  const fw = W * 0.5 * spread, fh = H * 0.5 * spread;
  // The positional wave is deliberately small: the field's motion is carried by
  // alpha, and a large displacement folds lattice rows into moiré.
  const fAmp = H * (0.008 + amp * 0.05);
  const sphereFrac = o.sphereFrac ?? 1;
  // A ±2.2 % elastic overshoot that peaks mid-transit and vanishes at both ends.
  const settle = mixed ? 1 + Math.sin((1 - morph) * 9.4) * 0.022 * morph * (1 - morph) * 4 : 1;

  // Draw thinning: FIELD only. See deviation C in the file header.
  const cols = latticeCols(count, W / H);
  const pts = cloud(count, dens, cols);
  const lim = (mixed && entry.q < 1)
    ? Math.max(400, Math.min(pts.length, Math.round(pts.length * entry.q)))
    : pts.length;

  ctx.clearRect(0, 0, W, H);

  // Motion is half of v2's throughout — the handoff halved spin, the wobble and
  // the listening ripple, and gave idle its own slower breath.
  let spin = 0.0006, sat = 1, jx = 0, radial = 0.82;
  if (st === 'listening') spin = 0.0013;
  else if (st === 'thinking') spin = 0.002;
  else if (st === 'speaking') spin = 0.0015;
  else if (st === 'working') spin = 0.003;
  else if (st === 'muted') { spin = 0.00025; radial = 0.68; sat = 0; }
  else if (st === 'alert') jx = Math.sin(T * 15) * Math.max(0, Math.sin(T * 2.6)) * 1.6 * dpr;
  if (o.spin != null) spin = o.spin;
  if (still) spin = 0;

  const tint = TINT[st] || null;
  const rot = still ? 0 : t * spin, ca = Math.cos(rot), sa = Math.sin(rot);
  const breathe = 1 + Math.sin(T * (st === 'idle' ? 0.16 : 0.3)) * 0.03;
  // A still frame shows the SETTLED form of a transitional state, never a frozen
  // mid-transition — `waking` at T=0 would otherwise paint an invisible sphere.
  const wake = st === 'waking' ? (still ? 1 : Math.min(1, ((T * 0.55) % 1.9) / 1.3)) : 1;
  const diss = st === 'dissolving' ? (still ? 0 : ((T * 0.6) % 1.9) / 1.9) : 0;

  const gAlpha = o.glow ?? (dark ? 0.15 : 0.07);
  if (gAlpha > 0) {
    // The glow belongs to the sphere, so it shrinks and fades out with the morph.
    const gR = R * 1.25 * (mixed ? 0.35 + 0.65 * morph : 1);
    const gc = pal ? pal[2] : (tint || [52, 97, 242]);
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, gR);
    const ga = (gAlpha * (0.45 + morph * 0.55)).toFixed(3);
    glow.addColorStop(0, `rgba(${gc[0] | 0},${gc[1] | 0},${gc[2] | 0},${ga})`);
    glow.addColorStop(1, `rgba(${gc[0] | 0},${gc[1] | 0},${gc[2] | 0},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(cx, cy, gR, 0, 6.2832);
    ctx.fill();
  }

  const szSoft = 1 + sof * 0.75, aSoft = 1 - sof * 0.42;
  for (let i = 0; i < NB * NS * NA; i++) paths[i] = null;

  for (let pi = 0; pi < lim; pi++) {
    const p = pts[pi];
    let x = p.x, y = p.y, z = p.z, aMul = 1, szMul = 1, dscale = 1;
    const wob = (1 + Math.sin(T * 0.5 + p.rn * 8) * 0.06) * breathe;
    x *= wob; y *= wob; z *= wob;

    if (st === 'listening') {
      const d0 = Math.sqrt(x * x + y * y + z * z) || 1e-4;
      const w = Math.sin(d0 * 8 - T * 4) * 0.09, k = 1 + w;
      x *= k; y *= k; z *= k; aMul = 1.18 + w * 2;
    } else if (st === 'thinking') {
      const sh = y * 0.9 + Math.sin(T * 1.3) * 0.2;
      const cs = Math.cos(sh), ss = Math.sin(sh), nx = x * cs - z * ss;
      z = x * ss + z * cs; x = nx;
    } else if (st === 'speaking') {
      const band = Math.floor((y + 1) * 4);
      const sAmp = 0.22 * Math.abs(Math.sin(T * 6 + band * 1.3)) * (1 - Math.abs(y) * 0.4);
      const k = 1 + sAmp;
      x *= k; z *= k; aMul = 0.9 + sAmp * 2.2;
    } else if (st === 'working') {
      const mix = 0.72, rr = Math.sqrt(x * x + z * z) || 1e-4, tr = 0.78 + (rr - 0.78) * 0.28;
      x += ((x / rr) * tr - x) * mix; z += ((z / rr) * tr - z) * mix; y *= 1 - mix * 0.72;
    } else if (st === 'alert') {
      const k = 1 + 0.1 * Math.max(0, Math.sin(T * 5.2)) * Math.max(0, Math.sin(T * 2.6));
      x *= k; y *= k; z *= k;
    } else if (st === 'success') {
      if (p.rn > 0.52) {
        const q = (T * 0.62 + p.rn * 1.85) % 1, e = 1 - (1 - q) * (1 - q), k = 1 + e * 1.05;
        x *= k; y *= k; z *= k; dscale = k;
        aMul = (1 - q) * (1 - q) * 1.6; szMul = 1 - 0.4 * e;
      } else {
        const k = 0.94 + 0.06 * Math.sin(T * 3.1);
        x *= k; y *= k; z *= k;
      }
    } else if (st === 'waking') {
      const q = clamp01((wake - p.rn * 0.5) / 0.5);
      const e = q * q * (3 - 2 * q);
      x = p.ox + (x - p.ox) * e; y = p.oy + (y - p.oy) * e; z = p.oz + (z - p.oz) * e;
      aMul = e * e; szMul = 0.5 + 0.5 * e;
    } else if (st === 'dissolving') {
      const q = clamp01((diss - p.rn * 0.35) / 0.65);
      const e = q * q, k = 1 + e * 0.9;
      x *= k; y *= k; z *= k; aMul = (1 - e) * (1 - e);
    }

    const X = x * ca + z * sa, Z = -x * sa + z * ca;
    let depth = (Z + 1) / 2;
    const dd = Math.sqrt(X * X + y * y + Z * Z) / dscale;
    let a = Math.max(0, 1 - Math.max(0, (dd - 0.42) / 0.5)) * (0.4 + depth * 0.6) * aMul * aSoft;
    const kR = R * (radial / 0.82) * settle;
    let px = cx + X * kR + jx, py = cy + y * kR;

    if (mixed) {
      // --- field home + travelling waves --------------------------------------
      const lin = Math.sin(p.u * 12.566 - T * 1.5 + p.vy * 2.3) * 0.78
                + Math.sin(p.u * 5.4 + T * 0.58 - p.vy * 1.1) * 0.34;
      const rad0 = Math.sin(p.fr * 5.1 - T * 2.3);
      const wv = (lin + (0.22 + 0.5 * pulse) * rad0) / (1.06 + 0.5 * pulse);
      let edge = 1 - p.fr * p.fr * p.fr;
      if (edge < 0) edge = 0;
      const fx = cx + ((p.u * 2 - 1) + p.jx) * fw;
      const fy = cy + (p.vy + p.jy) * fh + wv * fAmp * edge;
      const crest = wv * 0.5 + 0.5;
      let fDepth = 0.14 + 0.7 * crest + p.r * 0.14;
      if (fDepth > 1) fDepth = 1;
      const fa = edge * crestAlpha(crest) * (0.58 + amp * 0.7) * aSoft;

      // --- per-particle staggered, bowed transit ------------------------------
      const e = morphTransit(morph, p.fr, p.rn);
      const dx = px - fx, dy = py - fy, L = Math.sqrt(dx * dx + dy * dy) || 1;
      const bow = Math.sin(Math.PI * e) * L * BOW * p.par;
      px = fx + dx * e - (dy / L) * bow;
      py = fy + dy * e + (dx / L) * bow;
      depth = fDepth + (depth - fDepth) * e;
      a = fa + (a - fa) * e;
      szMul *= 1 + Math.sin(Math.PI * e) * 0.3;
      // Field-only extras dissolve on the way in rather than piling onto the shell.
      if (sphereFrac < 1 && p.rn > sphereFrac) a *= 1 - e;
    }

    a *= aGain;
    if (dark) a *= 1.25;
    if (a <= 0.014) continue;
    if (a > 1) a = 1;

    let sz = (0.6 + p.rn * 1.05) * (0.5 + depth * 0.7) * (S / 360) * szMul * dotSize * szSoft;
    // arc() throws on a negative or NaN radius, and ONE throw kills the whole
    // frame. Written as `!(sz > 0.04)` so NaN is rejected too.
    if (!(sz > 0.04)) continue;
    if (sz > 7) sz = 7;

    const db = depth < 0 ? 0 : depth > 0.999 ? NB - 1 : (depth * NB) | 0;
    let ab = (a * NA) | 0;
    if (ab >= NA) ab = NA - 1;
    const sb = p.rn < 0.34 ? 0 : p.rn < 0.72 ? 1 : 2;
    const key = (db * NS + sb) * NA + ab;
    const pt = paths[key] || (paths[key] = new Path2D());
    // Round dots; sub-pixel specks stay square (visually identical, much
    // cheaper). The moveTo is what stops arc() joining the previous subpath with
    // a hairline across the canvas.
    if (sz < 0.95) pt.rect(px - sz, py - sz, sz * 2, sz * 2);
    else { pt.moveTo(px + sz, py); pt.arc(px, py, sz, 0, 6.2831853); }
  }

  const bs = tint || [52, 97, 242];
  const sp = 1 - sof * 0.92;
  const paper = dark ? [58, 60, 74] : [249, 247, 244];
  const lift = (c: number, ix: number, f: number) => {
    const v = c + (paper[ix] - c) * sof * 0.62 * f;
    return v < 0 ? 0 : v > 255 ? 255 : v;
  };
  // A supplied palette is [deep, mid, light] and maps straight onto the three
  // shade bands, so an artwork palette drops in where the state tint would go.
  const SH = pal ? [
    [lift(pal[0][0], 0, 0.8), lift(pal[0][1], 1, 0.8), lift(pal[0][2], 2, 0.8)],
    [lift(pal[1][0], 0, 1), lift(pal[1][1], 1, 1), lift(pal[1][2], 2, 1)],
    [lift(pal[2][0], 0, 1.15), lift(pal[2][1], 1, 1.15), lift(pal[2][2], 2, 1.15)],
  ] : [
    [lift(bs[0] * (1 - 0.48 * sp), 0, 0.8), lift(bs[1] * (1 - 0.5 * sp), 1, 0.8), lift(bs[2] * (1 - 0.38 * sp), 2, 0.8)],
    [lift(bs[0], 0, 1), lift(bs[1], 1, 1), lift(bs[2], 2, 1)],
    [lift(bs[0] + (255 - bs[0]) * 0.46 * sp, 0, 1.15), lift(bs[1] + (255 - bs[1]) * 0.42 * sp, 1, 1.15), lift(bs[2] + (255 - bs[2]) * 0.3 * sp, 2, 1.15)],
  ];
  if (whiten) {
    for (let wi = 0; wi < 3; wi++) {
      for (let wj = 0; wj < 3; wj++) SH[wi][wj] += (255 - SH[wi][wj]) * whiten;
    }
  }

  for (let dbi = 0; dbi < NB; dbi++) {
    const dpth = (dbi + 0.5) / NB, f2 = 0.46 + dpth * 0.72;
    for (let sbi = 0; sbi < NS; sbi++) {
      const s3 = SH[sbi];
      let cr = Math.min(255, s3[0] * f2), cg = Math.min(255, s3[1] * f2), cb = Math.min(255, s3[2] * f2);
      if (!sat) { const l = cr * 0.3 + cg * 0.5 + cb * 0.2; cr = cg = cb = l; }
      if (dark) { cr = Math.min(255, cr + 62); cg = Math.min(255, cg + 54); cb = Math.min(255, cb + 36); }
      const head = `rgba(${cr | 0},${cg | 0},${cb | 0},`;
      for (let abi = 0; abi < NA; abi++) {
        const pth = paths[(dbi * NS + sbi) * NA + abi];
        if (!pth) continue;
        ctx.fillStyle = head + ((abi + 0.6) / NA).toFixed(3) + ')';
        ctx.fill(pth);
      }
    }
  }
}

// --- loop -------------------------------------------------------------------

const registry = new WeakMap<HTMLCanvasElement, Entry>();
const entries: Entry[] = [];
let raf = 0, guard = 0, prev = 0, last = 0;

// The MediaQueryList is cached rather than the boolean: `matches` is live, so
// this stays correct as the OS setting changes while costing one property read
// per paint instead of a fresh matchMedia() per canvas per frame.
let motionMQ: MediaQueryList | null | undefined;

function motionQuery(): MediaQueryList | null {
  if (motionMQ === undefined) {
    motionMQ = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  }
  return motionMQ;
}

const reduceMotion = (): boolean => !!motionQuery()?.matches;

function visible(el: HTMLCanvasElement): boolean {
  const r = el.getBoundingClientRect();
  // A display:none element reports an all-zero rect, so this covers it too.
  // Horizontal is checked as well — the original only tested vertically, so a
  // canvas scrolled off to the side kept painting.
  return !(r.bottom < 0 || r.top > window.innerHeight ||
           r.right < 0 || r.left > window.innerWidth || !r.width);
}

/** Paint one canvas, tolerating a failure without killing the shared loop. */
function safePaint(e: Entry, t: number): void {
  try {
    paint(e, t);
  } catch (err) {
    // The handoff swallowed this silently, so any failure — a missing Path2D,
    // a bad opts getter — produced a blank sphere with nothing in the console.
    if (!e.warned) {
      e.warned = true;
      console.error('[atlasSphere] paint failed; this canvas will stay blank', err);
    }
  }
}

/**
 * Trade field density for frame time on a canvas that opted in, so a slow
 * machine degrades density rather than smoothness. ~4.7× slower to recover than
 * to degrade, so it does not oscillate around the threshold.
 */
function adapt(e: Entry, ms: number): void {
  e.ema = e.ema == null ? ms : e.ema + (ms - e.ema) * 0.12;
  if (e.ema > 15 && e.q > 0.3) e.q = Math.max(0.3, e.q - 0.07);
  else if (e.ema < 9 && e.q < 1) e.q = Math.min(1, e.q + 0.015);
}

function frame(t: number): void {
  raf = requestAnimationFrame(frame);
  last = performance.now();
  if (t - prev < 26) return;   // ~38fps cap
  prev = t;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e.el.isConnected) {
      // Clear the registration too, or a re-attached canvas can never re-mount.
      registry.delete(e.el);
      entries.splice(i, 1);
      continue;
    }
    if (!visible(e.el)) continue;
    if (!e.adaptive) { safePaint(e, t); continue; }
    const t0 = performance.now();
    safePaint(e, t);
    adapt(e, performance.now() - t0);
  }
  if (!entries.length) stop();
}

/** One frame for every mounted canvas, then nothing. The reduced-motion path. */
function paintOnce(): void {
  const t = performance.now();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e.el.isConnected) { registry.delete(e.el); entries.splice(i, 1); continue; }
    if (visible(e.el)) safePaint(e, t);
  }
}

function stop(): void {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
  // window.clearInterval, matching the window.setInterval that created it —
  // the two must come from the same object or teardown silently no-ops.
  if (guard) { window.clearInterval(guard); guard = 0; }
}

function start(): void {
  if (reduceMotion()) { paintOnce(); return; }
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  if (!guard) {
    // 1200 / 1400 ms is the handoff's documented contract, and 8 timer wake-ups
    // a second forever is not free in a desktop app that never closes.
    guard = window.setInterval(() => {
      // RESTART the loop rather than driving it. The handoff called frame()
      // directly, and frame() re-queues itself unconditionally — so a slow loop
      // spawned a second concurrent chain, then a third, and got slower still.
      // Skipping while hidden also stops a backgrounded window from painting
      // 26 000 particles for nobody.
      if (document.visibilityState === 'hidden') return;
      if (performance.now() - last > 1400) {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(frame);
      }
    }, 1200);
  }
}

// Reduced-motion is honoured live: toggling the OS setting flips the sphere
// between animated and still without a reload.
{
  const mq = motionQuery();
  if (mq) {
    const onChange = () => { stop(); if (entries.length) start(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange);
  }
}

/**
 * Drive `el` from the shared loop. Returns the render handle, or null if the
 * canvas cannot provide a 2D context.
 *
 * `cfg.adaptive` lets a heavy full-bleed field trade density for frame time.
 */
export function mount(
  el: HTMLCanvasElement | null,
  opts: SphereOptsSource = {},
  cfg?: { adaptive?: boolean },
): SphereHandle | null {
  if (!el) return null;
  const existing = registry.get(el);
  if (existing) {
    existing.opts = opts;
    if (cfg) existing.adaptive = !!cfg.adaptive;
    return existing;
  }
  const ctx = el.getContext('2d');
  if (!ctx) return null;
  el.setAttribute('aria-hidden', 'true');   // decorative; the state is announced as text
  const entry: Entry = {
    el, ctx, opts, warned: false,
    q: 1, adaptive: !!cfg?.adaptive, ema: null,
  };
  registry.set(el, entry);
  entries.push(entry);
  start();
  return entry;
}

export function unmount(el: HTMLCanvasElement | null): void {
  if (!el) return;
  const entry = registry.get(el);
  if (!entry) return;
  const i = entries.indexOf(entry);
  if (i >= 0) entries.splice(i, 1);
  registry.delete(el);
  if (!entries.length) stop();
}

/**
 * Re-render once after a state change. Only meaningful under reduced motion —
 * with the loop running, the next frame picks the change up anyway. Call it
 * whenever `state` or any other opt changes so a still sphere still communicates.
 */
export function refresh(): void {
  if (reduceMotion()) paintOnce();
}

/** Test seam: how many canvases the shared loop is currently driving. */
export function mountedCount(): number {
  return entries.length;
}

/** Test seam: whether the shared loop is running. */
export function isRunning(): boolean {
  return raf !== 0;
}

/** Test seam: the live particle-cloud cache keys, oldest first. */
export function cachedCloudKeys(): string[] {
  return [...clouds.keys()];
}
