/**
 * Spotify's JSON, normalized into the few shapes the music surfaces use —
 * tracks, playlists, saved shows and their episodes, Connect devices — plus
 * the scope arithmetic that decides when Like and Rooms need a reconnect.
 *
 * Pure, so the shapes are tested without a Tauri bridge. `music.rs` returns
 * Spotify's raw JSON on purpose (it does not mirror Spotify's large schema in
 * Rust); this file is the one place that reads it.
 */

// --- Raw Spotify JSON shapes (partial) ---------------------------------------------

export interface RawImage { url: string; width?: number; height?: number }
interface RawArtist { name: string }
export interface RawTrack {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  artists?: RawArtist[];
  album?: { name?: string; images?: RawImage[]; release_date?: string };
}
export interface RawPlaylist { id: string; name: string; images?: RawImage[] | null; tracks?: { total?: number } }
interface RawShow { id: string; name: string; publisher?: string; images?: RawImage[]; total_episodes?: number }
interface RawEpisode {
  id: string;
  uri: string;
  name: string;
  duration_ms?: number;
  release_date?: string;
  images?: RawImage[];
  description?: string;
  is_playable?: boolean;
  resume_point?: { fully_played?: boolean; resume_position_ms?: number };
}
interface RawDevice {
  id: string | null;
  name?: string;
  type?: string;
  is_active?: boolean;
  is_restricted?: boolean;
  volume_percent?: number | null;
  supports_volume?: boolean;
}

// --- The view models ------------------------------------------------------------------

export interface Track {
  id: string;
  uri: string;
  title: string;
  artist: string;
  album: string;
  artUrl: string | null;
  durationMs: number;
  /**
   * The release year, from the album's `release_date` (or an episode's own);
   * null when Spotify gives none. Optional so records built elsewhere (tests,
   * the Workshop) need not carry it.
   */
  year?: string | null;
  /** 'episode' for a podcast episode; absent or 'track' for music. */
  kind?: 'track' | 'episode';
}

export interface Playlist {
  id: string;
  name: string;
  imageUrl: string | null;
  trackCount: number;
}

export interface Show {
  id: string;
  name: string;
  publisher: string;
  artUrl: string | null;
  episodes: number;
}

export interface Episode {
  id: string;
  uri: string;
  title: string;
  showId: string;
  showName: string;
  artUrl: string | null;
  durationMs: number;
  releaseDate: string | null;
  description: string;
  /** Spotify's own place in the episode — only with `user-read-playback-position`. */
  resume: { positionMs: number; fullyPlayed: boolean } | null;
  playable: boolean;
}

export interface Device {
  id: string;
  name: string;
  /** Spotify's device type: Computer, Smartphone, Speaker, TV, … */
  type: string;
  active: boolean;
  /** A device that refuses Web API control (some TVs, some cars). */
  restricted: boolean;
  /** 0–100, or null when the device does not report one. */
  volume: number | null;
  supportsVolume: boolean;
}

// --- Normalizers ------------------------------------------------------------------------

export const firstImage = (images?: RawImage[] | null): string | null =>
  images && images.length ? images[0].url : null;

/**
 * "1992", "1992-05" or "1992-05-10" → "1992". Spotify writes "0000" for an
 * unknown date, which is no year at all.
 */
export function releaseYear(date: string | null | undefined): string | null {
  const m = /^(\d{4})/.exec((date ?? '').trim());
  if (!m || Number(m[1]) < 1000) return null;
  return m[1];
}

export function normalizeTrack(t: RawTrack | null | undefined): Track | null {
  if (!t || !t.id) return null;
  return {
    id: t.id,
    uri: t.uri,
    title: t.name,
    artist: (t.artists ?? []).map((a) => a.name).join(', '),
    album: t.album?.name ?? '',
    artUrl: firstImage(t.album?.images),
    durationMs: t.duration_ms ?? 0,
    year: releaseYear(t.album?.release_date),
    kind: 'track',
  };
}

export function normalizePlaylist(p: RawPlaylist | null | undefined): Playlist | null {
  if (!p || !p.id) return null;
  return { id: p.id, name: p.name, imageUrl: firstImage(p.images), trackCount: p.tracks?.total ?? 0 };
}

