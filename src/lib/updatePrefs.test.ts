/* eslint-disable @typescript-eslint/no-explicit-any -- the storage test stands
   up a minimal `window` double on globalThis. */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  CHECK_EVERY_MS, DEFAULT_UPDATE_PREFS, UPDATE_PREFS_KEY, autoUpdateStep, inOvernightWindow, onUpdatePrefsChange, parseUpdatePrefs, readUpdatePrefs,
  setUpdatePrefs, type AutoInput,
} from './updatePrefs';

describe('the stored switches', () => {
  test('both start off, and malformed values fall back to off', () => {
    expect(DEFAULT_UPDATE_PREFS).toEqual({ autoDownload: false, installOvernight: false });
    expect(parseUpdatePrefs(null)).toEqual(DEFAULT_UPDATE_PREFS);
    expect(parseUpdatePrefs('{"autoDownload":true}')).toEqual({ autoDownload: true, installOvernight: false });
    expect(parseUpdatePrefs('{"installOvernight":"yes"}')).toEqual(DEFAULT_UPDATE_PREFS);
    expect(parseUpdatePrefs('{')).toEqual(DEFAULT_UPDATE_PREFS);
  });

  afterEach(() => { delete (globalThis as any).window; delete (globalThis as any).CustomEvent; });

  test('a write persists and reaches this window', () => {
    const store = new Map<string, string>();
    const fns = new Map<string, Set<(e: any) => void>>();
    (globalThis as any).CustomEvent = class extends Event { constructor(t: string) { super(t); } };
    (globalThis as any).window = {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
      addEventListener: (t: string, f: (e: any) => void) => { if (!fns.has(t)) fns.set(t, new Set()); fns.get(t)!.add(f); },
      removeEventListener: (t: string, f: (e: any) => void) => { fns.get(t)?.delete(f); },
      dispatchEvent: (e: Event) => { fns.get(e.type)?.forEach((f) => f(e)); return true; },
    };
    const seen: boolean[] = [];
    const off = onUpdatePrefsChange((p) => seen.push(p.installOvernight));
    setUpdatePrefs({ installOvernight: true });
    expect(JSON.parse(store.get(UPDATE_PREFS_KEY)!)).toEqual({ autoDownload: false, installOvernight: true });
    expect(readUpdatePrefs().installOvernight).toBe(true);
    expect(seen).toEqual([true]);
    off();
  });
});

describe('the background updater', () => {
  const night = new Date(2026, 9, 28, 3, 15);
  const day = new Date(2026, 9, 28, 14, 0);
  const base: AutoInput = {
    prefs: { autoDownload: true, installOvernight: true },
    phase: 'available',
    lastCheckAt: day.getTime(),
    now: day,
    plugged: true,
    idle: true,
  };

  test('the overnight window is 2 to 5 AM, local time', () => {
    expect(inOvernightWindow(new Date(2026, 9, 28, 1, 59))).toBe(false);
    expect(inOvernightWindow(new Date(2026, 9, 28, 2, 0))).toBe(true);
    expect(inOvernightWindow(new Date(2026, 9, 28, 4, 59))).toBe(true);
    expect(inOvernightWindow(new Date(2026, 9, 28, 5, 0))).toBe(false);
  });

  test('both switches off: nothing, ever', () => {
    for (const phase of ['idle', 'available', 'downloaded', 'installed'] as const) {
      expect(autoUpdateStep({ ...base, prefs: { autoDownload: false, installOvernight: false }, phase, now: night, lastCheckAt: null })).toBeNull();
    }
  });

  test('checks the feed when one is due, and only then', () => {
    expect(autoUpdateStep({ ...base, phase: 'idle', lastCheckAt: null })).toBe('check');
    expect(autoUpdateStep({ ...base, phase: 'upToDate', lastCheckAt: day.getTime() - 60_000 })).toBeNull();
    expect(autoUpdateStep({ ...base, phase: 'upToDate', lastCheckAt: day.getTime() - CHECK_EVERY_MS })).toBe('check');
    expect(autoUpdateStep({ ...base, phase: 'checking', lastCheckAt: null })).toBeNull();
  });

  test('downloads by day with automatic downloads on; otherwise only overnight', () => {
    expect(autoUpdateStep(base)).toBe('download');
    const overnightOnly = { ...base, prefs: { autoDownload: false, installOvernight: true } };
    expect(autoUpdateStep(overnightOnly)).toBeNull();
    expect(autoUpdateStep({ ...overnightOnly, now: night })).toBe('download');
  });

  test('installs and restarts only overnight, plugged in, with nobody at the Mac', () => {
    expect(autoUpdateStep({ ...base, phase: 'downloaded' })).toBeNull();
    expect(autoUpdateStep({ ...base, phase: 'downloaded', now: night })).toBe('install');
    expect(autoUpdateStep({ ...base, phase: 'downloaded', now: night, plugged: false })).toBeNull();
    expect(autoUpdateStep({ ...base, phase: 'downloaded', now: night, plugged: null })).toBeNull();
    expect(autoUpdateStep({ ...base, phase: 'downloaded', now: night, idle: false })).toBeNull();
    expect(autoUpdateStep({ ...base, phase: 'installed', now: night })).toBe('restart');
    expect(autoUpdateStep({ ...base, phase: 'installed' })).toBeNull();
    // Automatic downloads alone never install.
    expect(autoUpdateStep({ ...base, prefs: { autoDownload: true, installOvernight: false }, phase: 'downloaded', now: night })).toBeNull();
  });
});
