/**
 * The `beta_ui` flag — the switch every Beta redesign phase ships behind.
 *
 * Resolution order, first match wins:
 *   1. `?beta=1` / `?beta=0` on the URL. Writes itself to storage so the choice
 *      survives the next route change (the query string does not).
 *   2. `localStorage["atlas:beta_ui"]` ("1" / "0").
 *   3. `VITE_ATLAS_BETA_UI` at build time.
 *   4. DEFAULT_ON — false until phase 8 flips it and this file goes away.
 *
 * Read once at module load and again on `setBetaUi`. It is NOT reactive across
 * tabs or during a session on purpose: the shell, the sphere engine and the
 * dock are all chosen from it, so changing it mid-session is a reload, and
 * `setBetaUi` says so by reloading.
 */
import { useSyncExternalStore } from 'react';

export const DEFAULT_ON = false;
const KEY = 'atlas:beta_ui';

function fromUrl(): boolean | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('beta');
  if (v === null) return null;
  const on = v === '1' || v === 'true' || v === 'on';
  try { window.localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private window */ }
  return on;
}

function fromStorage(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(KEY);
    return v === null ? null : v === '1';
  } catch {
    return null;
  }
}

function fromEnv(): boolean | null {
  const v = import.meta.env?.VITE_ATLAS_BETA_UI as string | undefined;
  if (v === undefined || v === '') return null;
  return v === '1' || v === 'true';
}

/** Pure resolver, exported for the test. */
export function resolveBetaUi(url: boolean | null, storage: boolean | null, env: boolean | null, fallback = DEFAULT_ON): boolean {
  return url ?? storage ?? env ?? fallback;
}

let current = resolveBetaUi(fromUrl(), fromStorage(), fromEnv());
const listeners = new Set<() => void>();

export function isBetaUi(): boolean {
  return current;
}

/** Persist the choice and reload: the shell is chosen at boot, not per render. */
export function setBetaUi(on: boolean, { reload = true }: { reload?: boolean } = {}): void {
  try { window.localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private window */ }
  current = on;
  listeners.forEach((l) => l());
  if (reload && typeof window !== 'undefined') window.location.reload();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useBetaUi(): boolean {
  return useSyncExternalStore(subscribe, isBetaUi, isBetaUi);
}
