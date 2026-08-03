/**
 * The pre-auth sphere — `/auth` and `/permissions`.
 *
 * Replaces `src/pages/AuthSphere.tsx`, which was the fourth and last bespoke
 * sphere renderer in the app (~160 lines, its own point cloud, its own rAF
 * loop, its own DPR handling). It now composes the one shared renderer, and
 * carries over the two behaviours that were actually its own:
 *
 *   1. POINTER PARALLAX. Kept, and kept out of React: the pointer position
 *      lands in a ref and is read by the renderer's opts getter, so moving the
 *      mouse across the login costs zero re-renders. The easing that used to
 *      live in the old tick loop lives in the getter, which runs once per
 *      painted frame — the same cadence.
 *
 *   2. THE OFF-CENTRE COMPOSITION. `cx 0.9 / cy 0.55 / radius 0.66` is the
 *      split-login layout: the orb sits far right and the copy occupies the
 *      left. It is the reason the renderer needed non-square support at all —
 *      the old code read every term off `el.width`, which only worked because
 *      it was hand-tuned for one aspect.
 *
 *   3. THE DRIFTING BACKDROP is now CSS (`.authbg` in workshop.css) rather than
 *      a second full-viewport canvas running its own rAF loop. See the CSS for
 *      why. Behaviour that improves for free: the old canvas honoured
 *      `prefers-reduced-motion` nowhere; the CSS version is covered by the
 *      global kill-switch.
 *
 * WHAT IS LOST, stated rather than hidden: the old orb drew with
 * `globalCompositeOperation = 'lighter'`, so overlapping particles added up to
 * white. The shared renderer draws source-over. Dense centres therefore read
 * slightly less blown-out. Everything else — count, shell distribution, the
 * core glow, the state set — is matched.
 */
import { useCallback, useEffect, useRef } from 'react';
import { AtlasSphereCanvas } from '@/components/atlas-ui/AtlasSphereCanvas';
import type { RGB, SphereOpts } from '@/lib/atlasSphere';

/** Kept identical so `/auth` and `/permissions` need no other change. */
export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

/**
 * White ink over the flat `#3461f2` scene, bluest in the deepest shade band.
 * The renderer's `dark` bump is deliberately not used — this is a saturated
 * blue field, not a dark card, and +62/+54/+36 on every channel would grey it.
 */
const AUTH_PALETTE: RGB[] = [
  [186, 206, 252],
  [230, 239, 255],
  [255, 253, 250],
];

/**
 * 9 000, not the 26 000 default. This is the app's FIRST paint, before auth,
 * on a machine that has just launched a Tauri window — and the old orb ran at
 * `min(6400, w*h/120)`, so this is already denser than what shipped.
 */
const AUTH_COUNT = 9000;

/** `Math.pow(random, dens)` — the old orb used 0.42, i.e. pushed toward a shell. */
const AUTH_DENS = 0.45;

export function AuthSphere({ orbState }: { orbState: OrbState }) {
  // Target (raw pointer) and eased (what the renderer reads). Plain fields, not
  // state: this updates at pointer rate and must never re-render the login.
  const par = useRef({ mx: 0, my: 0, tx: 0, ty: 0 });
  const bgRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Parallax IS motion, so a reduced-motion user does not get it — and with
    // no listener the eased values stay at 0 and the composition sits still.
    const mq = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null;
    if (mq?.matches) return;

    const onMove = (e: PointerEvent) => {
      const mx = (e.clientX / window.innerWidth - 0.5) * 2;
      const my = (e.clientY / window.innerHeight - 0.5) * 2;
      par.current.mx = mx;
      par.current.my = my;
      // The backdrop eases in CSS (a transition on a composited transform)
      // rather than being re-drawn, so this write is a style set, not a repaint.
      const bg = bgRef.current;
      if (bg) bg.style.transform = `translate3d(${(-mx * 1.1).toFixed(2)}%, ${(-my * 0.7).toFixed(2)}%, 0)`;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  // Called once per painted frame, from inside the render loop.
  const live = useCallback((): Partial<SphereOpts> => {
    const m = par.current;
    m.tx += (m.mx - m.tx) * 0.06;
    m.ty += (m.my - m.ty) * 0.06;
    return { cx: 0.9 + m.tx * 0.05, cy: 0.55 + m.ty * 0.05 };
  }, []);

  return (
    <>
      <div className="authbg" aria-hidden="true">
        <div className="authbgpar" ref={bgRef}>
          <i className="authblob authblob1" />
          <i className="authblob authblob2" />
          <i className="authblob authblob3" />
        </div>
      </div>
      <AtlasSphereCanvas
        className="authorbcv"
        state={orbState}
        count={AUTH_COUNT}
        dens={AUTH_DENS}
        size={0.62}
        radius={0.66}
        cx={0.9}
        cy={0.55}
        glow={0.34}
        palette={AUTH_PALETTE}
        live={live}
      />
    </>
  );
}
