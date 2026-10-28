/**
 * The Beta Music screen's pure logic — the queue arithmetic (which track is
 * next, what Previous means), the source labels, the remembered preferences,
 * ducking, the mood stations, the rooms and the small formats — tested here,
 * driven by the music queue store (src/hooks/useMusicQueue.ts) and rendered
 * by BetaMusic.tsx and the Home widgets.
 *
 * Why there is a queue here at all: the Rust engine (`music_engine.rs`) holds
 * a one-element queue. `Load` replaces it, so the engine's own `Next` and
 * `Prev` are no-ops and `EndOfTrack` simply stops. "Up next" is therefore a
 * list kept in the webview — the liked songs, a playlist, a search or a
 * station Atlas picked — and advancing means handing the engine the next
 * track's URI with its metadata (`useMusicPlayer.load(uri, track)`).
 */
import type { AtlasBusState } from './atlasStateBus';
import type { Device, Playlist, Track } from './musicSpotify';

export type MoodKey = 'focus' | 'wind' | 'cook' | 'run';

/** Where the queue came from. The label on the list and the active station. */
export type QueueSource =
  | { kind: 'none' }
  | { kind: 'library' }
  | { kind: 'playlist'; id: string; name: string }
  | { kind: 'search'; query: string }
  | { kind: 'mood'; mood: MoodKey };

export const NO_SOURCE: QueueSource = { kind: 'none' };

export function sameSource(a: QueueSource, b: QueueSource): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'playlist' && b.kind === 'playlist') return a.id === b.id;
  if (a.kind === 'search' && b.kind === 'search') return a.query === b.query;
  if (a.kind === 'mood' && b.kind === 'mood') return a.mood === b.mood;
  return true;
}

