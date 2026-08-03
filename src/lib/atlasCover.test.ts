/* eslint-disable @typescript-eslint/no-explicit-any -- test code deliberately builds
   partial canvas doubles and reaches into them to assert on what was painted.
   Precise types here would mean mirroring the DOM's canvas surface, which adds
   churn without adding safety: the assertions, not the annotations, are the contract. */
/**
 * Tests for the artwork colour pipeline ported from the handoff's
 * `atlas-cover.js` (README §4).
 *
 * The two contracts worth locking down:
 *   - `make` is DETERMINISTIC per seed. The sleeve is generated fresh on every
 *     call (no internal cache), so the same seed must paint the same pixels.
 *   - `read` NEVER THROWS. Cross-origin artwork taints the canvas and
 *     `getImageData` throws SecurityError — an expected runtime state on the
 *     music surface, which must degrade to the supplied tone, not take a render
 *     down.
 *
 * Run: bun test src/lib/atlasCover.test.ts
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

// --- canvas doubles ---------------------------------------------------------
// bun's runtime has no DOM. The module only needs a 2D context that records
// what it was asked to paint, plus a getImageData it can be denied.

type Px = [number, number, number, number];

interface CanvasCfg {
  /** Per-pixel colour for getImageData. Defaults to opaque mid grey. */
  pixel?: (i: number, n: number) => Px;
  /** 'throw' simulates a tainted canvas; 'missing' removes getImageData entirely. */
  imageData?: 'ok' | 'throw' | 'missing';
  /** getContext returns null, as it does when 2D is unavailable. */
  noContext?: boolean;
  /** toDataURL throws, as an encoder failure would. */
  encodeThrows?: boolean;
}

let created: any[] = [];

const fx = (n: number) => Number(n).toFixed(4);

function fnv(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function checksum(d: ArrayLike<number>): string {
  let h = 2166136261;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

function gradient(kind: string, a: number[]) {
  const g: any = {
    __grad: `${kind}(${a.map(fx).join(',')})`,
    addColorStop(o: number, col: string) { g.__grad += `|${o}:${col}`; },
  };
  return g;
}

const styleTag = (s: unknown): string =>
  s && typeof s === 'object' && (s as any).__grad ? (s as any).__grad : String(s);

function fakeCanvas(cfg: CanvasCfg) {
  const ops: string[] = [];
  const ctx: any = {
    filter: 'none',
    fillStyle: '',
    fillRect: (...a: number[]) => ops.push(`fillRect(${a.join(',')}) ${styleTag(ctx.fillStyle)}`),
    beginPath: () => ops.push('beginPath'),
    arc: (...a: number[]) => ops.push(`arc(${a.map(fx).join(',')})`),
    fill: () => ops.push(`fill ${styleTag(ctx.fillStyle)} filter=${ctx.filter}`),
    drawImage: (...a: unknown[]) => ops.push(`drawImage(${a.length})`),
    createRadialGradient: (...a: number[]) => gradient('radial', a),
    createLinearGradient: (...a: number[]) => gradient('linear', a),
    putImageData: (im: any) => ops.push(`putImageData ${checksum(im.data)}`),
  };
  if (cfg.imageData !== 'missing') {
    ctx.getImageData = (_x: number, _y: number, w: number, h: number) => {
      if (cfg.imageData === 'throw') {
        const e: any = new Error('Failed to execute getImageData: the canvas has been tainted');
        e.name = 'SecurityError';
        throw e;
      }
      const n = w * h;
      const data = new Uint8ClampedArray(n * 4);
      const px = cfg.pixel || ((): Px => [128, 128, 128, 255]);
      for (let i = 0; i < n; i++) {
        const p = px(i, n);
        data[i * 4] = p[0]; data[i * 4 + 1] = p[1]; data[i * 4 + 2] = p[2]; data[i * 4 + 3] = p[3];
      }
      return { data, width: w, height: h };
    };
  }
  const el: any = {
    width: 0,
    height: 0,
    ops,
    ctx,
    getContext(kind: string, opts?: unknown) {
      if (cfg.noContext) return null;
      ops.push(`getContext(${kind}${opts ? ',' + JSON.stringify(opts) : ''})`);
      return ctx;
    },
    toDataURL(type: string, q: number) {
      if (cfg.encodeThrows) throw new Error('encode failed');
      return `data:${type};q=${q};ops=${fnv(ops.join('|'))}`;
    },
  };
  return el;
}

function installDocument(cfg: CanvasCfg = {}) {
  created = [];
  (globalThis as any).document = {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`unexpected createElement(${tag})`);
      const el = fakeCanvas(cfg);
      created.push(el);
      return el;
    },
  };
}

