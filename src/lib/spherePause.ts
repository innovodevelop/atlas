/**
 * When a Beta sphere moves, holds still, or sleeps.
 *
 * Every sphere on screen runs one small physics simulation per frame, and the
 * shell can show three at once (the page's, the Talk panel's, the orb). None
 * of that work is worth doing when nobody can see it, and none of it should
 * happen when someone has asked for no motion. The rules, in order:
 *
 *   1. Off-screen (IntersectionObserver) → sleep. Nothing is computed; the
 *      canvas keeps its last frame for when it scrolls back.
 *   2. Paused in Settings (`localStorage['atlas:sphere_paused'] === '1'`) or
 *      `prefers-reduced-motion: reduce` → still. One settled frame for the
 *      current state, so the sphere still shows Atlas's state in its colour,
 *      and nothing after it until the state changes.
 *   3. The window is hidden, unfocused past its grace period, or idle
 *      (`useWindowActivity`) → sleep. A state change while asleep paints one
 *      settled frame, because an unfocused window on a second screen is still
 *      looked at and the sphere must not show a state Atlas has left.
 *   4. Otherwise → animate.
 *
 * The decision is pure and tested; src/lib/quickSphere.ts applies it to every
 * instance. Settings owns the switch and writes the key; the engine listens
 * for `storage` events, which the browser only sends to OTHER documents, so a
 * writer in this window should call `setSpheresPaused` (it writes the key and
 * sends the same event here). The engine also re-reads the key after any
 * click, so a switch that writes localStorage directly still applies at once.
 */

export const SPHERE_PAUSED_KEY = 'atlas:sphere_paused';

export interface SpherePauseInputs {
  /** Settings → pause the sphere (`atlas:sphere_paused` is "1"). */
  userPaused: boolean;
  /** `prefers-reduced-motion: reduce`. */
  reducedMotion: boolean;
  /** `useWindowActivity`: visible, focused (after its grace) and not idle. */
  windowActive: boolean;
}

/**
 * - `animate`: advance the physics and draw every frame.
 * - `still`: one settled frame for the current state, then nothing.
 * - `sleep`: nothing at all; the last frame stays on the canvas.
 */
export type SphereRun = 'animate' | 'still' | 'sleep';

export function sphereRun(inputs: SpherePauseInputs, onScreen: boolean): SphereRun {
  if (!onScreen) return 'sleep';
  if (inputs.userPaused || inputs.reducedMotion) return 'still';
  if (!inputs.windowActive) return 'sleep';
  return 'animate';
}

/** The stored value means paused only when it is exactly "1" (Settings writes "0" to resume). */
export function parseSpherePaused(raw: string | null | undefined): boolean {
  return raw === '1';
}

export function readSpherePaused(): boolean {
  try {
    return typeof window !== 'undefined' && parseSpherePaused(window.localStorage.getItem(SPHERE_PAUSED_KEY));
  } catch {
    return false; // private window or blocked storage: the sphere moves
  }
}

/**
 * Write the switch and tell this window at once. `storage` events reach other
 * documents only; dispatching one here lets the engine use a single listener
 * for both.
 */
export function setSpheresPaused(paused: boolean): void {
  if (typeof window === 'undefined') return;
  const value = paused ? '1' : '0';
  try { window.localStorage.setItem(SPHERE_PAUSED_KEY, value); } catch { /* private window: nothing to persist */ }
  try {
    window.dispatchEvent(new StorageEvent('storage', { key: SPHERE_PAUSED_KEY, newValue: value }));
  } catch {
    /* an engine without StorageEvent: the click re-read still applies it */
  }
}
