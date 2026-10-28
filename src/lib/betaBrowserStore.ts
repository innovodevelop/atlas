/**
 * The Browser screen's store: one module-level `BrowserState`, read with
 * `useSyncExternalStore` (the talk bus pattern, as betaSchoolStore.ts), kept in
 * localStorage under `atlas:browser`.
 *
 * Why localStorage and not the app database: the tabs, the history and the
 * kept pages are this screen's own, nothing else reads them, and a new table
 * would be a Rust migration for a screen whose data is a few page copies. It
 * all stays on this Mac. The reader (`parseBrowser`) is defensive, so a
 * damaged entry opens as an empty browser rather than breaking the screen.
 *
 * Page copies are the bulk of it. What is written is `fitToBudget(state)`:
 * past STORE_BUDGET the copies of the least recently read tabs, then the
 * oldest kept pages, are left out of the saved state (the tabs stay, and say
 * they can load their page again). If the browser still refuses the write, the
 * store tries once more with no copies at all, and only then reports that the
 * session is not being kept.
 *
 * Writes are debounced; `flushBrowser` writes at once (the page calls it on
 * unmount, and the window on `pagehide`).
 */
import { useSyncExternalStore } from 'react';
import { EMPTY_BROWSER, fitToBudget, parseBrowser, type BrowserState } from './betaBrowser';

export const BROWSER_KEY = 'atlas:browser';
const SAVE_DELAY_MS = 400;

let state: BrowserState | null = null;
let saveFailed = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void { listeners.forEach((l) => l()); }

function load(): BrowserState {
  try {
    return parseBrowser(window.localStorage.getItem(BROWSER_KEY));
  } catch {
    // Storage blocked (a private window, a preview): start empty, in memory.
    return EMPTY_BROWSER;
  }
}

export function getBrowser(): BrowserState {
  if (state === null) state = load();
  return state;
}

function tryWrite(s: BrowserState): boolean {
  try {
    window.localStorage.setItem(BROWSER_KEY, JSON.stringify(s));
    return true;
  } catch {
    return false;
  }
}

function write(): void {
  saveTimer = null;
  const s = getBrowser();
  const ok = tryWrite(fitToBudget(s)) || tryWrite(fitToBudget(s, 0));
  if (ok === saveFailed) { saveFailed = !ok; emit(); }
}

/** Replace the state with `fn(state)`; returning the same object is a no-op. */
export function updateBrowser(fn: (s: BrowserState) => BrowserState): void {
  const prev = getBrowser();
  const next = fn(prev);
  if (next === prev) return;
  state = next;
  emit();
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(write, SAVE_DELAY_MS);
}

export function flushBrowser(): void {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  write();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useBrowserState(): BrowserState {
  return useSyncExternalStore(subscribe, getBrowser, getBrowser);
}

/** True after a write failed (storage full or blocked): the screen says its tabs are not being kept. */
export function useBrowserSaveFailed(): boolean {
  return useSyncExternalStore(subscribe, browserSaveFailed, () => false);
}

export function browserSaveFailed(): boolean {
  return saveFailed;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushBrowser);
  // Another window of the app wrote the store: take its version.
  window.addEventListener('storage', (e) => {
    if (e.key !== BROWSER_KEY) return;
    state = parseBrowser(e.newValue);
    emit();
  });
}

export function _resetBrowserStore(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  state = null;
  saveFailed = false;
}