export function sourceLabel(s: QueueSource): string {
  switch (s.kind) {
    case 'library': return 'Liked songs';
    case 'playlist': return s.name;
    case 'search': return `Search · ${s.query}`;
    case 'mood': return `${moodOf(s.mood).title} · picked by Atlas`;
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
 * belongs to it: a record started from another surface (the Workshop player,
 * a podcast episode) did not ask for the liked songs to follow it, so the
 * store leaves it ended rather than starting something nobody chose. `next`
 * is the track the store already announced as Up next (so a shuffled queue
 * plays what it said it would); it is used when it is still in the queue.
 * Null means stop.
 */
export function afterEnd(
  queue: readonly Track[],
  current: Track,
  repeat: boolean,
  shuffle = false,
  rnd: () => number = Math.random,
  next: Track | null = null,
): Track | null {
  if (repeat) return current;
  if (!queue.some((t) => t.id === current.id)) return null;
  if (next && next.id !== current.id && queue.some((t) => t.id === next.id)) return next;
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

/** The hero's line over the title: "Low Sun · 2026", the album alone, or "Single". */
export function albumLine(t: Pick<Track, 'album' | 'year'>): string {
  const album = t.album || 'Single';
  return t.year ? `${album} · ${t.year}` : album;
}

/** "Golden Hour · Vela Sunn" — the widget's Up next line. */
export function nextLine(t: Pick<Track, 'title' | 'artist'> | null): string {
  if (!t) return '';
  return t.artist ? `${t.title} · ${t.artist}` : t.title;
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
 * What the room remembers between visits: shuffle, repeat, the output volume
 * and whether Atlas lowers the music when someone speaks. Kept on this Mac
 * (localStorage); nothing here is a fact about the engine, which does not
 * read its volume back.
 */
export interface MusicPrefs { shuffle: boolean; repeat: boolean; volume: number; duck: boolean }
export const PREFS_KEY = 'atlas:beta-music';
/** Ducking is on by default, as the design draws it. */
export const DEFAULT_PREFS: MusicPrefs = { shuffle: false, repeat: false, volume: 1, duck: true };

export function parsePrefs(raw: string | null): MusicPrefs {
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof MusicPrefs, unknown>>;
    return {
      shuffle: v.shuffle === true,
      repeat: v.repeat === true,
      volume: typeof v.volume === 'number' && Number.isFinite(v.volume) ? clamp01(v.volume) : DEFAULT_PREFS.volume,
      duck: typeof v.duck === 'boolean' ? v.duck : DEFAULT_PREFS.duck,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** The design draws sixty bars in its ribbon. */
export const WAVE_BARS = 60;

/** How many playlists the station row shows before "all" is asked for (the moods and Liked songs come first). */
export const PLAYLISTS_SHOWN = 3;

// --- Ducking ------------------------------------------------------------------------

/**
 * The bus states during which Atlas lowers the music: the wake word, the
 * user speaking, Atlas thinking between the two, and Atlas speaking. Thinking
 * counts so a turn does not pump the volume up and down between its halves.
 */
export const DUCK_STATES: readonly AtlasBusState[] = ['waking', 'listening', 'thinking', 'speaking'];

export function shouldDuck(state: AtlasBusState, enabled: boolean): boolean {
  return enabled && DUCK_STATES.includes(state);
}

/**
 * How far ducking lowers the engine. The engine's SoftMixer maps its 0–1
 * volume on librespot's default 60 dB log curve, so the slider is in
 * decibels: taking 0.3 off it is about −18 dB, which leaves the music at
 * roughly 30 % of its loudness. Multiplying by 0.3 instead would drop full
 * volume by 42 dB — silence, not ducking.
 */
export const DUCK_DROP = 0.3;
/** After the turn ends, wait this long before restoring, so a reply that follows does not pump. */
export const DUCK_RESTORE_MS = 700;

/** Wind down: every ten minutes the station plays a little softer (−3 dB a step, six steps at most). */
export const WIND_STEP = 0.05;
export const WIND_STEP_MS = 10 * 60 * 1000;
export const WIND_MAX_STEPS = 6;

/** The volume the engine is actually given: the user's level, less Wind down's steps, less the duck. */
export function effectiveVolume(volume: number, ducked: boolean, windSteps = 0): number {
  const steps = Math.max(0, Math.min(WIND_MAX_STEPS, Math.floor(windSteps)));
  const base = clamp01(volume) - steps * WIND_STEP;
  return Math.round(clamp01(ducked ? base - DUCK_DROP : base) * 1000) / 1000;
}

// --- Mood stations --------------------------------------------------------------------

export interface Mood {
  key: MoodKey;
  title: string;
  /** The card's second line — what the station aims for. */
  line: string;
  /** The design's swatch colour. */
  swatch: string;
  /** What Atlas is asked to pick for. */
  brief: string;
}

/**
 * The design's four stations. Spotify closed its audio-features and
 * recommendations endpoints to new apps in November 2024, so nothing can
 * measure tempo or vocals: Atlas picks by asking the brain, which sees only
 * each liked song's title and artist. The design's "Matches your pace" for
 * Run stays out — no pace reaches a Mac.
 */
export const MOODS: readonly Mood[] = [
  { key: 'focus', title: 'Focus', line: 'No vocals, steady tempo', swatch: '#3461f2', brief: 'deep focus while working: instrumental or nearly instrumental tracks with a steady tempo and nothing jarring' },
  { key: 'wind', title: 'Wind down', line: 'Softer every 10 minutes', swatch: '#7854ff', brief: 'winding down in the evening: calm, soft tracks, ordered so the set gets gentler as it goes' },
  { key: 'cook', title: 'Cooking', line: 'Upbeat, for the kitchen', swatch: '#e07a1f', brief: 'cooking at home: upbeat, warm tracks with a good groove' },
  { key: 'run', title: 'Run', line: 'High energy, steady beat', swatch: '#0fae76', brief: 'running: high energy, a driving rhythm and a steady fast beat' },
];

export function moodOf(key: MoodKey): Mood {
  return MOODS.find((m) => m.key === key) ?? MOODS[0];
}

/** How many liked songs Atlas reads to pick from, and how many it picks. */
export const STATION_POOL = 200;
export const STATION_SIZE = 25;

/**
 * The question the brain gets: the station's brief and the liked songs as
 * "n. Title — Artist" lines. Titles and artists only; no ids, no albums,
 * nothing about the listener.
 */
export function stationPrompt(mood: Mood, pool: readonly Pick<Track, 'title' | 'artist'>[], size = STATION_SIZE): string {
  const order = mood.key === 'wind' ? 'ordered from the liveliest to the softest' : 'in a good listening order';
  const list = pool.map((t, i) => `${i + 1}. ${t.title.replace(/\s+/g, ' ')} — ${t.artist.replace(/\s+/g, ' ')}`).join('\n');
  return [
    `Pick a music station called "${mood.title}" for ${mood.brief}.`,
    `Below are songs from my Spotify liked songs, numbered. Choose up to ${size} that fit best, ${order}.`,
    'Reply with the numbers only, separated by commas, and no other text.',
    '',
    list,
  ].join('\n');
}

/**
 * The brain's answer → 0-based indices into the pool, in its order, without
 * repeats or out-of-range numbers. Prefers the longest comma- or line-
 * separated run of numbers, so a preamble ("Here are 25 picks:") does not
 * smuggle its count in as a pick.
 */
export function parseStationPicks(text: string, poolSize: number, max = STATION_SIZE): number[] {
  const runs = text.match(/\d+(?:\s*[,;\n]\s*\d+)+/g);
  const source = runs && runs.length ? runs.reduce((a, b) => (b.split(/[,;\n]/).length > a.split(/[,;\n]/).length ? b : a)) : text;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const m of source.match(/\d+/g) ?? []) {
    const i = Number(m) - 1;
    if (i < 0 || i >= poolSize || seen.has(i)) continue;
    seen.add(i);
    out.push(i);
    if (out.length >= max) break;
  }
  return out;
}

// --- Rooms ---------------------------------------------------------------------------

/** The id the rooms list gives this Mac, which Spotify does not list (Atlas is not a Connect device). */
export const THIS_MAC = 'this-mac';

export type RoomIcon = 'mac' | 'speaker' | 'iphone' | 'display';

export interface Room {
  id: string;
  name: string;
  detail: string;
  icon: RoomIcon;
  active: boolean;
  /** 0–100, or null when the device keeps its volume to itself. */
  volume: number | null;
  restricted: boolean;
}

export function roomIcon(type: string): RoomIcon {
  const t = type.toLowerCase();
  if (t === 'computer') return 'mac';
  if (t === 'smartphone' || t === 'tablet') return 'iphone';
  if (t === 'tv' || t === 'stb' || t === 'gameconsole') return 'display';
  return 'speaker';
}

/**
 * This Mac first, then the account's Connect devices. This Mac is the room
 * when Atlas holds the record, or when nothing is playing anywhere (that is
 * where Atlas would play it); a Connect device is the room when Spotify says
 * it is active and Atlas is not the player.
 */
export function roomsFrom(
  devices: readonly Device[],
  o: { atlasOwnsAudio: boolean; isPlaying: boolean; macVolume: number },
): Room[] {
  const remoteActive = !o.atlasOwnsAudio && devices.some((d) => d.active);
  const state = (on: boolean) => (on ? (o.isPlaying ? ' · playing' : ' · paused') : '');
  const mac: Room = {
    id: THIS_MAC,
    name: 'This Mac',
    detail: `Atlas, on this Mac${o.atlasOwnsAudio ? state(true) : ''}`,
    icon: 'mac',
    active: !remoteActive,
    volume: Math.round(clamp01(o.macVolume) * 100),
    restricted: false,
  };
  return [mac, ...devices.map<Room>((d) => {
    const active = remoteActive && d.active;
    return {
      id: d.id,
      name: d.name,
      detail: `${d.type === 'Unknown' ? 'Spotify Connect' : d.type}${d.restricted ? ' · no remote control' : state(active)}`,
      icon: roomIcon(d.type),
      active,
      volume: d.supportsVolume ? d.volume : null,
      restricted: d.restricted,
    };
  })];
}

export type RoomMove =
  | { kind: 'stay' }
  /** Pause the Connect device (when one is playing) and load the record here at its position. */
  | { kind: 'to-mac'; from: string | null }
  /** Start the record (and what follows it) on the device at the engine's position, then release the engine. */
  | { kind: 'mac-to-device'; to: string }
  /** A plain Connect transfer between two of the account's devices. */
  | { kind: 'device-to-device'; to: string }
  | { kind: 'blocked'; reason: string };

/** What choosing `target` in Rooms has to do, given where the record is now. */
export function roomMove(
  target: string,
  o: { hasTrack: boolean; atlasOwnsAudio: boolean; activeDeviceId: string | null; targetRestricted?: boolean },
): RoomMove {
  const here = o.atlasOwnsAudio || !o.activeDeviceId ? THIS_MAC : o.activeDeviceId;
  if (target === here) return { kind: 'stay' };
  if (o.targetRestricted) return { kind: 'blocked', reason: 'This device does not take remote control from Spotify.' };
  if (!o.hasTrack) return { kind: 'blocked', reason: 'Start something first, then move it to a room.' };
  if (target === THIS_MAC) return { kind: 'to-mac', from: o.activeDeviceId };
  if (o.atlasOwnsAudio) return { kind: 'mac-to-device', to: target };
  return { kind: 'device-to-device', to: target };
}

/**
 * What a speaker is handed when a record moves off this Mac: the record, then
 * the tracks after it in Up next (no wrap), so the speaker keeps playing the
 * queue. Episodes go alone — a show does not continue into the liked songs.
 */
export function handoffUris(queue: readonly Track[], current: Track, max = 50): string[] {
  if (current.kind === 'episode') return [current.uri];
  const i = queue.findIndex((t) => t.id === current.id);
  const rest = i < 0 ? [] : queue.slice(i + 1).filter((t) => t.kind !== 'episode' && t.uri.startsWith('spotify:track:'));
  return [current.uri, ...rest.map((t) => t.uri)].slice(0, Math.max(1, max));
}

// --- Podcast resume ------------------------------------------------------------------

/** Within this of the end, an episode counts as finished and starts over. */
export const RESUME_TAIL_MS = 30_000;
/** Less than this in is not worth resuming. */
export const RESUME_MIN_MS = 5_000;

/**
 * Where an episode starts. Atlas's own record wins: it is where the user was
 * last here, and Spotify's resume point does not move for Atlas's playback
 * (librespot is not a Connect device). Without one, Spotify's point (from the
 * phone, say) is used unless Spotify marks the episode played.
 */
export function resumeFrom(o: {
  local: { positionMs: number } | null;
  spotify: { positionMs: number; fullyPlayed: boolean } | null;
  durationMs: number;
}): number {
  const pos = o.local ? o.local.positionMs : o.spotify && !o.spotify.fullyPlayed ? o.spotify.positionMs : 0;
  if (!Number.isFinite(pos) || pos < RESUME_MIN_MS) return 0;
  if (o.durationMs > 0 && pos >= o.durationMs - RESUME_TAIL_MS) return 0;
  return Math.floor(pos);
}

/** "32 min left", "Played", "48 min" — an episode row's right-hand line. */
export function episodeLeft(durationMs: number, positionMs: number): string {
  const total = Math.max(0, durationMs);
  if (positionMs >= RESUME_MIN_MS && total > 0 && positionMs >= total - RESUME_TAIL_MS) return 'Played';
  if (positionMs >= RESUME_MIN_MS && positionMs < total) return `${Math.max(1, Math.round((total - positionMs) / 60000))} min left`;
  return `${Math.max(1, Math.round(total / 60000))} min`;
}
