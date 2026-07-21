import { useEffect, useRef } from 'react';

// The split-login Atlas Sphere — a lightweight canvas-2D particle orb (~6400
// points) + a soft drifting backdrop, ported from the "Atlas Login C1 - Split"
// design. Deliberately canvas, not the WebGL AtlasSphere: the login is the
// first paint, pre-auth, and shouldn't drag in the ~1MB three.js chunk. White
// ink over the flat #3461f2 scene; tracks the pointer for a gentle parallax.

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

const N = 6400; // design density; caps below on small viewports for perf

interface Pt { x: number; y: number; z: number; rn: number }
function makePoints(n: number): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const th = Math.random() * 6.283;
    const ph = Math.acos(2 * Math.random() - 1);
    const r = Math.pow(Math.random(), 0.42);
    pts.push({
      x: r * Math.sin(ph) * Math.cos(th),
      y: r * Math.sin(ph) * Math.sin(th),
      z: r * Math.cos(ph),
      rn: Math.random(),
    });
  }
  return pts;
}

const TG = {
  idle: { br: 0.95, spd: 0.0026, jit: 0 },
  listening: { br: 1.12, spd: 0.004, jit: 0.14 },
  thinking: { br: 1.0, spd: 0.013, jit: 0.5 },
  speaking: { br: 1.14, spd: 0.005, jit: 0.22 },
};

export function AuthSphere({ orbState }: { orbState: OrbState }) {
  const bgRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<OrbState>(orbState);
  stateRef.current = orbState;
  // pointer parallax targets/eased values
  const mouse = useRef({ mx: 0, my: 0, tx: 0, ty: 0 });

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      mouse.current.mx = (e.clientX / window.innerWidth - 0.5) * 2;
      mouse.current.my = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  // Soft drifting backdrop.
  useEffect(() => {
    const el = bgRef.current;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const fit = () => {
      const d = Math.min(2, window.devicePixelRatio || 1);
      el.width = el.clientWidth * d; el.height = el.clientHeight * d;
    };
    fit();
    const B = [
      { c: '184,201,247', x: 0.2, y: 0.3, r: 0.8, a: 0.06 },
      { c: '110,144,243', x: 0.8, y: 0.7, r: 0.9, a: 0.05 },
      { c: '128,102,255', x: 0.3, y: 0.85, r: 0.7, a: 0.03 },
    ];
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      if (!el.width) fit();
      const W = el.width, H = el.height;
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (const b of B) {
        const bx = W * (b.x + 0.1 * Math.sin(t * 0.0001 + b.x * 9) - mouse.current.tx * 0.04);
        const by = H * (b.y + 0.1 * Math.cos(t * 0.00012 + b.y * 9));
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, W * b.r);
        g.addColorStop(0, 'rgba(' + b.c + ',' + b.a + ')');
        g.addColorStop(1, 'rgba(' + b.c + ',0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      ctx.globalCompositeOperation = 'source-over';
    };
    raf = requestAnimationFrame(tick);
    const onResize = () => fit();
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  }, []);

  // The particle orb.
  useEffect(() => {
    const el = orbRef.current;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let d = Math.min(2, window.devicePixelRatio || 1);
    const fit = () => {
      d = Math.min(2, window.devicePixelRatio || 1);
      el.width = el.clientWidth * d; el.height = el.clientHeight * d;
    };
    fit();
    // Cap the count on smaller viewports so the first-paint stays cheap.
    const count = Math.min(N, Math.round((el.clientWidth * el.clientHeight) / 120));
    const pts = makePoints(count);
    const cur = { ...TG.idle };
    let rot = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      if (!el.width) fit();
      const m = mouse.current;
      m.tx += (m.mx - m.tx) * 0.06; m.ty += (m.my - m.ty) * 0.06;
      const S = el.width, H = el.height;
      ctx.clearRect(0, 0, S, H);
      const T = TG[stateRef.current] || TG.idle;
      for (const k in T) (cur as Record<string, number>)[k] += ((T as Record<string, number>)[k] - (cur as Record<string, number>)[k]) * 0.06;
      rot += cur.spd; const cxr = Math.cos(rot), sxr = Math.sin(rot);
      const cx = S * 0.9 + m.tx * S * 0.05 + Math.sin(t * 0.00042) * S * 0.015;
      const cy = H * 0.55 + m.ty * H * 0.05 + Math.cos(t * 0.00051) * H * 0.018;
      const R = H * 0.44, breathe = 1 + Math.sin(t * 0.0009) * 0.03;
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.3);
      cg.addColorStop(0, 'rgba(255,252,248,' + (0.36 * cur.br) + ')');
      cg.addColorStop(0.5, 'rgba(190,206,248,.11)');
      cg.addColorStop(1, 'rgba(110,144,243,0)');
      ctx.fillStyle = cg; ctx.fillRect(0, 0, S, H);
      ctx.globalCompositeOperation = 'lighter';
      for (const p of pts) {
        const w = (1 + Math.sin(t * 0.0012 + p.rn * 8) * 0.06) * breathe + (cur.jit ? cur.jit * Math.sin(t * 0.006 + p.rn * 22) * 0.05 : 0);
        const x = p.x * w, y = p.y * w, z = p.z * w;
        const X = x * cxr + z * sxr, Z = -x * sxr + z * cxr;
        const px = cx + X * R, py = cy + y * R, depth = (Z + 1) / 2;
        const sz = (1.1 + p.rn * 1.35) * (0.5 + depth * 0.7) * (S / 860);
        const di = Math.sqrt(X * X + y * y + Z * Z);
        const a = Math.max(0, (1 - Math.max(0, (di - 0.42) / 0.5))) * (0.55 + depth * 0.5) * cur.br;
        if (a <= 0.02) continue;
        ctx.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(px, py, sz, 0, 6.2832); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    };
    raf = requestAnimationFrame(tick);
    const onResize = () => fit();
    window.addEventListener('resize', onResize);
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); };
  }, []);

  return (
    <>
      <canvas ref={bgRef} className="authbgcv" aria-hidden="true" />
      <canvas ref={orbRef} className="authorbcv" aria-hidden="true" />
    </>
  );
}
