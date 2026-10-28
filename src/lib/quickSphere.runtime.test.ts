/* eslint-disable @typescript-eslint/no-explicit-any -- the runtime tests stand
   up minimal window / canvas / observer doubles on globalThis. */
/**
 * The shared sphere runtime against DOM doubles: when the one rAF runs, what
 * the pause switch, reduced motion, an inactive window and an off-screen
 * canvas do to it, and that the last sphere to go leaves nothing behind
 * (listeners, observers, frames).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { liveCount, mount, setSpheresWindowActive, type QuickSphereHandle } from './quickSphere';
import { SPHERE_PAUSED_KEY } from './spherePause';

let rafQueue: Map<number, FrameRequestCallback>;
let rafSeq = 0;
let now = 0;
let listeners: { type: string; fn: (e: any) => void }[];
let mqListeners: (() => void)[];
let reduce = false;
let store: Map<string, string>;
let timers: Map<number, () => void>;
let observers: { kind: 'io' | 'ro'; cb: (entries: any[]) => void; connected: boolean }[];
let puts = 0;
const handles: QuickSphereHandle[] = [];

/** Run every frame queued so far (not the ones those frames queue). */
function frame() {
  const due = [...rafQueue.entries()];
  rafQueue.clear();
  now += 16;
  for (const [, cb] of due) cb(now);
}
function runTimers() {
  const due = [...timers.values()];
  timers.clear();
  for (const fn of due) fn();
}
function fire(type: string, e: any = {}) {
  for (const l of listeners.filter((x) => x.type === type)) l.fn(e);
}

function canvas(box = 60): any {
  return {
    width: 0,
    height: 0,
    getBoundingClientRect: () => ({ width: box, height: box }),
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => { puts++; },
    }),
  };
}

function sphere(opts: Record<string, unknown> = {}) {
  const h = mount(canvas(), { count: 300, mode: 'veil', bg: '#f1eeea', ...opts });
  handles.push(h);
  return h;
}
function io(i = 0) { return observers.filter((o) => o.kind === 'io')[i]; }

beforeEach(() => {
  rafQueue = new Map(); rafSeq = 0; now = 0; puts = 0; reduce = false;
  listeners = []; mqListeners = []; store = new Map(); timers = new Map(); observers = [];
  (globalThis as any).window = {
    devicePixelRatio: 1,
    matchMedia: () => ({
      get matches() { return reduce; },
      addEventListener: (_: string, fn: () => void) => { mqListeners.push(fn); },
      removeEventListener: (_: string, fn: () => void) => { mqListeners = mqListeners.filter((f) => f !== fn); },
    }),
    addEventListener: (type: string, fn: (e: any) => void) => { listeners.push({ type, fn }); },
    removeEventListener: (type: string, fn: (e: any) => void) => { listeners = listeners.filter((l) => !(l.type === type && l.fn === fn)); },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } },
    setTimeout: (fn: () => void) => { const id = ++rafSeq; timers.set(id, fn); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
  };
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => { const id = ++rafSeq; rafQueue.set(id, cb); return id; };
  (globalThis as any).cancelAnimationFrame = (id: number) => { rafQueue.delete(id); };
  for (const kind of ['io', 'ro'] as const) {
    (globalThis as any)[kind === 'io' ? 'IntersectionObserver' : 'ResizeObserver'] = class {
      rec: { kind: 'io' | 'ro'; cb: (entries: any[]) => void; connected: boolean };
      constructor(cb: (entries: any[]) => void) { this.rec = { kind, cb, connected: true }; observers.push(this.rec); }
      observe() {}
      disconnect() { this.rec.connected = false; }
    };
  }
});

afterEach(() => {
  while (handles.length) handles.pop()!.destroy();
  setSpheresWindowActive(true);
  for (const k of ['window', 'requestAnimationFrame', 'cancelAnimationFrame', 'IntersectionObserver', 'ResizeObserver']) delete (globalThis as any)[k];
});

