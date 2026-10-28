import { describe, expect, test } from 'bun:test';
import {
  LIKE_SCOPES, RESUME_SCOPES, ROOM_SCOPES, episodeAsTrack, isEpisode, lacks, normalizeDevices, normalizeEpisodes,
  normalizePlaylist, normalizeShows, normalizeTrack, reconnectLabel, recentFromRaw, releaseYear,
} from './musicSpotify';

describe('release year', () => {
  test('every precision Spotify uses, and its unknown date', () => {
    expect(releaseYear('1992')).toBe('1992');
    expect(releaseYear('1992-05')).toBe('1992');
    expect(releaseYear('1992-05-10')).toBe('1992');
    expect(releaseYear('0000')).toBeNull();
    expect(releaseYear('')).toBeNull();
    expect(releaseYear(null)).toBeNull();
    expect(releaseYear(undefined)).toBeNull();
  });
});

describe('tracks and playlists', () => {
  test('a track carries its year and kind', () => {
    const t = normalizeTrack({
      id: 'a', uri: 'spotify:track:a', name: 'Xtal', duration_ms: 291000,
      artists: [{ name: 'Aphex Twin' }, { name: 'Guest' }],
      album: { name: 'SAW 85-92', images: [{ url: 'https://i/1' }], release_date: '1992-11-09' },
    });
    expect(t).toEqual({
      id: 'a', uri: 'spotify:track:a', title: 'Xtal', artist: 'Aphex Twin, Guest', album: 'SAW 85-92',
      artUrl: 'https://i/1', durationMs: 291000, year: '1992', kind: 'track',
    });
    expect(normalizeTrack(null)).toBeNull();
    expect(normalizeTrack({ id: '', uri: '', name: '', duration_ms: 0 })).toBeNull();
  });
  test('a playlist Spotify withdrew (null) is dropped', () => {
    expect(normalizePlaylist(null)).toBeNull();
    expect(normalizePlaylist({ id: 'p', name: 'Evening', images: null, tracks: { total: 12 } })).toEqual({ id: 'p', name: 'Evening', imageUrl: null, trackCount: 12 });
  });
});

describe('shows and episodes', () => {
  test('saved shows', () => {
    const shows = normalizeShows({ items: [{ show: { id: 's', name: 'Show', publisher: 'Pub', images: [{ url: 'u' }], total_episodes: 40 } }, { show: null }] });
    expect(shows).toEqual([{ id: 's', name: 'Show', publisher: 'Pub', artUrl: 'u', episodes: 40 }]);
    expect(normalizeShows(null)).toEqual([]);
  });
  test('episodes: resume point, playability, the show art as fallback, withdrawn ones dropped', () => {
    const show = { id: 's', name: 'Show', artUrl: 'show-art' };
    const eps = normalizeEpisodes({
      items: [
        { id: 'e1', uri: 'spotify:episode:e1', name: 'One', duration_ms: 3600000, release_date: '2026-10-01', description: ' hi ', resume_point: { fully_played: false, resume_position_ms: 120000 } },
        null,
        { id: 'e2', uri: 'spotify:episode:e2', name: 'Two', images: [{ url: 'ep-art' }], is_playable: false },
      ],
    }, show);
    expect(eps).toHaveLength(2);
    expect(eps[0]).toMatchObject({ id: 'e1', showName: 'Show', artUrl: 'show-art', description: 'hi', resume: { positionMs: 120000, fullyPlayed: false }, playable: true });
    expect(eps[1]).toMatchObject({ id: 'e2', artUrl: 'ep-art', resume: null, playable: false, durationMs: 0 });
  });
  test('an episode as a record', () => {
    const [e] = normalizeEpisodes({ items: [{ id: 'e1', uri: 'spotify:episode:e1', name: 'One', duration_ms: 10, release_date: '2025-01-02' }] }, { id: 's', name: 'Show', artUrl: null });
    const t = episodeAsTrack(e);
    expect(t).toMatchObject({ id: 'e1', artist: 'Show', album: 'Show', year: '2025', kind: 'episode' });
    expect(isEpisode(t)).toBe(true);
    expect(isEpisode({ uri: 'spotify:episode:x' })).toBe(true);
    expect(isEpisode({ uri: 'spotify:track:x', kind: 'track' })).toBe(false);
    expect(isEpisode(null)).toBe(false);
  });
});

describe('devices', () => {
  test('ids are required; volume is clamped and only offered when supported', () => {
    const d = normalizeDevices({
      devices: [
        { id: 'k', name: ' Kitchen ', type: 'Speaker', is_active: true, volume_percent: 130, supports_volume: true },
        { id: null, name: 'Ghost' },
        { id: 't', name: '', type: 'TV', is_restricted: true, volume_percent: null },
      ],
    });
    expect(d).toEqual([
      { id: 'k', name: 'Kitchen', type: 'Speaker', active: true, restricted: false, volume: 100, supportsVolume: true },
      { id: 't', name: 'Spotify device', type: 'TV', active: false, restricted: true, volume: null, supportsVolume: false },
    ]);
    expect(normalizeDevices(null)).toEqual([]);
  });
});

describe('resume rows', () => {
  test('the stored record comes back as an episode', () => {
    const r = recentFromRaw({
      item_id: 'e1', uri: 'spotify:episode:e1', position_ms: 5000, duration_ms: 9000, updated_at: 'now',
      meta: { title: 'One', artist: 'Show', album: 'Show', artUrl: 'a', durationMs: 9000, year: '2025' },
    });
    expect(r.track).toMatchObject({ id: 'e1', title: 'One', kind: 'episode', year: '2025', durationMs: 9000 });
    expect(r.positionMs).toBe(5000);
  });
  test('a row without a usable record keeps its place but no track', () => {
    const r = recentFromRaw({ item_id: 'e1', uri: 'spotify:episode:e1', position_ms: 1, duration_ms: 2, updated_at: 'x', meta: null });
    expect(r.track).toBeNull();
    const odd = recentFromRaw({ item_id: 't', uri: 'spotify:track:t', position_ms: 1, duration_ms: 2, updated_at: 'x', meta: { title: 'T', durationMs: 'long' } });
    expect(odd.track).toMatchObject({ kind: 'track', durationMs: 2, artUrl: null });
  });
});

describe('scopes', () => {
  test('an unknown grant lacks nothing; a known one is checked', () => {
    expect(lacks(null, LIKE_SCOPES)).toBe(false);
    expect(lacks(['user-library-read'], LIKE_SCOPES)).toBe(true);
    expect(lacks(['user-library-modify'], LIKE_SCOPES)).toBe(false);
    expect(lacks(['user-read-playback-state'], ROOM_SCOPES)).toBe(true);
    expect(lacks(['user-read-playback-state', 'user-modify-playback-state'], ROOM_SCOPES)).toBe(false);
    expect(lacks([], RESUME_SCOPES)).toBe(true);
  });
  test('one reconnect line naming only what is missing', () => {
    expect(reconnectLabel(true, true)).toBe('Reconnect Spotify to turn on Like and Rooms');
    expect(reconnectLabel(true, false)).toBe('Reconnect Spotify to turn on Like');
    expect(reconnectLabel(false, true)).toBe('Reconnect Spotify to turn on Rooms');
    expect(reconnectLabel(false, false)).toBeNull();
  });
});
