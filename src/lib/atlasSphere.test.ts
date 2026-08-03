/* eslint-disable @typescript-eslint/no-explicit-any -- test code deliberately builds
   partial fixtures and reaches into internals to assert on them. Precise types
   here would mean mirroring production shapes in the tests, which adds churn
   without adding safety: the assertions, not the annotations, are the contract. */
/**
 * Regression tests for the renderer.
 *
 * The first block locks the five defects the 2026-07-26 design audit found in
 * the handoff's atlas-sphere.js — each test names the bug, so if one fails that
 * specific bug is back. The v3 bundle re-introduces all five, so these are also
 * the merge's guard rail.
 *
 * The second block locks the v3 merge itself: the morph endpoints, the alpha
 * formula the README misstates, the radius clamp, LRU eviction, the cache key's
 * independence from adaptive quality, non-square canvases, and the
 * reduced-motion rule.
 *
 * Run: bun test src/lib/atlasSphere.test.ts
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

// --- minimal DOM/canvas doubles --------------------------------------------
// jsdom has no canvas; the renderer only needs a 2d context that accepts calls.

/** One recorded particle, in canvas coordinates. `r` is the dot radius. */
interface Op { kind: 'rect' | 'arc'; x: number; y: number; r: number }
let ops: Op[] = [];
let clearRects = 0;

/** Records what the renderer actually draws — the only way to assert geometry. */
class FakePath2D {
  rect(x: number, y: number, w: number, h: number) {
    ops.push({ kind: 'rect', x: x + w / 2, y: y + h / 2, r: w / 2 });
  }
  // v3 draws round dots, so both of these are now on the hot path. Without them
  // every frame would throw into safePaint and the whole suite would keep
  // passing while painting nothing.
  moveTo(_x: number, _y: number) {}
  arc(x: number, y: number, r: number) {
    ops.push({ kind: 'arc', x, y, r });
  }
}

function fakeCtx() {
  return {
    clearRect() { clearRects++; },
    beginPath() {}, arc() {}, fill() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    fillStyle: '',
  };
}

interface FakeCanvas {
  width: number; height: number; clientWidth: number; clientHeight: number;
  isConnected: boolean;
  getContext: () => unknown;
  getBoundingClientRect: () => { top: number; bottom: number; left: number; right: number; width: number; height: number };
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  attrs: Record<string, string>;
}

