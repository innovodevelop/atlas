import { useCallback, useRef, useState } from 'react';
import { isTauri } from '@/integrations/local/localClient';
import type { Update } from '@tauri-apps/plugin-updater';

// Verifying app updater (ship substrate). Thin state machine over
// @tauri-apps/plugin-updater: check() hits the release feed configured in
// tauri.conf.json, and downloadAndInstall() only installs artifacts whose
// minisign signature verifies against the pinned public key — the plugin
// rejects anything unsigned or tampered before a single byte is installed.
//
// Invariant: installation ONLY happens from an explicit user action (the
// panel's Install button calls install()). This hook never auto-installs.

export type UpdaterPhase =
  | 'idle' // nothing checked yet
  | 'checking' // check() in flight
  | 'upToDate' // checked, no newer version
  | 'available' // newer version found, waiting for the user
  | 'downloading' // downloadAndInstall() in flight
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

export function useAppUpdater() {
  // Updates only exist in the desktop app; the web preview has no bundle.
  const supported = isTauri();
  const [phase, setPhase] = useState<UpdaterPhase>('idle');
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [progress, setProgress] = useState<DownloadProgress>({ downloaded: 0, total: null });
  const [error, setError] = useState<string | null>(null);
  // The live plugin handle for the found update; kept out of React state on
  // purpose (it is a resource, not renderable data).
  const updateRef = useRef<Update | null>(null);

  const check = useCallback(async () => {
    if (!supported) return;
    setPhase('checking');
    setError(null);
    try {
      const { check: checkForUpdate } = await import('@tauri-apps/plugin-updater');
      const found = await checkForUpdate();
      if (found) {
        updateRef.current = found;
        setUpdate({
          version: found.version,
          currentVersion: found.currentVersion,
          notes: found.body ?? null,
          date: found.date ?? null,
        });
        setPhase('available');
      } else {
        updateRef.current = null;
        setUpdate(null);
        setPhase('upToDate');
      }
    } catch (e) {
      // Surface the real failure (offline, feed missing, malformed manifest)
      // instead of pretending we are up to date.
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, [supported]);

  const install = useCallback(async () => {
    const found = updateRef.current;
    if (!found) return;
    setPhase('downloading');
    setError(null);
    setProgress({ downloaded: 0, total: null });
    let downloaded = 0;
    let total: number | null = null;
    try {
      await found.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? null;
            setProgress({ downloaded: 0, total });
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            setProgress({ downloaded, total });
            break;
          case 'Finished':
            setProgress({ downloaded: total ?? downloaded, total });
            break;
        }
      });
      // The plugin verified the minisign signature before install; the new
      // bundle is staged and takes effect on next launch.
      setPhase('installed');
    } catch (e) {
      // Includes signature-verification failures — never swallow those.
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }, []);

  return { supported, phase, update, progress, error, check, install };
}

export default useAppUpdater;
