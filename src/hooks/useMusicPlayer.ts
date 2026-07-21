import { useCallback, useEffect, useRef, useState } from 'react';

// Provider-agnostic music player hook (Spotify first). Audio + catalog come from
// the LOCAL Rust backend (music.rs): OAuth via the atlas:// deep link, browse/
// search/state via the Spotify Web API, and — once librespot lands — in-app
// audio with a per-frame level feed for the Sphere visualizer. In the browser
// preview there's no Tauri backend, so everything degrades to an
// "open in the desktop app" state (available=false).

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

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

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

export function useMusicPlayer() {
  const [available] = useState(isTauri);
  const [connected, setConnected] = useState(false);
  const [premium, setPremium] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const [library, setLibrary] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The visualizer reads live audio energy every animation frame; keep it in a
  // ref so 30fps updates never trigger React re-renders (same approach as the
  // voice HeaderWave). Populated by `music:level` once librespot streams PCM.
  const levelRef = useRef<AudioLevel>({ amp: 0, bands: [0, 0, 0] });

  const refreshStatus = useCallback(async () => {
    if (!isTauri) return;
    try {
      const st = await invoke<MusicStatus>('music_status');
      setConnected(st.connected);
      setPremium(st.premium);
      setAudioReady(st.audio_ready);
    } catch (e) {
      console.error('[music] status failed:', e);
    }
  }, []);

  const refreshNowPlaying = useCallback(async () => {
    if (!isTauri) return;
    try {
      const raw = await invoke<{
        item?: RawTrack;
        is_playing?: boolean;
        progress_ms?: number;
        device?: { name?: string };
      } | null>('music_now_playing');
      if (!raw) {
        setNowPlaying(null);
        return;
      }
      setNowPlaying({
        track: normalizeTrack(raw.item),
        isPlaying: !!raw.is_playing,
        positionMs: raw.progress_ms ?? 0,
        deviceName: raw.device?.name ?? null,
      });
    } catch (e) {
      console.error('[music] now-playing failed:', e);
    }
  }, []);

  const loadLibrary = useCallback(async (offset = 0, limit = 50) => {
    if (!isTauri) return;
    try {
      const page = await invoke<{ items?: { track: RawTrack }[] }>('music_library_tracks', {
        offset,
        limit,
      });
      const tracks = (page.items ?? [])
        .map((i) => normalizeTrack(i.track))
        .filter((t): t is Track => t !== null);
      setLibrary((prev) => (offset === 0 ? tracks : [...prev, ...tracks]));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const loadPlaylists = useCallback(async (offset = 0, limit = 50) => {
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
      setPlaylists((prev) => (offset === 0 ? lists : [...prev, ...lists]));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const loadPlaylistTracks = useCallback(
    async (playlistId: string, offset = 0, limit = 100): Promise<Track[]> => {
      if (!isTauri) return [];
      const page = await invoke<{ items?: { track: RawTrack }[] }>('music_playlist_tracks', {
        playlistId,
        offset,
        limit,
      });
      return (page.items ?? [])
        .map((i) => normalizeTrack(i.track))
        .filter((t): t is Track => t !== null);
    },
    [],
  );

  const search = useCallback(async (query: string, limit = 20): Promise<SearchResults> => {
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
  }, []);

  const connect = useCallback(async () => {
    if (!isTauri) return;
    setIsConnecting(true);
    setError(null);
    try {
      // Rust builds the PKCE consent URL; open it in the system browser (where
      // the user's Spotify session lives). The redirect returns via the deep
      // link and Rust emits `music:status` on completion.
      const url = await invoke<string>('music_connect');
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
    } catch (e) {
      setError(String(e));
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (!isTauri) return;
    try {
      await invoke('music_disconnect');
      setConnected(false);
      setPremium(false);
      setAudioReady(false);
      setNowPlaying(null);
      setLibrary([]);
      setPlaylists([]);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Transport — thin pass-throughs to the Rust engine. Until librespot is wired
  // these reject with a clear message; the UI surfaces `error`.
  const cmd = useCallback(
    (name: string, args?: Record<string, unknown>) => async () => {
      if (!isTauri) return;
      try {
        await invoke(name, args);
      } catch (e) {
        setError(String(e));
        throw e;
      }
    },
    [],
  );

  const play = useCallback(() => cmd('music_play')(), [cmd]);
  const pause = useCallback(() => cmd('music_pause')(), [cmd]);
  const next = useCallback(() => cmd('music_next')(), [cmd]);
  const prev = useCallback(() => cmd('music_prev')(), [cmd]);
  const seek = useCallback((positionMs: number) => cmd('music_seek', { positionMs })(), [cmd]);
  const load = useCallback((uri: string) => cmd('music_load', { uri })(), [cmd]);
  const setVolume = useCallback((volume: number) => cmd('music_volume', { volume })(), [cmd]);

  useEffect(() => {
    if (!isTauri) return;
    refreshStatus();

    let unlisteners: Array<() => void> = [];
    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisteners = await Promise.all([
        // Connection state flips after the OAuth round trip.
        listen<{ connected: boolean; error: string | null }>('music:status', (e) => {
          setIsConnecting(false);
          if (e.payload.error) setError(e.payload.error);
          if (e.payload.connected) {
            setConnected(true);
            refreshStatus();
            refreshNowPlaying();
          } else {
            setConnected(false);
          }
        }),
        // Track/state changes pushed from the backend (not polling).
        listen<RawTrack | null>('music:now_playing', () => refreshNowPlaying()),
        // Per-frame audio energy for the Sphere — write the ref, no re-render.
        listen<AudioLevel>('music:level', (e) => {
          levelRef.current = e.payload;
        }),
      ]);
    })();

    return () => unlisteners.forEach((u) => u());
  }, [refreshStatus, refreshNowPlaying]);

  return {
    available,
    connected,
    premium,
    audioReady,
    nowPlaying,
    library,
    playlists,
    isConnecting,
    error,
    /** Live audio level for the visualizer; read in an animation loop. */
    levelRef,
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
  };
}
