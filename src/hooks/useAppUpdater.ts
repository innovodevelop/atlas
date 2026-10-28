import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { isTauri } from '@/integrations/local/localClient';
import { isWindowActive } from '@/hooks/useWindowActivity';
import { autoUpdateStep, readUpdatePrefs } from '@/lib/updatePrefs';
import type { Update } from '@tauri-apps/plugin-updater';

// Verifying app updater (ship substrate). Thin state machine over
// @tauri-apps/plugin-updater: check() hits the release feed configured in
// tauri.conf.json, and the plugin only installs artifacts whose minisign
// signature verifies against the pinned public key — it rejects anything
// unsigned or tampered before a single byte is installed.
//
// ONE UPDATER PER WINDOW. The state lives at module level and every
// useAppUpdater() reads the same snapshot, so a download the background
// updater (useAutoUpdate, below) started shows its progress in Settings, and
// two screens can never race two downloads of the same update.
//
// Invariant: installation happens from an explicit user action (the Update
// section's buttons) — or overnight, ONLY when the user has switched on
// Settings → Software Update → "Install overnight", which is that approval
// given in advance (src/lib/updatePrefs.ts holds the rules: 2–5 AM, on mains
// power, nobody at the Mac). With that switch off this module never installs
// on its own.

export type UpdaterPhase =
  | 'idle' // nothing checked yet
  | 'checking' // check() in flight
  | 'upToDate' // checked, no newer version
  | 'available' // newer version found, waiting for the user
  | 'downloading' // download in flight
  | 'downloaded' // downloaded and verified, waiting to be installed
  | 'installing' // install() in flight
  | 'installed' // installed — restart Atlas to finish
  | 'error'; // check or install failed (offline, bad signature, …)

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
}

export interface DownloadProgress {
  downloaded: number;
  total: number | null;
}

interface UpdaterSnapshot {
  phase: UpdaterPhase;
  update: AvailableUpdate | null;
  progress: DownloadProgress;
  error: string | null;
  /** `Date.now()` of the last finished check. */
  lastCheckAt: number | null;
}

let snap: UpdaterSnapshot = { phase: 'idle', update: null, progress: { downloaded: 0, total: null }, error: null, lastCheckAt: null };
const subscribers = new Set<() => void>();
// The live plugin handle for the found update; kept out of the snapshot on
// purpose (it is a resource, not renderable data).
let handle: Update | null = null;

function set(patch: Partial<UpdaterSnapshot>) {
  snap = { ...snap, ...patch };
  for (const fn of subscribers) fn();
}
function subscribe(fn: () => void) { subscribers.add(fn); return () => { subscribers.delete(fn); }; }
const getSnapshot = () => snap;
const busy = () => snap.phase === 'checking' || snap.phase === 'downloading' || snap.phase === 'installing';
const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function checkNow(): Promise<void> {
  if (!isTauri() || busy()) return;
  set({ phase: 'checking', error: null });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const found = await check();
    if (found) {
      handle = found;
      set({
        phase: 'available',
        update: { version: found.version, currentVersion: found.currentVersion, notes: found.body ?? null, date: found.date ?? null },
        lastCheckAt: Date.now(),
      });
    } else {
      handle = null;
      set({ phase: 'upToDate', update: null, lastCheckAt: Date.now() });
    }
  } catch (e) {
    // Surface the real failure (offline, feed missing, malformed manifest)
    // instead of pretending we are up to date.
    set({ phase: 'error', error: describe(e), lastCheckAt: Date.now() });
  }
}

/** Download (the plugin verifies the signature as part of it). True when it finished. */
async function downloadNow(): Promise<boolean> {
  const found = handle;
  if (!found || busy()) return false;
  set({ phase: 'downloading', error: null, progress: { downloaded: 0, total: null } });
  let downloaded = 0;
  let total: number | null = null;
  try {
    await found.download((event) => {
      switch (event.event) {
        case 'Started':
          total = event.data.contentLength ?? null;
          set({ progress: { downloaded: 0, total } });
          break;
        case 'Progress':
          downloaded += event.data.chunkLength;
          set({ progress: { downloaded, total } });
          break;
        case 'Finished':
          set({ progress: { downloaded: total ?? downloaded, total } });
          break;
      }
    });
    set({ phase: 'downloaded' });
    return true;
  } catch (e) {
    // Includes signature-verification failures — never swallow those.
    set({ phase: 'error', error: describe(e) });
    return false;
  }
}

