/**
 * QuickSphere — the Beta veil particle sphere, ported from the handoff's
 * `atlas-quickstart-sphere.js` (design/current/design_handoff_atlas_beta).
 *
 * The algorithm is the designer's, kept line for line where it matters so the
 * app's sphere is the one in the references: one shared rAF for every
 * instance, offscreen instances sleep (IntersectionObserver), physics runs on
 * alternating halves of the particles each frame, and dots are blended
 * straight into an ImageData buffer (one putImageData per frame).
 *
 * What changed in the port:
 *   - typed, and a module instead of `window.QuickSphere`
 *   - `prefers-reduced-motion: reduce` paints one settled frame and stops
 *   - `target()` and the tint tables are exported so the state maths is testable
 *
 * The older contour/field engine (`atlasSphere.ts`) stays for the non-Beta
 * screens until phase 8 retires them.
 */

export type QuickSphereMode = 'contour' | 'tide' | 'spiral' | 'veil' | 'vortex' | 'breathe' | 'murmur';

export const QS_STATES = [
  'idle', 'listening', 'thinking', 'speaking', 'working',
  'success', 'alert', 'muted', 'waking', 'dissolving',
] as const;
export type QuickSphereState = (typeof QS_STATES)[number];

export type RGB = readonly [number, number, number];

export interface QuickSphereOpts {
  count: number;
  dust: RGB;
  strand: RGB;
  /** A hex colour, or 'transparent' (then `tone` is the fill the sphere sits on). */
  bg: string;
  tone?: RGB;
  blend: 'source-over' | 'lighter';
  speed: number;
  seed: number;
  spin: number;
  alpha: number;
  scale: number;
  mode: QuickSphereMode;
  state: QuickSphereState;
}

export interface QuickSphereHandle {
  set(next: Partial<QuickSphereOpts>): void;
  destroy(): void;
}

type Params = {
  flow: number; spin: number; tight: number; wav: number; aF: number; fF: number; aM: number; fM: number;
  aV: number; aB: number; bR: number; b2: number; aS: number; fS: number; turb: number; scale: number;
  fade: number; mix: number; osc: number; drift: number; wake: number; swirl: number; sway: number;
};
type ParamKey = keyof Params;
type StateTarget = Partial<Params> & { tint?: TintKey };
type TintKey = 'c' | 'v' | 'b' | 'a' | 'g' | 'r' | 'n' | 'd' | 'm';

