/**
 * The music queue store — Up next, shuffle, repeat, the output volume,
 * ducking, Like, the mood stations, Rooms and podcast resume points — as ONE
 * module, so playback goes on wherever the user is.
 *
 * Why it lives here and not in BetaMusic: the Rust engine holds one record at
 * a time (`music_engine.rs`), so "what comes next" has always been webview
 * state. While it lived in the page, the queue only advanced with Music open:
 * leave for Mail and the record ended into silence. Now BetaShell mounts
 * `MusicDriver` (one lazy import, one element, as Clock mounts its ringing
 * dialog), which boots this store for the run. The store holds the music
 * bridge open exactly while Atlas's engine holds a record (`subscribeEngine`),
 * so it hears a track end on any screen and hands the engine the next one —
 * and it costs nothing while nothing is loaded.
 *
 * What leaves the Mac from here: Like and Rooms call Spotify's Web API
 * through music.rs; a mood station sends the titles and artists of up to 200
 * liked songs to Atlas's brain, which asks its AI model to pick. Ducking,
 * Wind down and the podcast resume points stay on this Mac.
 *
 * The pure rules (what is next, what a room move means, how far ducking
 * drops) are in src/lib/betaMusic.ts with their tests.
 */
import { useSyncExternalStore } from 'react';
import {
  engineHoldsUri, engineUriNow, getMusicSnapshot, musicActions, musicBridgeAvailable, musicInvoke, subscribeEngine,
  subscribeMusic, type MusicSnapshot,
} from '@/hooks/useMusicPlayer';
import { getAtlasState, subscribeAtlasState } from '@/lib/atlasStateBus';
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';
import { parseBrainLine } from '@/lib/brainSse';
import {
  DEFAULT_PREFS, DUCK_RESTORE_MS, PREFS_KEY, STATION_POOL, STATION_SIZE, THIS_MAC, WIND_MAX_STEPS, WIND_STEP_MS,
  afterEnd, effectiveVolume, handoffUris, moodOf, neighbour, parsePrefs, parseStationPicks, prevIntent, roomMove,
  sameSource, shouldDuck, startOf, stationPrompt,
  type MoodKey, type MusicPrefs, type QueueSource,
} from '@/lib/betaMusic';
import { isEpisode, normalizeDevices, normalizeTrack, type Device, type RawTrack, type Track } from '@/lib/musicSpotify';

export interface RoomsState {
  status: 'idle' | 'loading' | 'error';
  error: string | null;
  /** `Date.now()` of the last answer, 0 before the first. */
  at: number;
  /** The room a move is under way to. */
  moving: string | null;
}

export interface QueueSnapshot {
  source: QueueSource;
  /** The list for every source but the liked songs, which stay live in the music store. */
  tracks: Track[];
  prefs: MusicPrefs;
  /** True while Atlas has lowered the music for a turn. */
  ducked: boolean;
  /** Wind down's steps taken so far (each a little softer). */
  windSteps: number;
  /** The track announced as Up next — under shuffle, the one already drawn. */
  nextUp: Track | null;
  /** Known Like state per track id; absent until Spotify has been asked. */
  liked: Record<string, boolean>;
  likeBusy: boolean;
  /** A mood station Atlas is picking, or why it could not. */
  station: { mood: MoodKey; status: 'picking' | 'error'; note: string } | null;
  devices: Device[];
  rooms: RoomsState;
  /** One line for the screens: a refused like, a failed move, an unavailable record. */
  notice: string | null;
  /** Bumped whenever a resume point is written, so Home and Podcast re-read. */
  resumeTick: number;
}

function readPrefs(): MusicPrefs {
  try { return parsePrefs(window.localStorage.getItem(PREFS_KEY)); } catch { return { ...DEFAULT_PREFS }; }
}
function writePrefs(p: MusicPrefs): void {
  // A per-Mac convenience: a private window or blocked storage just forgets.
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* nothing to do */ }
}

