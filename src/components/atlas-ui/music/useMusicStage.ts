/**
 * The engine room behind all three presentations of the player.
 *
 * Full player, sleeve and compact widget differ only in what they draw. The
 * things that make them *the same player* — the palette crossfading out of
 * Atlas Blue into the record, the morph tween between field and sphere, the
 * single animation frame, and the reduced-motion behaviour — live here so there
 * is exactly one copy of each. A second copy is how two surfaces end up
 * disagreeing about which formation the sphere is in.
 *
 * THE ONE PERFORMANCE RULE, restated because this is where it would be broken:
 * the only per-frame style writes any presentation may make are on unfiltered,
 * untransformed elements — an opacity, a width, a text node. The cover washes
 * are blurred by 44–130px and are STATIC. Animating a transform or a filter on
 * a blurred full-bleed image re-rasters the blur every frame and takes the
 * surface to ~15fps.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { refresh as refreshSphere, type SphereOpts } from '@/lib/atlasSphere';
import type { CoverPalette, RGB } from '@/lib/atlasCover';
import type { Reactivity } from '@/hooks/useAudioReactivity';
import {
  chromeFor, freshPalette, paletteSignature, particlePalette, settlePalette, stepPalette,
  type MusicChrome,
} from './musicPalette';

/** `morphSeconds` from the handoff's prop table. */
export const MORPH_MS = 1500;
/** The intro: the sphere unrolls into the field over 2.6s on mount. */
export const INTRO_MS = 2600;

/**
 * The beat glow's opacity at rest — `0.1 + amp*0.46 + pulse*0.16` with the
 * envelope at zero. Under reduced motion the glow is pinned here: the wash
 * stays lit, but nothing pulses.
 */
export const GLOW_REST = '0.100';

export interface StageFrame {
  /** Smoothed real amplitude from `music:level`, 0–1. */
  amp: number;
  /** Beat envelope, 0–1. */
  pulse: number;
  /** True when the sphere is settled rather than dispersed into the field. */
  settled: boolean;
}

export interface MusicStageOptions {
  /** The palette read off the artwork; the crossfade's destination. */
  palette: CoverPalette;
  /** Transport state. Playing disperses the sphere into the field. */
  isPlaying: boolean;
  /** The live envelope from `useAudioReactivity`. */
  reactivity: RefObject<Reactivity>;
  /**
   * `prefers-reduced-motion`. Passed in rather than read here because the
   * surface needs the same value to gate `useAudioReactivity`, and two
   * independent matchMedia reads is two chances to disagree.
   */
  reduced: boolean;
  /**
   * Apply the palette-derived CSS. Called once on mount and again on every
   * change of the palette signature — a handful of times per track change,
   * never per frame.
   */
  onChrome: (chrome: MusicChrome) => void;
  /** Per-frame element writes. ~60Hz normally; 1Hz under reduced motion. */
  onFrame: (frame: StageFrame) => void;
}

export interface MusicStage {
  /** True when the user asked for less motion. Presentations must honour it. */
  reduced: boolean;
  /** `live` for `AtlasSphereCanvas` — read inside the renderer's own loop. */
  live: () => Partial<SphereOpts>;
  /**
   * Force one `onFrame`. For pointer feedback under reduced motion, where
   * there is no loop to pick the change up.
   */
  paintNow: () => void;
  /**
   * Invalidate the chrome signature so the next frame repaints it.
   *
   * Chrome is painted onto element refs only when the palette MOVES, which is
   * the right trigger nearly always and exactly wrong when a chrome-bearing
   * element is swapped for a new one — the vinyl disc, which mounts long after
   * the palette settled and would otherwise wear the stylesheet's default
   * navy for the rest of the track. The prototype does the same thing by
   * nulling its `_sig` on a variant switch.
   */
  repaintChrome: () => void;
}

export function useReducedMotion(): boolean {
  const [v, setV] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const q = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!q) return;
    const on = () => setV(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return v;
}

