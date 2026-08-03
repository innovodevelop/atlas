/**
 * The Atlas sphere — React wrapper around `src/lib/atlasSphere.ts`.
 *
 * This is now the ONLY sphere in the app. The three.js renderer it used to sit
 * beside (`src/components/atlas/`, ~1 MB of the bundle), the bespoke music
 * canvas and the bespoke auth canvas are all gone; every surface renders this
 * component. That is why the file moved out of `src/components/atlas/` — that
 * directory was the WebGL tree and was deleted whole.
 *
 * Live values are passed to the renderer as a GETTER, not as props, so slider
 * drags, audio levels and pointer parallax reach the render loop without
 * waiting on a React commit.
 *
 * Two sizing modes:
 *   px given     fixed square, written inline. The gallery uses this — it wants
 *                a known particle-per-pixel density to tune against.
 *   px omitted   fills the parent box. Every app surface uses this, because
 *                the parent is CSS-sized (`.orbwrapB`, `.homeorb`, `.coreorb`,
 *                `.authorbcv`) and several are not square. The renderer reads
 *                `clientWidth`/`clientHeight` on every paint and re-sizes its
 *                own backing store, so no measurement is needed here.
 */
import { useEffect, useRef } from 'react';
import { mount, unmount, refresh, type SphereOpts, type SphereState } from '@/lib/atlasSphere';

interface Props extends SphereOpts {
  /**
   * CSS edge length in px. Omit to fill the parent instead.
   *
   * Deliberately NOT called `size` — `SphereOpts.size` is the particle size
   * multiplier from the handoff's contract, and one name for two meanings is a
   * bug waiting to happen.
   */
  px?: number;
  className?: string;
  /** Forwarded to the canvas element; the sphere itself is aria-hidden. */
  title?: string;
  onClick?: () => void;
  /**
   * Per-frame overrides, read INSIDE the render loop and merged over the props.
   * For values that change faster than React should re-render — pointer
   * parallax, an audio envelope. Returning `{}` is free.
   */
  live?: () => Partial<SphereOpts>;
  /** Let the renderer trade field density for frame time on this canvas. */
  adaptive?: boolean;
}

export function AtlasSphereCanvas({
  px,
  className,
  title,
  onClick,
  live,
  adaptive,
  ...opts
}: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  // Newest values in refs; the renderer holds one stable getter for the life of
  // the canvas, so changing state or particle values never remounts it (a
  // remount would drop the animation mid-flight and re-allocate the cloud).
  const optsRef = useRef<SphereOpts>(opts);
  optsRef.current = opts;
  const liveRef = useRef<Props['live']>(live);
  liveRef.current = live;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    mount(el, () => {
      const extra = liveRef.current?.();
      return extra ? { ...optsRef.current, ...extra } : optsRef.current;
    }, { adaptive });
    return () => unmount(el);
  }, [adaptive]);

  // Under prefers-reduced-motion the loop does not run, so without this a
  // changed opt would leave the last-painted frame on screen indefinitely.
  //
  // No dependency array on purpose. The previous version listed the seven v2
  // opts, which silently stopped covering `morph`, `amp`, `palette`, `radius`…
  // the moment v3 landed. `refresh()` is a matchMedia read and an early return
  // unless reduced motion is on, so running it on every commit is cheaper than
  // maintaining a list that is wrong by construction the next time an opt is
  // added.
  useEffect(() => { refresh(); });

  // A container resize under reduced motion produces no frame either, so the
  // canvas would keep the backing store from its old box.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => refresh());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <canvas
      ref={ref}
      className={className}
      title={title}
      onClick={onClick}
      style={
        px == null
          ? { width: '100%', height: '100%', display: 'block', cursor: onClick ? 'pointer' : undefined }
          : { width: px, height: px, flexShrink: 0, display: 'block', cursor: onClick ? 'pointer' : undefined }
      }
    />
  );
}

export type { SphereState };
