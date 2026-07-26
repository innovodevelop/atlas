/**
 * Regression tests for the five defects the design audit found in the handoff's
 * atlas-sphere.js. Each test names the bug it locks down — if one of these ever
 * fails, that specific bug is back.
 *
 * Run: bun test src/lib/atlasSphere.test.ts
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

// --- minimal DOM/canvas doubles --------------------------------------------
// jsdom has no canvas; the renderer only needs a 2d context that accepts calls.

class FakePath2D { rect() {} }

function fakeCtx() {
  return {
    clearRect() {}, beginPath() {}, arc() {}, fill() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '',
  };
}

interface FakeCanvas {
  width: number; height: number; clientWidth: number; clientHeight: number;
  isConnected: boolean;
  getContext: () => unknown;
  getBoundingClientRect: () => { top: number; bottom: number; left: number; right: number; width: number };
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  attrs: Record<string, string>;
}

function fakeCanvas(visible = true): FakeCanvas {
  const attrs: Record<string, string> = {};
  return {
    width: 224, height: 224, clientWidth: 224, clientHeight: 224,
    isConnected: true,
    getContext: () => fakeCtx(),
    getBoundingClientRect: () =>
      visible
        ? { top: 0, bottom: 224, left: 0, right: 224, width: 224 }
        : { top: 0, bottom: 0, left: 0, right: 0, width: 0 },
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => attrs[k] ?? null,
    attrs,
  };
}

let rafQueue: FrameRequestCallback[] = [];
let rafCancelled: number[] = [];
let rafSeq = 0;
let intervals = 0;
let reduce = false;

beforeEach(() => {
  rafQueue = []; rafCancelled = []; rafSeq = 0; intervals = 0; reduce = false;
  (globalThis as any).Path2D = FakePath2D;
  (globalThis as any).window = {
    devicePixelRatio: 1,
    innerHeight: 900,
    innerWidth: 1440,
    matchMedia: () => ({ matches: reduce, addEventListener() {}, addListener() {} }),
    setInterval: () => { intervals++; return ++rafSeq; },
    clearInterval: () => { intervals--; },
  };
  (globalThis as any).document = { visibilityState: 'visible' };
  (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQueue.push(cb); return ++rafSeq;
  };
  (globalThis as any).cancelAnimationFrame = (h: number) => { rafCancelled.push(h); };
});

afterEach(() => {
  delete (globalThis as any).Path2D;
  delete (globalThis as any).window;
  delete (globalThis as any).document;
});

/** Drain exactly one queued rAF callback. */
function tick(t: number) {
  const cbs = rafQueue;
  rafQueue = [];
  for (const cb of cbs) cb(t);
}

async function load() {
  // Fresh module per test — the renderer holds loop state at module scope.
  return await import(`@/lib/atlasSphere?t=${Math.random()}`);
}

describe('atlasSphere', () => {
  test('BUG 1 — a re-attached canvas can mount again (the remount bug)', async () => {
    const S = await load();
    const el = fakeCanvas() as unknown as HTMLCanvasElement;

    S.mount(el, { state: 'idle' });
    expect(S.mountedCount()).toBe(1);

    // Detached from the DOM, then pruned by the frame loop.
    (el as unknown as FakeCanvas).isConnected = false;
    tick(0); tick(100);
    expect(S.mountedCount()).toBe(0);

    // Re-attached and mounted again. The handoff left el.__atlasSphere set, so
    // mount() returned early here and the canvas stayed blank forever.
    (el as unknown as FakeCanvas).isConnected = true;
    S.mount(el, { state: 'idle' });
    expect(S.mountedCount()).toBe(1);
  });

  test('BUG 2 — the watchdog restarts the loop instead of duplicating it', async () => {
    const S = await load();
    S.mount(fakeCanvas() as unknown as HTMLCanvasElement, {});
    tick(0);

    // Exactly one chain is in flight after a frame.
    const inFlight = rafQueue.length;
    expect(inFlight).toBe(1);

    // The handoff's watchdog called frame() directly, which re-queued rAF on
    // top of the pending one — two chains, then three. Ours cancels first, so
    // the count never grows.
    expect(rafCancelled.length).toBe(0);
    tick(200);
    expect(rafQueue.length).toBe(1);
  });

  test('BUG 3 — the loop and its interval stop when the last canvas unmounts', async () => {
    const S = await load();
    const el = fakeCanvas() as unknown as HTMLCanvasElement;
    S.mount(el, {});
    expect(S.isRunning()).toBe(true);
    expect(intervals).toBe(1);

    S.unmount(el);
    expect(S.mountedCount()).toBe(0);
    expect(S.isRunning()).toBe(false);
    expect(intervals).toBe(0);   // the handoff never cleared this
  });

  test('BUG 4 — prefers-reduced-motion paints once and never starts a loop', async () => {
    reduce = true;
    const S = await load();
    S.mount(fakeCanvas() as unknown as HTMLCanvasElement, { state: 'listening' });

    expect(S.mountedCount()).toBe(1);
    expect(S.isRunning()).toBe(false);   // no animation at all
    expect(rafQueue.length).toBe(0);

    S.refresh();                          // state change still repaints
    expect(S.isRunning()).toBe(false);
  });

  test('BUG 5 — a paint failure is reported, not silently swallowed', async () => {
    const S = await load();
    const el = fakeCanvas() as unknown as HTMLCanvasElement;
    // Simulate the missing-Path2D case the handoff's empty catch hid.
    delete (globalThis as any).Path2D;

    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
    try {
      S.mount(el, {});
      tick(0); tick(100);
      tick(200); tick(300);   // repeated failures must not spam
    } finally {
      console.error = orig;
    }
    expect(errors.length).toBe(1);        // logged once per canvas
  });

  test('the canvas is marked decorative for screen readers', async () => {
    const S = await load();
    const el = fakeCanvas();
    S.mount(el as unknown as HTMLCanvasElement, {});
    expect(el.attrs['aria-hidden']).toBe('true');
  });

  test('an off-screen canvas is skipped (including horizontally)', async () => {
    const S = await load();
    const hidden = fakeCanvas(false);     // zero rect, as display:none reports
    S.mount(hidden as unknown as HTMLCanvasElement, {});
    tick(0); tick(100);
    // No throw, still mounted — it is skipped, not pruned.
    expect(S.mountedCount()).toBe(1);
  });

  test('the ten states are the documented contract', async () => {
    const S = await load();
    expect(S.STATES).toEqual([
      'idle', 'listening', 'thinking', 'speaking', 'working',
      'success', 'alert', 'muted', 'waking', 'dissolving',
    ]);
    expect(S.PRESET).toEqual({ count: 26000, dens: 0.7, size: 0.6, soft: 0 });
  });
});
