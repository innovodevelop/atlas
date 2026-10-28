/**
 * The Beta Music screen's pure logic — the queue arithmetic (which track is
 * next, what Previous means), the source labels, the remembered preferences
 * and the small formats — tested here, rendered by BetaMusic.tsx.
 *
 * Why there is a queue here at all: the Rust engine (`music_engine.rs`) holds
 * a one-element queue. `Load` replaces it, so the engine's own `Next` and
 * `Prev` are no-ops and `EndOfTrack` simply stops. The listening room's
 * "Up next" is therefore a list kept in the webview — the liked songs, a
 * playlist, or a search — and advancing means handing the engine the next
 * track's URI with its metadata (`useMusicPlayer.load(uri, track)`).
 */
import type { Playlist, Track } from '@/hooks/useMusicPlayer';

/** Where the queue came from. The label on the list and the active station. */
export type QueueSource =
  | { kind: 'none' }
  | { kind: 'library' }
  | { kind: 'playlist'; id: string; name: string }
  | { kind: 'search'; query: string };

export const NO_SOURCE: QueueSource = { kind: 'none' };

export function sameSource(a: QueueSource, b: QueueSource): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'playlist' && b.kind === 'playlist') return a.id === b.id;
  if (a.kind === 'search' && b.kind === 'search') return a.query === b.query;
  return true;
}

export function sourceLabel(s: QueueSource): string {
  switch (s.kind) {
    case 'library': return 'Liked songs';
    case 'playlist': return s.name;
    case 'search': return `Search · ${s.query}`;
    default: return 'Up next';
  }
}

/** The design's rule: Previous restarts a track more than four seconds in; before that it steps back. */
export const RESTART_AFTER_MS = 4000;

export function prevIntent(positionMs: number): 'restart' | 'previous' {
  return positionMs > RESTART_AFTER_MS ? 'restart' : 'previous';
}

/**
 * The track after (`dir` 1) or before (`dir` -1) `currentId` in `queue`,
 * wrapping at the ends as the design does. With `shuffle` it is any OTHER
 * track — the design's `(i + 1 + floor(rnd * (n - 1))) % n`, which can never
 * land on the current one. A current track that is not in the queue (it is
 * playing on another device, or the queue changed under it) steps to the
 * first or the last. Null only when there is nothing to step to.
 */
export function neighbour(
  queue: readonly Track[],
  currentId: string | null,
  dir: 1 | -1,
  shuffle = false,
  rnd: () => number = Math.random,
): Track | null {
  const n = queue.length;
  if (n === 0) return null;
  const i = currentId ? queue.findIndex((t) => t.id === currentId) : -1;
  if (i < 0) return queue[dir > 0 ? 0 : n - 1];
  if (n === 1) return null;
  if (shuffle) return queue[(i + 1 + Math.floor(Math.min(0.999999, Math.max(0, rnd())) * (n - 1))) % n];
  return queue[(i + dir + n) % n];
}

/**
 * Where a station starts: its first track, or with `shuffle` any of them.
 * Null for an empty list.
 */
export function startOf(queue: readonly Track[], shuffle = false, rnd: () => number = Math.random): Track | null {
  const n = queue.length;
  if (n === 0) return null;
  if (!shuffle) return queue[0];
  return queue[Math.floor(Math.min(0.999999, Math.max(0, rnd())) * n)];
}

/**
 * What to hand the engine once `current` has played to its end. Repeat plays
 * it again. Otherwise the queue moves on, but only when the track that ended
 * belongs to it: a record started from another surface (the Home widget, the
 * Workshop player) did not ask for the liked songs to follow it, so the room
 * leaves it ended rather than starting something nobody chose. Null means
 * stop.
 */
export function afterEnd(
  queue: readonly Track[],
  current: Track,
  repeat: boolean,
  shuffle = false,
  rnd: () => number = Math.random,
): Track | null {
  if (repeat) return current;
  if (!queue.some((t) => t.id === current.id)) return null;
  return neighbour(queue, current.id, 1, shuffle, rnd);
}

/**
 * The output the hero names beside "Music": this Mac whenever Atlas is the
 * player (or nothing is playing, which is where Atlas would play it), else
 * the Spotify device the snapshot came from.
 */
export function outputLine(o: { hasTrack: boolean; atlasOwnsAudio: boolean; deviceName: string | null }): string {
  if (!o.hasTrack || o.atlasOwnsAudio) return 'This Mac';
  return o.deviceName || 'Spotify';
}

/** "12 tracks · 48 min"; empty for an empty queue. */
export function queueSummary(queue: readonly Track[]): string {
  if (queue.length === 0) return '';
  const mins = Math.round(queue.reduce((a, t) => a + (t.durationMs || 0), 0) / 60000);
  return `${queue.length} ${queue.length === 1 ? 'track' : 'tracks'} · ${mins} min`;
}

export function stationLine(p: Pick<Playlist, 'trackCount'>): string {
  return `${p.trackCount} ${p.trackCount === 1 ? 'track' : 'tracks'}`;
}

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

export function volumeLabel(v: number): string {
  return `${Math.round(clamp01(v) * 100)}%`;
}

/** Where a click on a bar landed, as a fraction of its width. */
export function ratioAt(clientX: number, left: number, width: number): number {
  if (width <= 0) return 0;
  return clamp01((clientX - left) / width);
}

/**
 * What the room remembers between visits: shuffle, repeat and the output
 * volume. Kept on this Mac (localStorage); nothing here is a fact about the
 * engine, which does not read its volume back.
 */
export interface MusicPrefs { shuffle: boolean; repeat: boolean; volume: number }
export const PREFS_KEY = 'atlas:beta-music';
export const DEFAULT_PREFS: MusicPrefs = { shuffle: false, repeat: false, volume: 1 };

export function parsePrefs(raw: string | null): MusicPrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof MusicPrefs, unknown>>;
    return {
      shuffle: v.shuffle === true,
      repeat: v.repeat === true,
      volume: typeof v.volume === 'number' && Number.isFinite(v.volume) ? clamp01(v.volume) : DEFAULT_PREFS.volume,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** The design draws sixty bars in its ribbon. */
export const WAVE_BARS = 60;

/** How many stations the row shows before "all" is asked for. */
export const STATIONS_SHOWN = 7;
