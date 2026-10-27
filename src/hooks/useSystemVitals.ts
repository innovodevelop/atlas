/**
 * Battery, Wi-Fi and Bluetooth for the Beta top bar, from the Rust
 * `system_vitals` command (src-tauri/src/system_vitals.rs).
 *
 * Polls every 30 s while the window is active. Outside the desktop app (the
 * browser preview) it returns the fixture, marked `fixture: true`, so the bar
 * can be laid out without a Mac behind it and never pretends the numbers are
 * real. Types and the pure helpers live in src/lib/systemVitals.ts.
 */
import { useEffect, useState } from 'react';
import { isTauri } from '@/integrations/local/localClient';
import { isWindowActive } from '@/hooks/useWindowActivity';
import { FIXTURE_VITALS, type SystemVitals } from '@/lib/systemVitals';

export { deviceKinds, batteryTone, FIXTURE_VITALS } from '@/lib/systemVitals';
export type { Battery, Wifi, BtDevice, Bluetooth, SystemVitals } from '@/lib/systemVitals';

export interface SystemVitalsState extends SystemVitals {
  /** True outside the desktop app: the numbers are the fixture, not the Mac. */
  fixture: boolean;
  /** `Date.now()` of the last successful read. */
  at: number | null;
}

const POLL_MS = 30_000;

export function useSystemVitals(): SystemVitalsState {
  const native = isTauri();
  const [state, setState] = useState<SystemVitalsState>(() =>
    native
      ? { battery: null, wifi: null, bluetooth: null, bluetooth_at: null, fixture: false, at: null }
      : { ...FIXTURE_VITALS, fixture: true, at: Date.now() },
  );

  useEffect(() => {
    if (!native) return;
    let alive = true;
    const read = async () => {
      if (!isWindowActive()) return;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const v = await invoke<SystemVitals>('system_vitals');
        if (alive) setState({ ...v, fixture: false, at: Date.now() });
      } catch {
        /* keep the last reading; the bar shows what it had */
      }
    };
    void read();
    // Bluetooth is cached 30 s in Rust and the first answer has none, so one
    // quick follow-up fills it in without waiting a whole poll.
    const soon = window.setTimeout(read, 2500);
    const id = window.setInterval(read, POLL_MS);
    return () => { alive = false; window.clearTimeout(soon); window.clearInterval(id); };
  }, [native]);

  return state;
}
