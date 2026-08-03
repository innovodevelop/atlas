/**
 * The music player's two canvas readouts: the progress ribbon (full player)
 * and the five-bar equaliser (compact widget).
 *
 * IMPORTANT, and the reason this file has a long comment for 60 lines of maths:
 * **this is not an analysis of the audio.** It is a deterministic silhouette
 * derived from the track id — the same record always draws the same shape, but
 * the shape does not describe the sound. Spotify's `audio-analysis` endpoint is
 * not wired into `src-tauri/src/music.rs` and was closed to new applications in
 * 2024, and the real thing Atlas *does* have (`music:level`, the librespot PCM
 * envelope) only exists for the part of the track that has already played, and
 * only when Atlas itself is the player.
 *
 * So the honest framing, used in the UI copy and the canvas `title`, is
 * "progress ribbon", never "waveform of this song". Design handoff
 * §5 / `Atlas Music Player v2.dc.html` (`waveFor` / `drawWave`), ported
 * verbatim except where noted.
 */

/** How many bars the ribbon draws. The design's number; `bw = w / BARS`. */
export const BARS = 108;

/**
 * Fold a Spotify track id into the LCG's numeric domain (FNV-1a).
 *
 * The handoff seeded from small hand-written integers (7 / 19 / 31). Real ids
 * are 22-character base62 strings, so they need hashing — and `Math.imul` is
 * used below rather than `*` for exactly the reason `atlasCover` documents:
 * `seed * 2654435761` past ~2^22 exceeds 2^53 and rounds, which would make
 * neighbouring hashes share a silhouette.
 */
export function seedFromId(id: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // Never 0: the LCG's `sd || 1` guard would collapse every all-zero hash onto
  // one stream, and `sin(0)` phases would align too.
  return h || 1;
}

/**
 * The silhouette: `n` values in 0.05–1.
 *
 * A loudness arc (`swell`) times a fast ripple (`bar`) times jitter, tapered at
 * both ends, then smoothed. The smoothing pass is deliberately IN-PLACE and
 * asymmetric — it reads the already-smoothed `out[k - 1]`, so it is a
 * one-directional IIR, not a symmetric blur. Porting it as a symmetric blur
 * changes every silhouette, so it is kept exactly as the handoff wrote it.
 */
export function waveFor(seed: number, n: number): number[] {
  const sd = Math.imul(seed, 2654435761) >>> 0;
  let r = sd || 1;
  const rnd = () => (r = (Math.imul(r, 1664525) + 1013904223) >>> 0) / 4294967296;
  const out = new Array<number>(n);
  for (let k = 0; k < n; k++) {
    const p = (k + 0.5) / n;
    const swell = 0.5 + 0.5 * Math.sin(p * Math.PI * 3.2 + seed);
    const bar = 0.62 + 0.38 * Math.sin(p * n * 0.42 + seed * 0.7);
    let v = (0.3 + 0.52 * swell) * (0.66 + 0.34 * bar) * (0.72 + 0.5 * rnd());
    v *= Math.min(1, p / 0.035) * Math.min(1, (1 - p) / 0.06); // intro + outro taper
    out[k] = Math.max(0.05, Math.min(1, v));
  }
  for (let k = 1; k < n - 1; k++) out[k] = out[k] * 0.68 + (out[k - 1] + out[k + 1]) * 0.16;
  return out;
}

/**
 * Prepare a canvas for a device-pixel-correct 2D paint and clear it.
 *
 * Note the DPR cap of 2 is the handoff's `size()` helper and is separate from
 * the sphere renderer's `maxDpr` option — this canvas draws flat shapes, not
 * ten thousand particles, so it does not need the renderer's frame budget.
 */
function surface(cv: HTMLCanvasElement): { x: CanvasRenderingContext2D; w: number; h: number } | null {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (!w || !h) return null;
  const wantW = Math.round(w * dpr);
  const wantH = Math.round(h * dpr);
  if (cv.width !== wantW || cv.height !== wantH) { cv.width = wantW; cv.height = wantH; }
  const x = cv.getContext('2d');
  if (!x) return null;
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, w, h);
  return { x, w, h };
}

/** A fully-rounded bar, added to an open Path2D. Four arcTos, as the handoff. */
function bar(p: Path2D, a: number, b: number, w: number, h: number, r: number): void {
  p.moveTo(a + r, b);
  p.arcTo(a + w, b, a + w, b + h, r);
  p.arcTo(a + w, b + h, a, b + h, r);
  p.arcTo(a, b + h, a, b, r);
  p.arcTo(a, b, a + w, b, r);
  p.closePath();
}

