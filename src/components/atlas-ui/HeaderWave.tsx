/**
 * Header audio-wave visualization — port of `wave(el)` from the design
 * handoff "Atlas Dashboard (Current).dc.html". Five drifting color blobs
 * behind four layered wave crests, with per-state presets (idle/listening/
 * thinking/speaking) eased at 0.05/frame. The design demo cycled states on
 * click; here the real voice session drives it, and live `audioLevel`
 * modulates the amplitude on top of the state preset.
 */
import { memo, useEffect, useRef } from "react";
import { useWindowActivity } from "@/hooks/useWindowActivity";
import type { AIState } from "@/types";

interface Props {
  state: AIState;
  audioLevel: number;
}

const TARGETS: Record<AIState, { a: number; sp: number; f: number; jit: number; mix: number }> = {
  idle:      { a: 1.1, sp: 0.35, f: 0.85, jit: 0,    mix: 0.18 },
  listening: { a: 3.2, sp: 0.7,  f: 1.1,  jit: 0.05, mix: 0.55 },
  thinking:  { a: 5,   sp: 2.1,  f: 2.4,  jit: 0.7,  mix: 0.65 },
  speaking:  { a: 13,  sp: 3.6,  f: 2,    jit: 0.32, mix: 1.35 },
};

const BLOBS = [
  { c: "52,97,242",   p1: 0.9, p2: 2.1, s1: 0.00021, s2: 0.00017, rr: 1.5 },
  { c: "104,140,242",  p1: 3.4, p2: 0.6, s1: 0.00016, s2: 0.00023, rr: 1.9 },
  { c: "172,191,246", p1: 5.1, p2: 4.2, s1: 0.00027, s2: 0.00013, rr: 2.3 },
  { c: "57,80,230",   p1: 1.9, p2: 5.6, s1: 0.00019, s2: 0.00026, rr: 1.4 },
  { c: "52,97,242",   p1: 4.4, p2: 3.1, s1: 0.00013, s2: 0.0002,  rr: 2.1 },
];

const LAYERS = [
  { ph: 4.1, al: 0.2,  c: "104,140,242", hm: 1.18 },
  { ph: 2.0, al: 0.28, c: "52,97,242",  hm: 1 },
  { ph: 5.3, al: 0.16, c: "57,80,230",  hm: 0.55 },
  { ph: 0,   al: 0.42, c: "52,97,242",  hm: 0.78 },
];

export const HeaderWave = memo(function HeaderWave({ state, audioLevel }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef(state);
  const levelRef = useRef(audioLevel);
  const active = useWindowActivity();
  const activeRef = useRef(active);
  stateRef.current = state;
  levelRef.current = audioLevel;
  activeRef.current = active;

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let running = true;
    const cur = { a: 2, sp: 1, f: 1, jit: 0, mix: 0.5 };
    let pt = 0, lastT = 0;

    const tick = (t: number) => {
      if (!running || !el.isConnected) return;
      if (!activeRef.current) { requestAnimationFrame(tick); return; }
      const d = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.max(1, el.clientWidth * d), H = Math.max(1, el.clientHeight * d);
      if (el.width !== W || el.height !== H) { el.width = W; el.height = H; }
      ctx.clearRect(0, 0, W, H);

      const T = TARGETS[stateRef.current] ?? TARGETS.listening;
      const ease = reduced ? 1 : 0.05;
      cur.a += (T.a - cur.a) * ease;
      cur.sp += (T.sp - cur.sp) * ease;
      cur.f += (T.f - cur.f) * ease;
      cur.jit += (T.jit - cur.jit) * ease;
      cur.mix += (T.mix - cur.mix) * ease;
      // Real audio drives extra amplitude/energy on top of the preset.
      const live = Math.min(1, levelRef.current);
      const aAmp = cur.a * (1 + live * 0.8);
      const e = Math.max(0, Math.min(1.3, cur.mix + live * 0.25));

      const dt = lastT ? Math.min(50, t - lastT) : 16;
      lastT = t;
      pt += dt * (reduced ? 0 : cur.sp);
      const ts = pt;

      for (let i = 0; i < BLOBS.length; i++) {
        const b = BLOBS[i];
        const jx = cur.jit * Math.sin(t * 0.01 + i * 7) * 14 * d;
        const bx = W * (0.5 + 0.44 * Math.sin(ts * b.s1 + b.p1)) + jx;
        const by = H * (0.5 + 0.4 * Math.cos(ts * b.s2 + b.p2));
        const br = Math.max(4, H * (b.rr + 0.35 * Math.sin(ts * 0.0004 + b.p2)));
        const a = b.c === "57,80,230" ? 0.05 + cur.jit * 0.22 : 0.09 + e * 0.16;
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        g.addColorStop(0, `rgba(${b.c},${a.toFixed(3)})`);
        g.addColorStop(1, `rgba(${b.c},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }

      // Edge fade so the wave melts into the header pill.
      const ef = ctx.createLinearGradient(0, 0, W, 0);
      ef.addColorStop(0, "rgba(255,255,255,.55)");
      ef.addColorStop(0.15, "rgba(255,255,255,0)");
      ef.addColorStop(0.7, "rgba(255,255,255,0)");
      ef.addColorStop(1, "rgba(255,255,255,.55)");
      ctx.fillStyle = ef;
      ctx.fillRect(0, 0, W, H);

      const crest = (L: (typeof LAYERS)[number], x: number) => {
        const u = x / W;
        const env = 0.55 + 0.45 * Math.sin(Math.PI * u);
        const jit = cur.jit * Math.sin(x * 0.15 / d + t * 0.02) * Math.sin(x * 0.037 / d - t * 0.013);
        const baseF = 0.16 + aAmp * 0.038;
        const m = 0.75
          + 0.45 * Math.sin(x * 0.014 * cur.f / d - ts * 0.002 + L.ph)
          + 0.25 * Math.sin(x * 0.031 * cur.f / d + ts * 0.0027 + L.ph * 2)
          + jit * 0.5;
        return H - H * baseF * L.hm * env * Math.max(0.05, m);
      };

      for (const L of LAYERS) {
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let x = 0; x <= W; x += 2 * d) ctx.lineTo(x, crest(L, x));
        ctx.lineTo(W, H);
        ctx.closePath();
        ctx.fillStyle = `rgba(${L.c},${(L.al * (0.4 + 0.45 * e)).toFixed(3)})`;
        ctx.fill();
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => { running = false; };
  }, []);

  return <canvas ref={canvasRef} className="hdrcv" aria-hidden />;
});
