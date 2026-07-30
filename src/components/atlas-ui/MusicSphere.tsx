import { useEffect, useRef } from 'react';
import type { CSSProperties, RefObject } from 'react';
import type { Reactivity } from '@/hooks/useAudioReactivity';

// The Atlas Sphere as the music visual — five canvas-2D forms, ported from the
// "Atlas Music Player" design. The disc/vinyl is gone; the sphere breathes with
// the music. Motion has two sources: time `t` (idle breathing/spin so it's alive
// even when paused) and the live `Reactivity` ref (amp/pulse/spin) fed by
// useAudioReactivity from the real audio level (music:level). White ink on the
// orange card — the canvas itself is transparent.

export type SphereForm = 'orb' | 'rings' | 'bloom' | 'field' | 'burst';

// --- Fibonacci sphere points (cached per count) ---------------------------
const fibCache: Record<number, [number, number, number][]> = {};
function fib(n: number): [number, number, number][] {
  const p: [number, number, number][] = [];
  const gr = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = gr * i;
    p.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return p;
}
const fibC = (n: number) => (fibCache[n] ??= fib(n));

// rounded-rect path helper
function rr(x: CanvasRenderingContext2D, a: number, b: number, w: number, h: number, r: number) {
  x.beginPath();
  x.moveTo(a + r, b);
  x.arcTo(a + w, b, a + w, b + h, r);
  x.arcTo(a + w, b + h, a, b + h, r);
  x.arcTo(a, b + h, a, b, r);
  x.arcTo(a, b, a + w, b, r);
  x.closePath();
}

// --- The five forms (ported verbatim from the design's draw*) -------------

function drawOrb(x: CanvasRenderingContext2D, w: number, h: number, amp: number, spin: number) {
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.46 * (1 + amp * 0.05);
  const N = Math.round(Math.min(620, Math.max(200, w * 2.4)));
  const pts = fibC(N);
  const ay = spin, ax = 0.42, ca = Math.cos(ay), sa = Math.sin(ay), cx2 = Math.cos(ax), sx2 = Math.sin(ax);
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, R * 1.1);
  g.addColorStop(0, 'rgba(255,255,255,' + (0.5 + amp * 0.3) + ')');
  g.addColorStop(0.4, 'rgba(226,234,252,.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.beginPath(); x.arc(cx, cy, R * 1.1, 0, 7); x.fill();
  const rrad = R * (1 + amp * 0.06);
  for (let i = 0; i < N; i++) {
    const p = pts[i];
    const X = p[0] * ca + p[2] * sa;
    let Z = -p[0] * sa + p[2] * ca;
    const Y = p[1] * cx2 - Z * sx2; Z = p[1] * sx2 + Z * cx2;
    const depth = (Z + 1) / 2;
    const sx = cx + X * rrad, sy = cy + Y * rrad;
    const rad = (0.5 + depth * 1.7) * (1 + amp * 0.5);
    x.beginPath(); x.arc(sx, sy, rad, 0, 7);
    x.fillStyle = 'rgba(255,' + (250 - depth * 10) + ',' + (238 - depth * 20) + ',' + (0.22 + depth * 0.72) + ')';
    x.fill();
  }
}

function drawRings(x: CanvasRenderingContext2D, w: number, h: number, amp: number, spin: number) {
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.42 * (1 + amp * 0.08);
  const rings = [[0.35, 0.0], [1.15, 0.5], [2.0, 1.1], [0.75, 2.2]];
  x.lineCap = 'round';
  rings.forEach((rg, ri) => {
    const tilt = rg[0], ph = rg[1] + spin * (0.6 + ri * 0.12);
    x.beginPath();
    for (let a = 0; a <= 64; a++) {
      const th = a / 64 * Math.PI * 2;
      const X = Math.cos(th), Y = Math.sin(th) * Math.cos(tilt), Z = Math.sin(th) * Math.sin(tilt);
      const ca = Math.cos(ph), sa = Math.sin(ph); const X2 = X * ca + Z * sa;
      const sx = cx + X2 * R, sy = cy + Y * R;
      if (a === 0) x.moveTo(sx, sy); else x.lineTo(sx, sy);
    }
    x.strokeStyle = 'rgba(255,255,255,' + (0.32 + amp * 0.4) + ')'; x.lineWidth = 1.6; x.stroke();
  });
  const cg = x.createRadialGradient(cx, cy, 0, cx, cy, R * 0.5);
  cg.addColorStop(0, 'rgba(255,255,255,' + (0.6 + amp * 0.35) + ')');
  cg.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = cg; x.beginPath(); x.arc(cx, cy, R * 0.5, 0, 7); x.fill();
}

