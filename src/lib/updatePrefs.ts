/**
 * Settings → Software Update → "Automatic updates": the two switches, and the
 * pure decision of what the background updater (useAutoUpdate in
 * src/hooks/useAppUpdater.ts) does next.
 *
 * Both switches start OFF. Until this screen existed, installing happened
 * only when the user pressed Install, and the hook's invariant said so; an
 * upgrade must not quietly change that. Turning "Install overnight" on is the
 * user's approval for installs that happen while they are away — and only
 * then, between 2 and 5 AM, on mains power, with nobody using the Mac.
 *
 * Every install is still the updater plugin's, which verifies the minisign
 * signature against the pinned key before a byte is written; nothing here
 * changes what may be installed, only when.
 */

export const UPDATE_PREFS_KEY = 'atlas:update_prefs';
/** Sent on `window` after a write in this document. */
export const UPDATE_PREFS_EVENT = 'atlas:update-prefs';

export interface UpdatePrefs {
  /** Download a new version in the background as soon as one is found. */
  autoDownload: boolean;
  /** Install (and restart into) a downloaded version overnight. */
  installOvernight: boolean;
}

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = { autoDownload: false, installOvernight: false };

/** How often the background updater asks the release feed (one small HTTPS request). */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** The overnight window, local time: from 2 AM up to 5 AM. */
export const OVERNIGHT_FROM_HOUR = 2;
export const OVERNIGHT_TO_HOUR = 5;

export function parseUpdatePrefs(raw: string | null | undefined): UpdatePrefs {
  let v: Record<string, unknown> = {};
  try { v = raw ? (JSON.parse(raw) as Record<string, unknown>) ?? {} : {}; } catch { v = {}; }
  return {
    autoDownload: typeof v.autoDownload === 'boolean' ? v.autoDownload : DEFAULT_UPDATE_PREFS.autoDownload,
    installOvernight: typeof v.installOvernight === 'boolean' ? v.installOvernight : DEFAULT_UPDATE_PREFS.installOvernight,
  };
}

export function readUpdatePrefs(): UpdatePrefs {
  try {
    return parseUpdatePrefs(typeof window === 'undefined' ? null : window.localStorage.getItem(UPDATE_PREFS_KEY));
  } catch {
    return { ...DEFAULT_UPDATE_PREFS };
  }
}

export function setUpdatePrefs(patch: Partial<UpdatePrefs>): UpdatePrefs {
  const next = { ...readUpdatePrefs(), ...patch };
  if (typeof window === 'undefined') return next;
  try { window.localStorage.setItem(UPDATE_PREFS_KEY, JSON.stringify(next)); } catch { /* private window: this session only */ }
  try { window.dispatchEvent(new CustomEvent(UPDATE_PREFS_EVENT, { detail: next })); } catch { /* the next read sees it */ }
  return next;
}

export function onUpdatePrefsChange(fn: (prefs: UpdatePrefs) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const here = () => fn(readUpdatePrefs());
  const there = (e: StorageEvent) => { if (e.key === null || e.key === UPDATE_PREFS_KEY) fn(readUpdatePrefs()); };
  window.addEventListener(UPDATE_PREFS_EVENT, here);
  window.addEventListener('storage', there);
  return () => { window.removeEventListener(UPDATE_PREFS_EVENT, here); window.removeEventListener('storage', there); };
}

export function inOvernightWindow(now: Date): boolean {
  const h = now.getHours();
  return h >= OVERNIGHT_FROM_HOUR && h < OVERNIGHT_TO_HOUR;
}

/** Mirrors `UpdaterPhase` in src/hooks/useAppUpdater.ts (not imported: src/lib stays hook-free). */
export type AutoPhase =
  | 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'installed' | 'error';

export interface AutoInput {
  prefs: UpdatePrefs;
  phase: AutoPhase;
  /** `Date.now()` of the last finished check, or null. */
  lastCheckAt: number | null;
  now: Date;
  /** On mains power (or a Mac with no battery). Null when unknown, which never counts as plugged in. */
  plugged: boolean | null;
  /** Nobody is using Atlas: the window is hidden, unfocused or input-idle. */
  idle: boolean;
}

export type AutoStep = 'check' | 'download' | 'install' | 'restart' | null;

/**
 * The background updater's next step, or null to wait. One step per tick, so
 * every step is re-decided against fresh conditions (an unplugged charger
 * between download and install stops the install).
 */
export function autoUpdateStep(i: AutoInput): AutoStep {
  const { prefs, phase } = i;
  if (!prefs.autoDownload && !prefs.installOvernight) return null;
  const overnight = prefs.installOvernight && inOvernightWindow(i.now) && i.plugged === true && i.idle;
  switch (phase) {
    case 'checking':
    case 'downloading':
    case 'installing':
      return null;
    case 'available':
      return prefs.autoDownload || overnight ? 'download' : null;
    case 'downloaded':
      return overnight ? 'install' : null;
    case 'installed':
      return overnight ? 'restart' : null;
    case 'idle':
    case 'upToDate':
    case 'error':
    default: {
      const due = i.lastCheckAt == null || i.now.getTime() - i.lastCheckAt >= CHECK_EVERY_MS;
      return due ? 'check' : null;
    }
  }
}
