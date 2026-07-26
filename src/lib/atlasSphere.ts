/**
 * Atlas particle sphere — canvas-2D renderer, ported from the design handoff's
 * `atlas-sphere.js` (2026-07-26 bundle) with the defects found in
 * docs/design-sync/2026-07-26-audit-sphere-mail-header.md §3 fixed.
 *
 * Rendering approach, unchanged from the handoff because it is the good part:
 * particles are bucketed into 8 depth × 3 shade × 11 alpha = 264 quantised
 * Path2D objects per frame and each is filled once — so a 26 000-particle
 * sphere costs ~264 draw calls, not 26 000. Measured at 0.84 ms/frame for the
 * per-particle maths on Apple silicon (3 % of the 26 ms frame budget), which is
 * why no device tier is needed: this app ships aarch64-only, macOS 13+, so the
 * floor is an M1.
 *
 * What changed from the handoff, and why:
 *
 * 1. REMOUNT. The original pruned disconnected canvases from `entries` inside
 *    the frame loop but left `el.__atlasSphere` set, so a re-attached canvas hit
 *    the early-return in `mount()` and was never re-added — it stayed blank
 *    forever. Almost certainly the "rAF loop dead after a remount" bug the
 *    watchdog existed to paper over. Entries now live in a WeakMap keyed by the
 *    canvas, and the prune path clears the registration.
 *
 * 2. WATCHDOG. The original called `frame()` directly from a setInterval, and
 *    `frame()` unconditionally re-queues itself — so a merely *slow* loop (not a
 *    dead one) grew a second concurrent chain, then a third. On a backgrounded
 *    window, where rAF is throttled to nothing, the interval became the render
 *    driver and painted 26 000 particles for nobody. Both are worse on weaker
 *    hardware, which is exactly backwards. The watchdog now *restarts* the loop
 *    (cancel, then re-request) and only while the document is visible.
 *
 * 3. TEARDOWN. rAF and the interval were never cancelled; they ran for the life
 *    of the page even with zero canvases mounted. In a desktop app that never
 *    reloads, that is forever. Both stop when the last entry unmounts.
 *
 * 4. REDUCED MOTION. Honoured nowhere before. A `prefers-reduced-motion` user
 *    gets one frame, then stillness — not a slower spin, because continuous
 *    motion is the trigger regardless of speed. Re-rendered on state change so
 *    the sphere still *communicates*, it just does not animate. Listens live, so
 *    toggling the OS setting takes effect without a reload.
 *
 * 5. ERRORS. The original's empty catch swallowed everything forever, so a
 *    missing Path2D (or any bug) produced a silently blank sphere. Now logged
 *    once per canvas.
 */

export const PRESET = { count: 26000, dens: 0.7, size: 0.6, soft: 0 } as const;

export const STATES = [
  'idle', 'listening', 'thinking', 'speaking', 'working',
  'success', 'alert', 'muted', 'waking', 'dissolving',
] as const;

export type SphereState = (typeof STATES)[number];

export interface SphereOpts {
  state?: SphereState;
  dark?: boolean;
  count?: number;
  dens?: number;
  size?: number;
  soft?: number;
  countScale?: number;
}

/** Live values: pass a getter so the render loop never waits on a React commit. */
export type SphereOptsSource = SphereOpts | (() => SphereOpts);

const TINT: Partial<Record<SphereState, [number, number, number]>> = {
  thinking: [109, 75, 255],
  speaking: [22, 168, 122],
  working: [224, 122, 31],
  success: [30, 176, 128],
  alert: [208, 69, 58],
};

interface Particle { x: number; y: number; z: number; rn: number; ox: number; oy: number; oz: number }

const clouds = new Map<string, Particle[]>();

function cloud(n: number, dens: number): Particle[] {
  const key = `${n}|${dens.toFixed(2)}`;
  const hit = clouds.get(key);
  if (hit) return hit;
  // Evict one entry rather than clearing the map: dragging the editor's count
  // slider walks through many values, and wiping every cached cloud made each
  // step re-allocate 26 000 objects.
  if (clouds.size > 8) clouds.delete(clouds.keys().next().value as string);
  const P: Particle[] = [];
  for (let i = 0; i < n; i++) {
    const th = Math.random() * 6.2832;
    const ph = Math.acos(2 * Math.random() - 1);
    const r = Math.pow(Math.random(), dens);
    P.push({
      x: r * Math.sin(ph) * Math.cos(th),
      y: r * Math.sin(ph) * Math.sin(th),
      z: r * Math.cos(ph),
      rn: Math.random(),
      ox: (Math.random() - 0.5) * 4.2,
      oy: (Math.random() - 0.5) * 4.2,
      oz: (Math.random() - 0.5) * 4.2,
    });
  }
  clouds.set(key, P);
  return P;
}