let state: QueueSnapshot = {
  source: { kind: 'library' },
  tracks: [],
  prefs: typeof window === 'undefined' ? { ...DEFAULT_PREFS } : readPrefs(),
  ducked: false,
  windSteps: 0,
  nextUp: null,
  liked: {},
  likeBusy: false,
  station: null,
  devices: [],
  rooms: { status: 'idle', error: null, at: 0, moving: null },
  notice: null,
  resumeTick: 0,
};

const listeners = new Set<() => void>();

/** Replace the snapshot (new identity on every write, as `useSyncExternalStore` needs) and notify. */
function set(next: Partial<QueueSnapshot>): void {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

function subscribeQueue(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const getQueue = (): QueueSnapshot => state;

// --- reading the music store -------------------------------------------------------

/** The list Up next shows and Next steps through. The liked songs stay live. */
export function queueOf(q: Pick<QueueSnapshot, 'source' | 'tracks'>, library: readonly Track[]): readonly Track[] {
  return q.source.kind === 'library' ? library : q.tracks;
}

const queueTracks = (): readonly Track[] => queueOf(state, getMusicSnapshot().library);
const current = (): Track | null => getMusicSnapshot().nowPlaying?.track ?? null;

/** Atlas can hand the engine a record: the bridge is there, Spotify is connected, the account is Premium. */
function canQueue(snap: MusicSnapshot = getMusicSnapshot()): boolean {
  return snap.available && snap.connected && snap.premium;
}

function atlasOwns(snap: MusicSnapshot, t: Track | null): boolean {
  return !!t && snap.audioReady && engineHoldsUri(t.uri);
}

/** Like state for a track: the answer Spotify gave, or true for anything in the liked songs. */
export function likedOf(q: Pick<QueueSnapshot, 'liked'>, library: readonly Track[], t: Track | null): boolean | undefined {
  if (!t) return undefined;
  if (t.id in q.liked) return q.liked[t.id];
  return library.some((x) => x.id === t.id) ? true : undefined;
}

function drawNextUp(cur: Track | null): Track | null {
  const q = queueTracks();
  if (!cur || !q.some((t) => t.id === cur.id)) return null;
  return neighbour(q, cur.id, 1, state.prefs.shuffle);
}

// --- transport -------------------------------------------------------------------------

/**
 * Hand the engine `t` with its record (so every surface shows it), optionally
 * switching lists, at `positionMs` (a podcast's resume point; a record a room
 * hands back).
 */
async function playTrack(t: Track, next?: { source: QueueSource; tracks: Track[] }, positionMs = 0): Promise<void> {
  if (!canQueue()) return;
  if (next) {
    const changed = !sameSource(next.source, state.source);
    set({ source: next.source, tracks: next.tracks, ...(changed ? { windSteps: 0, station: null } : {}) });
    if (changed) applyVolume();
  }
  set({ notice: null });
  try {
    await musicActions.load(t.uri, t, positionMs);
  } catch {
    // `useMusicPlayer` puts it on `error`, which the screens show.
  }
}

/** Start a list: its first track, or with shuffle any of them. */
async function playList(source: QueueSource, tracks: Track[], keepOrder = false): Promise<void> {
  const first = startOf(tracks, state.prefs.shuffle && !keepOrder);
  if (first) await playTrack(first, { source, tracks });
}

async function playLibrary(): Promise<void> {
  const lib = getMusicSnapshot().library;
  const first = startOf(lib, state.prefs.shuffle);
  if (first) await playTrack(first, { source: { kind: 'library' }, tracks: [] });
}

function next(): void {
  const q = queueTracks();
  const cur = current();
  const up = state.nextUp;
  const t = up && up.id !== cur?.id && q.some((x) => x.id === up.id) ? up : neighbour(q, cur?.id ?? null, 1, state.prefs.shuffle);
  if (t) void playTrack(t);
}

/** The design's rule: more than four seconds in, Previous restarts the track. */
function prev(): void {
  const snap = getMusicSnapshot();
  const cur = current();
  if (cur && atlasOwns(snap, cur) && cur.durationMs > 0 && prevIntent(musicActions.readPosition()) === 'restart') {
    musicActions.seek(0).catch(() => {});
    return;
  }
  const t = neighbour(queueTracks(), cur?.id ?? null, -1, state.prefs.shuffle);
  if (t) void playTrack(t);
}

/**
 * Play/pause, everywhere. Pause only means pause when Atlas is the one
 * playing (see useMusicSurface). Otherwise the press plays the record here —
 * loading it when the engine does not hold it or has finished it, resuming
 * when it does — and when another device was playing it, that device is
 * paused first, so the record moves rather than doubles. With nothing showing
 * at all it starts Up next.
 */
async function togglePlay(): Promise<void> {
  const snap = getMusicSnapshot();
  if (!canQueue(snap)) return;
  const np = snap.nowPlaying;
  const cur = np?.track ?? null;
  if (!cur) {
    const first = startOf(queueTracks(), state.prefs.shuffle);
    if (first) await playTrack(first);
    return;
  }
  const owns = atlasOwns(snap, cur);
  if (np?.isPlaying && owns) { await musicActions.pause().catch(() => {}); return; }
  if (np?.isPlaying && !owns) { await takeHere(cur, true, state.devices.find((d) => d.active)?.id ?? null); return; }
  if (np?.ended || !engineHoldsUri(cur.uri) || snap.unavailable === cur.uri) {
    // An episode picks up where its record says; music starts from the top.
    const at = isEpisode(cur) && !np?.ended ? musicActions.readPosition() : 0;
    await playTrack(cur, undefined, at);
    return;
  }
  await musicActions.play().catch(() => {});
}

function setPrefs(nextPrefs: Partial<MusicPrefs>): void {
  const prefs = { ...state.prefs, ...nextPrefs };
  writePrefs(prefs);
  const ducked = prefs.duck ? state.ducked : false;
  if (ducked !== state.ducked && restoreTimer) { window.clearTimeout(restoreTimer); restoreTimer = 0; }
  set({ prefs, ducked });
  if (nextPrefs.shuffle !== undefined) set({ nextUp: drawNextUp(current()) });
  // Turning ducking on mid-turn ducks now; off restores now.
  if (nextPrefs.duck !== undefined) onBus();
  applyVolume();
}

// --- volume: the user's level, ducking, Wind down --------------------------------------

/** The value last handed the engine, so a push twice a second does not re-send it. */
let lastApplied: number | null = null;

/**
 * Give the engine the volume it should have now. Only when the engine is up
 * and holds a record: `music_volume` on a cold engine would START librespot
 * (send_cmd → ensure_engine), which is not this function's business.
 */
function applyVolume(): void {
  const snap = getMusicSnapshot();
  if (!snap.audioReady || !engineUriNow()) return;
  const v = effectiveVolume(state.prefs.volume, state.ducked, state.windSteps);
  if (lastApplied !== null && Math.abs(v - lastApplied) < 0.001) return;
  lastApplied = v;
  musicActions.setVolume(v).catch(() => { lastApplied = null; });
}

let restoreTimer = 0;

/**
 * Ducking: while Atlas listens, thinks or speaks (the state bus), lower the
 * engine; restore it a moment after the turn ends. The store does not need
 * the music to be playing to decide — `applyVolume` only touches a live
 * engine.
 */
function onBus(): void {
  const want = shouldDuck(getAtlasState().state, state.prefs.duck);
  if (want) {
    if (restoreTimer) { window.clearTimeout(restoreTimer); restoreTimer = 0; }
    if (!state.ducked) { set({ ducked: true }); applyVolume(); }
    return;
  }
  if (!state.ducked) return;
  if (!state.prefs.duck) { set({ ducked: false }); applyVolume(); return; }
  if (restoreTimer) return;
  restoreTimer = window.setTimeout(() => {
    restoreTimer = 0;
    if (shouldDuck(getAtlasState().state, state.prefs.duck)) return;
    set({ ducked: false });
    applyVolume();
  }, DUCK_RESTORE_MS);
}

let windTimer = 0;

/** Wind down plays a little softer every ten minutes of playing. Other stations reset it. */
function syncWind(snap: MusicSnapshot): void {
  const on = state.source.kind === 'mood' && state.source.mood === 'wind'
    && !!snap.nowPlaying?.isPlaying && atlasOwns(snap, snap.nowPlaying?.track ?? null);
  if (on && !windTimer) {
    windTimer = window.setInterval(() => {
      if (state.windSteps >= WIND_MAX_STEPS) return;
      set({ windSteps: state.windSteps + 1 });
      applyVolume();
    }, WIND_STEP_MS);
  } else if (!on && windTimer) {
    window.clearInterval(windTimer);
    windTimer = 0;
  }
}

// --- Like ------------------------------------------------------------------------------

const likeAsked = new Set<string>();

/** Ask Spotify which of `ids` are liked (once per id per run), 50 at a time. */
async function checkLiked(ids: readonly string[]): Promise<void> {
  const lib = getMusicSnapshot().library;
  const todo = ids.filter((id) => !(id in state.liked) && !likeAsked.has(id) && !lib.some((t) => t.id === id));
  if (!todo.length || !getMusicSnapshot().connected) return;
  todo.forEach((id) => likeAsked.add(id));
  for (let i = 0; i < todo.length; i += 50) {
    const batch = todo.slice(i, i + 50);
    try {
      const answer = await musicInvoke<boolean[]>('music_saved_contains', { ids: batch });
      const liked = { ...state.liked };
      batch.forEach((id, k) => { if (typeof answer?.[k] === 'boolean') liked[id] = answer[k]; });
      set({ liked });
    } catch {
      batch.forEach((id) => likeAsked.delete(id));
    }
  }
}

function likeError(e: unknown): string {
  const msg = String(e);
  if (/\b403\b|scope/i.test(msg)) return 'Spotify refused: the connection Atlas has cannot change your library. Reconnect Spotify to turn on Like.';
  return `Could not change your Liked Songs: ${msg}`;
}

async function toggleLike(t: Track): Promise<void> {
  if (state.likeBusy || isEpisode(t)) return;
  const was = likedOf(state, getMusicSnapshot().library, t) === true;
  set({ likeBusy: true, liked: { ...state.liked, [t.id]: !was }, notice: null });
  try {
    await musicInvoke('music_save_tracks', { ids: [t.id], save: !was });
    musicActions.markLiked(t, !was);
  } catch (e) {
    set({ liked: { ...state.liked, [t.id]: was }, notice: likeError(e) });
  } finally {
    set({ likeBusy: false });
  }
}

// --- mood stations ---------------------------------------------------------------------

/** Up to STATION_POOL liked songs, read for the pick (not the Up next list, which pages on its own). */
async function likedPool(): Promise<Track[]> {
  const out: Track[] = [];
  const seen = new Set<string>();
  for (let offset = 0; offset < STATION_POOL; offset += 50) {
    const page = await musicInvoke<{ items?: { track: RawTrack }[] }>('music_library_tracks', { offset, limit: 50 });
    const items = page?.items ?? [];
    for (const i of items) {
      const t = normalizeTrack(i.track);
      if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); }
    }
    if (items.length < 50) break;
  }
  return out;
}

