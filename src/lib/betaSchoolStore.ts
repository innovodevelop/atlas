/**
 * The School screen's store: one module-level `SchoolState`, read with
 * `useSyncExternalStore` (the talk bus pattern), kept in localStorage under
 * `atlas:school`.
 *
 * Why localStorage and not the app database: the SQLite schema has nothing
 * that fits a spaced-repetition card (due, interval, ease) or a study session,
 * and the two tables that look close — `user_notes` and `user_tasks` — feed
 * the Notes and Tasks widgets, which would start showing flashcards and study
 * blocks. A new table is a Rust migration, which this screen does not get to
 * add. Everything here is the student's own and lives on this Mac only; the
 * reader (`parseSchool`) is defensive so a damaged entry opens as empty
 * rather than breaking the screen.
 *
 * Writes are debounced: the editor and the sheet change the state on every
 * keystroke, and serialising the whole store each time would be wasted work.
 * `flushSchool` writes immediately (the page calls it on unmount, and the
 * window on `pagehide`).
 */
import { useSyncExternalStore } from 'react';
import { EMPTY_SCHOOL, parseSchool, type SchoolState } from './betaSchool';

export const SCHOOL_KEY = 'atlas:school';
const SAVE_DELAY_MS = 400;

let state: SchoolState | null = null;
let saveFailed = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void { listeners.forEach((l) => l()); }

function load(): SchoolState {
  try {
    return parseSchool(window.localStorage.getItem(SCHOOL_KEY));
  } catch {
    // Storage blocked (a private window, a preview): start empty, in memory.
    return EMPTY_SCHOOL;
  }
}

export function getSchool(): SchoolState {
  if (state === null) state = load();
  return state;
}

function write(): void {
  saveTimer = null;
  let failed = false;
  try {
    window.localStorage.setItem(SCHOOL_KEY, JSON.stringify(getSchool()));
  } catch {
    failed = true;
  }
  if (failed !== saveFailed) { saveFailed = failed; emit(); }
}

/** Replace the state with `fn(state)`; returning the same object is a no-op. */
export function updateSchool(fn: (s: SchoolState) => SchoolState): void {
  const prev = getSchool();
  const next = fn(prev);
  if (next === prev) return;
  state = next;
  emit();
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(write, SAVE_DELAY_MS);
}

export function flushSchool(): void {
  if (saveTimer === null) return;
  clearTimeout(saveTimer);
  write();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function useSchool(): SchoolState {
  return useSyncExternalStore(subscribe, getSchool, getSchool);
}

/** True after a write failed (storage full or blocked): the screen says its changes are not being kept. */
export function useSchoolSaveFailed(): boolean {
  return useSyncExternalStore(subscribe, () => saveFailed, () => false);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushSchool);
  // Another window of the app wrote the store: take its version.
  window.addEventListener('storage', (e) => {
    if (e.key !== SCHOOL_KEY) return;
    state = parseSchool(e.newValue);
    emit();
  });
}

export function _resetSchoolStore(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  state = null;
  saveFailed = false;
}