function drawBloom(x: CanvasRenderingContext2D, w: number, h: number, amp: number, t: number) {
  const cx = w / 2, cy = h / 2, M = Math.min(w, h);
  const aura = x.createRadialGradient(cx, cy, 0, cx, cy, M * 0.58);
  aura.addColorStop(0, 'rgba(255,255,255,' + (0.2 + amp * 0.32) + ')');
  aura.addColorStop(0.5, 'rgba(220,230,252,' + (0.09 + amp * 0.16) + ')');
  aura.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = aura; x.fillRect(0, 0, w, h);
  for (let r = 0; r < 3; r++) {
    const pr = ((t * 0.55 + r / 3) % 1);
    const rrad = M * 0.16 + pr * M * 0.36 * (1 + amp * 0.7);
    x.beginPath(); x.arc(cx, cy, rrad, 0, 7);
    x.strokeStyle = 'rgba(255,255,255,' + ((1 - pr) * (0.16 + amp * 0.34)).toFixed(3) + ')';
    x.lineWidth = 1 + amp * 2.6; x.stroke();
  }
  const R = M * 0.37 * (1 + amp * 0.22);
  x.beginPath();
  for (let a = 0; a <= 120; a++) {
    const th = a / 120 * Math.PI * 2;
    const rad = R * (1 + 0.13 * Math.sin(th * 3 + t * 1.6) + 0.09 * Math.sin(th * 5 - t * 2.3) + 0.06 * Math.sin(th * 7 + t * 3.1) + (0.11 + amp * 0.36) * Math.sin(th * 2 + t * 4));
    const sx = cx + Math.cos(th) * rad, sy = cy + Math.sin(th) * rad;
    if (a === 0) x.moveTo(sx, sy); else x.lineTo(sx, sy);
  }
  x.closePath();
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, R * 1.4);
  g.addColorStop(0, 'rgba(255,255,255,.96)');
  g.addColorStop(0.45, 'rgba(228,235,252,' + (0.55 + amp * 0.3) + ')');
  g.addColorStop(1, 'rgba(255,255,255,.04)');
  x.fillStyle = g; x.fill();
  const dx = Math.cos(t * 0.9) * R * 0.14, dy = Math.sin(t * 1.15) * R * 0.14, ir = R * 0.42 * (1 + amp * 0.32);
  const ig = x.createRadialGradient(cx + dx, cy + dy, 0, cx + dx, cy + dy, ir);
  ig.addColorStop(0, 'rgba(255,255,255,.98)');
  ig.addColorStop(0.6, 'rgba(224,233,252,' + (0.5 + amp * 0.4) + ')');
  ig.addColorStop(1, 'rgba(220,230,252,0)');
  x.fillStyle = ig; x.beginPath(); x.arc(cx + dx, cy + dy, ir, 0, 7); x.fill();
}