/**
 * One plain question to the brain's `/chat` — no memory, no tools, nothing
 * written anywhere — streamed and joined. The answer is a list of numbers.
 */
async function askBrainPlain(prompt: string): Promise<string> {
  const token = getToken();
  if (!token) throw new Error('Sign in to Atlas so it can pick a station.');
  const brain = await getBrainEndpoint();
  if (!brain) throw new Error('Stations are picked by Atlas in the desktop app.');
  const res = await fetch(`${brain.baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-sidecar-token': brain.token },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) {
    if (res.status === 429) throw new Error('Atlas is rate-limited right now. Try again in a moment.');
    throw new Error(`Atlas did not answer (HTTP ${res.status}).`);
  }
  if (!res.body) throw new Error('Atlas sent an empty reply.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  outer: for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const ev = parseBrainLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (!ev) continue;
      if (ev.kind === 'done') break outer;
      if (ev.kind === 'text') text += ev.delta;
    }
  }
  return text;
}

/** The last picks per station, for this run: tapping a station again re-picks. */
const stationCache = new Map<MoodKey, Track[]>();

async function startStation(mood: MoodKey): Promise<void> {
  if (state.station?.status === 'picking') return;
  if (!canQueue()) return;
  const m = moodOf(mood);
  set({ station: { mood, status: 'picking', note: 'Reading your liked songs…' }, notice: null });
  try {
    const pool = await likedPool();
    if (pool.length < 5) throw new Error('Atlas picks stations from your liked songs, and this account has too few. Like a few more on Spotify.');
    set({ station: { mood, status: 'picking', note: `Atlas is picking from ${pool.length} liked songs…` } });
    const answer = await askBrainPlain(stationPrompt(m, pool));
    const picks = parseStationPicks(answer, pool.length, STATION_SIZE).map((i) => pool[i]);
    if (!picks.length) throw new Error('Atlas did not pick anything this time. Try again.');
    stationCache.set(mood, picks);
    set({ station: null });
    // Atlas's order is the point (Wind down gets gentler as it goes), so the station starts at its top.
    await playList({ kind: 'mood', mood }, picks, true);
  } catch (e) {
    set({ station: { mood, status: 'error', note: e instanceof Error ? e.message : String(e) } });
  }
}

// --- Rooms ------------------------------------------------------------------------------

function roomsError(e: unknown): string {
  const msg = String(e);
  if (/\b401\b|\b403\b|scope/i.test(msg)) return 'Spotify refused: the connection Atlas has cannot see your speakers. Reconnect Spotify to turn on Rooms.';
  return `Could not reach your speakers: ${msg}`;
}

async function refreshRooms(): Promise<void> {
  const snap = getMusicSnapshot();
  if (!snap.available || !snap.connected) return;
  set({ rooms: { ...state.rooms, status: 'loading' } });
  try {
    const raw = await musicInvoke<Parameters<typeof normalizeDevices>[0]>('music_devices');
    set({ devices: normalizeDevices(raw), rooms: { ...state.rooms, status: 'idle', error: null, at: Date.now() } });
  } catch (e) {
    set({ rooms: { ...state.rooms, status: 'error', error: roomsError(e), at: Date.now() } });
  }
}

/**
 * Bring a record playing on another device here: pause that device (the one
 * named, or whichever is active), then load the record in Atlas at the
 * position it had reached, so it moves rather than plays twice.
 */
async function takeHere(cur: Track, playingElsewhere: boolean, from: string | null): Promise<void> {
  const at = Math.floor(musicActions.readPosition());
  if (playingElsewhere) await musicInvoke('music_remote_pause', from ? { deviceId: from } : {}).catch(() => {});
  await playTrack(cur, undefined, at);
}

/** Move what is playing to `roomId` (THIS_MAC or a Connect device id). See `roomMove`. */
async function moveTo(roomId: string): Promise<void> {
  const snap = getMusicSnapshot();
  const cur = snap.nowPlaying?.track ?? null;
  const owns = atlasOwns(snap, cur);
  const active = state.devices.find((d) => d.active) ?? null;
  const target = state.devices.find((d) => d.id === roomId) ?? null;
  const mv = roomMove(roomId, {
    hasTrack: !!cur,
    atlasOwnsAudio: owns,
    activeDeviceId: active?.id ?? null,
    targetRestricted: target?.restricted,
  });
  if (mv.kind === 'stay') return;
  if (mv.kind === 'blocked') { set({ notice: mv.reason }); return; }
  if (!cur) return;
  set({ rooms: { ...state.rooms, moving: roomId }, notice: null });
  try {
    if (mv.kind === 'to-mac') {
      await takeHere(cur, !!snap.nowPlaying?.isPlaying && !owns, mv.from);
    } else if (mv.kind === 'mac-to-device') {
      const at = Math.floor(musicActions.readPosition());
      await musicInvoke('music_play_on', { deviceId: mv.to, uris: handoffUris(queueTracks(), cur), positionMs: at });
      await musicActions.releaseEngine();
    } else {
      await musicInvoke('music_transfer', { deviceId: mv.to, play: !!snap.nowPlaying?.isPlaying });
      window.setTimeout(() => { void musicActions.refreshNowPlaying(); }, 900);
    }
  } catch (e) {
    set({ notice: roomsError(e) });
  } finally {
    set({ rooms: { ...state.rooms, moving: null } });
    window.setTimeout(() => { void refreshRooms(); }, 1200);
  }
}

const volumeTimers = new Map<string, number>();

/** A room's volume, 0–100. This Mac is Atlas's own engine; the others are set through Spotify, debounced. */
function setRoomVolume(roomId: string, percent: number): void {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  if (roomId === THIS_MAC) { setPrefs({ volume: p / 100 }); return; }
  set({ devices: state.devices.map((d) => (d.id === roomId ? { ...d, volume: p } : d)) });
  const t = volumeTimers.get(roomId);
  if (t) window.clearTimeout(t);
  volumeTimers.set(roomId, window.setTimeout(() => {
    volumeTimers.delete(roomId);
    musicInvoke('music_device_volume', { deviceId: roomId, percent: p }).catch((e) => set({ notice: roomsError(e) }));
  }, 250));
}

// --- podcast resume points ------------------------------------------------------------

let resumeMark = { id: null as string | null, at: 0, pos: -1 };
const RESUME_EVERY_MS = 15_000;

/**
 * While Atlas plays an episode, keep its place on this Mac (`music_resume`):
 * every fifteen seconds, on pause, and at the end. Spotify's own resume point
 * does not move for Atlas's playback, so this is what Podcast resumes from.
 */
function trackResume(snap: MusicSnapshot): void {
  const np = snap.nowPlaying;
  const t = np?.track ?? null;
  if (!np || !t || !isEpisode(t) || !engineHoldsUri(t.uri)) return;
  const pos = np.ended ? t.durationMs : Math.floor(musicActions.readPosition());
  const now = Date.now();
  const due = resumeMark.id !== t.id
    || (np.isPlaying ? now - resumeMark.at >= RESUME_EVERY_MS : Math.abs(pos - resumeMark.pos) >= 1000);
  if (!due) return;
  resumeMark = { id: t.id, at: now, pos };
  musicInvoke('music_resume_set', {
    itemId: t.id,
    uri: t.uri,
    positionMs: Math.max(0, pos),
    durationMs: Math.max(0, t.durationMs),
    meta: { title: t.title, artist: t.artist, album: t.album, artUrl: t.artUrl, durationMs: t.durationMs, year: t.year ?? null, kind: 'episode' },
  }).then(() => set({ resumeTick: state.resumeTick + 1 })).catch(() => {});
}

// --- the engine bridge ----------------------------------------------------------------

let unsubMusic: (() => void) | null = null;
/** The record the queue already advanced from, so one ending advances once. */
let advancedFor: string | null = null;
let lastTrackId: string | null = null;
let handledUnavailable: string | null = null;

function onTrackChanged(cur: Track | null): void {
  set({ nextUp: drawNextUp(cur) });
  if (cur && !isEpisode(cur)) void checkLiked([cur.id]);
}

function onUnavailable(cur: Track | null): void {
  if (!cur) return;
  if (isEpisode(cur)) {
    set({ notice: 'This episode can’t play inside Atlas: Spotify has no audio Atlas may decode for it. Play it on one of your speakers instead.' });
    return;
  }
  const inQueue = queueTracks().some((t) => t.id === cur.id);
  set({ notice: `“${cur.title}” can’t play in Atlas${inQueue ? ', so Up next moved on' : ''}.` });
  if (inQueue && !state.prefs.repeat) next();
}

/** Runs on every music snapshot while the engine holds a record — twice a second while playing, so it stays light. */
function onMusic(): void {
  const snap = getMusicSnapshot();
  if (snap.audioReady) applyVolume(); else lastApplied = null;
  const np = snap.nowPlaying;
  const cur = np?.track ?? null;
  if ((cur?.id ?? null) !== lastTrackId) { lastTrackId = cur?.id ?? null; onTrackChanged(cur); }
  if (snap.unavailable && snap.unavailable !== handledUnavailable) {
    handledUnavailable = snap.unavailable;
    onUnavailable(cur);
  } else if (!snap.unavailable) handledUnavailable = null;
  // Advance when the engine reports the end of a record. Once per ending: the
  // guard is cleared only by real progress on the next record, so a load that
  // fails (and restores the ended record) cannot retry in a loop.
  if (np && cur) {
    if (!np.ended) { if (np.positionMs > 0) advancedFor = null; }
    else if (advancedFor !== cur.id && canQueue(snap)) {
      advancedFor = cur.id;
      const t = afterEnd(queueTracks(), cur, state.prefs.repeat, state.prefs.shuffle, Math.random, state.nextUp);
      if (t) void playTrack(t);
    }
  }
  trackResume(snap);
  syncWind(snap);
}

/** Hold the bridge exactly while the engine holds a record. */
function onEngine(): void {
  const holds = engineUriNow() !== null;
  if (holds && !unsubMusic) {
    // A record that had already ended before the store began counts as handled:
    // starting Atlas must not start something by itself.
    const np = getMusicSnapshot().nowPlaying;
    if (np?.ended) advancedFor = np.track?.id ?? null;
    unsubMusic = subscribeMusic(onMusic);
    onMusic();
  } else if (!holds && unsubMusic) {
    unsubMusic();
    unsubMusic = null;
    lastApplied = null;
    syncWind(getMusicSnapshot());
  }
}

let boots = 0;
let unsubBus: (() => void) | null = null;
let unsubEngine: (() => void) | null = null;

/**
 * Start the store for the run (MusicDriver, from BetaShell). Ref-counted, so
 * a StrictMode double mount or a second caller cannot register twice.
 * Returns the release.
 */
export function bootMusicQueue(): () => void {
  boots++;
  if (boots === 1 && musicBridgeAvailable) {
    unsubBus = subscribeAtlasState(onBus);
    unsubEngine = subscribeEngine(onEngine);
    onEngine();
    onBus();
  }
  return () => {
    boots = Math.max(0, boots - 1);
    if (boots > 0) return;
    unsubBus?.(); unsubBus = null;
    unsubEngine?.(); unsubEngine = null;
    unsubMusic?.(); unsubMusic = null;
    if (windTimer) { window.clearInterval(windTimer); windTimer = 0; }
    if (restoreTimer) { window.clearTimeout(restoreTimer); restoreTimer = 0; }
  };
}

/** Everything that is not a snapshot field. Frozen module identity. */
const QUEUE_ACTIONS = {
  playTrack,
  playList,
  playLibrary,
  next,
  prev,
  togglePlay,
  setPrefs,
  toggleLike,
  checkLiked,
  startStation,
  refreshRooms,
  moveTo,
  setRoomVolume,
  clearNotice: () => set({ notice: null }),
  /** The picks a station made earlier in this run, if any. */
  stationPicks: (mood: MoodKey): readonly Track[] | null => stationCache.get(mood) ?? null,
} as const;

export const musicQueue = QUEUE_ACTIONS;

export type MusicQueue = QueueSnapshot & typeof QUEUE_ACTIONS;

/**
 * The queue store as a hook. It does NOT open the music bridge — a surface
 * that shows the record calls `useMusicPlayer` for that.
 */
export function useMusicQueue(): QueueSnapshot {
  return useSyncExternalStore(subscribeQueue, getQueue, getQueue);
}