/** Silence + capture the module's warn-once diagnostics. */
function captureWarnings<T>(fn: () => T): { value: T; warnings: unknown[][] } {
  const warnings: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a); };
  try {
    return { value: fn(), warnings };
  } finally {
    console.warn = orig;
  }
}

async function load() {
  // Fresh module per test — the warn-once set and last-failure are module state.
  return await import(`@/lib/atlasCover?t=${Math.random()}`);
}

const TONE: [number[], number[], number[]] = [[18, 20, 34], [52, 97, 242], [214, 226, 255]];

beforeEach(() => { installDocument(); });
afterEach(() => { delete (globalThis as any).document; });

// --- colour helpers ---------------------------------------------------------

describe('atlasCover · colour helpers', () => {
  test('hex formats, pads, rounds and clamps', async () => {
    const C = await load();
    expect(C.hex([0, 0, 0])).toBe('#000000');
    expect(C.hex([255, 255, 255])).toBe('#ffffff');
    expect(C.hex([52, 97, 242])).toBe('#3461f2');    // Atlas Blue
    expect(C.hex([1, 2, 3])).toBe('#010203');        // zero-padded
    expect(C.hex([10.6, 10.4, 0.5])).toBe('#0b0a01'); // rounded, not truncated
    expect(C.hex([-20, 300, 128])).toBe('#00ff80');  // clamped both ends
  });

  test('hex folds NaN to black instead of emitting an invalid colour', async () => {
    const C = await load();
    // The handoff produced '#NaNNaNNaN', which voids the whole declaration.
    expect(C.hex([NaN, NaN, NaN])).toBe('#000000');
    expect(C.hex([NaN, NaN, NaN])).toMatch(/^#[0-9a-f]{6}$/);
  });

  test('rgba truncates channels (as the handoff) and clamps both channels and alpha', async () => {
    const C = await load();
    expect(C.rgba([52, 97, 242], 0.5)).toBe('rgba(52,97,242,0.5)');
    expect(C.rgba([12.9, 0.4, 255.9], 1)).toBe('rgba(12,0,255,1)');   // | 0 truncation
    expect(C.rgba([-5, 300, 10], 2)).toBe('rgba(0,255,10,1)');        // clamped
    expect(C.rgba([10, 10, 10], -1)).toBe('rgba(10,10,10,0)');
    expect(C.rgba([NaN, 10, 10], NaN)).toBe('rgba(0,10,10,0)');
  });

  test('toward hits both endpoints and the midpoint, without aliasing its inputs', async () => {
    const C = await load();
    const a: number[] = [0, 0, 0];
    const b: number[] = [255, 128, 64];

    expect(C.toward(a, b, 0)).toEqual([0, 0, 0]);
    expect(C.toward(a, b, 1)).toEqual([255, 128, 64]);
    expect(C.toward(a, b, 0.5)).toEqual([127.5, 64, 32]);

    // A returned array must never be the caller's array — one surface's tween
    // would otherwise mutate another surface's palette entry.
    expect(C.toward(a, b, 0)).not.toBe(a);
    expect(C.toward(a, b, 1)).not.toBe(b);
    expect(a).toEqual([0, 0, 0]);   // inputs untouched
    expect(b).toEqual([255, 128, 64]);
  });

  test('lum is 0 at black, 1 at white, and monotone between', async () => {
    const C = await load();
    expect(C.lum([0, 0, 0])).toBe(0);
    expect(C.lum([255, 255, 255])).toBeCloseTo(1, 10);
    expect(C.lum([40, 40, 40])).toBeLessThan(C.lum([200, 200, 200]));
  });

  test('toTone maps a palette to the [deep, mid, light] tuple, copied', async () => {
    const C = await load();
    const p = { deep: [1, 2, 3], mid: [4, 5, 6], light: [7, 8, 9] };
    expect(C.toTone(p)).toEqual([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    expect(C.toTone(p)[0]).not.toBe(p.deep);
  });
});

// --- make -------------------------------------------------------------------

describe('atlasCover · make', () => {
  test('is deterministic for a seed and differs between seeds', async () => {
    const C = await load();
    const a = C.make(7, TONE);
    const b = C.make(7, TONE);
    const c = C.make(8, TONE);

    expect(a).not.toBe('');
    expect(a).toBe(b);          // same seed, same pixels
    expect(c).not.toBe(a);      // different seed, different sleeve
  });

  test('is deterministic across module instances (it holds no cache)', async () => {
    const A = await load();
    const B = await load();
    expect(B.make(11, TONE)).toBe(A.make(11, TONE));
  });

  test('string seeds work and are stable — a track id can be the seed', async () => {
    const C = await load();
    const a = C.make('spotify:track:4cOdK2wGLETKBW3PvgPWqT', TONE);
    const b = C.make('spotify:track:4cOdK2wGLETKBW3PvgPWqT', TONE);
    const c = C.make('spotify:track:0eGsygTp906u18L0Oimnem', TONE);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  test('large seeds stay distinct (the handoff collided at Date.now() scale)', async () => {
    const C = await load();
    // These two seeds round to the same first LCG state under the handoff's
    // un-reduced arithmetic, so they generated one identical sleeve. Verified
    // against a transcription of the handoff generator, not assumed.
    expect(C.make(1_700_000_000_000, TONE)).not.toBe(C.make(1_700_000_000_457, TONE));
  });

  test('the tone drives the paint: the base fill is the deep tone', async () => {
    const C = await load();
    C.make(3, TONE);
    const ops: string[] = created[0].ops;
    const base = ops.find((o) => o.startsWith('fillRect(0,0,512,512)'));
    expect(base).toContain(C.hex(TONE[0]));   // '#121422'
    expect(created[0].width).toBe(512);
    expect(created[0].height).toBe(512);
  });

  test('accepts a CoverPalette as well as a tone tuple, and the tone reaches the paint', async () => {
    const C = await load();
    const asTuple = C.make(5, TONE);
    const asPalette = C.make(5, { deep: TONE[0], mid: TONE[1], light: TONE[2] });
    expect(asPalette).toBe(asTuple);

    // Same seed, different record — the sleeve must change with the palette.
    expect(C.make(5, [[60, 10, 10], [220, 90, 40], [255, 240, 210]])).not.toBe(asTuple);
  });

  test('every colour it paints with is a valid CSS colour', async () => {
    const C = await load();
    C.make(4, [[-30, 300, NaN], [52, 97, 242], [214, 226, 255]]);
    const blob = (created[0].ops as string[]).join('|');

    const rgbas = blob.match(/rgba\([^)]*\)/g) || [];
    expect(rgbas.length).toBeGreaterThan(0);
    for (const s of rgbas) {
      const m = s.match(/^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),(0|1|0?\.\d+)\)$/);
      expect(m, `invalid CSS colour: ${s}`).not.toBeNull();
      for (let i = 1; i <= 3; i++) expect(Number(m![i])).toBeLessThanOrEqual(255);
    }
    for (const s of blob.match(/#[0-9a-zA-Z]+/g) || []) {
      expect(s).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  test('returns no art rather than throwing when there is no canvas', async () => {
    const C = await load();
    delete (globalThis as any).document;
    const { value, warnings } = captureWarnings(() => C.make(1, TONE));
    expect(value).toBe('');
    expect(warnings.length).toBe(1);
  });

  test('returns no art rather than throwing when 2D is unavailable', async () => {
    const C = await load();
    installDocument({ noContext: true });
    expect(captureWarnings(() => C.make(1, TONE)).value).toBe('');
  });

  test('still produces a sleeve when pixel access is denied (grain is optional)', async () => {
    const C = await load();
    installDocument({ imageData: 'missing' });
    const url = captureWarnings(() => C.make(2, TONE)).value;
    expect(url).toMatch(/^data:image\/jpeg;/);

    installDocument({ imageData: 'throw' });
    const tainted = captureWarnings(() => C.make(2, TONE));
    expect(tainted.value).toMatch(/^data:image\/jpeg;/);
    expect(tainted.warnings.length).toBe(1);   // reported, not swallowed
  });

  test('an encoder failure degrades to no art, reported once', async () => {
    const C = await load();
    installDocument({ encodeThrows: true });
    const first = captureWarnings(() => C.make(1, TONE));
    expect(first.value).toBe('');
    expect(first.warnings.length).toBe(1);
    expect(C.lastCoverFailure()).toBeInstanceOf(Error);

    // Same cause again: no second log. A per-frame caller must not spam.
    installDocument({ encodeThrows: true });
    expect(captureWarnings(() => C.make(2, TONE)).warnings.length).toBe(0);
  });
});

// --- read -------------------------------------------------------------------

/** A 40×40 image in three bands: dark blue, mid violet, light peach. */
const banded = (i: number, n: number): Px => {
  const t = i / n;
  if (t < 0.34) return [20, 24, 60, 255];
  if (t < 0.67) return [120, 90, 200, 255];
  return [240, 220, 200, 255];
};

describe('atlasCover · read', () => {
  test('samples three separated tones from artwork', async () => {
    const C = await load();
    installDocument({ pixel: banded });
    const p = C.read({} as any);

    for (const key of ['deep', 'mid', 'light'] as const) {
      expect(p[key]).toHaveLength(3);
      for (const v of p[key]) expect(Number.isFinite(v)).toBe(true);
    }
    // The trio must stay ordered, or every scrim derived from it inverts.
    expect(C.lum(p.deep)).toBeLessThanOrEqual(C.lum(p.mid));
    expect(C.lum(p.mid)).toBeLessThanOrEqual(C.lum(p.light));
    // Three distinct bands must yield three distinct tones, not one repeated.
    expect(C.lum(p.deep)).toBeLessThan(C.lum(p.mid));
    expect(C.lum(p.mid)).toBeLessThan(C.lum(p.light));
    // It sampled the art, not the fallback.
    expect(p).not.toEqual(C.FALLBACK_PALETTE);
  });

  test('is deterministic for the same pixels', async () => {
    const C = await load();
    installDocument({ pixel: banded });
    expect(C.read({} as any)).toEqual(C.read({} as any));
  });

  test('a light sleeve is brightened and a dark one darkened, so the tones separate', async () => {
    const C = await load();
    // Two near-black bands: `deep` must be pushed darker still.
    installDocument({ pixel: (i, n) => (i / n < 0.5 ? [90, 92, 110, 255] : [70, 64, 88, 255]) });
    const dark = C.read({} as any);
    expect(C.lum(dark.deep)).toBeLessThan(C.lum([70, 64, 88]));
    expect(C.lum(dark.light)).toBeGreaterThan(C.lum([90, 92, 110]));
  });

  test('falls back instead of throwing on a tainted canvas', async () => {
    const C = await load();
    installDocument({ imageData: 'throw' });
    const fallback = { deep: [1, 2, 3], mid: [4, 5, 6], light: [7, 8, 9] };

    const { value, warnings } = captureWarnings(() => C.read({} as any, fallback));
    expect(value).toEqual(fallback);
    expect(warnings.length).toBe(1);
    expect((C.lastCoverFailure() as any).name).toBe('SecurityError');

    // Reported once, not once per call — this runs on every artwork change.
    installDocument({ imageData: 'throw' });
    expect(captureWarnings(() => C.read({} as any, fallback)).warnings.length).toBe(0);
  });

  test('falls back when getImageData is unavailable', async () => {
    const C = await load();
    installDocument({ imageData: 'missing' });
    const { value } = captureWarnings(() => C.read({} as any, null));
    expect(value).toEqual(C.FALLBACK_PALETTE);
  });

  test('falls back when there is no canvas at all', async () => {
    const C = await load();
    delete (globalThis as any).document;
    expect(captureWarnings(() => C.read({} as any)).value).toEqual(C.FALLBACK_PALETTE);
  });

  test('falls back for a missing image, an undecoded <img>, and a flat image', async () => {
    const C = await load();
    const cases: Array<() => unknown> = [
      () => C.read(null),
      () => C.read(undefined),
      () => C.read({ naturalWidth: 0 } as any),          // not decoded yet
    ];
    for (const run of cases) {
      expect(captureWarnings(run).value).toEqual(C.FALLBACK_PALETTE);
    }
    // A single flat colour yields one bucket — fewer than the two tones needed.
    installDocument({ pixel: () => [17, 17, 17, 255] });
    expect(captureWarnings(() => C.read({} as any)).value).toEqual(C.FALLBACK_PALETTE);
  });

  test('transparency does not drag the palette to black', async () => {
    const C = await load();
    // A third of the sleeve transparent, the rest two light tones. The handoff
    // read RGB and ignored alpha, so the transparent third scored as pure black
    // and became `deep` outright — a light record rendered on a black wash.
    installDocument({
      pixel: (i, n) => {
        const t = i / n;
        if (t < 0.34) return [0, 0, 0, 0];
        return t < 0.67 ? [200, 180, 240, 255] : [250, 240, 230, 255];
      },
    });
    const p = captureWarnings(() => C.read({} as any)).value as any;
    expect(p.deep).not.toEqual([0, 0, 0]);
    expect(C.lum(p.deep)).toBeGreaterThan(0.1);
    expect(C.lum(p.light)).toBeGreaterThan(0.8);

    // A fully transparent image has nothing to sample: fall back, do not throw.
    installDocument({ pixel: () => [0, 0, 0, 0] });
    expect(captureWarnings(() => C.read({} as any)).value).toEqual(C.FALLBACK_PALETTE);
  });

  test('the returned fallback is a copy — mutating it cannot poison later reads', async () => {
    const C = await load();
    installDocument({ imageData: 'throw' });

    const first = captureWarnings(() => C.read({} as any)).value as any;
    first.deep[0] = 999;
    const second = captureWarnings(() => C.read({} as any)).value as any;

    expect(second.deep[0]).toBe(24);
    expect(C.FALLBACK_PALETTE.deep).toEqual([24, 24, 30]);

    // Same for a caller-supplied fallback.
    const mine = { deep: [1, 2, 3], mid: [4, 5, 6], light: [7, 8, 9] };
    const out = captureWarnings(() => C.read({} as any, mine)).value as any;
    out.mid[1] = 999;
    expect(mine.mid).toEqual([4, 5, 6]);
  });

  test('read output feeds make', async () => {
    const C = await load();
    installDocument({ pixel: banded });
    const palette = C.read({} as any);
    const url = C.make('track-1', palette);
    expect(url).toMatch(/^data:image\/jpeg;/);
  });
});
