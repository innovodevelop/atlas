import { useEffect, useRef, useState } from 'react';
import { mount, refresh, unmount, type SphereOpts, type SphereState } from '@/lib/atlasSphere';

/**
 * The onboarding orb.
 *
 * The design file mounts "the real Atlas particle sphere — same shared renderer
 * as every dashboard", so this wraps `src/lib/atlasSphere` (the canvas-2D
 * renderer) directly rather than forking a fourth sphere. It is deliberately
 * NOT `AtlasSphereCanvas` or `AtlasSphereLazy`: the sphere-merge track owns
 * those files right now, and this surface must not edit or depend on a file
 * being rewritten underneath it. The public contract used here — `mount` /
 * `unmount` / `refresh` — is the one README §3 documents, so it survives the
 * merge either way.
 *
 * SIZE COMES FROM CSS, not from a prop. The renderer re-reads `clientWidth`
 * every frame (atlasSphere.ts line ~373), which is what lets the orb *glide*
 * between its intro size and its band size on a plain CSS transition instead of
 * a JS animation — the design's orb travel, expressed the way the app animates.
 *
 * HONEST FAILURE. `mount()` returns null when the canvas cannot hand back a 2D
 * context. When that happens this renders nothing at all rather than leaving a
 * blank square where a sphere is supposed to be: an empty box reads as a broken
 * screen, and the orb carries no information the copy does not.
 */
interface OnboardingSphereProps {
  state: SphereState;
  /** Sizing/positioning class. The canvas fills it. */
  className?: string;
}

export function OnboardingSphere({ state, className }: OnboardingSphereProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  // Live values via a getter, so a state change reaches the render loop without
  // waiting on a React commit — and never remounts the canvas (a remount drops
  // the animation mid-flight and re-allocates the point cloud).
  const optsRef = useRef<SphereOpts>({ state });
  optsRef.current = { state };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handle = mount(el, () => optsRef.current);
    if (!handle) setUnavailable(true);
    return () => unmount(el);
  }, []);

  // Under prefers-reduced-motion the loop does not run, so without this the
  // last-painted state would stay on screen for the whole flow.
  useEffect(() => { refresh(); }, [state]);

  if (unavailable) return null;

  return <canvas ref={ref} className={className} />;
}

export default OnboardingSphere;
