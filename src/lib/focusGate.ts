/**
 * The focus gate — the one place Atlas's notifiers ask "may I speak now?"
 * (Beta row 12), and the store behind the Focus screen.
 *
 * A notifier calls `holdForFocus({ source, title, body })` before it shows
 * anything. While a focus session runs, a `message` is held here and the call
 * returns true, so the notifier stays quiet; any other time it returns false
 * and the notifier goes ahead. Alarms and approvals pass `kind: 'alarm'` or
 * `'approval'` and are never held — or, like the Clock's alarms, never ask.
 * When the session ends the screen says how many were held and what they
 * were, and the one notification Atlas does send at the end is the session's
 * own (the timer finishing, like a Clock countdown).
 *
 * A module store (the talkBus / betaClockStore pattern): a session started on
 * the Focus screen keeps running while the user is on Mail, and ends on time
 * wherever they are. One `setTimeout` to the end, nothing ticking; the screen
 * draws its own seconds. Saved to localStorage 'atlas:focus' on every change,
 * so a reload resumes the session (a paused one stays paused, a running one
 * that should have ended while the app was closed is logged as done).
 *
 * The optional macOS Focus: macOS lets an app turn on a system Focus only
 * through the user's own Shortcuts, so when the user has named one, a start
 * runs it through `focus_shortcut_run` (src-tauri/src/focus_mode.rs) and an
 * end runs the end one. Nothing about a session leaves the Mac.
 */
import { useSyncExternalStore } from 'react';
import {
  appendLog, endsAt, holdNote, logEntry, parseFocusSaved, pauseSession, resumeSession, shouldHold, startSession,
  FOCUS_KEY, type FocusLength, type FocusSaved, type HeldNote, type NotifyKind,
} from './betaFocus';

export interface FocusSnapshot extends FocusSaved {
  /** The last thing that went wrong (a Shortcut that did not run); null when all is well. */
  notice: string | null;
  /** A Shortcut is running right now. */
  busy: boolean;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let endTimer: number | null = null;

const inTauri = (): boolean => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

function readSaved(): FocusSaved {
  try {
    return parseFocusSaved(typeof window === 'undefined' ? null : window.localStorage.getItem(FOCUS_KEY), Date.now());
  } catch {
    return parseFocusSaved(null, Date.now());
  }
}

let snap: FocusSnapshot = { ...readSaved(), notice: null, busy: false };

function persist(): void {
  try {
    const { session, log, prefs, ended } = snap;
    window.localStorage.setItem(FOCUS_KEY, JSON.stringify({ session, log, prefs, ended }));
  } catch { /* private window: the session keeps the state, the next launch starts clean */ }
}

function set(patch: Partial<FocusSnapshot>, save = true): void {
  snap = { ...snap, ...patch };
  if (save) persist();
  schedule();
  listeners.forEach((l) => l());
}

/** One timeout to the end of a running session; none otherwise. */
function schedule(): void {
  if (endTimer != null) { window.clearTimeout(endTimer); endTimer = null; }
  const s = snap.session;
  const end = s ? endsAt(s) : null;
  if (end == null || typeof window === 'undefined') return;
  // Re-checked at least every minute, so a Mac that slept through the end
  // finishes the session when it wakes rather than whenever a timer that
  // slept with it fires.
  endTimer = window.setTimeout(checkEnd, Math.max(0, Math.min(end - Date.now(), 60000)));
}

function checkEnd(): void {
  endTimer = null;
  const s = snap.session;
  const end = s ? endsAt(s) : null;
  if (s && end != null && Date.now() >= end) finish(true, end);
  else schedule();
}

async function runShortcut(name: string): Promise<void> {
  if (!name) return;
  if (!inTauri()) { set({ notice: 'Shortcuts run only in the Mac app.' }, false); return; }
  set({ busy: true }, false);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('focus_shortcut_run', { name });
    set({ busy: false }, false);
  } catch (e) {
    set({ busy: false, notice: e instanceof Error ? e.message : String(e) }, false);
  }
}

async function notifyEnd(held: number, minutes: number): Promise<void> {
  const body = held
    ? `${minutes} minutes done. Atlas held ${held} ${held === 1 ? 'notification' : 'notifications'} for you.`
    : `${minutes} minutes done. Nothing came in.`;
  try {
    if (inTauri()) {
      const plugin = await import('@tauri-apps/plugin-notification');
      let granted = await plugin.isPermissionGranted();
      if (!granted) granted = (await plugin.requestPermission()) === 'granted';
      if (granted) plugin.sendNotification({ title: 'Focus done', body });
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('Focus done', { body });
    }
  } catch { /* the screen shows the same summary; a refused notification is not worth a crash */ }
}

function finish(completed: boolean, at: number): void {
  const s = snap.session;
  if (!s) return;
  const entry = logEntry(s, at);
  set({ session: null, log: appendLog(snap.log, entry, at), ended: { entry, held: s.held } });
  if (completed) void notifyEnd(s.held.length, entry.minutes);
  void runShortcut(snap.prefs.endShortcut);
}

// A session saved by an earlier launch: end it if its time ran out meanwhile,
// otherwise arm its timer.
if (typeof window !== 'undefined') {
  const s = snap.session;
  const end = s ? endsAt(s) : null;
  if (s && end != null && Date.now() >= end) finish(true, end);
  else schedule();
}

// --- The gate ------------------------------------------------------------------------

/**
 * Ask before notifying. Returns true when the notification was held for a
 * running focus session — the caller then shows nothing. `kind` defaults to
 * a message; alarms and approvals always come through.
 */
export function holdForFocus(n: { source: string; title: string; body?: string; kind?: NotifyKind }): boolean {
  const now = Date.now();
  if (!shouldHold(snap.session, n.kind ?? 'message', now) || !snap.session) return false;
  const note: HeldNote = { source: n.source, title: n.title, body: n.body, at: now };
  set({ session: holdNote(snap.session, note) });
  return true;
}

// --- Actions -------------------------------------------------------------------------

export function startFocus(task: string | null = null): void {
  if (snap.session) return;
  set({ session: startSession(snap.prefs.lengthMin, Date.now(), task), ended: null, notice: null });
  void runShortcut(snap.prefs.startShortcut);
}

export function pauseFocus(): void {
  if (snap.session) set({ session: pauseSession(snap.session, Date.now()) });
}

export function resumeFocus(): void {
  if (snap.session) set({ session: resumeSession(snap.session, Date.now()) });
}

/** End the session now; it is logged with the minutes actually focused. */
export function endFocus(): void {
  if (snap.session) finish(false, Date.now());
}

export function setFocusLength(lengthMin: FocusLength): void {
  if (snap.session) return;
  set({ prefs: { ...snap.prefs, lengthMin } });
}

export function setFocusShortcut(which: 'start' | 'end', name: string): void {
  set({ prefs: { ...snap.prefs, [which === 'start' ? 'startShortcut' : 'endShortcut']: name.trim() }, notice: null });
}

export function dismissFocusSummary(): void {
  set({ ended: null, notice: null });
}

/** The user's Shortcuts, for the pick list. Throws with a sentence the screen can show. */
export async function listShortcuts(): Promise<string[]> {
  if (!inTauri()) throw new Error('Your Shortcuts are listed only in the Mac app.');
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string[]>('focus_shortcut_list');
}

// --- Reading -------------------------------------------------------------------------

const subscribe = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getSnapshot = () => snap;

export function useFocus(): FocusSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** For non-React readers and tests. */
export function focusSnapshot(): FocusSnapshot {
  return snap;
}