function drawField(x: CanvasRenderingContext2D, w: number, h: number, amp: number, pulse: number, t: number) {
  const cx = w / 2, cy = h / 2;
  const cols = Math.max(11, Math.round(w / 12)), rows = Math.max(8, Math.round(h / 13));
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const nx = (i / (cols - 1)) * 2 - 1, ny = (j / (rows - 1)) * 2 - 1;
      const rd = Math.hypot(nx, ny * 1.05);
      const edge = Math.max(0, 1 - Math.pow(Math.min(1, rd / 1.24), 2.6));
      if (edge <= 0) continue;
      const p = pulse || 0;
      const lin = Math.sin(i * 0.48 - t * 3.0 + j * 0.28);
      const rad0 = Math.sin(rd * 4.2 - t * 4.6);
      const wave = (lin + (0.7 + 1.3 * p) * rad0) / (1.7 + 1.3 * p);
      const off = wave * (6 + amp * 40) * edge;
      const px = cx + nx * (w * 0.47), py = cy + ny * (h * 0.44) + off;
      const crest = Math.max(0, wave);
      const br = Math.min(1, (0.16 + 0.62 * (wave * 0.5 + 0.5)) * edge * (0.5 + amp * 0.95));
      const rad = (1 + crest * 2.9) * edge * (0.75 + amp * 1.15);
      if (crest > 0.4) {
        x.beginPath(); x.arc(px, py, rad * 2.8, 0, 7);
        x.fillStyle = 'rgba(222,232,252,' + (crest * edge * (amp * 0.4 + p * 0.55)).toFixed(3) + ')'; x.fill();
      }
      x.beginPath(); x.arc(px, py, Math.max(0.5, rad), 0, 7);
      x.fillStyle = 'rgba(232,238,253,' + br.toFixed(3) + ')'; x.fill();
    }
  }
}

function drawBurst(x: CanvasRenderingContext2D, w: number, h: number, amp: number, spin: number, t: number) {
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) * 0.46, N = 54;
  x.lineCap = 'round';
  for (let k = 0; k < N; k++) {
    const a = k / N * Math.PI * 2 + spin * 0.5;
    const len = R * (0.16 + (0.16 + amp * 0.6) * (0.4 + 0.6 * Math.abs(Math.sin(k * 0.7 + t * 5))));
    const inr = R * 0.2;
    const c = Math.cos(a), sn = Math.sin(a);
    x.beginPath(); x.moveTo(cx + c * inr, cy + sn * inr); x.lineTo(cx + c * (inr + len), cy + sn * (inr + len));
    x.strokeStyle = 'rgba(255,255,255,' + (0.3 + amp * 0.5) + ')'; x.lineWidth = 2; x.stroke();
    x.beginPath(); x.arc(cx + c * (inr + len), cy + sn * (inr + len), 1.4 + amp * 2, 0, 7);
    x.fillStyle = 'rgba(255,255,255,.9)'; x.fill();
  }
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, R * 0.32);
  g.addColorStop(0, 'rgba(255,255,255,' + (0.85 + amp * 0.15) + ')');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g; x.beginPath(); x.arc(cx, cy, R * 0.32, 0, 7); x.fill();
}

function dispatch(form: SphereForm, x: CanvasRenderingContext2D, w: number, h: number, r: Reactivity, t: number) {
  switch (form) {
    case 'orb': return drawOrb(x, w, h, r.amp, r.spin);
    case 'rings': return drawRings(x, w, h, r.amp, r.spin);
    case 'bloom': return drawBloom(x, w, h, r.amp, t);
    case 'field': return drawField(x, w, h, r.amp, r.pulse, t);
    case 'burst': return drawBurst(x, w, h, r.amp, r.spin, t);
  }
}

const REST: Reactivity = { amp: 0, pulse: 0, bands: [0, 0, 0], spin: 0, energy: 0 };

export interface MusicSphereProps {
  form: SphereForm;
  /** Live reactivity (from useAudioReactivity). */
  reactivity: RefObject<Reactivity>;
  className?: string;
  style?: CSSProperties;
}

export function MusicSphere({ form, reactivity, className, style }: MusicSphereProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    const draw = (ts: number) => {
      raf = requestAnimationFrame(draw);
      if (typeof document !== 'undefined' && document.hidden) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
      const x = canvas.getContext('2d');
      if (!x) return;
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, w, h);
      x.globalCompositeOperation = 'lighter';
      dispatch(form, x, w, h, reactivity.current ?? REST, ts / 1000);
      x.globalCompositeOperation = 'source-over';
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [form, reactivity]);

  return <canvas ref={canvasRef} className={className} style={style} aria-hidden="true" />;
}
