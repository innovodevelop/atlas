import { useMemo, useSyncExternalStore } from 'react';

// Provider-agnostic music player hook (Spotify first). Audio + catalog come from
// the LOCAL Rust backend (music.rs): OAuth via the atlas:// deep link, browse/
// search/state via the Spotify Web API, and librespot in-app audio with a
// per-frame level feed for the Sphere visualizer. In the browser preview there's
// no Tauri backend, so everything degrades to an "open in the desktop app"
// state (available=false).
//
// ONE STORE, NOT ONE PER MOUNT — read this before adding a call site.
//
// This used to be a plain hook. Every call site got its own state, its own
// `music_status` round-trip (which does a blocking `GET /me` in Rust) and its
// own `listen()` registration for all three Tauri events. Five components call
// it — band narration (mounted for the life of the dashboard), the Now-Playing
// widget, the full player, the widget catalog and Settings → Music — so the app
// routinely held two to four copies of a state that describes ONE process-wide
// librespot engine. `music:level` fires at 30Hz and was being delivered N times
// per tick; each `music:now_playing` push ran N metadata pulls.
//
// So the store below is module-scoped and the hook is a `useSyncExternalStore`
// view onto it. The bridge (listeners + first status pull) starts with the first
// subscriber and stops with the last, and it is impossible for two mounted
// surfaces to register the same listener twice: there is only ever one
// registration, held here.

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// --- Normalized view models (only the fields the UI uses) ------------------

export interface Track {
  id: string;
  uri: string;
  title: string;
  artist: string;
  album: string;
  artUrl: string | null;
  durationMs: number;
}

export interface Playlist {
  id: string;
  name: string;
  imageUrl: string | null;
  trackCount: number;
}

export interface NowPlaying {
  track: Track | null;
  isPlaying: boolean;
  /**
   * Position at the last authoritative sync — a Spotify Web API pull or an
   * engine push, NOT a live clock. It moves at most twice a second and stands
   * still between pushes. Anything drawing a progress indicator should call
   * `readPosition()` instead, which interpolates from the same anchor — freely
   * when the anchor is Atlas's own engine, and only within `REMOTE_LEAD_MS`
   * when it is a snapshot of a device Atlas cannot observe.
   */
  positionMs: number;
  deviceName: string | null;
}

export interface SearchResults {
  tracks: Track[];
  playlists: Playlist[];
}

/** Audio level feed for the visualizer (RMS amplitude + 3 bands, 0..1). */
export interface AudioLevel {
  amp: number;
  bands: [number, number, number];
}

interface MusicStatus {
  available: boolean;
  connected: boolean;
  premium: boolean;
  audio_ready: boolean;
  device_name: string;
}

// --- Raw Spotify JSON shapes (partial) -------------------------------------

interface RawImage { url: string; width?: number; height?: number }
interface RawArtist { name: string }
interface RawTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists?: RawArtist[];
  album?: { name?: string; images?: RawImage[] };
}

/** What `music_engine.rs` puts on `music:now_playing`. */
interface EnginePosition {
  is_playing?: boolean;
  /** Absent on TrackChanged, which means "re-pull the metadata". */
  position_ms?: number | null;
}

/**
 * The Spotify URI the local librespot engine currently holds, or null.
 *
 * MODULE scope on purpose: the Rust engine is a process singleton, so "what is
 * loaded" is process state, not component state.
 */
let engineUri: string | null = null;

/**
 * Whether the local engine is DECODING right now, as opposed to merely holding
 * a track. Also module state, for the same reason.
 *
 * This is what decides whether `/v1/me/player` may be consulted at all. While
 * librespot is playing, that endpoint cannot describe Atlas — Atlas drives the
 * Player directly and is not a Spotify Connect device — so it answers 204
 * exactly when Atlas is the only thing making sound.
 */
let enginePlaying = false;

/**
 * Whether the engine already holds this URI. False on a cold launch even for an
 * entitled Premium user — nothing in the app calls `music_load` until the user
 * presses play, so `music_play` on its own would start a player with an empty
 * queue and produce silence.
 */
