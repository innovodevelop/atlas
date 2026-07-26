/**
 * Canvas-2D Atlas sphere — the React wrapper around src/lib/atlasSphere.ts.
 *
 * This exists alongside the WebGL `AtlasSphere` (three.js) rather than
 * replacing it: the design handoff proposes the swap but never says so, and
 * three.js is ~1 MB of the bundle, so the decision deserves a side-by-side
 * comparison rather than a silent cutover. Mount both, look at them, then
 * delete one. See docs/design-sync/2026-07-26-audit-sphere-mail-header.md §P0-1.
 *
 * Live values are passed as a getter, not props, so slider drags and audio
 * levels reach the render loop without waiting on a React commit — the same
 * reason the handoff mirrors editor state to a plain field.
 */
import { useEffect, useRef } from 'react';
import { mount, unmount, refresh, type SphereOpts, type SphereState } from '@/lib/atlasSphere';

interface Props extends SphereOpts {
  /**
   * CSS edge length in px; the backing store is this × devicePixelRatio (capped
   * at 1.5). Deliberately NOT called `size` — `SphereOpts.size` is the particle
   * size multiplier from the handoff's contract, and one name for two meanings
   * is a bug waiting to happen.
   */
  px?: number;
  className?: string;
  /** Forwarded to the canvas element; the sphere itself is aria-hidden. */
  title?: string;
  onClick?: () => void;
}

export function AtlasSphereCanvas({
  px = 224,
  className,
  title,
  onClick,
  ...opts
}: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  // Keep the newest opts in a ref and hand the renderer a getter, so changing
  // state or particle values never remounts the canvas (a remount would drop
  // the animation mid-flight and re-allocate the point cloud).
  const optsRef = useRef<SphereOpts>(opts);
  optsRef.current = opts;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    mount(el, () => optsRef.current);
    return () => unmount(el);
  }, []);

  // Under prefers-reduced-motion the loop does not run, so a state change would
  // otherwise leave the last-painted state on screen indefinitely.
  useEffect(() => {
    refresh();
  }, [opts.state, opts.dark, opts.count, opts.dens, opts.size, opts.soft, opts.countScale]);

  return (
    <canvas
      ref={ref}
      className={className}
      title={title}
      onClick={onClick}
      style={{
        width: px,
        height: px,
        flexShrink: 0,
        cursor: onClick ? 'pointer' : undefined,
      }}
    />
  );
}

export type { SphereState };