export interface WaveFrame {
  /** The silhouette, `BARS` long. */
  data: number[];
  /** Played fraction, 0–1. */
  ratio: number;
  /** Smoothed live amplitude — raises the bars either side of the playhead. */
  amp: number;
  /** Pointer x within the canvas, or null. Draws the scrub column. */
  hoverX: number | null;
  /** Dim the whole ribbon when the transport cannot act on it. */
  inert?: boolean;
}

/**
 * Paint one frame.
 *
 * The played/unplayed split is ONE path filled TWICE, the second pass clipped
 * to the exact progress x. That is what makes the fill sweep *through* the bar
 * under the playhead instead of snapping bar to bar — and it is why there is no
 * playhead dot: the clip edge is the playhead.
 */
export function drawWave(cv: HTMLCanvasElement, f: WaveFrame): void {
  const s = surface(cv);
  if (!s) return;
  const { x, w, h } = s;

  const n = f.data.length || BARS;
  const bw = w / n;
  const cy = h / 2;
  const ratio = f.ratio > 0 ? (f.ratio < 1 ? f.ratio : 1) : 0;
  const px = ratio * w;

  const P = new Path2D();
  for (let i = 0; i < n; i++) {
    const p = (i + 0.5) / n;
    const d2 = Math.abs(p - ratio);
    let v = f.data[i];
    // The live crest: real amplitude lifts the bars within 5 % of the playhead,
    // which is the one part of the ribbon that IS driven by the audio feed.
    if (d2 < 0.05) v = Math.min(1, v + f.amp * 0.5 * (1 - d2 / 0.05));
    const bh = Math.max(2.5, v * h * 0.86);
    const bwid = bw * 0.6;
    bar(P, i * bw + bw * 0.2, cy - bh / 2, bwid, bh, bwid / 2);
  }

  // The scrub column goes UNDER the bars — a faint hint, not a cursor.
  if (f.hoverX != null) {
    x.fillStyle = 'rgba(255,253,250,.16)';
    x.fillRect(Math.max(0, f.hoverX - 1), 0, 2, h);
  }

  const dim = f.inert ? 0.45 : 1;
  x.fillStyle = `rgba(255,253,250,${(0.3 * dim).toFixed(3)})`;
  x.fill(P);
  x.save();
  x.beginPath();
  x.rect(0, 0, px, h);
  x.clip();
  x.fillStyle = `rgba(255,253,250,${(0.98 * dim).toFixed(3)})`;
  x.fill(P);
  x.restore();
}

// ---------------------------------------------------------------------------
// The compact widget's equaliser (design §8)
// ---------------------------------------------------------------------------

/** Five bars, as the handoff. */
export const EQ_BARS = 5;

/**
 * The handoff's smoothing coefficient, converted to a rate.
 *
 * It writes `eqbars[i] += (tgt - eqbars[i]) * 0.32` — a per-FRAME constant, so
 * the bars settle twice as fast on a 120Hz display and crawl on a loaded one.
 * `min(1, dt * 19.2)` is the same 0.32 at 60fps and the same *speed*
 * everywhere, which is the idiom `useAudioReactivity` already uses.
 */
const EQ_RATE = 19.2;

/**
 * Advance the bar heights one step, in place. Pure apart from the mutation, so
 * the frame-rate independence is testable without a canvas.
 *
 * `amp` is the real envelope from `music:level`; the per-bar phase offsets are
 * the handoff's and exist only to stop five identical bars moving as one block.
 * The bars are therefore an amplitude readout, not a spectrum — the three-band
 * split Rust also sends would be a spectrum, but five bars drawn from three
 * bands would have to invent the other two.
 */
export function eqStep(bars: number[], amp: number, t: number, dt: number): number[] {
  const k = Math.min(1, dt * EQ_RATE);
  for (let i = 0; i < bars.length; i++) {
    const target = amp * (0.28 + 0.72 * Math.abs(Math.sin(t * (3 + i * 0.7) + i * 1.3)));
    bars[i] += (target - bars[i]) * k;
  }
  return bars;
}

/** Paint the stepped bars: bottom-anchored, fully rounded caps, 3px gaps. */
export function drawEq(cv: HTMLCanvasElement, bars: number[]): void {
  const s = surface(cv);
  if (!s) return;
  const { x, w, h } = s;
  const n = bars.length;
  const gap = 3;
  const bw = (w - gap * (n - 1)) / n;
  if (bw <= 0) return;
  const P = new Path2D();
  for (let i = 0; i < n; i++) {
    const bh = Math.max(2, Math.min(1, bars[i]) * h);
    bar(P, i * (bw + gap), h - bh, bw, bh, bw / 2);
  }
  x.fillStyle = 'rgba(255,253,250,.95)';
  x.fill(P);
}
