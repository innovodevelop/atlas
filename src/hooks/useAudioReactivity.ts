import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { AudioLevel } from './useMusicPlayer';

// Native-audio reactivity core for the music Sphere.
//
// The design prototype drove the sphere from a *synthetic* BPM clock
// (kick = exp(-timeSinceBeat*8)). Atlas has no such clock and — crucially — no
// Web Audio AnalyserNode: audio is decoded natively by librespot in Rust, not in
// the webview. Instead the Rust TappingSink emits a real RMS + 3-band envelope
// as `music:level`, surfaced by useMusicPlayer as `levelRef` ({amp, bands}).
//
// This hook consumes that real feed and produces the values a canvas draw loop
// wants — a smoothed amplitude, a beat "pulse", a running spin, and an energy
// gate — using:
//   • frame-rate-independent smoothing (so motion is fluid at any FPS, and the
//     ~30 fps level feed is interpolated to 60 fps render),
//   • onset detection on the LOW band (bass/kick) to lock beats to the actual
//     music instead of a fixed tempo,
//   • an energy gate that settles everything to rest when paused.
//
// Output lives in a ref (never state) so 60 fps updates cause zero React
// re-renders — the sphere reads `reactivity.current` inside its own rAF loop.

export interface Reactivity {
  /** Smoothed overall amplitude 0..1 — drives size/brightness swells. */
  amp: number;
  /** Beat envelope 0..1 — spikes on each detected kick, decays fast. */
  pulse: number;
  /** Smoothed [low, mid, high] band energies 0..1. */
  bands: [number, number, number];
  /** Ever-increasing rotation, faster while playing. */
  spin: number;
  /** 0 (paused/rest) → 1 (playing) gate the others fade through. */
  energy: number;
}

const REST: Reactivity = { amp: 0, pulse: 0, bands: [0, 0, 0], spin: 0, energy: 0 };

/** Frame-rate-independent lerp: eases `a` toward `b` by rate/sec `k`. */
const approach = (a: number, b: number, dt: number, k: number) =>
  a + (b - a) * Math.min(1, dt * k);

export interface AudioReactivityOptions {
  /** When false, output stays near rest (respects reduced-motion / low-power). */
  reactive?: boolean;
}

export function useAudioReactivity(
  levelRef: RefObject<AudioLevel>,
  isPlaying: boolean,
  { reactive = true }: AudioReactivityOptions = {},
): RefObject<Reactivity> {
  const out = useRef<Reactivity>({ ...REST });

  // Mutable inputs read inside the loop without re-subscribing the rAF.
  const playingRef = useRef(isPlaying);
  playingRef.current = isPlaying;
  const reactiveRef = useRef(reactive);
  reactiveRef.current = reactive;

  useEffect(() => {
    const reduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let last = 0;
    // Smoothing/onset state.
    let ampS = 0;
    let pulse = 0;
    let energy = 0;
    let spin = 0;
    const bandsS: [number, number, number] = [0, 0, 0];
    let lowAvg = 0; // slow baseline of the low band for onset detection
    let beatT = -1; // timestamp of the last detected beat (seconds)

    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      // Pause work entirely when the tab/window is hidden.
      if (typeof document !== 'undefined' && document.hidden) {
        last = 0;
        return;
      }
      const t = ts / 1000;
      const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
      last = ts;
      if (dt === 0) return;

      const on = reactiveRef.current && !reduceMotion;
      const lvl = levelRef.current ?? REST;
      const [low, mid, high] = lvl.bands ?? [0, 0, 0];

      // Energy gate settles motion to rest shortly after pause.
      energy = approach(energy, playingRef.current ? 1 : 0, dt, 3);

      // Onset detection on the low band → beat timestamp. Bass transients are a
      // far better beat source than broadband RMS.
      lowAvg = approach(lowAvg, low, dt, 2.2);
      const onset = low - lowAvg - 0.05;
      const sinceBeat = beatT < 0 ? 999 : t - beatT;
      if (on && onset > 0.06 && sinceBeat > 0.14) beatT = t;
      const kick = beatT < 0 ? 0 : Math.exp(-(t - beatT) * 8);

      // Target amplitude blends the real swell with the beat kick, gated by
      // energy. At rest it eases to a faint idle breathing.
      const target = on
        ? Math.min(1, (0.42 * kick + 0.4 * (lvl.amp ?? 0) + 0.12) * energy)
        : 0.1 * energy;

      ampS = approach(ampS, target, dt, 11);
      pulse = approach(pulse, kick * energy, dt, 16);
      bandsS[0] = approach(bandsS[0], low, dt, 12);
      bandsS[1] = approach(bandsS[1], mid, dt, 12);
      bandsS[2] = approach(bandsS[2], high, dt, 12);
      spin += dt * (0.25 + 1.3 * energy);

      const o = out.current;
      o.amp = ampS;
      o.pulse = pulse;
      o.bands[0] = bandsS[0];
      o.bands[1] = bandsS[1];
      o.bands[2] = bandsS[2];
      o.spin = spin;
      o.energy = energy;
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);

  return out;
}
