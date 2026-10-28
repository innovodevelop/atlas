/**
 * Settings → This Mac and the status panels' switches, over the Rust commands
 * in src-tauri/src/mac_controls.rs. Parsing lives in src/lib/macProbes.ts.
 *
 * Each hook reads when it mounts and then on a slow timer, and only while the
 * window is in use (`useWindowActivity`): these run macOS tools, and nobody
 * needs a fresh CPU meter on a screen they are not looking at. A tick never
 * starts a read while the last one is still out: `system_profiler` can hang
 * (Rust kills it at a limit, mac_controls.rs), and a timer that kept asking
 * would stack one stuck tool per tick. Outside the desktop app there is no
 * Mac to ask, so every hook reports `available: false` and does nothing; the
 * screens say so.
 *
 * The actions throw the tool's own message on failure, so the screen that
 * asked can put it next to the control that failed. A Wi-Fi password goes
 * from the join form to `wifi_join` as an argument and nowhere else: no state
 * here holds it, and nothing logs it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@/integrations/local/localClient';
import { useWindowActivity } from '@/hooks/useWindowActivity';
import {
  parseBattery, parseBluetooth, parseMac, parseWifi,
  type BatteryRaw, type BatteryState, type BluetoothRaw, type BluetoothState, type MacRaw, type MacState, type WifiRaw, type WifiState,
} from '@/lib/macProbes';

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Read `read()` now and every `everyMs` while the window is active. Returns
 * the latest value, the last read error, and a way to read again at once.
 *
 * One read at a time. A tick while a read is out is skipped; a `reload()`
 * then (after a switch, which must show its result) waits for it and reads
 * once more, shared by everyone who asked meanwhile.
 */
function useReading<T>(available: boolean, read: () => Promise<T>, everyMs: number) {
  const active = useWindowActivity();
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readRef = useRef(read);
  readRef.current = read;
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // The read that is out, and the one queued behind it.
  const inFlight = useRef<Promise<void> | null>(null);
  const queued = useRef<Promise<void> | null>(null);

  const readNow = useCallback(async () => {
    try {
      const v = await readRef.current();
      if (alive.current) { setValue(v); setError(null); }
    } catch (e) {
      if (alive.current) setError(message(e));
    }
  }, []);

  const reload = useCallback((): Promise<void> => {
    if (!available) return Promise.resolve();
    const out = inFlight.current;
    if (out) {
      queued.current ??= out.then(() => { queued.current = null; return reload(); });
      return queued.current;
    }
    const p = readNow().finally(() => { inFlight.current = null; });
    inFlight.current = p;
    return p;
  }, [available, readNow]);

  useEffect(() => {
    if (!available || !active) return;
    const tick = () => { if (!inFlight.current) void reload(); };
    tick();
    const id = window.setInterval(tick, everyMs);
    return () => window.clearInterval(id);
  }, [available, active, everyMs, reload]);

  return { value, error, reload };
}

/* ── Wi-Fi ───────────────────────────────────────────────────────────────── */

export interface WifiControls {
  available: boolean;
  wifi: WifiState | null;
  error: string | null;
  /** The slow `system_profiler` scan is running. */
  scanning: boolean;
  scan: () => Promise<void>;
  refresh: () => Promise<void>;
  setPower: (on: boolean) => Promise<void>;
  join: (ssid: string, password?: string) => Promise<void>;
  forget: (ssid: string) => Promise<void>;
}