function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function gauss(r: () => number): number { return Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(6.2832 * r()); }
export function hex(h: string): RGB {
  let s = (h || '#ffffff').replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function unit(r: () => number): [number, number, number] {
  const x = gauss(r), y = gauss(r), z = gauss(r);
  const m = Math.hypot(x, y, z) || 1;
  return [x / m, y / m, z / m];
}
function perp(a: readonly number[]): [number[], number[]] {
  let u = [-a[1], a[0], 0];
  let m = Math.hypot(u[0], u[1]);
  if (m < 1e-3) { u = [0, -a[2], a[1]]; m = Math.hypot(u[1], u[2]); }
  u = u.map((v) => v / m);
  const w = [a[1] * u[2] - a[2] * u[1], a[2] * u[0] - a[0] * u[2], a[0] * u[1] - a[1] * u[0]];
  return [u, w];
}

export const DEF: Params = { flow: 1, spin: 1, tight: 1, wav: 1, aF: 0, fF: 2.4, aM: 0, fM: 0.8, aV: 0, aB: 0, bR: 0.4, b2: 0, aS: 0, fS: 0.5, turb: 0, scale: 1, fade: 1, mix: 0, osc: 0, drift: 0, wake: 0, swirl: 0, sway: 1 };

/* every flow has its own hand-tuned table — the same state reads through that
   flow's own structure (bands / arms / curtains) rather than a shared effect */
const MODE_STATES: Record<string, Record<string, StateTarget>> = {
  tide: {
    listening: { flow: 0.5, spin: 0.45, tight: 1.35, wav: 0.85, aF: 0.03, fF: 2.4, scale: 1.015 },
    thinking: { flow: 1.5, spin: 1.6, tight: 1.5, wav: 1.2, osc: 1, aM: 0.014, fM: 2.4 },
    speaking: { flow: 1.05, tight: 1.15, aV: 0.05 },
    working: { flow: 1.5, spin: 1.3, wav: 1.7, aM: 0.028, fM: 1.8, turb: 0.02 },
    success: { flow: 0.75, spin: 0.8, aB: 0.05, bR: 0.3, mix: 0.85, tint: 'g' },
    alert: { flow: 1.3, osc: 0.6, aB: 0.04, bR: 0.95, b2: 0.8, turb: 0.05, mix: 0.9, tint: 'r' },
    muted: { flow: 0.2, spin: 0.25, tight: 1.8, fade: 0.5, mix: 0.75, tint: 'n', scale: 0.95 },
    waking: { flow: 0.8, spin: 0.6, fade: 0.92, wake: 1 },
    dissolving: { flow: 0.55, tight: 0.45, wav: 0.6, drift: 0.3 },
  },
  spiral: {
    listening: { flow: 0.5, spin: 0.4, wav: 0.65, tight: 1.3, aF: 0.028, fF: 2.0, scale: 1.02 },
    thinking: { flow: 1.6, spin: 2.0, wav: 1.6, tight: 1.5, aM: 0.02, fM: 3.4, swirl: 0.12 },
    speaking: { flow: 1.1, tight: 1.15, aV: 0.05 },
    working: { flow: 1.5, spin: 1.4, wav: 2.0, tight: 1.3, aS: 0.04, fS: 0.5 },
    success: { flow: 0.8, wav: 0.8, aB: 0.05, bR: 0.32, mix: 0.85, tint: 'g' },
    alert: { flow: 1.3, swirl: 0.1, aB: 0.042, bR: 1.0, b2: 0.8, turb: 0.04, mix: 0.9, tint: 'r' },
    muted: { flow: 0.2, spin: 0.25, wav: 0.8, tight: 0.5, fade: 0.5, mix: 0.75, tint: 'n', scale: 0.95 },
    waking: { flow: 0.85, spin: 0.7, fade: 0.92, wake: 1 },
    dissolving: { flow: 0.6, wav: 0.45, tight: 0.5, drift: 0.3, swirl: 0.08 },
  },
  veil: {
    listening: { flow: 0.45, spin: 0.4, wav: 0.6, sway: 0.4, aF: 0.03, fF: 2.6, scale: 1.015 },
    thinking: { flow: 1.6, spin: 1.8, wav: 1.8, sway: 1.6, aM: 0.018, fM: 3.0 },
    speaking: { flow: 1.1, sway: 1.2, aV: 0.055 },
    working: { flow: 1.4, spin: 1.2, wav: 1.4, aM: 0.032, fM: 2.2 },
    success: { flow: 0.75, sway: 0.7, aB: 0.05, bR: 0.3, mix: 0.85, tint: 'g' },
    alert: { flow: 1.3, wav: 1.5, sway: 1.8, aB: 0.04, bR: 1.0, b2: 0.8, turb: 0.04, mix: 0.9, tint: 'r' },
    muted: { flow: 0.2, spin: 0.25, sway: 0.15, tight: 0.5, fade: 0.5, mix: 0.75, tint: 'n', scale: 0.95 },
    waking: { flow: 0.85, spin: 0.7, fade: 0.92, wake: 1 },
    dissolving: { flow: 0.55, wav: 0.4, tight: 0.45, drift: 0.3 },
  },
};

/* one colour per state — light grounds use the deeper value, ink grounds the lighter one */
export const TINT: Record<TintKey, RGB> = { c: [22, 150, 190], v: [120, 84, 255], b: [52, 97, 242], a: [224, 122, 31], g: [15, 174, 118], r: [208, 69, 58], n: [139, 134, 129], d: [214, 150, 60], m: [150, 110, 180] };
export const TINT_INK: Record<TintKey, RGB> = { c: [110, 214, 240], v: [180, 156, 255], b: [143, 168, 255], a: [255, 179, 107], g: [80, 220, 160], r: [240, 120, 110], n: [170, 166, 160], d: [255, 210, 138], m: [214, 184, 230] };
export const STATE_TINT: Record<QuickSphereState, TintKey | null> = { idle: null, listening: 'c', thinking: 'v', speaking: 'b', working: 'a', success: 'g', alert: 'r', muted: 'n', waking: 'd', dissolving: 'm' };
for (const m in MODE_STATES) {
  for (const st of QS_STATES) {
    const tint = STATE_TINT[st];
    if (!tint) continue;
    const e = MODE_STATES[m][st] || (MODE_STATES[m][st] = {});
    if (!e.tint) { e.tint = tint; e.mix = e.mix != null ? e.mix : (st === 'speaking' ? 0.7 : 0.8); }
  }
}

/** The parameter set a (mode, state) settles toward. Pure, so it is tested. */
export function target(mode: QuickSphereMode, st: QuickSphereState): Params & { tint?: TintKey } {
  return Object.assign({}, DEF, (MODE_STATES[mode] || {})[st] || {});
}
const sm = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

interface Live { vis: boolean; tick(now: number): void }
const live = new Set<Live>();
let pump = 0;
function loop(now: number) { pump = 0; for (const s of live) if (s.vis) s.tick(now); if (live.size) pump = requestAnimationFrame(loop); }
function wake() { if (!pump) pump = requestAnimationFrame(loop); }

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

const DEFAULT_OPTS: QuickSphereOpts = { count: 24000, dust: [92, 168, 255], strand: [28, 122, 240], bg: '#ffffff', blend: 'source-over', speed: 1, seed: 11, spin: 0.05, alpha: 0.62, scale: 0.36, mode: 'contour', state: 'idle' };

export function mount(canvas: HTMLCanvasElement, opts: Partial<QuickSphereOpts>): QuickSphereHandle {
  const o: QuickSphereOpts = Object.assign({}, DEFAULT_OPTS, opts);
  const got = canvas.getContext('2d');
  if (!got) return { set() {}, destroy() {} };
  const ctx: CanvasRenderingContext2D = got;
  let RT: Float32Array;
  const P: Params = Object.assign({}, DEF), PV: Partial<Record<ParamKey, number>> = {};
  const TC: [number, number, number] = [139, 134, 129];
  const ph = { F: 0, M: 0, B: 0, V: 0, S: 0, W: 0.6, Sw: 0 };
  let N = 0, X: Float32Array, Y: Float32Array, Z: Float32Array, R: Float32Array, AGE: Float32Array, LIFE: Float32Array, T: Uint8Array, L: Float32Array, RR: Float32Array, DR: Float32Array;
  type Wave = { kx: number; ky: number; kz: number; a: number; ph: number; w: number; cur: number };
  type Vort = { c: number[]; u: number[]; w: number[]; s: number; om: number; ph: number; cx: number; cy: number; cz: number };
  type Pack = { a: number[]; u: number[]; w: number[]; om: number; ph: number; cx: number; cy: number; cz: number };
  let waves: Wave[] = [], vort: Vort[] = [], packs: Pack[] = [];
  let rand: () => number = Math.random;
  let W = 0, H = 0, dpr = 1, img: ImageData | null = null, px8: Uint8ClampedArray | null = null, px32: Uint32Array | null = null, bg32 = 0, t = 0, last = 0, rot = 0, frameN = 0;

  function init() {
    const r = rng(o.seed); rand = r;
    N = Math.round(o.count);
    X = new Float32Array(N); Y = new Float32Array(N); Z = new Float32Array(N); R = new Float32Array(N);
    AGE = new Float32Array(N); LIFE = new Float32Array(N); T = new Uint8Array(N); L = new Float32Array(N);
    RR = new Float32Array(N); DR = new Float32Array(N); RT = new Float32Array(N);
    waves = [];
    for (let j = 0; j < 7; j++) {
      const kx = gauss(r), ky = gauss(r), kz = gauss(r); const m = Math.hypot(kx, ky, kz) || 1, mag = 2.0 + r() * 1.8;
      waves.push({ kx: kx / m * mag, ky: ky / m * mag, kz: kz / m * mag, a: 0.55 + r() * 0.45, ph: r() * 6.28, w: (r() - 0.5) * 0.5, cur: 0 });
    }
    vort = [];
    for (let k = 0; k < 6; k++) { const c = unit(r), [u, w] = perp(c); vort.push({ c, u, w, s: (k % 2 ? 1 : -1) * (0.7 + r() * 0.6), om: 0.05 + r() * 0.08, ph: r() * 6.28, cx: 0, cy: 0, cz: 0 }); }
    packs = [];
    for (let k = 0; k < 3; k++) { const a = unit(r), [u, w] = perp(a); packs.push({ a, u, w, om: (0.35 + r() * 0.25) * (k % 2 ? -1 : 1), ph: r() * 6.28, cx: 0, cy: 0, cz: 0 }); }
    for (let i = 0; i < N; i++) { const q = r(); T[i] = q < 0.46 ? 1 : (q < 0.86 ? 0 : 2); spawn(i, true); }
  }
  function spawn(i: number, initial: boolean) {
    const r = rand, p = unit(r);
    X[i] = p[0]; Y[i] = p[1]; Z[i] = p[2];
    const ty = T[i];
    R[i] = ty === 2 ? 1 + Math.abs(gauss(r)) * 0.2 + r() * 0.08 : 1 + gauss(r) * (ty === 1 ? 0.012 : 0.028);
    L[i] = [-0.9, -0.3, 0.3, 0.9][(r() * 4) | 0];
    RR[i] = 0.015 + r() * r() * 0.2; DR[i] = 0; RT[i] = R[i];
    LIFE[i] = 3 + r() * 9;
    AGE[i] = initial ? r() * LIFE[i] : 0;
  }

  /* critically damped spring per parameter: a state change eases in from rest
     over ~2.5s instead of snapping. Every travelling phase is integrated, so a
     changing rate never makes a wave jump. */
  function settle(dt: number) {
    const tg = target(o.mode, o.state || 'idle'), K = 2.6, D = 2 * Math.sqrt(K), sp = o.speed;
    for (const key in DEF) {
      const k = key as ParamKey;
      const v = (PV[k] || 0) + ((tg[k] - P[k]) * K - D * (PV[k] || 0)) * dt; PV[k] = v; P[k] += v * dt;
    }
    if (tg.tint) { const c = (o.blend === 'lighter' ? TINT_INK : TINT)[tg.tint], q = Math.min(1, dt * 1.1); for (let j = 0; j < 3; j++) TC[j] += (c[j] - TC[j]) * q; }
    ph.F += dt * P.fF * sp; ph.M += dt * P.fM * sp; ph.B += dt * P.bR * sp; ph.V += dt * 2.3 * sp; ph.S += dt * P.fS * sp; ph.Sw += dt * 0.2 * sp * P.flow;
    ph.W += dt / 7 * sp;
  }
  function step(dt: number, parity: number) {
    const sp = o.speed, ws = waves, nw = ws.length, mode = o.mode, k = dt * sp * P.flow;
    const ca = Math.cos(rot), sa = Math.sin(rot), ct = Math.cos(0.32), st = Math.sin(0.32);
    const fx = -sa * ct, fy = st, fz = ca * ct;
    const env = Math.pow(Math.abs(Math.sin(t * 6.1)), 0.7) * (0.35 + 0.65 * Math.max(0, Math.sin(t * 1.3 + Math.sin(t * 0.7) * 2)));
    const bu = ph.B % 1, yRoll = 1.25 - 2.5 * bu, yRise = -1.25 + 2.5 * bu, pole = 1 - bu;
    const doDrift = P.drift > 0.005, doWake = P.wake > 0.005, wakeRate = Math.min(1, dt * 2.2), relax = Math.min(1, dt * 0.5);
    const pulsing = P.aF > 1e-4 || P.aM > 1e-4 || P.aV > 1e-4 || P.aB > 1e-4 || P.aS > 1e-4;
    const sweep = ph.S * 6.2832;
    for (let j = 0; j < nw; j++) ws[j].cur = ws[j].ph + t * ws[j].w * sp;
    if (mode === 'vortex') for (const v of vort) {
      const a = t * v.om * sp + v.ph, ca2 = Math.cos(a) * 0.5, sa2 = Math.sin(a) * 0.5;
      const cx = v.c[0] + ca2 * v.u[0] + sa2 * v.w[0], cy = v.c[1] + ca2 * v.u[1] + sa2 * v.w[1], cz = v.c[2] + ca2 * v.u[2] + sa2 * v.w[2];
      const m = Math.hypot(cx, cy, cz); v.cx = cx / m; v.cy = cy / m; v.cz = cz / m;
    }
    if (mode === 'murmur') for (const q of packs) {
      const a = t * q.om * sp + q.ph, ca2 = Math.cos(a), sa2 = Math.sin(a);
      q.cx = ca2 * q.u[0] + sa2 * q.w[0]; q.cy = ca2 * q.u[1] + sa2 * q.w[1]; q.cz = ca2 * q.u[2] + sa2 * q.w[2];
    }
    const plx = Math.sin(t * 0.07), ply = 0.6, plz = Math.cos(t * 0.07), plm = Math.hypot(plx, ply, plz);
    for (let i = parity; i < N; i += 2) {
      AGE[i] += dt;
      if (AGE[i] > LIFE[i]) spawn(i, false);
      let x = X[i], y = Y[i], z = Z[i];
      let f = 0, gx = 0, gy = 0, gz = 0;
      for (let j = 0; j < nw; j++) {
        const w = ws[j], d = w.kx * x + w.ky * y + w.kz * z + w.cur, c = Math.cos(d) * w.a;
        f += w.a * Math.sin(d); gx += c * w.kx; gy += c * w.ky; gz += c * w.kz;
      }
      const dot = gx * x + gy * y + gz * z; gx -= dot * x; gy -= dot * y; gz -= dot * z;
      let vx = (y * gz - z * gy) * 0.05, vy = (z * gx - x * gz) * 0.05, vz = (x * gy - y * gx) * 0.05;
      const ty = T[i];
      const phi = mode === 'tide' || mode === 'spiral' || mode === 'veil' ? Math.atan2(z, x) : 0;
      const ri = (i * 0.6180339) % 1, ay = Math.abs(y);
      let pulse = 0;
      if (pulsing) {
        const dp = x * fx + y * fy + z * fz, front = Math.max(0, (dp + 0.2) / 1.2);
        if (mode === 'tide') {
          if (P.aF > 1e-4) pulse += P.aF * Math.sin(ay * 9 + ph.F) * (0.4 + 0.6 * (1 - ay));
          if (P.aM > 1e-4) pulse += P.aM * Math.sin(phi * 4 - ph.M);
          if (P.aV > 1e-4) pulse += P.aV * env * (0.5 + 0.5 * Math.sin(y * 5.5 * P.wav + ph.V * 0.6));
          if (P.aB > 1e-4) { const a1 = y - yRoll, a2 = a1 - 0.35; pulse += P.aB * (Math.exp(-a1 * a1 * 9) + P.b2 * Math.exp(-a2 * a2 * 9)); }
        } else if (mode === 'spiral') {
          const armC = phi - 3.4 * P.wav * y;
          if (P.aF > 1e-4) pulse += P.aF * Math.sin(dp * 7 + ph.F + armC * 0.5) * front;
          if (P.aM > 1e-4) pulse += P.aM * Math.sin(armC * 2 + y * 4 - ph.M);
          if (P.aV > 1e-4) pulse += P.aV * env * (0.5 + 0.5 * (L[i] > 0 ? 1 : -1) * Math.sin(ph.V * 0.8));
          if (P.aB > 1e-4) { const a1 = ay - pole, a2 = a1 + 0.3; pulse += P.aB * (Math.exp(-a1 * a1 * 14) + P.b2 * Math.exp(-a2 * a2 * 14)); }
          if (P.aS > 1e-4) { const an = phi - sweep, dd = Math.atan2(Math.sin(an), Math.cos(an)); pulse += P.aS * Math.exp(-dd * dd * 6) * (1 - ay * ay); }
        } else if (mode === 'veil') {
          if (P.aF > 1e-4) pulse += P.aF * Math.sin(dp * 8 + ph.F) * front * (0.6 + 0.4 * Math.cos(phi * 5));
          if (P.aM > 1e-4) pulse += P.aM * Math.sin(y * 7 - ph.M + phi * 0.5);
          if (P.aV > 1e-4) pulse += P.aV * env * Math.max(0, Math.sin(y * 4 - ph.V));
          if (P.aB > 1e-4) { const a1 = y - yRise, a2 = a1 + 0.35; pulse += P.aB * (Math.exp(-a1 * a1 * 9) + P.b2 * Math.exp(-a2 * a2 * 9)); }
        }
      }
      DR[i] = pulse;
      if (mode === 'tide') {
        const band = Math.sin(y * 5.5 * P.wav + t * 0.12 * sp + f * 0.35);
        const om = (0.16 + 0.3 * band) * (1 - P.osc + P.osc * Math.cos(t * 0.6 * sp + y * 3));
        vx = vx * 0.4 + z * om; vy *= 0.4; vz = vz * 0.4 - x * om;
        if (ty === 1) { const e = (y - (L[i] * 0.85 + 0.1 * f)) * 1.4 * P.tight; vx += e * y * x; vy -= e * (1 - y * y); vz += e * y * z; }
      } else if (mode === 'vortex') {
        vx *= 0.3; vy *= 0.3; vz *= 0.3;
        let best = -2, bc: Vort | null = null;
        for (const v of vort) {
          const dp = v.cx * x + v.cy * y + v.cz * z, w = v.s * Math.exp((dp - 1) * 7) * 1.3;
          vx += (v.cy * z - v.cz * y) * w; vy += (v.cz * x - v.cx * z) * w; vz += (v.cx * y - v.cy * x) * w;
          if (dp > best) { best = dp; bc = v; }
        }
        if (ty === 1 && bc) { const e = ((1 - best) - RR[i]) * 2.2; vx += e * (bc.cx - best * x); vy += e * (bc.cy - best * y); vz += e * (bc.cz - best * z); }
      } else if (mode === 'breathe') {
        const dp = (x * plx + y * ply + z * plz) / plm;
        DR[i] += Math.sin(dp * 9 - t * 1.3 * sp) * 0.035 * (0.4 + 0.6 * (1 - dp * dp));
        if (ty === 1) { const e = (f - L[i]) / (gx * gx + gy * gy + gz * gz + 0.6); vx -= e * gx; vy -= e * gy; vz -= e * gz; }
      } else if (mode === 'spiral') {
        // two counter-wound loxodromes; strands wind pole to pole along them while the whole lattice turns.
        // The arm field is singular at the poles (1/rho); soften it and fade the
        // arm forces out over the polar cap so particles can't pile into a spike.
        const rr2 = x * x + z * z, rho2 = rr2 + 0.06, cap = sm(rr2 / 0.12), K = 3.4 * P.wav, om = 0.22 * sp;
        const arg = 2 * (phi - K * y) - t * om + f * 0.25 + (L[i] > 0 ? 3.1416 : 0);
        const ax = 2 * (-z / rho2 + K * y * x), ay2 = -2 * K * (1 - y * y), az = 2 * (x / rho2 + K * y * z);
        const am = ax * ax + ay2 * ay2 + az * az + 1;
        vx = vx * 0.35 + z * (0.08 + P.swirl); vy *= 0.35; vz = vz * 0.35 - x * (0.08 + P.swirl);
        const cx = (y * az - z * ay2), cy = (z * ax - x * az), cz = (x * ay2 - y * ax), cm = 0.11 * cap / Math.sqrt(am);
        vx += cx * cm; vy += cy * cm; vz += cz * cm;
        if (ty === 1) { const e = Math.sin(arg) * 1.6 * P.tight * cap / am; vx -= e * ax; vy -= e * ay2; vz -= e * az; }
      } else if (mode === 'veil') {
        // aurora curtains hanging on meridians, rising on one side of the sphere and falling on the other
        const rr2 = x * x + z * z, rho2 = rr2 + 0.06, cap = sm(rr2 / 0.12), wv = P.wav;
        const arg = phi * 5 + f * 0.7 * wv + Math.sin(y * 2.2 + ph.Sw) * 0.6 * wv * P.sway;
        const lift = 0.16 * P.sway * Math.sin(phi * 2 + t * 0.09 * sp) * Math.sqrt(1 - y * y);
        vx = vx * 0.5 - lift * y * x; vy = vy * 0.5 + lift * (1 - y * y); vz = vz * 0.5 - lift * y * z;
        if (ty === 1) {
          const ax = -5 * z / rho2 + 0.7 * wv * gx, ay2 = 0.7 * wv * gy, az = 5 * x / rho2 + 0.7 * wv * gz, am = ax * ax + ay2 * ay2 + az * az + 1;
          const e = Math.sin(arg + (L[i] > 0 ? 3.1416 : 0)) * 1.4 * P.tight * cap / am; vx -= e * ax; vy -= e * ay2; vz -= e * az;
        }
      } else if (mode === 'murmur') {
        // three swarms orbit on great circles; anything near one is swept along, then let go
        vx *= 0.45; vy *= 0.45; vz *= 0.45;
        for (const q of packs) {
          const dp = q.cx * x + q.cy * y + q.cz * z, g = Math.exp((dp - 1) * 3.2), w = q.om * g * 1.25;
          vx += (q.a[1] * z - q.a[2] * y) * w; vy += (q.a[2] * x - q.a[0] * z) * w; vz += (q.a[0] * y - q.a[1] * x) * w;
          if (ty === 1 && g > 0.25) {
            const da = q.a[0] * x + q.a[1] * y + q.a[2] * z, e = (da - L[i] * 0.16 - f * 0.04) * 2.4 * g;
            vx -= e * (q.a[0] - da * x); vy -= e * (q.a[1] - da * y); vz -= e * (q.a[2] - da * z);
          }
        }
      } else if (ty === 1) {
        const e = (f - L[i]) / (gx * gx + gy * gy + gz * gz + 0.6) * 1.6;
        vx -= e * gx; vy -= e * gy; vz -= e * gz;
      } else if (ty === 2) { vx *= 0.4; vy *= 0.4; vz *= 0.4; }
      if (ty !== 2) {
        if (doDrift) {
          const w = mode === 'tide' ? 0.3 + ay * 1.2 : mode === 'spiral' ? 0.5 + 0.8 * (1 - ay) : mode === 'veil' ? 0.3 + (y + 1) * 0.6 : 0.8;
          R[i] += dt * P.drift * w * (0.4 + 0.8 * ri);
        } else {
          let tgt = RT[i];
          if (doWake) {
            const stg = mode === 'tide' ? ay : mode === 'spiral' || mode === 'veil' ? (1 - y) / 2 : ri;
            const u = ((ph.W - stg * 0.4) % 1 + 1) % 1;
            const g = u < 0.2 ? sm(u / 0.2) : 1 - sm((u - 0.2) / 0.55);
            tgt += P.wake * (0.25 + 0.9 * ri) * g;
          }
          R[i] += (tgt - R[i]) * (doWake ? wakeRate : relax);
        }
        const lift = R[i] - RT[i];
        if (lift > 0.002) { const sw = lift * 0.6; vx += z * sw; vz -= x * sw; }
      }
      if (P.turb > 1e-3) { const q = ri * 6.2832; vx += P.turb * Math.sin(y * 9 + t * 2.3 + q); vy += P.turb * Math.sin(z * 9 + t * 2.7 + q); vz += P.turb * Math.sin(x * 9 + t * 2.1 + q); }
      x += vx * k; y += vy * k; z += vz * k;
      const m = 1 / Math.sqrt(x * x + y * y + z * z);
      X[i] = x * m; Y[i] = y * m; Z[i] = z * m;
    }
  }

  function draw() {
    if (!img || !px8 || !px32) return;
    px32.fill(bg32);
    const add = o.blend === 'lighter', A = o.alpha, d = px8, Wd = W, Hd = H;
    const cx = W / 2, cy = H / 2, Rad = Math.min(W, H) * o.scale * P.scale * (1 + Math.sin(t * 0.5) * 0.008);
    const ca = Math.cos(rot), sa = Math.sin(rot), tilt = 0.32, ct = Math.cos(tilt), st = Math.sin(tilt);
    const mx = P.mix, lift0 = o.blend === 'lighter' ? 0.25 : 0.3, TR = o.bg === 'transparent', bgc: RGB = TR ? (o.tone || [249, 247, 244]) : hex(o.bg);
    const S = o.strand.map((v, j) => v + (TC[j] - v) * mx), D = o.dust.map((v, j) => v + ((TC[j] + (bgc[j] - TC[j]) * lift0) - v) * mx);
    const FADE = P.fade;
    for (let i = 0; i < N; i++) {
      const ty = T[i], rr = R[i] * (1 + DR[i]), x0 = X[i] * rr, y0 = Y[i] * rr, z0 = Z[i] * rr;
      const x1 = x0 * ca + z0 * sa, z1 = -x0 * sa + z0 * ca;
      const y2 = y0 * ct - z1 * st, z2 = y0 * st + z1 * ct;
      const u = AGE[i] / LIFE[i], env = Math.min(1, u * 6, (1 - u) * 4);
      const depth = 0.22 + 0.78 * Math.max(0, (z2 + 1) * 0.5);
      const lf = ty !== 2 ? R[i] - RT[i] : 0;
      let a = (ty === 1 ? 1 : ty === 2 ? 0.32 : 0.55) * env * depth * (1 + DR[i] * 9) * FADE * (lf > 0 ? 1 / (1 + lf * 1.6) : 1);
      if (a > 1) a = 1;
      // bin to the same 10 steps the canvas renderer used, so tone matches
      a = (Math.min(9, (a * 10) | 0) + 0.5) / 10 * A;
      if (a < 0.03 * A) continue;
      const p = 1 / (1 - z2 * 0.16);
      const s = (ty === 1 ? 1.35 : ty === 2 ? 0.95 : 1.1) * dpr * p;
      let n = Math.round(s); if (n < 1) n = 1;
      const aa = a * (s * s) / (n * n);
      const al = aa > 1 ? 1 : aa;
      const sx = (cx + x1 * Rad * p - n / 2) | 0, sy = (cy + y2 * Rad * p - n / 2) | 0;
      if (sx < 0 || sy < 0 || sx + n > Wd || sy + n > Hd) continue;
      const c = ty === 1 ? S : D, r0 = c[0], g0 = c[1], b0 = c[2];
      for (let yy = 0; yy < n; yy++) {
        let idx = ((sy + yy) * Wd + sx) << 2;
        for (let xx = 0; xx < n; xx++, idx += 4) {
          if (TR) { const ao = d[idx + 3] / 255, an = ao + al * (1 - ao); if (an > 0) { const kk = ao * (1 - al); d[idx] = (r0 * al + d[idx] * kk) / an; d[idx + 1] = (g0 * al + d[idx + 1] * kk) / an; d[idx + 2] = (b0 * al + d[idx + 2] * kk) / an; d[idx + 3] = an * 255; } }
          else if (add) { d[idx] += r0 * al; d[idx + 1] += g0 * al; d[idx + 2] += b0 * al; }
          else { d[idx] += (r0 - d[idx]) * al; d[idx + 1] += (g0 - d[idx + 1]) * al; d[idx + 2] += (b0 - d[idx + 2]) * al; }
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function setBg() { if (o.bg === 'transparent') { bg32 = 0; return; } const c = hex(o.bg); bg32 = (255 << 24 | c[2] << 16 | c[1] << 8 | c[0]) >>> 0; }
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    const b = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(b.width * dpr)), h = Math.max(1, Math.round(b.height * dpr));
    if (w === W && h === H && img) return;
    W = canvas.width = w; H = canvas.height = h;
    img = ctx.createImageData(W, H); px8 = img.data; px32 = new Uint32Array(px8.buffer);
    if (still) paintStill();
  }
  const inst: Live = {
    vis: true,
    tick(now: number) {
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016); last = now;
      t += dt; settle(dt); rot += dt * o.spin * o.speed * P.spin;
      step(frameN ? dt * 2 : dt, frameN & 1); frameN++;
      draw();
    },
  };
  // Reduced motion: settle the state instantly and paint one frame. The
  // guidelines say the sphere is never swapped for a static image, but the
  // app's accessibility rule wins for the people who asked for it.
  const still = reducedMotion();
  function paintStill() {
    const tg = target(o.mode, o.state || 'idle');
    for (const key in DEF) { const k = key as ParamKey; P[k] = tg[k]; }
    if (tg.tint) { const c = (o.blend === 'lighter' ? TINT_INK : TINT)[tg.tint]; TC[0] = c[0]; TC[1] = c[1]; TC[2] = c[2]; }
    for (let i = 0; i < 24; i++) step(0.05, i & 1);
    draw();
  }
  init(); setBg(); resize();
  const ro = new ResizeObserver(resize); ro.observe(canvas);
  const io = new IntersectionObserver((es) => { for (const e of es) { inst.vis = e.isIntersecting; if (inst.vis) { last = 0; wake(); } } }, { rootMargin: '120px' });
  io.observe(canvas);
  if (!still) { live.add(inst); wake(); } else paintStill();
  return {
    set(n) {
      if (n.state && n.state !== o.state && n.state === 'waking') ph.W = 0.85;
      const re = (n.count != null && Math.round(n.count) !== N) || (n.mode && n.mode !== o.mode);
      Object.assign(o, n); setBg(); if (re) init();
      if (still) paintStill();
    },
    destroy() { live.delete(inst); ro.disconnect(); io.disconnect(); },
  };
}

/** How many instances are animating — for the perf pass and tests. */
export function liveCount(): number {
  return live.size;
}