export const engineHoldsUri = (uri: string | null | undefined): boolean =>
  !!uri && engineUri === uri;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

const nowMs = () =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

const firstImage = (images?: RawImage[]): string | null =>
  images && images.length ? images[0].url : null;

function normalizeTrack(t: RawTrack | null | undefined): Track | null {
  if (!t || !t.id) return null;
  return {
    id: t.id,
    uri: t.uri,
    title: t.name,
    artist: (t.artists ?? []).map((a) => a.name).join(', '),
    album: t.album?.name ?? '',
    artUrl: firstImage(t.album?.images),
    durationMs: t.duration_ms ?? 0,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

interface MusicSnapshot {
  available: boolean;
  connected: boolean;
  premium: boolean;
  audioReady: boolean;
  nowPlaying: NowPlaying | null;
  library: Track[];
  playlists: Playlist[];
  isConnecting: boolean;
  error: string | null;
}

let snapshot: MusicSnapshot = {
  available: isTauri,
  connected: false,
  premium: false,
  audioReady: false,
  nowPlaying: null,
  library: [],
  playlists: [],
  isConnecting: false,
  error: null,
};

const subscribers = new Set<() => void>();

/**
 * Replace the snapshot and notify. The object identity MUST change on every
 * write and MUST NOT change otherwise — `useSyncExternalStore` compares
 * snapshots by identity and would either miss an update or loop forever.
 */
function patch(next: Partial<MusicSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const fn of subscribers) fn();
}

const getSnapshot = () => snapshot;

/**
 * Live audio energy for the visualizer. One ref for the whole app: the feed
 * describes one engine, and every surface reading it wants the same numbers.
 * Written by the `music:level` listener ~30 times a second and never put in
 * state, so it causes zero React renders.
 */
const levelRef: { current: AudioLevel } = { current: { amp: 0, bands: [0, 0, 0] } };

/**
 * The playback clock, as an ANCHOR rather than an accumulator.
 *
 * `positionMs` used to move only when the backend pushed, so the scrub bar
 * visibly stalled. It is ticked client-side now — but derived from
 * `performance.now() - anchorAt`, never from a counter incremented per frame.
 * An accumulator drifts every time a frame is dropped, and WKWebView defers
 * timers while the window is not key, so a counter would fall arbitrarily far
 * behind and then jump. The engine re-anchors this twice a second while playing
 * (`position_update_interval = 500ms`) plus on play/pause/seek, so worst-case
 * drift is half a second and every push snaps it back.
 */
let anchorState = { ms: 0, at: 0, playing: false, local: false };

/**
 * `local` = the anchor came from Atlas's own engine (a `music:now_playing`
 * push, a seek, a load) rather than from a `/v1/me/player` snapshot of
 * somebody else's device. It is the difference between a clock Atlas can keep
 * and a clock it is guessing at; see `readPosition`.
 */
function anchor(ms: number, playing: boolean, local: boolean): void {
  anchorState = { ms, at: nowMs(), playing, local };
}

const clearAnchor = (): void => { anchorState = { ms: 0, at: 0, playing: false, local: false }; };

/**
 * How far a REMOTE anchor may be extrapolated before the readout stops moving.
 *
 * A local anchor is re-stated by the engine twice a second, so interpolating
 * from it is arithmetic on a fact. A remote one is a snapshot of a device Atlas
 * cannot observe: if the user pauses or skips on their phone, nothing tells
 * Atlas, and an uncapped clock would sweep a track Spotify stopped playing an
 * hour ago all the way to its end under a status line still reading "Playing on
 * iPhone". That is a worse failure than a bar that stands still, because it is
 * confidently wrong rather than visibly stale.
 *
 * The cap is a little above `REMOTE_POLL_PLAYING_MS`, so in normal operation
 * the next poll always lands first and the readout is smooth — and if polling
 * stops (window hidden, network gone, token expired) the claim self-limits to a
 * few seconds instead of running away.
 */
const REMOTE_LEAD_MS = 12000;

/**
 * Live position in ms. Safe to call every animation frame — it reads a module
 * value and does arithmetic; it never touches state, so it cannot cause a
 * render.
 */
export function readPosition(): number {
  const a = anchorState;
  if (!a.at) return 0;
  if (!a.playing) return a.ms;
  const since = nowMs() - a.at;
  return a.ms + (a.local ? since : Math.min(since, REMOTE_LEAD_MS));
}

// --- server calls ----------------------------------------------------------

/** Drop a stale command error once something succeeds. See `cmd`. */
function clearError(): void {
  if (snapshot.error !== null) patch({ error: null });
}

async function refreshStatus(): Promise<void> {
  if (!isTauri) return;
  try {
    const st = await invoke<MusicStatus>('music_status');
    patch({ connected: st.connected, premium: st.premium, audioReady: st.audio_ready });
  } catch (e) {
    console.error('[music] status failed:', e);
  }
}

/**
 * Pull `/v1/me/player` — the user's Spotify CONNECT session.
 *
 * TWO GUARDS, AND BOTH ARE LORE. Atlas drives the librespot Player directly
 * and is not a Connect device, so this endpoint cannot see Atlas's own
 * playback; it answers 204 precisely when Atlas is the only thing making
 * sound.
 *
 * 1. While the engine is decoding, do not ask at all. `ensure_engine` emits
 *    `music:status {connected:true}` from inside the very `music_load` that
 *    starts playback, and librespot then fires TrackChanged with a null
 *    position — both of which used to answer with a pull. On a Mac with no
 *    other active device those pulls returned 204 and nulled the track that
 *    was decoding: the title flipped to "Nothing playing", the artwork and
 *    palette reset, and `canPlay` went false, so the user could not even pause
 *    the audio Atlas was playing. With another device active they instead
 *    overwrote Atlas's own transport state with the phone's.
 * 2. A 204 while the engine still HOLDS a track is "no Connect device", not
 *    "nothing is playing" — leave the local record alone. Without this, the
 *    end of a locally played track erased the record that had just finished.
 */
async function refreshNowPlaying(): Promise<void> {
  if (!isTauri || enginePlaying) return;
  try {
    const raw = await invoke<{
      item?: RawTrack;
      is_playing?: boolean;
      progress_ms?: number;
      device?: { name?: string };
    } | null>('music_now_playing');
    if (!raw) {
      if (engineUri) return;
      clearAnchor();
      patch({ nowPlaying: null });
      schedulePoll();
      return;
    }
    // Remote snapshot: not a clock Atlas can keep. `readPosition` caps how far
    // it is willing to extrapolate this.
    anchor(raw.progress_ms ?? 0, !!raw.is_playing, false);
    patch({
      nowPlaying: {
        track: normalizeTrack(raw.item),
        isPlaying: !!raw.is_playing,
        positionMs: raw.progress_ms ?? 0,
        deviceName: raw.device?.name ?? null,
      },
    });
    // Restart the chain from this sync, at the cadence the answer implies: the
    // first pull of a session happens before anything is known, so without this
    // a launch into remote playback would wait out a full idle interval before
    // moving to the 8s one.
    schedulePoll();
  } catch (e) {
    console.error('[music] now-playing failed:', e);
  }
}

// --- remote refresh --------------------------------------------------------
//
// Atlas hears nothing about playback on the user's other devices: `music:*` is
// emitted only by the LOCAL engine. Without a pull, the dashboard's Now-Playing
// widget and the player would sit on whatever `/me/player` said at launch — the
// wrong track, under a status line claiming it is playing — for the life of the
// session.
//
// So: ONE timer for the whole app, on a setTimeout chain rather than an
// interval so ticks cannot stack, only while something is subscribed, only
// while connected, only while Atlas itself is NOT decoding (the engine pushes
// in that case, twice a second, for free), and never while the window is
// hidden. That is 7.5 requests a minute while somebody's phone is playing and
// 1.3 while nothing is.

const REMOTE_POLL_PLAYING_MS = 8000;
const REMOTE_POLL_IDLE_MS = 45000;
let pollTimer = 0;

const pageHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

function schedulePoll(): void {
  if (!isTauri || !bridgeOn) return;
  if (pollTimer) window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(
    runPoll,
    snapshot.nowPlaying?.isPlaying ? REMOTE_POLL_PLAYING_MS : REMOTE_POLL_IDLE_MS,
  );
}

async function runPoll(): Promise<void> {
  pollTimer = 0;
  if (!bridgeOn) return;
  if (snapshot.connected && !enginePlaying && !pageHidden()) await refreshNowPlaying();
  schedulePoll();
}

/** Catch up immediately when the window comes back, then resume the chain. */
function onVisibility(): void {
  if (pageHidden() || !bridgeOn) return;
  if (snapshot.connected && !enginePlaying) void refreshNowPlaying();
  schedulePoll();
}

async function loadLibrary(offset = 0, limit = 50): Promise<void> {
  if (!isTauri) return;
  try {
    const page = await invoke<{ items?: { track: RawTrack }[] }>('music_library_tracks', {
      offset,
      limit,
    });
    const tracks = (page.items ?? [])
      .map((i) => normalizeTrack(i.track))
      .filter((t): t is Track => t !== null);
    patch({ library: offset === 0 ? tracks : [...snapshot.library, ...tracks] });
  } catch (e) {
    patch({ error: String(e) });
  }
}

async function loadPlaylists(offset = 0, limit = 50): Promise<void> {
  if (!isTauri) return;
  try {
    const page = await invoke<{ items?: Array<{ id: string; name: string; images?: RawImage[]; tracks?: { total?: number } }> }>(
      'music_playlists',
      { offset, limit },
    );
    const lists: Playlist[] = (page.items ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      imageUrl: firstImage(p.images),
      trackCount: p.tracks?.total ?? 0,
    }));
    patch({ playlists: offset === 0 ? lists : [...snapshot.playlists, ...lists] });
  } catch (e) {
    patch({ error: String(e) });
  }
}