/** `GET /me/shows` → the saved shows, in the order Spotify lists them (newest saved first). */
export function normalizeShows(page: { items?: { show?: RawShow | null }[] } | null | undefined): Show[] {
  return (page?.items ?? []).flatMap((i) => {
    const s = i?.show;
    if (!s || !s.id) return [];
    return [{ id: s.id, name: s.name, publisher: s.publisher ?? '', artUrl: firstImage(s.images), episodes: s.total_episodes ?? 0 }];
  });
}

/** `GET /shows/{id}/episodes` → episodes, newest first. A null item is an episode Spotify withdrew. */
export function normalizeEpisodes(
  page: { items?: (RawEpisode | null)[] } | null | undefined,
  show: Pick<Show, 'id' | 'name' | 'artUrl'>,
): Episode[] {
  return (page?.items ?? []).flatMap((e) => {
    if (!e || !e.id) return [];
    const rp = e.resume_point;
    return [{
      id: e.id,
      uri: e.uri,
      title: e.name,
      showId: show.id,
      showName: show.name,
      artUrl: firstImage(e.images) ?? show.artUrl,
      durationMs: e.duration_ms ?? 0,
      releaseDate: e.release_date ?? null,
      description: (e.description ?? '').trim(),
      resume: rp ? { positionMs: Math.max(0, rp.resume_position_ms ?? 0), fullyPlayed: rp.fully_played === true } : null,
      playable: e.is_playable !== false,
    }];
  });
}

/** An episode as the record every music surface draws: the show stands where the artist would. */
export function episodeAsTrack(e: Episode): Track {
  return {
    id: e.id,
    uri: e.uri,
    title: e.title,
    artist: e.showName,
    album: e.showName,
    artUrl: e.artUrl,
    durationMs: e.durationMs,
    year: releaseYear(e.releaseDate),
    kind: 'episode',
  };
}

export const isEpisode = (t: Pick<Track, 'kind' | 'uri'> | null | undefined): boolean =>
  !!t && (t.kind === 'episode' || t.uri.startsWith('spotify:episode:'));

/** `GET /me/player/devices` → the Connect devices Atlas can address (a device without an id cannot be). */
export function normalizeDevices(raw: { devices?: RawDevice[] } | null | undefined): Device[] {
  return (raw?.devices ?? []).flatMap((d) => {
    if (!d.id) return [];
    const vol = typeof d.volume_percent === 'number' && Number.isFinite(d.volume_percent)
      ? Math.max(0, Math.min(100, Math.round(d.volume_percent)))
      : null;
    return [{
      id: d.id,
      name: d.name?.trim() || 'Spotify device',
      type: d.type ?? 'Unknown',
      active: d.is_active === true,
      restricted: d.is_restricted === true,
      volume: vol,
      supportsVolume: d.supports_volume !== false && vol !== null,
    }];
  });
}

// --- Scopes ---------------------------------------------------------------------------

/** Saving to Liked Songs. Reading them (the contains check) is `user-library-read`, which every grant has. */
export const LIKE_SCOPES = ['user-library-modify'] as const;
/** Listing the Connect devices, moving playback, setting their volume. */
export const ROOM_SCOPES = ['user-read-playback-state', 'user-modify-playback-state'] as const;
/** Spotify's own resume point on an episode. */
export const RESUME_SCOPES = ['user-read-playback-position'] as const;

/**
 * True when the grant is known to be missing one of `needed`. An unknown grant
 * (null: not connected, or Spotify did not list scopes) lacks nothing — the
 * call is tried and Spotify's answer is shown, rather than a reconnect being
 * demanded on a guess.
 */
export function lacks(granted: readonly string[] | null | undefined, needed: readonly string[]): boolean {
  if (!granted) return false;
  return needed.some((s) => !granted.includes(s));
}

/** The one reconnect line Music offers, naming only what the current grant cannot do. */
export function reconnectLabel(likeMissing: boolean, roomsMissing: boolean): string | null {
  if (likeMissing && roomsMissing) return 'Reconnect Spotify to turn on Like and Rooms';
  if (likeMissing) return 'Reconnect Spotify to turn on Like';
  if (roomsMissing) return 'Reconnect Spotify to turn on Rooms';
  return null;
}