/** `scan: true` runs one network scan when it mounts (Settings); the status panel only needs the switch. */
export function useWifiControls({ scan: scanOnMount = false }: { scan?: boolean } = {}): WifiControls {
  const available = isTauri();
  // The scan's output is kept apart from the quick reads, which carry none,
  // so a refresh every ten seconds does not empty the list of networks.
  const [profiler, setProfiler] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  // One scan at a time, for the same reason as useReading's one read.
  const scanOut = useRef(false);
  const quick = useReading<WifiRaw>(available, () => call<WifiRaw>('wifi_read', { scan: false }), 10_000);

  const scan = useCallback(async () => {
    if (!available || scanOut.current) return;
    scanOut.current = true;
    setScanning(true);
    try {
      const raw = await call<WifiRaw>('wifi_read', { scan: true });
      setProfiler(raw.profiler);
    } catch {
      /* the quick read reports errors; a failed scan leaves the last list */
    } finally {
      scanOut.current = false;
      setScanning(false);
    }
  }, [available]);

  useEffect(() => { if (scanOnMount) void scan(); }, [scanOnMount, scan]);

  const { reload } = quick;
  const after = useCallback(async (rescan: boolean) => {
    await reload();
    if (rescan && scanOnMount) void scan();
  }, [reload, scan, scanOnMount]);

  const setPower = useCallback(async (on: boolean) => {
    await call('wifi_set_power', { on });
    if (!on) setProfiler(null);
    await after(on);
  }, [after]);

  const join = useCallback(async (ssid: string, password?: string) => {
    await call('wifi_join', { ssid, password: password || null });
    await after(true);
  }, [after]);

  const forget = useCallback(async (ssid: string) => {
    await call('wifi_forget', { ssid });
    await after(false);
  }, [after]);

  const wifi = quick.value ? parseWifi({ ...quick.value, profiler }) : null;
  return { available, wifi, error: quick.error, scanning, scan, refresh: reload, setPower, join, forget };
}

/* ── Bluetooth ──────────────────────────────────────────────────────────── */

export interface BluetoothControls {
  available: boolean;
  bluetooth: BluetoothState | null;
  error: string | null;
  refresh: () => Promise<void>;
  setPower: (on: boolean) => Promise<void>;
  /** Connect or disconnect a paired device by its address. */
  setConnected: (address: string, connect: boolean) => Promise<void>;
}

/** `devices: false` for the status panel: blueutil's answer only, without the slow device list. */
export function useBluetoothControls({ devices = true }: { devices?: boolean } = {}): BluetoothControls {
  const available = isTauri();
  const reading = useReading<BluetoothRaw>(available, () => call<BluetoothRaw>('bluetooth_read', { devices }), 20_000);
  const { reload } = reading;

  const setPower = useCallback(async (on: boolean) => {
    await call('bluetooth_set_power', { on });
    await reload();
  }, [reload]);

  const setConnected = useCallback(async (address: string, connect: boolean) => {
    await call('bluetooth_device', { address, connect });
    await reload();
  }, [reload]);

  return { available, bluetooth: reading.value ? parseBluetooth(reading.value) : null, error: reading.error, refresh: reload, setPower, setConnected };
}

/* ── This Mac and the battery ───────────────────────────────────────────── */

export function useMacDetails(): { available: boolean; mac: MacState | null; error: string | null } {
  const available = isTauri();
  // Five seconds: the processor meter is the one reading here that moves.
  const reading = useReading<MacRaw>(available, () => call<MacRaw>('mac_read'), 5_000);
  return { available, mac: reading.value ? parseMac(reading.value) : null, error: reading.error };
}

export function useBatteryDetails(): { available: boolean; battery: BatteryState | null; error: string | null } {
  const available = isTauri();
  // A minute: the history gains a sample every ten, and health does not move.
  const reading = useReading<BatteryRaw>(available, () => call<BatteryRaw>('battery_read'), 60_000);
  return { available, battery: reading.value ? parseBattery(reading.value) : null, error: reading.error };
}

/* ── Restart Atlas ──────────────────────────────────────────────────────── */

/**
 * Quit and reopen Atlas (`app_restart`). The window closes moments after the
 * command returns, so a caller keeps showing "Restarting…"; a rejection means
 * the restart could not be asked for, and carries why.
 */
export async function restartAtlas(): Promise<void> {
  if (!isTauri()) throw new Error('Restarting needs the Atlas desktop app.');
  await call('app_restart');
}