async function loadPlaylistTracks(playlistId: string, offset = 0, limit = 100): Promise<Track[]> {
  if (!isTauri) return [];
  const page = await invoke<{ items?: { track: RawTrack }[] }>('music_playlist_tracks', {
    playlistId,
    offset,
    limit,
  });
  return (page.items ?? [])
    .map((i) => normalizeTrack(i.track))
    .filter((t): t is Track => t !== null);
}

async function search(query: string, limit = 20): Promise<SearchResults> {
  if (!isTauri || !query.trim()) return { tracks: [], playlists: [] };
  const raw = await invoke<{
    tracks?: { items?: RawTrack[] };
    playlists?: { items?: Array<{ id: string; name: string; images?: RawImage[]; tracks?: { total?: number } }> };
  }>('music_search', { query, limit });
  return {
    tracks: (raw.tracks?.items ?? [])
      .map(normalizeTrack)
      .filter((t): t is Track => t !== null),
    playlists: (raw.playlists?.items ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      imageUrl: firstImage(p.images),
      trackCount: p.tracks?.total ?? 0,
    })),
  };
}

async function connect(): Promise<void> {
  if (!isTauri) return;
  patch({ isConnecting: true, error: null });
  try {
    // Rust builds the PKCE consent URL; open it in the system browser (where
    // the user's Spotify session lives). The redirect returns via the deep link
    // and Rust emits `music:status` on completion.
    const url = await invoke<string>('music_connect');
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch (e) {
    patch({ error: String(e), isConnecting: false });
  }
}

async function disconnect(): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke('music_disconnect');
    engineUri = null;
    enginePlaying = false;
    clearAnchor();
    patch({
      connected: false,
      premium: false,
      audioReady: false,
      nowPlaying: null,
      library: [],
      playlists: [],
    });
  } catch (e) {
    patch({ error: String(e) });
  }
}

