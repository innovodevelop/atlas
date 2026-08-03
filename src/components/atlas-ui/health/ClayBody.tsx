import { useEffect, useRef } from 'react';
import type { ClayMode, ClayRegion } from '@/lib/mocks/health';
import { CLAY_ZONES } from '@/lib/mocks/health';

type Region = Exclude<ClayRegion, 'whole'>;
type RGB = [number, number, number];

/**
 * The clay figure.
 *
 * A canvas *drawing*, ported from `Atlas Health.dc.html` — a soft-shaded human
 * form whose four regions tint with whatever reading is selected. README §1.1
 * exempts illustration strokes from the borderless rule; this is the same
 * category, and the only element on the surface that is not a fill.
 *
 * TWO THINGS IT DOES THAT THE PROTOTYPE DOES NOT:
 *
 * 1. IT REFUSES TO SHADE WHAT IT CANNOT MEASURE. The design's own settings copy
 *    promises exactly this — "it never guesses a value it has not measured" —
 *    but the prototype tints all four regions unconditionally. Here `regions` is
 *    the set with live signals behind it, and a region outside it renders as
 *    plain clay. Turn Workouts off in Sources and the legs go grey while you
 *    watch. That is the whole honesty argument for this component.
 *
 * 2. IT STOPS. The prototype runs an unconditional rAF loop plus a 400ms
 *    interval that restarts it — the exact shape `atlas-perf-review` exists to
 *    catch. This one cancels on unmount, parks while the document is hidden,
 *    and under `prefers-reduced-motion` paints ONE frame and never schedules
 *    another. No interval, no self-healing pump.
 *
 * Sizing comes from a ResizeObserver rather than reading `clientWidth` every
 * frame, which would force a layout on each tick.
 */
interface ClayBodyProps {
  mode: ClayMode;
  /** Regions with a live signal behind them. Everything else stays neutral clay. */
  regions: Set<Region>;
  /** False when the selected reading's own required signals are missing. */
  shaded: boolean;
  className?: string;
}

const TONE = {
  base: [240, 238, 236] as RGB,
  hi: [255, 255, 255] as RGB,
  lo: [192, 189, 186] as RGB,
};

const mix = (a: RGB, b: RGB, f: number): RGB => [
  a[0] + (b[0] - a[0]) * f,
  a[1] + (b[1] - a[1]) * f,
  a[2] + (b[2] - a[2]) * f,
];

const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