export function useMusicStage(opts: MusicStageOptions): MusicStage {
  const { palette, isPlaying, reactivity, reduced } = opts;

  // Callbacks and inputs the loop must see without re-subscribing. Written
  // during render, read inside rAF — the idiom `useAudioReactivity` uses.
  const chromeCb = useRef(opts.onChrome);
  chromeCb.current = opts.onChrome;
  const frameCb = useRef(opts.onFrame);
  frameCb.current = opts.onFrame;
  const targetRef = useRef(palette);
  targetRef.current = palette;
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  // --- palette -------------------------------------------------------------
  const palRef = useRef(freshPalette());
  const partPalRef = useRef<RGB[]>(particlePalette(palRef.current));
  const sigRef = useRef<string>('');

  // --- morph tween: playing → field (0), paused → sphere (1) ---------------
  const morphRef = useRef(1);
  const twRef = useRef<{ a: number; b: number; t0: number; d: number } | null>(null);
  const to = useCallback((v: number, ms: number) => {
    twRef.current = { a: morphRef.current, b: v, t0: performance.now(), d: ms };
  }, []);

  const settled = useCallback(
    () => reducedRef.current || morphRef.current > 0.5,
    [],
  );

  const paintNow = useCallback(() => {
    const r = reactivity.current;
    frameCb.current({
      amp: reducedRef.current ? 0 : (r?.amp ?? 0),
      pulse: reducedRef.current ? 0 : (r?.pulse ?? 0),
      settled: settled(),
    });
  }, [reactivity, settled]);

  const repaintChrome = useCallback(() => {
    sigRef.current = '';
    // Under reduced motion there is no next frame to pick the invalidation up.
    if (reducedRef.current) chromeCb.current(chromeFor(palRef.current));
  }, []);

  // --- the one animation frame --------------------------------------------
  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    let last = 0;
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      // A hidden window still fires rAF in some WebKit configurations; do no
      // work, and drop the clock so the first visible frame is not a 10s dt.
      if (typeof document !== 'undefined' && document.hidden) { last = 0; return; }
      const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
      last = ts;
      if (!dt) return;

      const w = twRef.current;
      if (w) {
        const u = Math.min(1, (ts - w.t0) / w.d);
        const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; // easeInOutCubic
        morphRef.current = w.a + (w.b - w.a) * e;
        if (u >= 1) twRef.current = null;
      }

      stepPalette(palRef.current, targetRef.current, dt);
      partPalRef.current = particlePalette(palRef.current);
      const sig = paletteSignature(palRef.current);
      if (sig !== sigRef.current) { sigRef.current = sig; chromeCb.current(chromeFor(palRef.current)); }

      const r = reactivity.current;
      frameCb.current({ amp: r?.amp ?? 0, pulse: r?.pulse ?? 0, settled: morphRef.current > 0.5 });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [reduced, reactivity]);

  // --- reduced motion: no loop, no tween, no crossfade ---------------------
  useEffect(() => {
    if (!reduced) return;
    twRef.current = null;
    // `atlasSphere.paint` forces morph = 1 and spin = 0 under reduced motion,
    // so this is not a preference — it is what the renderer will draw. A
    // presentation reading its formation label off a tween would announce
    // "Field · in motion" over a static sphere.
    morphRef.current = 1;
    settlePalette(palRef.current, targetRef.current);
    partPalRef.current = particlePalette(palRef.current);
    sigRef.current = paletteSignature(palRef.current);
    chromeCb.current(chromeFor(palRef.current));
    paintNow();
    // The sphere paints once per commit, and child effects run before parent
    // effects — so `AtlasSphereCanvas` has already repainted with the previous
    // palette by the time we settle this one.
    refreshSphere();
  }, [reduced, palette, paintNow]);

  // A 1Hz readout, not an animation: a clock that advances once a second is
  // what a clock does, and a progress display frozen at 0:00 would be its own
  // kind of lie. Nothing else moves.
  useEffect(() => {
    if (!reduced) return;
    paintNow();
    const id = window.setInterval(paintNow, 1000);
    return () => window.clearInterval(id);
  }, [reduced, paintNow]);

  // Formation follows the transport; on mount it unrolls over 2.6s.
  const mounted = useRef(false);
  useEffect(() => {
    if (reduced) return;
    const target = isPlaying ? 0 : 1;
    if (!mounted.current) { mounted.current = true; to(target, INTRO_MS); }
    else to(target, MORPH_MS);
  }, [isPlaying, reduced, to]);

  const live = useCallback(() => ({
    morph: morphRef.current,
    amp: reactivity.current?.amp ?? 0.3,
    pulse: reactivity.current?.pulse ?? 0,
    palette: partPalRef.current,
  }), [reactivity]);

  // Stable identity: surfaces list this in effect dependency arrays.
  return useMemo(
    () => ({ reduced, live, paintNow, repaintChrome }),
    [reduced, live, paintNow, repaintChrome],
  );
}