// Transport — thin pass-throughs to the Rust engine.
//
// `error` is CLEARED on success, not only set on failure. Every music surface
// renders it in every state, and the store is module-scoped, so a single
// transient rejection — a token caught mid-refresh, a network blip — used to
// pin a red "Spotify API 401: …" line under a perfectly working transport for
// the rest of the app's life. Closing and reopening the player no longer resets
// it either, since the state outlives the mount.
async function cmd(name: string, args?: Record<string, unknown>): Promise<void> {
  if (!isTauri) return;
  try {
    await invoke(name, args);
    clearError();
  } catch (e) {
    patch({ error: String(e) });
    throw e;
  }
}

const play = () => cmd('music_play');
const pause = () => cmd('music_pause');
const next = () => cmd('music_next');
const prev = () => cmd('music_prev');

async function seek(positionMs: number): Promise<void> {
  await cmd('music_seek', { positionMs });
  // Anchor optimistically: librespot confirms with a Seeked event, but the
  // scrub bar should not sit at the old position waiting for it. Seeking is
  // only ever offered while Atlas owns the audio, so this anchor is local.
  anchor(positionMs, anchorState.playing, true);
}

/**
 * Hand a track to the local engine. This is the ONLY path that puts anything in
 * librespot's queue — `music_play` on an engine that has never been loaded
 * plays silence, which is why the player loads before it plays.
 *
 * Ownership is claimed BEFORE the round trip on purpose. `music_load` reaches
 * `ensure_engine`, which emits `music:status {connected:true}` from inside this
 * still-pending call; that listener's `refreshNowPlaying()` must already see
 * that Atlas owns the audio, or it pulls `/me/player` and nulls the track that
 * is about to start.
 */