export const ClayBody = ({ mode, regions, shaded, className }: ClayBodyProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read inside the draw closure so a mode change never restarts the loop.
  const paint = useRef({ mode, regions, shaded });
  paint.current = { mode, regions, shaded };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)');
    let box = { w: canvas.clientWidth, h: canvas.clientHeight };
    let raf = 0;

    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) box = { w: r.width, h: r.height };
      // Whenever the loop is parked — reduced motion, hidden tab — a resize has
      // to repaint by hand or the canvas keeps a picture drawn for the old box.
      if (!raf) frame(0);
    });
    ro.observe(canvas);

    /** One frame at elapsed time `ms`. Reduced motion always passes 0. */
    function frame(ms: number) {
      const { w, h } = box;
      if (!w || !h || !ctx) return;

      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }

      const W = canvas.width;
      const H = canvas.height;
      const T = ms * 0.001;
      const { mode: m, regions: live, shaded: on } = paint.current;
      const palette = CLAY_ZONES[m];

      /** The tint for a region, or null when nothing measured it. */
      const zoneOf = (region: Region): RGB | null =>
        on && live.has(region) ? palette[region] : null;

      ctx.clearRect(0, 0, W, H);

      const cx = W * 0.5;
      const u = Math.min(W / 6.4, H / 11.4);
      const top = H * 0.5 - u * 4.6;
      const sway = Math.sin(T * 0.45) * 0.035;
      const breathe = 1 + Math.sin(T * 0.85) * 0.012;

      const P = (x: number, y: number): [number, number] => [
        cx + x * u + sway * u * (y < 4 ? (4 - y) * 0.06 : 0),
        top + y * u,
      ];

      const fillPath = (
        path: Path2D,
        region: Region,
        bounds: [number, number, number, number],
        glow: number,
      ) => {
        const z = zoneOf(region);
        const base = z ? mix(TONE.base, z, 0.07 + 0.04 * Math.sin(T * 1.1 + bounds[1] * 0.01)) : TONE.base;
        const g = ctx.createLinearGradient(
          bounds[0] - bounds[2] * 0.55, bounds[1] - bounds[3] * 0.66,
          bounds[0] + bounds[2] * 0.8, bounds[1] + bounds[3] * 0.75,
        );
        g.addColorStop(0, rgba(mix(base, TONE.hi, 0.92), 1));
        g.addColorStop(0.38, rgba(mix(base, TONE.hi, 0.42), 1));
        g.addColorStop(0.72, rgba(base, 1));
        g.addColorStop(1, rgba(mix(base, TONE.lo, 0.6), 1));
        ctx.fillStyle = g;
        ctx.fill(path);

        ctx.save();
        ctx.clip(path);
        const rim = ctx.createLinearGradient(bounds[0] + bounds[2] * 0.1, 0, bounds[0] + bounds[2] * 0.62, 0);
        rim.addColorStop(0, rgba(TONE.lo, 0));
        rim.addColorStop(1, rgba(mix(TONE.hi, TONE.base, 0.35), 0.42));
        ctx.fillStyle = rim;
        ctx.fill(path);
        if (z && glow) {
          const pulse = 0.2 + 0.16 * Math.sin(T * (region === 'chest' ? 3.4 : 1.3));
          const gg = ctx.createRadialGradient(
            bounds[0], bounds[1], 0,
            bounds[0], bounds[1], Math.max(bounds[2], bounds[3]) * 0.9,
          );
          gg.addColorStop(0, rgba(z, pulse * glow));
          gg.addColorStop(1, rgba(z, 0));
          ctx.fillStyle = gg;
          ctx.fill(path);
        }
        ctx.restore();
      };

      const limb = (
        joints: Array<[number, number]>,
        widths: number[],
        region: Region,
        glow: number,
      ) => {
        const pts = joints.map((j) => P(j[0], j[1]));
        const xs = pts.map((q) => q[0]);
        const ys = pts.map((q) => q[1]);
        const w0 = widths[0] * u;
        const bx = (Math.min(...xs) + Math.max(...xs)) / 2;
        const by = (Math.min(...ys) + Math.max(...ys)) / 2;
        const bw = Math.max(...xs) - Math.min(...xs) + w0 * 2;
        const bh = Math.max(...ys) - Math.min(...ys) + w0 * 2;
        const z = zoneOf(region);
        const base = z ? mix(TONE.base, z, 0.07 + 0.04 * Math.sin(T * 1.1 + by * 0.01)) : TONE.base;

        const g = ctx.createLinearGradient(bx - bw * 0.5, by - bh * 0.6, bx + bw * 0.75, by + bh * 0.7);
        g.addColorStop(0, rgba(mix(base, TONE.hi, 0.78), 1));
        g.addColorStop(0.34, rgba(mix(base, TONE.hi, 0.24), 1));
        g.addColorStop(0.68, rgba(base, 1));
        g.addColorStop(1, rgba(mix(base, TONE.lo, 0.72), 1));

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        const pass = (style: string | CanvasGradient, scale: number) => {
          ctx.strokeStyle = style;
          for (let i = 0; i < pts.length - 1; i++) {
            ctx.beginPath();
            ctx.moveTo(pts[i][0], pts[i][1]);
            ctx.lineTo(pts[i + 1][0], pts[i + 1][1]);
            ctx.lineWidth = (widths[i] + widths[i + 1]) * u * scale;
            ctx.stroke();
          }
        };
        pass(g, 1);
        if (z && glow) pass(rgba(z, (0.1 + 0.07 * Math.sin(T * 1.3)) * glow), 0.72);

        const hi = ctx.createLinearGradient(bx - bw * 0.34, by - bh * 0.4, bx + bw * 0.28, by + bh * 0.4);
        hi.addColorStop(0, rgba(mix(TONE.hi, [255, 255, 255], 0.6), 0.52));
        hi.addColorStop(0.6, rgba(TONE.hi, 0));
        hi.addColorStop(1, rgba(TONE.lo, 0));
        pass(hi, 0.44);

        const sh = ctx.createLinearGradient(bx + bw * 0.05, 0, bx + bw * 0.6, 0);
        sh.addColorStop(0, rgba(TONE.lo, 0));
        sh.addColorStop(1, rgba(mix(TONE.lo, [80, 76, 72], 0.4), 0.24));
        pass(sh, 0.9);

        for (let i = 0; i < pts.length - 1; i++) {
          const mx = (pts[i][0] + pts[i + 1][0]) / 2;
          const my = (pts[i][1] + pts[i + 1][1]) / 2;
          const wv = (widths[i] + widths[i + 1]) * u * 0.5;
          const gg = ctx.createRadialGradient(mx - wv * 0.35, my - wv * 0.2, 0, mx, my, wv * 1.5);
          gg.addColorStop(0, rgba(mix(TONE.hi, [255, 255, 255], 0.5), 0.3));
          gg.addColorStop(1, rgba(TONE.hi, 0));
          ctx.fillStyle = gg;
          ctx.beginPath();
          ctx.ellipse(mx, my, wv * 0.9, wv * 1.5, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      };

      ctx.save();
      ctx.translate(cx, top);
      ctx.scale(1, breathe);
      ctx.translate(-cx, -top);

      // Contact shadow.
      const gy = top + u * 8.62;
      const sh = ctx.createRadialGradient(cx, gy, 0, cx, gy, u * 2.4);
      sh.addColorStop(0, 'rgba(120,96,74,.3)');
      sh.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = sh;
      ctx.beginPath();
      ctx.ellipse(cx, gy, u * 2.2, u * 0.38, 0, 0, Math.PI * 2);
      ctx.fill();

      // Legs, then feet.
      limb([[-0.44, 4.62], [-0.52, 5.7], [-0.50, 6.45], [-0.44, 7.5], [-0.42, 8.15]], [0.44, 0.38, 0.28, 0.24, 0.16], 'legs', 1);
      limb([[0.44, 4.62], [0.52, 5.7], [0.50, 6.45], [0.44, 7.5], [0.42, 8.15]], [0.44, 0.38, 0.28, 0.24, 0.16], 'legs', 1);
      ctx.fillStyle = rgba(mix(TONE.base, TONE.lo, 0.45), 1);
      for (const f of [[-0.42, 8.3], [0.42, 8.3]]) {
        const p = P(f[0], f[1]);
        ctx.beginPath();
        ctx.ellipse(p[0], p[1], u * 0.26, u * 0.15, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // Torso.
      const torso = new Path2D();
      const t0 = P(0, 1.42);
      const sL = P(-1.06, 2.16); const aL = P(-0.94, 2.72); const wL = P(-0.66, 3.72);
      const hL = P(-0.92, 4.42); const cL = P(-0.44, 4.86);
      const cR = P(0.44, 4.86); const hR = P(0.92, 4.42); const wR = P(0.66, 3.72);
      const aR = P(0.94, 2.72); const sR = P(1.06, 2.16);
      const bl = P(-0.6, 1.66); const br = P(0.6, 1.66);
      torso.moveTo(t0[0] - u * 0.2, t0[1]);
      torso.bezierCurveTo(bl[0], bl[1], sL[0] - u * 0.06, sL[1] - u * 0.18, sL[0], sL[1]);
      torso.bezierCurveTo(aL[0] - u * 0.06, aL[1] - u * 0.12, aL[0], aL[1] + u * 0.1, aL[0] + u * 0.02, aL[1] + u * 0.34);
      torso.bezierCurveTo(wL[0] - u * 0.06, wL[1] - u * 0.34, wL[0], wL[1] - u * 0.1, wL[0], wL[1]);
      torso.bezierCurveTo(hL[0] + u * 0.02, hL[1] - u * 0.28, hL[0], hL[1], hL[0] + u * 0.12, hL[1] + u * 0.26);
      torso.bezierCurveTo(cL[0] - u * 0.16, cL[1] + u * 0.06, cL[0] - u * 0.04, cL[1], P(0, 0)[0], cL[1] - u * 0.06);
      torso.bezierCurveTo(cR[0] + u * 0.04, cR[1], cR[0] + u * 0.16, cR[1] + u * 0.06, hR[0] - u * 0.12, hR[1] + u * 0.26);
      torso.bezierCurveTo(hR[0], hR[1], hR[0] - u * 0.02, hR[1] - u * 0.28, wR[0], wR[1]);
      torso.bezierCurveTo(wR[0], wR[1] - u * 0.1, wR[0] + u * 0.06, wR[1] - u * 0.34, aR[0] - u * 0.02, aR[1] + u * 0.34);
      torso.bezierCurveTo(aR[0], aR[1] + u * 0.1, aR[0] + u * 0.06, aR[1] - u * 0.12, sR[0], sR[1]);
      torso.bezierCurveTo(sR[0] + u * 0.06, sR[1] - u * 0.18, br[0], br[1], t0[0] + u * 0.2, t0[1]);
      torso.closePath();

      const centre = P(0, 3.1);
      fillPath(torso, 'chest', [centre[0], centre[1], u * 2.1, u * 2.9], 1);

      // Muscle modelling, clipped to the torso.
      ctx.save();
      ctx.clip(torso);
      const soft = (x: number, y: number, rx: number, ry: number, col: RGB, a: number) => {
        const p = P(x, y);
        const gg = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], Math.max(rx, ry) * u);
        gg.addColorStop(0, rgba(col, a));
        gg.addColorStop(0.55, rgba(col, a * 0.5));
        gg.addColorStop(1, rgba(col, 0));
        ctx.save();
        ctx.translate(p[0], p[1]);
        ctx.scale(1, ry / rx);
        ctx.translate(-p[0], -p[1]);
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(p[0], p[1], rx * u, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      };
      const LIT = mix(TONE.hi, [255, 255, 255], 0.5);
      const SHA = mix(TONE.lo, [90, 86, 82], 0.35);
      soft(-0.44, 2.52, 0.42, 0.3, LIT, 0.5);
      soft(0.44, 2.52, 0.42, 0.3, LIT, 0.42);
      soft(0, 2.86, 0.5, 0.1, SHA, 0.22);
      soft(-0.86, 2.35, 0.3, 0.34, LIT, 0.38);
      soft(0.86, 2.35, 0.3, 0.34, LIT, 0.3);
      [3.12, 3.44, 3.76].forEach((ay, i) => {
        const s = 1 - i * 0.12;
        soft(-0.24 * s, ay, 0.2 * s, 0.13 * s, LIT, 0.34);
        soft(0.24 * s, ay, 0.2 * s, 0.13 * s, LIT, 0.28);
        soft(0, ay + 0.16, 0.42 * s, 0.045, SHA, 0.17);
      });
      soft(0, 3.4, 0.045, 0.75, SHA, 0.18);
      soft(-0.62, 3.5, 0.28, 0.55, SHA, 0.2);
      soft(0.62, 3.5, 0.28, 0.55, SHA, 0.24);
      soft(0, 3.98, 0.07, 0.08, SHA, 0.26);
      soft(-0.32, 4.3, 0.36, 0.22, LIT, 0.3);
      soft(0.32, 4.3, 0.36, 0.22, LIT, 0.24);
      soft(-0.98, 2.62, 0.26, 0.46, SHA, 0.26);
      soft(0.98, 2.62, 0.26, 0.46, SHA, 0.3);
      soft(0, 1.62, 0.34, 0.16, SHA, 0.2);
      ctx.restore();

      // Arms, neck, head.
      limb([[-0.92, 2.26], [-1.16, 3.1], [-1.3, 4.05], [-1.28, 4.66]], [0.3, 0.24, 0.19, 0.14], 'arms', 0.55);
      limb([[0.92, 2.26], [1.16, 3.1], [1.3, 4.05], [1.28, 4.66]], [0.3, 0.24, 0.19, 0.14], 'arms', 0.55);
      limb([[0, 1.34], [0, 1.78]], [0.24, 0.28], 'head', 0.3);

      const head = new Path2D();
      const hc = P(0, 0.86);
      head.moveTo(hc[0], hc[1] - u * 0.66);
      head.bezierCurveTo(hc[0] + u * 0.52, hc[1] - u * 0.62, hc[0] + u * 0.56, hc[1] + u * 0.02, hc[0] + u * 0.44, hc[1] + u * 0.3);
      head.bezierCurveTo(hc[0] + u * 0.34, hc[1] + u * 0.56, hc[0] + u * 0.16, hc[1] + u * 0.7, hc[0], hc[1] + u * 0.72);
      head.bezierCurveTo(hc[0] - u * 0.16, hc[1] + u * 0.7, hc[0] - u * 0.34, hc[1] + u * 0.56, hc[0] - u * 0.44, hc[1] + u * 0.3);
      head.bezierCurveTo(hc[0] - u * 0.56, hc[1] + u * 0.02, hc[0] - u * 0.52, hc[1] - u * 0.62, hc[0], hc[1] - u * 0.66);
      head.closePath();
      fillPath(head, 'head', [hc[0], hc[1], u * 1.1, u * 1.4], 1);

      ctx.restore();
    }

    const pump = (t: number) => {
      raf = requestAnimationFrame(pump);
      frame(t);
    };

    const start = () => {
      if (raf || still.matches || document.hidden) return;
      raf = requestAnimationFrame(pump);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    // A hidden window still fires rAF in some WKWebView builds; park explicitly.
    const onVisibility = () => (document.hidden ? stop() : start());
    const onMotionPref = () => {
      stop();
      if (still.matches) frame(0);
      else start();
    };

    document.addEventListener('visibilitychange', onVisibility);
    still.addEventListener('change', onMotionPref);

    // Always paint once, even while hidden or under reduced motion: a surface
    // that mounts in a background tab must already have a figure on it the
    // moment it is looked at, not a blank rectangle until the first rAF tick.
    frame(0);
    start();

    return () => {
      stop();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      still.removeEventListener('change', onMotionPref);
    };
  }, []);

  return <canvas ref={canvasRef} className={className} aria-hidden />;
};