describe('the shared sphere runtime', () => {
  test('a visible sphere in an active window animates on the one rAF', () => {
    sphere();
    sphere();
    expect(liveCount()).toBe(2);
    expect(rafQueue.size).toBe(1); // one loop, not one per sphere
    frame();
    expect(puts).toBe(2);
    expect(rafQueue.size).toBe(1);
  });

  test('the Settings switch (storage event) stops every sphere on one still frame', () => {
    sphere();
    sphere();
    frame();
    puts = 0;
    store.set(SPHERE_PAUSED_KEY, '1');
    fire('storage', { key: SPHERE_PAUSED_KEY });
    expect(liveCount()).toBe(0);
    frame(); // the loop's last call (it does not re-arm) and the still frames
    expect(puts).toBe(2);
    frame();
    frame();
    expect(puts).toBe(2);
    expect(rafQueue.size).toBe(0);

    // Resuming ("0", as Settings writes it) brings the loop back.
    store.set(SPHERE_PAUSED_KEY, '0');
    fire('storage', { key: SPHERE_PAUSED_KEY });
    expect(liveCount()).toBe(2);
    expect(rafQueue.size).toBe(1);
  });

  test('a sphere mounted while paused draws one still frame and no loop', () => {
    store.set(SPHERE_PAUSED_KEY, '1');
    sphere();
    expect(liveCount()).toBe(0);
    frame();
    expect(puts).toBe(1);
    expect(rafQueue.size).toBe(0);
  });

  test('a state change while paused repaints once, settled, for the new state', () => {
    store.set(SPHERE_PAUSED_KEY, '1');
    const h = sphere();
    frame();
    h.set({ state: 'thinking' });
    h.set({ state: 'thinking' }); // no change: no work
    frame();
    expect(puts).toBe(2);
    expect(rafQueue.size).toBe(0);
  });

  test('a same-window write without an event is picked up after the next click', () => {
    sphere();
    store.set(SPHERE_PAUSED_KEY, '1');
    fire('click');
    expect(liveCount()).toBe(1); // the click handler writes first; the read is deferred
    runTimers();
    expect(liveCount()).toBe(0);
  });

  test('an unrelated storage key does nothing', () => {
    sphere();
    store.set(SPHERE_PAUSED_KEY, '1');
    fire('storage', { key: 'atlas:something_else' });
    expect(liveCount()).toBe(1);
  });

  test('reduced motion holds still and lets go when the setting changes', () => {
    sphere();
    reduce = true;
    for (const fn of mqListeners) fn();
    expect(liveCount()).toBe(0);
    reduce = false;
    for (const fn of mqListeners) fn();
    expect(liveCount()).toBe(1);
  });

  test('an inactive window sleeps; a state change still shows, once', () => {
    const h = sphere();
    frame();
    puts = 0;
    setSpheresWindowActive(false);
    expect(liveCount()).toBe(0);
    frame(); // the loop sees nothing to animate and stops
    expect(puts).toBe(0);
    expect(rafQueue.size).toBe(0);
    h.set({ state: 'alert' });
    frame();
    expect(puts).toBe(1);
    expect(rafQueue.size).toBe(0);
    setSpheresWindowActive(true);
    expect(liveCount()).toBe(1);
  });

  test('off-screen sleeps and draws nothing, even for a state change', () => {
    const h = sphere();
    frame();
    puts = 0;
    io().cb([{ isIntersecting: false }]);
    expect(liveCount()).toBe(0);
    h.set({ state: 'speaking' });
    frame();
    frame();
    expect(puts).toBe(0);
    // Back on screen: animating again.
    io().cb([{ isIntersecting: true }]);
    expect(liveCount()).toBe(1);
  });

  test('`fit` sizes the particles to the canvas box', () => {
    const boxes: number[] = [];
    sphere({ fit: (box: number) => { boxes.push(box); return 200; } });
    expect(boxes).toContain(60);
  });

  test('the last sphere to go removes every listener, observer and frame', () => {
    const a = sphere();
    const b = sphere();
    expect(listeners.length).toBeGreaterThan(0);
    expect(mqListeners).toHaveLength(1);
    a.destroy();
    expect(listeners.length).toBeGreaterThan(0); // b still needs them
    b.destroy();
    handles.length = 0;
    expect(listeners).toHaveLength(0);
    expect(mqListeners).toHaveLength(0);
    expect(observers.every((o) => !o.connected)).toBe(true);
    expect(rafQueue.size).toBe(0);
    expect(timers.size).toBe(0);
  });

  test('a still frame owed at destroy is cancelled', () => {
    store.set(SPHERE_PAUSED_KEY, '1');
    const h = sphere();
    expect(rafQueue.size).toBe(1);
    h.destroy();
    handles.length = 0;
    expect(rafQueue.size).toBe(0);
    expect(puts).toBe(0);
  });
});