async function load(uri: string): Promise<void> {
  const wasUri = engineUri;
  const wasPlaying = enginePlaying;
  engineUri = uri;
  enginePlaying = true;
  // `player.load(uri, start_playing = true, 0)` — loading starts playback.
  anchor(0, true, true);
  try {
    await cmd('music_load', { uri });
  } catch (e) {
    engineUri = wasUri;
    enginePlaying = wasPlaying;
    throw e;
  }
}

const setVolume = (volume: number) => cmd('music_volume', { volume });

// --- the bridge: exactly one registration, ref-counted ---------------------

let bridgeOn = false;
/** Bumped on every start/stop so a `listen()` that resolves late can bail. */
let bridgeGen = 0;
let unlisteners: Array<() => void> = [];
let stopTimer = 0;

function startBridge(): void {
  if (!isTauri || bridgeOn) return;
  bridgeOn = true;
  const gen = ++bridgeGen;

  void refreshStatus();
  // Previously missing: on a cold launch with a valid Keychain token nothing
  // pulled the current track, so the surface said "Nothing playing" until an
  // event happened to arrive.
  void refreshNowPlaying();
  schedulePoll();
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  void (async () => {
    const { listen } = await import('@tauri-apps/api/event');
    const us = await Promise.all([
      // Connection state flips after the OAuth round trip.
      listen<{ connected: boolean; error?: string | null; audio_ready?: boolean }>('music:status', (e) => {
        const p: Partial<MusicSnapshot> = { isConnecting: false };
        // Set AND cleared: a status event that reports no error is the backend
        // saying the last one is over.
        p.error = e.payload.error ?? null;
        p.connected = !!e.payload.connected;
        // `ensure_engine` puts `audio_ready` on this payload; taking it here
        // rather than waiting for the `music_status` round trip is what keeps
        // the play button from spending a beat claiming Atlas is not the
        // player of the track it has just started decoding.
        if (typeof e.payload.audio_ready === 'boolean') p.audioReady = e.payload.audio_ready;
        if (!e.payload.connected) {
          // Only `disconnect()` used to clear this, so a token that went away
          // on its own left the last record on screen under a "Not connected"
          // status line — a sleeve, a title and a progress bar describing
          // something Atlas can no longer see.
          p.nowPlaying = null;
          p.premium = false;
          engineUri = null;
          enginePlaying = false;
          clearAnchor();
        }
        patch(p);
        if (e.payload.connected) { void refreshStatus(); void refreshNowPlaying(); schedulePoll(); }
      }),
      // State pushed from the LOCAL engine.
      //
      // This used to discard the payload and re-pull `/v1/me/player` instead.
      // That was wrong twice over: librespot fires PositionChanged twice a
      // second while playing, so a playing engine issued two blocking HTTPS
      // round-trips per second PER MOUNTED HOOK straight into Spotify's rate
      // limiter — and `/me/player` describes the user's Spotify *Connect*
      // session, while Atlas drives the librespot Player directly and is not a
      // Connect device, so the answer could never describe Atlas's own
      // playback.
      //
      // The engine's own `position_ms` is authoritative and free. A null
      // position means TrackChanged, which carries no position and is the one
      // case that genuinely needs a metadata pull.
      listen<EnginePosition>('music:now_playing', (e) => {
        const p = e.payload;
        const playing = !!p?.is_playing;
        enginePlaying = playing;
        const pos = p && typeof p.position_ms === 'number' ? p.position_ms : null;
        if (pos == null) {
          // TrackChanged. `refreshNowPlaying` no-ops while the engine is
          // decoding, which is right: the only thing librespot can have loaded
          // is the URI Atlas handed it, and Atlas already has that metadata.
          // On EndOfTrack (`is_playing:false`) it does run, and its 204 guard
          // keeps the finished record on screen rather than blanking it.
          void refreshNowPlaying();
          return;
        }
        anchor(pos, playing, true);
        const cur = snapshot.nowPlaying;
        if (cur) patch({ nowPlaying: { ...cur, isPlaying: playing, positionMs: pos } });
      }),
      // Per-frame audio energy for the Sphere — write the ref, no re-render.
      listen<AudioLevel>('music:level', (e) => {
        levelRef.current = e.payload;
      }),
    ]);
    if (gen !== bridgeGen) { us.forEach((u) => u()); return; }
    unlisteners = us;
  })();
}