/** Install what was downloaded. The new version runs from the next start. */
async function installNow(): Promise<boolean> {
  const found = handle;
  if (!found || snap.phase !== 'downloaded') return false;
  set({ phase: 'installing', error: null });
  try {
    await found.install();
    set({ phase: 'installed' });
    return true;
  } catch (e) {
    set({ phase: 'error', error: describe(e) });
    return false;
  }
}

/** Quit and reopen Atlas (the Rust `app_restart`). */
async function restartNow(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('app_restart');
}

export function useAppUpdater() {
  // Updates only exist in the desktop app; the web preview has no bundle.
  const supported = isTauri();
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const check = useCallback(async () => { await checkNow(); }, []);
  const download = useCallback(async () => { await downloadNow(); }, []);

  // The one-button path ("Download and install"): download if needed, then
  // install. Explicit — only ever called from a button.
  const install = useCallback(async () => {
    if (snap.phase === 'available' && !(await downloadNow())) return;
    await installNow();
  }, []);

  const restart = useCallback(async () => {
    try {
      await restartNow();
    } catch (e) {
      set({ phase: 'error', error: `Atlas could not restart itself: ${describe(e)}. Quit and reopen it instead.` });
    }
  }, []);

  return {
    supported,
    phase: s.phase,
    update: s.update,
    progress: s.progress,
    error: s.error,
    lastCheckAt: s.lastCheckAt,
    check,
    download,
    install,
    restart,
  };
}

/** How often the background updater re-decides. Cheap: no network unless a step is due. */
const AUTO_TICK_MS = 15 * 60 * 1000;

/**
 * The background half of Settings → Software Update → "Automatic updates".
 * Mounted once, in the Beta shell. Every tick it asks autoUpdateStep what to
 * do — check the feed, download, install overnight, restart overnight — and
 * does at most that one thing. Does nothing at all while both switches are off.
 *
 * "Plugged in" is asked of Rust at the moment it matters (`system_vitals`);
 * "nobody at the Mac" is the window being hidden, unfocused or input-idle.
 */
export function useAutoUpdate(): void {
  const supported = isTauri();
  const running = useRef(false);

  useEffect(() => {
    if (!supported) return;
    let alive = true;
    const plugged = async (): Promise<boolean | null> => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const v = await invoke<{ battery: { on_power: boolean } | null }>('system_vitals');
        return v.battery ? v.battery.on_power : true; // no battery: always on mains
      } catch {
        return null;
      }
    };
    const tick = async () => {
      if (!alive || running.current) return;
      running.current = true;
      try {
        // Up to three steps per tick, each re-decided on fresh conditions, so
        // a check that finds an update can download it at once, and overnight
        // a download can go straight on to install and restart.
        for (let i = 0; i < 3 && alive; i++) {
          const prefs = readUpdatePrefs();
          if (!prefs.autoDownload && !prefs.installOvernight) return;
          const step = autoUpdateStep({
            prefs,
            phase: snap.phase,
            lastCheckAt: snap.lastCheckAt,
            now: new Date(),
            plugged: prefs.installOvernight ? await plugged() : null,
            idle: !isWindowActive(),
          });
          if (step === 'check') await checkNow();
          else if (step === 'download') { if (!(await downloadNow())) return; }
          else if (step === 'install') { if (!(await installNow())) return; }
          else if (step === 'restart') { await restartNow(); return; }
          else return;
          // A check is followed by a download only when one was found.
          if (step === 'check' && snap.phase !== 'available') return;
        }
      } catch {
        /* the step recorded its own error in the snapshot; try again next tick */
      } finally {
        running.current = false;
      }
    };
    // The first tick waits a minute: launch is busy enough without a feed check.
    const first = window.setTimeout(() => void tick(), 60_000);
    const id = window.setInterval(() => void tick(), AUTO_TICK_MS);
    return () => { alive = false; window.clearTimeout(first); window.clearInterval(id); };
  }, [supported]);
}

export default useAppUpdater;
