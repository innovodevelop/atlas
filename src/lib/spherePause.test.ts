/* eslint-disable @typescript-eslint/no-explicit-any -- the storage tests stand
   up a minimal `window` double on globalThis. */
import { afterEach, describe, expect, test } from 'bun:test';
import { SPHERE_PAUSED_KEY, parseSpherePaused, readSpherePaused, setSpheresPaused, sphereRun, type SpherePauseInputs } from './spherePause';

const base: SpherePauseInputs = { userPaused: false, reducedMotion: false, windowActive: true };

describe('sphereRun — the pause decision', () => {
  test('on screen, in an active window, nothing asked: animate', () => {
    expect(sphereRun(base, true)).toBe('animate');
  });

  test('off-screen always sleeps, whatever else holds', () => {
    for (const userPaused of [false, true])
      for (const reducedMotion of [false, true])
        for (const windowActive of [false, true])
          expect(sphereRun({ userPaused, reducedMotion, windowActive }, false)).toBe('sleep');
  });

  test('the Settings switch holds every sphere still, active window or not', () => {
    expect(sphereRun({ ...base, userPaused: true }, true)).toBe('still');
    expect(sphereRun({ ...base, userPaused: true, windowActive: false }, true)).toBe('still');
  });

  test('reduced motion holds still the same way', () => {
    expect(sphereRun({ ...base, reducedMotion: true }, true)).toBe('still');
    expect(sphereRun({ ...base, reducedMotion: true, windowActive: false }, true)).toBe('still');
  });

  test('an inactive window sleeps', () => {
    expect(sphereRun({ ...base, windowActive: false }, true)).toBe('sleep');
  });
});

describe('the stored switch', () => {
  test('only exactly "1" means paused', () => {
    expect(parseSpherePaused('1')).toBe(true);
    for (const v of ['0', '', 'true', ' 1', '01', null, undefined]) expect(parseSpherePaused(v)).toBe(false);
  });

  test('the key is the contract with Settings', () => {
    expect(SPHERE_PAUSED_KEY).toBe('atlas:sphere_paused');
  });
});

describe('reading and writing the switch', () => {
  afterEach(() => { delete (globalThis as any).window; delete (globalThis as any).StorageEvent; });

  function fakeWindow(opts: { throws?: boolean } = {}) {
    const store = new Map<string, string>();
    const events: { key: string | null; newValue: string | null }[] = [];
    // Bun has no StorageEvent; WebKit does.
    (globalThis as any).StorageEvent = class extends Event {
      key: string | null; newValue: string | null;
      constructor(type: string, init: { key?: string; newValue?: string } = {}) {
        super(type); this.key = init.key ?? null; this.newValue = init.newValue ?? null;
      }
    };
    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => { if (opts.throws) throw new Error('blocked'); return store.get(k) ?? null; },
        setItem: (k: string, v: string) => { if (opts.throws) throw new Error('blocked'); store.set(k, v); },
      },
      dispatchEvent: (e: StorageEvent) => { events.push({ key: e.key, newValue: e.newValue }); return true; },
    };
    return { store, events };
  }

  test('without a window it reads as not paused', () => {
    expect(readSpherePaused()).toBe(false);
  });

  test('blocked storage reads as not paused, and writing it does not throw', () => {
    const { events } = fakeWindow({ throws: true });
    expect(readSpherePaused()).toBe(false);
    expect(() => setSpheresPaused(true)).not.toThrow();
    // The event still goes out, so this window's spheres follow the switch.
    expect(events).toEqual([{ key: SPHERE_PAUSED_KEY, newValue: '1' }]);
  });

  test('setSpheresPaused writes "1"/"0" and tells this window with a storage event', () => {
    const { store, events } = fakeWindow();
    setSpheresPaused(true);
    expect(store.get(SPHERE_PAUSED_KEY)).toBe('1');
    expect(readSpherePaused()).toBe(true);
    setSpheresPaused(false);
    expect(store.get(SPHERE_PAUSED_KEY)).toBe('0');
    expect(readSpherePaused()).toBe(false);
    expect(events).toEqual([
      { key: SPHERE_PAUSED_KEY, newValue: '1' },
      { key: SPHERE_PAUSED_KEY, newValue: '0' },
    ]);
  });
});