const NB = 8, NA = 11, NS = 3;

/**
 * Shared across every canvas, and safe ONLY because painting is synchronous and
 * single-threaded: `paint` nulls all 264 slots and fully consumes them before
 * returning, with no await and no yield in between. If this function ever gains
 * an `await`, two canvases will silently paint into each other's buckets —
 * move this into the entry at that point.
 */
const paths: (Path2D | null)[] = new Array(NB * NS * NA).fill(null);

interface Entry {
  el: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  opts: SphereOptsSource;
  warned: boolean;
  lastKey: string;
}

function readOpts(entry: Entry): SphereOpts {
  return typeof entry.opts === 'function' ? entry.opts() || {} : entry.opts;
}

function paint(entry: Entry, t: number): void {
  const { el, ctx } = entry;
  const o = readOpts(entry);
  const st = (o.state || (el.getAttribute('data-state') as SphereState) || 'idle') as SphereState;
  const dark = !!o.dark;
  const count = Math.max(400, Math.round((o.count ?? PRESET.count) * (o.countScale ?? 1)));
  const dens = o.dens ?? PRESET.dens;
  const dotSize = o.size ?? PRESET.size;
  const sof = Math.max(0, Math.min(1, (o.soft ?? PRESET.soft) / 10));

  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const cw = el.clientWidth || el.width;
  const ch = el.clientHeight || el.height;
  if (!cw || !ch) return;
  // Re-read every frame so moving the window to a different-density monitor
  // recovers on the next paint.
  if (el.width !== Math.round(cw * dpr)) {
    el.width = Math.round(cw * dpr);
    el.height = Math.round(ch * dpr);
  }

  const S = el.width, R = S * 0.44, cx = S / 2, cy = S / 2;
  const pts = cloud(count, dens);
  const T = t * 0.001;
  ctx.clearRect(0, 0, S, S);

  let spin = 0.0016, sat = 1, jx = 0, radial = 0.82;
  if (st === 'listening') spin = 0.0026;
  else if (st === 'thinking') spin = 0.004;
  else if (st === 'speaking') spin = 0.003;
  else if (st === 'working') spin = 0.006;
  else if (st === 'muted') { spin = 0.0006; radial = 0.68; sat = 0; }
  else if (st === 'alert') jx = Math.sin(T * 15) * Math.max(0, Math.sin(T * 2.6)) * 1.6 * dpr;

  const tint = TINT[st] || null;
  const rot = t * spin, ca = Math.cos(rot), sa = Math.sin(rot);
  const breathe = 1 + Math.sin(T * 0.6) * 0.03;
  const wake = st === 'waking' ? Math.min(1, ((T * 0.55) % 1.9) / 1.3) : 1;
  const diss = st === 'dissolving' ? ((T * 0.6) % 1.9) / 1.9 : 0;

  const gc = tint || [52, 97, 242];
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.25);
  glow.addColorStop(0, `rgba(${gc[0]},${gc[1]},${gc[2]},${dark ? 0.15 : 0.07})`);
  glow.addColorStop(1, `rgba(${gc[0]},${gc[1]},${gc[2]},0)`);
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, R * 1.25, 0, 6.2832);
  ctx.fill();

  const szSoft = 1 + sof * 0.75, aSoft = 1 - sof * 0.42;
  for (let i = 0; i < NB * NS * NA; i++) paths[i] = null;

  for (let pi = 0; pi < pts.length; pi++) {
    const p = pts[pi];
    let x = p.x, y = p.y, z = p.z, aMul = 1, szMul = 1, dscale = 1;
    const wob = (1 + Math.sin(T + p.rn * 8) * 0.06) * breathe;
    x *= wob; y *= wob; z *= wob;

    if (st === 'listening') {
      const d0 = Math.sqrt(x * x + y * y + z * z) || 1e-4;
      const w = Math.sin(d0 * 8 - T * 8) * 0.09, k = 1 + w;
      x *= k; y *= k; z *= k; aMul = 1.18 + w * 2;
    } else if (st === 'thinking') {
      const sh = y * 0.9 + Math.sin(T * 1.3) * 0.2;
      const cs = Math.cos(sh), ss = Math.sin(sh), nx = x * cs - z * ss;
      z = x * ss + z * cs; x = nx;
    } else if (st === 'speaking') {
      const band = Math.floor((y + 1) * 4);
      const amp = 0.22 * Math.abs(Math.sin(T * 6 + band * 1.3)) * (1 - Math.abs(y) * 0.4);
      const k = 1 + amp;
      x *= k; z *= k; aMul = 0.9 + amp * 2.2;
    } else if (st === 'working') {
      const mix = 0.72, rr = Math.sqrt(x * x + z * z) || 1e-4, tr = 0.78 + (rr - 0.78) * 0.28;
      x += ((x / rr) * tr - x) * mix; z += ((z / rr) * tr - z) * mix; y *= 1 - mix * 0.72;
    } else if (st === 'alert') {
      const pulse = 1 + 0.1 * Math.max(0, Math.sin(T * 5.2)) * Math.max(0, Math.sin(T * 2.6));
      x *= pulse; y *= pulse; z *= pulse;
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
      const q = Math.min(1, Math.max(0, (wake - p.rn * 0.5) / 0.5));
      const e = q * q * (3 - 2 * q);
      x = p.ox + (x - p.ox) * e; y = p.oy + (y - p.oy) * e; z = p.oz + (z - p.oz) * e;
      aMul = e * e; szMul = 0.5 + 0.5 * e;
    } else if (st === 'dissolving') {
      const q = Math.min(1, Math.max(0, (diss - p.rn * 0.35) / 0.65));
      const e = q * q, k = 1 + e * 0.9;
      x *= k; y *= k; z *= k; aMul = (1 - e) * (1 - e);
    }

    const X = x * ca + z * sa, Z = -x * sa + z * ca;
    const depth = (Z + 1) / 2;
    const dd = Math.sqrt(X * X + y * y + Z * Z) / dscale;
    let a = Math.max(0, 1 - Math.max(0, (dd - 0.42) / 0.5)) * (0.4 + depth * 0.6) * aMul * aSoft;
    if (dark) a *= 1.25;
    if (a <= 0.014) continue;
    if (a > 1) a = 1;

    const db = depth < 0 ? 0 : depth > 0.999 ? NB - 1 : (depth * NB) | 0;
    let ab = (a * NA) | 0;
    if (ab >= NA) ab = NA - 1;
    const sb = p.rn < 0.34 ? 0 : p.rn < 0.72 ? 1 : 2;
    const key = (db * NS + sb) * NA + ab;
    const pt = paths[key] || (paths[key] = new Path2D());
    const sz = (0.6 + p.rn * 1.05) * (0.5 + depth * 0.7) * (S / 360) * szMul * dotSize * szSoft;
    const px = cx + X * R * (radial / 0.82) + jx;
    const py = cy + y * R * (radial / 0.82);
    pt.rect(px - sz, py - sz, sz * 2, sz * 2);
  }

  const bs = tint || [52, 97, 242];
  const sp = 1 - sof * 0.92;
  const paper = dark ? [58, 60, 74] : [249, 247, 244];
  const lift = (c: number, ix: number, f: number) => {
    const v = c + (paper[ix] - c) * sof * 0.62 * f;
    return v < 0 ? 0 : v > 255 ? 255 : v;
  };
  const SH = [
    [lift(bs[0] * (1 - 0.48 * sp), 0, 0.8), lift(bs[1] * (1 - 0.5 * sp), 1, 0.8), lift(bs[2] * (1 - 0.38 * sp), 2, 0.8)],
    [lift(bs[0], 0, 1), lift(bs[1], 1, 1), lift(bs[2], 2, 1)],
    [lift(bs[0] + (255 - bs[0]) * 0.46 * sp, 0, 1.15), lift(bs[1] + (255 - bs[1]) * 0.42 * sp, 1, 1.15), lift(bs[2] + (255 - bs[2]) * 0.3 * sp, 2, 1.15)],
  ];

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
let entries: Entry[] = [];
let raf = 0, guard = 0, prev = 0, last = 0;

const reduceMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
    safePaint(e, t);
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
    guard = window.setInterval(() => {
      // RESTART the loop rather than driving it. The handoff called frame()
      // directly, and frame() re-queues itself unconditionally — so a slow loop
      // spawned a second concurrent chain, then a third, and got slower still.
      // Skipping while hidden also stops a backgrounded window from painting
      // 26 000 particles for nobody.
      if (document.visibilityState === 'hidden') return;
      if (performance.now() - last > 260) {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(frame);
      }
    }, 120);
  }
}

// Reduced-motion is honoured live: toggling the OS setting flips the sphere
// between animated and still without a reload.
if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const onChange = () => { stop(); if (entries.length) start(); };
  if (mq.addEventListener) mq.addEventListener('change', onChange);
  else mq.addListener(onChange);
}

export function mount(el: HTMLCanvasElement | null, opts: SphereOptsSource = {}): void {
  if (!el) return;
  const existing = registry.get(el);
  if (existing) { existing.opts = opts; return; }
  const ctx = el.getContext('2d');
  if (!ctx) return;
  el.setAttribute('aria-hidden', 'true');   // decorative; the state is announced as text
  const entry: Entry = { el, ctx, opts, warned: false, lastKey: '' };
  registry.set(el, entry);
  entries.push(entry);
  start();
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
 * whenever `state` changes so a still sphere still communicates.
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
