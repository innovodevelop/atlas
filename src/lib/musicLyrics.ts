/**
 * Lyrics for the Music screen's Lyrics tab — LRCLIB's answer, read.
 *
 * `music.rs` (`music_lyrics`) asks lrclib.net with the track's title, artist,
 * album and length and caches the answer in SQLite. LRCLIB returns timed
 * lyrics as LRC text (`[01:23.45] a line`) when it has them and plain text
 * otherwise; this file turns either into lines and finds the one the
 * playback position is in. Pure, so the parsing is tested here.
 */

export interface LyricLine {
  /** When the line starts, in ms from the top of the track. */
  ms: number;
  text: string;
}

/** What `music_lyrics` returns. */
export interface LyricsAnswer {
  found: boolean;
  instrumental: boolean;
  synced: string | null;
  plain: string | null;
  cached: boolean;
}

export type LyricsView =
  | { kind: 'synced'; lines: LyricLine[] }
  | { kind: 'plain'; lines: string[] }
  | { kind: 'instrumental' }
  | { kind: 'none' };

/** `[mm:ss]`, `[mm:ss.x]`, `[mm:ss.xx]`, `[mm:ss.xxx]`, and the `[mm:ss:xx]` some files use. */
const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET = /^\[offset:\s*([+-]?\d+)\s*\]$/i;

function stampMs(min: string, sec: string, frac: string | undefined): number {
  const f = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  return Number(min) * 60000 + Number(sec) * 1000 + f;
}

/**
 * LRC text → lines in time order. A line may carry several stamps (a chorus
 * written once); each becomes its own line. Tag lines (`[ar:…]`, `[ti:…]`)
 * are dropped; `[offset:±ms]` shifts every stamp as the format says (a
 * positive offset makes the lines come sooner). Empty lines are kept: they
 * are the instrumental breaks, and the current-line marker should rest on
 * them rather than linger on the last sung line.
 */
export function parseLrc(lrc: string | null | undefined): LyricLine[] {
  if (!lrc) return [];
  let offset = 0;
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const off = OFFSET.exec(line);
    if (off) { offset = Number(off[1]); continue; }
    const stamps: number[] = [];
    let rest = line;
    STAMP.lastIndex = 0;
    // Stamps lead the line; collect them and keep what follows the last one.
    for (;;) {
      const m = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*/.exec(rest);
      if (!m) break;
      stamps.push(stampMs(m[1], m[2], m[3]));
      rest = rest.slice(m[0].length);
    }
    if (!stamps.length) continue;
    const text = rest.replace(STAMP, '').trim();
    for (const ms of stamps) out.push({ ms: Math.max(0, ms - offset), text });
  }
  out.sort((a, b) => a.ms - b.ms);
  return out;
}

/**
 * The index of the line playing at `posMs`: the last one that has started.
 * −1 before the first line. Binary search — it runs every animation frame.
 */
export function lineAt(lines: readonly LyricLine[], posMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].ms <= posMs) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** Plain lyrics → their lines, with runs of blank lines folded to one break. */
export function plainLines(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t && (!out.length || out[out.length - 1] === '')) continue;
    out.push(t);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/** What the tab draws for an answer: timed lines first, then plain, then the two empty states. */
export function lyricsView(a: LyricsAnswer | null | undefined): LyricsView {
  if (!a) return { kind: 'none' };
  const synced = parseLrc(a.synced);
  if (synced.some((l) => l.text)) return { kind: 'synced', lines: synced };
  const plain = plainLines(a.plain);
  if (plain.length) return { kind: 'plain', lines: plain };
  if (a.instrumental) return { kind: 'instrumental' };
  return { kind: 'none' };
}

/** The design's two empty lines. */
export const NO_LYRICS = 'Lyrics aren’t available for this track.';
export const INSTRUMENTAL = 'Instrumental. Nothing to sing along to.';