function fakeCanvas(opt: boolean | { w?: number; h?: number; visible?: boolean } = true): FakeCanvas {
  const cfg = typeof opt === 'boolean' ? { visible: opt } : opt;
  const w = cfg.w ?? 224, h = cfg.h ?? 224;
  const on = cfg.visible ?? true;
  const attrs: Record<string, string> = {};
  return {
    width: w, height: h, clientWidth: w, clientHeight: h,
    isConnected: true,
    getContext: () => fakeCtx(),
    getBoundingClientRect: () =>
      on
        ? { top: 0, bottom: h, left: 0, right: w, width: w, height: h }
        : { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => attrs[k] ?? null,
    attrs,
  };
}

let rafQueue: FrameRequestCallback[] = [];
let rafCancelled: number[] = [];
let rafSeq = 0;
let intervals = 0;
let intervalCb: (() => void) | null = null;
let reduce = false;
let clock = 0;

beforeEach(() => {
  rafQueue = []; rafCancelled = []; rafSeq = 0; intervals = 0; reduce = false;
  intervalCb = null; ops = []; clearRects = 0; clock = 0;
  (globalThis as any).Path2D = FakePath2D;
  (globalThis as any).window = {
    devicePixelRatio: 1,
    innerHeight: 900,
    innerWidth: 1440,
    matchMedia: () => ({ matches: reduce, addEventListener() {}, addListener() {} }),
    setInterval: (cb: () => void) => { intervals++; intervalCb = cb; return ++rafSeq; },
    clearInterval: () => { intervals--; intervalCb = null; },
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

/**
 * Drain one frame at a timestamp far enough ahead to clear the 26 ms cap, so a
 * paint definitely happens. `tick(0)` on a fresh module never paints.
 */
function paintTick() {
  clock += 100;
  tick(clock);
}

async function load() {
  // Fresh module per test — the renderer holds loop state at module scope.
  return await import(`@/lib/atlasSphere?t=${Math.random()}`);
}

const xs = () => ops.map((o) => o.x);
const ys = () => ops.map((o) => o.y);
const maxAbs = (v: number[], centre: number) => Math.max(...v.map((n) => Math.abs(n - centre)));

describe('atlasSphere — the five audited defects', () => {
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

  test('a canvas under an opaque full-screen overlay stops painting', async () => {
    // `visible()` is a viewport test with no occlusion sense, so the dashboard
    // header orb — 26 000 particles, on-screen by geometry — kept painting
    // under the music player's opaque fixed sheet for as long as it was open.
    const S = await load();
    const under = fakeCanvas() as unknown as HTMLCanvasElement;
    const over = fakeCanvas() as unknown as HTMLCanvasElement;
    S.mount(under, { state: 'idle' });
    S.mount(over, { state: 'listening' });

    paintTick();
    const both = clearRects;
    expect(both).toBe(2);                 // baseline: two canvases, two clears

    const overlay = { contains: (el: unknown) => el === over } as unknown as HTMLElement;
    const release = S.occludeAllExcept(overlay);
    clearRects = 0;
    paintTick();
    expect(clearRects).toBe(1);           // only the overlay's own canvas

    release();
    clearRects = 0;
    paintTick();
    expect(clearRects).toBe(2);           // and everything comes back
  });

  test('the ten states are the documented contract', async () => {
    const S = await load();
    expect(S.STATES).toEqual([
      'idle', 'listening', 'thinking', 'speaking', 'working',
      'success', 'alert', 'muted', 'waking', 'dissolving',
    ]);
    expect(S.PRESET).toEqual({ count: 26000, dens: 0.7, size: 0.6, soft: 0 });
    // Exported live in the handoff — a caller mutating them mutated the
    // renderer's defaults for every canvas.
    expect(Object.isFrozen(S.PRESET)).toBe(true);
    expect(Object.isFrozen(S.STATES)).toBe(true);
  });
});

describe('atlasSphere — the v3 morph/field merge', () => {
  test('morph = 1 is the sphere: every particle has arrived, and stays inside R', async () => {
    const S = await load();
    // The endpoint is exact, not asymptotic: at morph 1 the transit term is a
    // no-op for every particle, which is what makes v2 callers byte-identical.
    for (let fr = 0; fr <= 1.0001; fr += 0.1) {
      for (let rn = 0; rn <= 1.0001; rn += 0.1) {
        expect(S.morphTransit(1, fr, rn)).toBe(1);
      }
    }

    const el = fakeCanvas({ w: 1200, h: 400 });
    S.mount(el as unknown as HTMLCanvasElement, { count: 800, morph: 1 });
    ops = [];
    paintTick();
    expect(ops.length).toBeGreaterThan(100);
    // R = min(W,H) * 0.44 = 176; the wobble adds ~9 %.
    expect(maxAbs(xs(), 600)).toBeLessThan(176 * 1.2);
  });

  test('morph = 0 is the field: nobody has left, and the plane is full-bleed', async () => {
    const S = await load();
    for (let fr = 0; fr <= 1.0001; fr += 0.1) {
      for (let rn = 0; rn <= 1.0001; rn += 0.1) {
        expect(S.morphTransit(0, fr, rn)).toBe(0);
      }
    }

    const el = fakeCanvas({ w: 1200, h: 400 });
    S.mount(el as unknown as HTMLCanvasElement, { count: 2000, morph: 0 });
    ops = [];
    paintTick();
    expect(ops.length).toBeGreaterThan(100);
    // fieldSpread 1.06 → the lattice reaches ±53 % of the width, far outside
    // the sphere's 176 px radius.
    expect(maxAbs(xs(), 600)).toBeGreaterThan(400);
  });

  test('the transit is staggered, not uniform', async () => {
    const S = await load();
    const es: number[] = [];
    for (let fr = 0; fr <= 1.0001; fr += 0.05) {
      for (let rn = 0; rn <= 1.0001; rn += 0.05) es.push(S.morphTransit(0.5, fr, rn));
    }
    // STAG 0.62: at half morph the leaders are almost home while the stragglers
    // have barely left, so the sphere re-forms as a sweep rather than a jump.
    expect(Math.max(...es) - Math.min(...es)).toBeGreaterThan(0.5);
  });

  test('the field alpha is the cubic crest weighting, not the README’s square', async () => {
    const S = await load();
    // README §3: fa = edge · (0.045 + 0.95·crest²) · (0.58 + 0.7·amp)
    // Code:      crest² · (0.4 + 0.6·crest), and an extra aSoft factor.
    const readme = (wv: number, edge: number, amp: number) => {
      const crest = wv * 0.5 + 0.5;
      return edge * (0.045 + 0.95 * crest * crest) * (0.58 + amp * 0.7);
    };
    for (const wv of [-0.8, -0.4, 0, 0.4, 0.8]) {
      const crest = wv * 0.5 + 0.5;
      expect(S.crestAlpha(crest)).toBeCloseTo(0.045 + 0.95 * crest * crest * (0.4 + 0.6 * crest), 12);
    }
    // The prose drops the (0.4 + 0.6·crest) factor, so it overstates the
    // crest-weighted term by 1/(0.4 + 0.6·crest) — 2.5× in a trough, 1.25× at
    // mid crest. The two must not be interchangeable, or a rewrite from the
    // prose would pass unnoticed and the field would read flat and bright.
    for (const c of [0.05, 0.2, 0.5, 1]) {
      expect((0.95 * c * c) / (S.crestAlpha(c) - 0.045)).toBeCloseTo(1 / (0.4 + 0.6 * c), 9);
    }
    expect((0.95 * 0.05 * 0.05) / (S.crestAlpha(0.05) - 0.045)).toBeGreaterThan(2.3);
    expect(S.fieldAlpha(-0.6, 1, 0.3, 1)).toBeLessThan(readme(-0.6, 1, 0.3));
    // aSoft is part of the formula and the README omits it: soft 10 → ×0.58.
    expect(S.fieldAlpha(0.3, 1, 0.3, 0.58)).toBeCloseTo(S.fieldAlpha(0.3, 1, 0.3, 1) * 0.58, 12);
  });

  test('the dot radius is clamped at both bounds — arc() throws on a bad one', async () => {
    const S = await load();
    const el = fakeCanvas({ w: 400, h: 400 });
    let cur: Record<string, unknown> = { count: 600, size: 40 };
    const handle = S.mount(el as unknown as HTMLCanvasElement, () => cur);

    ops = [];
    paintTick();
    expect(ops.length).toBeGreaterThan(100);
    expect(Math.max(...ops.map((o) => o.r))).toBe(7);          // upper clamp hit
    expect(Math.min(...ops.map((o) => o.r))).toBeGreaterThan(0.04);

    // A negative or NaN radius must be dropped, not handed to arc(): one throw
    // kills the whole frame, and safePaint would then blank the canvas for good.
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a); };
    try {
      cur = { count: 600, size: -3 };
      ops = []; paintTick();
      expect(ops.length).toBe(0);

      cur = { count: 600, size: NaN };
      ops = []; paintTick();
      expect(ops.length).toBe(0);
    } finally {
      console.error = orig;
    }
    expect(errors).toEqual([]);
    expect(handle).not.toBeNull();
  });

  test('dots are round above 0.95px and square below', async () => {
    const S = await load();
    const el = fakeCanvas({ w: 400, h: 400 });
    let cur: Record<string, unknown> = { count: 600, size: 4 };
    S.mount(el as unknown as HTMLCanvasElement, () => cur);

    ops = []; paintTick();
    expect(ops.length).toBeGreaterThan(100);
    expect(ops.every((o) => o.kind === 'arc')).toBe(true);

    // Sub-pixel specks stay square — visually identical, much cheaper.
    cur = { count: 600, size: 0.05 };
    ops = []; paintTick();
    expect(ops.length).toBeGreaterThan(10);
    expect(ops.every((o) => o.kind === 'rect')).toBe(true);
  });

  test('adaptive quality thins the draw and never reaches the cache key', async () => {
    const S = await load();
    const el = fakeCanvas({ w: 1200, h: 400 });
    const handle = S.mount(
      el as unknown as HTMLCanvasElement,
      { count: 4000, morph: 0.5 },
      { adaptive: true },
    );

    ops = []; paintTick();
    const full = ops.length;
    const keysBefore = S.cachedCloudKeys();
    expect(keysBefore.length).toBe(1);

    handle!.q = 0.4;
    ops = []; paintTick();
    expect(ops.length).toBeLessThan(full);

    // Keying the cloud on count × q rebuilt 26 000 particles every frame and
    // hard-locked the main thread. The key must be identical.
    expect(S.cachedCloudKeys()).toEqual(keysBefore);
  });

  test('the cloud cache evicts least-recently-USED, not first-created', async () => {
    const S = await load();
    const el = fakeCanvas({ w: 400, h: 400 });
    let count = 500;
    S.mount(el as unknown as HTMLCanvasElement, () => ({ count }));

    for (const n of [500, 600, 700, 800, 900, 1000, 1100, 1200]) {
      count = n; paintTick();
    }
    expect(S.cachedCloudKeys().length).toBe(8);

    count = 500; paintTick();     // touch the oldest — it is now the newest
    count = 1300; paintTick();    // forces one eviction

    const keys: string[] = S.cachedCloudKeys();
    expect(keys.length).toBe(8);
    // The port evicted in insertion order, so the hot first-created cloud (in
    // production, the 26 000-point default) was always the victim.
    expect(keys.some((k) => k.startsWith('500|'))).toBe(true);
    expect(keys.some((k) => k.startsWith('1300|'))).toBe(true);
    expect(keys.some((k) => k.startsWith('600|'))).toBe(false);
  });

  test('a non-square canvas centres on its own axes', async () => {
    const S = await load();
    // Radius follows the SHORT edge; the centre follows each axis separately.
    expect(S.sphereGeometry(1200, 400)).toEqual({ S: 400, R: 176, cx: 600, cy: 200 });
    expect(S.sphereGeometry(1200, 400, { cx: 0.25, radius: 0.5 }))
      .toEqual({ S: 400, R: 200, cx: 300, cy: 200 });

    const el = fakeCanvas({ w: 1200, h: 400 });
    S.mount(el as unknown as HTMLCanvasElement, { count: 800 });
    ops = []; paintTick();
    expect(ops.length).toBeGreaterThan(100);
    // v2 derived cy from el.width, which put the whole sphere 400 px below a
    // 1200×400 tile — every dot would land past the bottom edge.
    expect(Math.max(...ys())).toBeLessThan(400);
    expect(maxAbs(ys(), 200)).toBeLessThan(176 * 1.2);
  });

  test('a height-only resize still updates the backing store', async () => {
    const S = await load();
    const el = fakeCanvas({ w: 400, h: 400 });
    S.mount(el as unknown as HTMLCanvasElement, { count: 600 });
    paintTick();
    expect(el.height).toBe(400);

    // v2 compared the width alone, so a tile that resized vertically kept
    // rendering stretched from a stale buffer forever.
    el.clientHeight = 200;
    paintTick();
    expect(el.width).toBe(400);
    expect(el.height).toBe(200);
  });

  test('the watchdog re-queues a dead pump and never paints from its timer', async () => {
    const S = await load();
    S.mount(fakeCanvas() as unknown as HTMLCanvasElement, { count: 600 });
    paintTick();
    expect(clearRects).toBeGreaterThan(0);
    expect(intervalCb).not.toBeNull();

    const painted = clearRects;
    const cancelled = rafCancelled.length;
    rafQueue = [];

    // Push the clock past the 1400 ms silence threshold so the guard fires.
    const realNow = performance.now.bind(performance);
    const frozen = realNow() + 5000;
    (performance as any).now = () => frozen;
    try {
      intervalCb!();
    } finally {
      (performance as any).now = realNow;
    }

    // Painting from the timer stacks a synchronous frame on a slow frame and
    // saturates the main thread — the guard only ever restarts the pump.
    expect(clearRects).toBe(painted);
    expect(rafQueue.length).toBe(1);
    expect(rafCancelled.length).toBe(cancelled + 1);
    expect(S.isRunning()).toBe(true);
  });

  test('reduced motion settles to the sphere: no morph, no spin, no drift', async () => {
    reduce = true;
    const S = await load();
    const el = fakeCanvas({ w: 1200, h: 400 });
    // morph 0 and a fast spin are both requested and both must be ignored.
    S.mount(el as unknown as HTMLCanvasElement, { count: 800, morph: 0, spin: 0.006 });

    expect(S.isRunning()).toBe(false);
    expect(rafQueue.length).toBe(0);
    expect(ops.length).toBeGreaterThan(100);
    // Settled to the sphere, not left as a still (and therefore dead) plane.
    expect(maxAbs(xs(), 600)).toBeLessThan(176 * 1.2);

    // Every repaint is identical: spin 0 and a frozen clock, so a state change
    // repaints without the sphere jumping.
    ops = []; S.refresh();
    const first = ops;
    ops = []; S.refresh();
    expect(ops).toEqual(first);
    expect(S.isRunning()).toBe(false);
  });

  test('reduced motion shows the settled form of a transitional state', async () => {
    reduce = true;
    const S = await load();
    // `waking` at a frozen clock would otherwise paint an invisible sphere:
    // every particle sits at its scatter home with alpha 0.
    S.mount(fakeCanvas() as unknown as HTMLCanvasElement, { count: 800, state: 'waking' });
    expect(ops.length).toBeGreaterThan(100);
  });

  test('zero is an honoured value, not a missing one', async () => {
    const S = await load();
    const el = fakeCanvas({ w: 400, h: 400 });
    S.mount(el as unknown as HTMLCanvasElement, { count: 0, dens: 0 });
    paintTick();
    // The handoff's `||` defaulting turned all three of these into the preset.
    // count 0 clamps to the 400 floor; dens 0 is a legitimate hollow shell.
    expect(S.cachedCloudKeys()).toEqual(['400|0.00|20']);

    const lo = fakeCanvas({ w: 400, h: 400 });
    S.mount(lo as unknown as HTMLCanvasElement, { count: 600, maxDpr: 0 });
    paintTick();
    // maxDpr 0 means "as cheap as possible" (floored at 0.5), never 1.5.
    expect(lo.width).toBe(200);
  });

  test('the new option defaults are the documented contract', async () => {
    const S = await load();
    expect(S.sphereGeometry(400, 400)).toEqual({ S: 400, R: 176, cx: 200, cy: 200 });
    expect(S.morphTransit(1, 0.5, 0.5)).toBe(1);   // morph defaults to the sphere
    // The lattice width is quantised so a live resize walks a short ladder of
    // cache keys instead of a continuum, while staying within ~3 % of the exact
    // width — so cells stay square and the plane does not read as a grid.
    for (const [n, ar] of [[26000, 1], [26000, 2.5], [800, 0.5], [4000, 4]] as const) {
      expect(Math.abs(S.latticeCols(n, ar) / Math.sqrt(n * ar) - 1)).toBeLessThan(0.03);
    }
    expect(S.latticeCols(26000, 1)).toBe(S.latticeCols(26000, 1.01));   // a 1 % drag: no rebuild
    expect(S.latticeCols(26000, 4)).toBeGreaterThan(S.latticeCols(26000, 0.5));
    expect(S.latticeCols(26000, NaN)).toBe(S.latticeCols(26000, 1));    // NaN aspect ≠ NaN key
  });
});