function stopBridge(): void {
  bridgeGen++;
  bridgeOn = false;
  if (pollTimer) { window.clearTimeout(pollTimer); pollTimer = 0; }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility);
  }
  unlisteners.forEach((u) => u());
  unlisteners = [];
}

/**
 * Ref-counted subscribe. The teardown is deferred by a tick because React
 * unmounts the outgoing tree before mounting the incoming one on a route or
 * focus-view swap: without the delay, opening the full player from the
 * dashboard card would tear the bridge down and immediately rebuild it,
 * costing a `GET /me` and dropping level events in between.
 */
function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  if (stopTimer) { clearTimeout(stopTimer); stopTimer = 0; }
  startBridge();
  return () => {
    subscribers.delete(cb);
    if (subscribers.size > 0 || !bridgeOn) return;
    stopTimer = window.setTimeout(() => {
      stopTimer = 0;
      if (subscribers.size === 0) stopBridge();
    }, 400);
  };
}

/** Everything that is not a snapshot field. Frozen module identity. */
const ACTIONS = {
  /** Live audio level for the visualizer; read in an animation loop. */
  levelRef,
  /**
   * Live playback position in ms, interpolated from the last authoritative
   * anchor — freely when that anchor came from Atlas's own engine, and only up
   * to `REMOTE_LEAD_MS` when it came from a snapshot of another device. Call it
   * per frame; it never triggers a render.
   */
  readPosition,
  connect,
  disconnect,
  search,
  loadLibrary,
  loadPlaylists,
  loadPlaylistTracks,
  refreshNowPlaying,
  play,
  pause,
  next,
  prev,
  seek,
  load,
  setVolume,
} as const;

export type MusicPlayer = MusicSnapshot & typeof ACTIONS;

export function useMusicPlayer(): MusicPlayer {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // One object per snapshot change, not one per render: several call sites list
  // the returned value in a `useCallback` dependency array.
  return useMemo(() => ({ ...snap, ...ACTIONS }), [snap]);
}
