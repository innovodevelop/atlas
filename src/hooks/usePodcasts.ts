/**
 * Podcasts, for Home's Podcast widget and its full view: the user's saved
 * shows (`GET /me/shows`), a show's episodes (`GET /shows/{id}/episodes`) and
 * where Atlas last stopped in each (`music_resume`, on this Mac).
 *
 * Spotify is read through `music.rs` on the connected account; nothing else
 * leaves the Mac. Atlas's own resume points are kept locally because
 * Spotify's `resume_point` only moves for Spotify Connect playback, and Atlas
 * drives its librespot engine directly (see `resumeFrom` in betaMusic.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { musicInvoke, useMusicPlayer } from '@/hooks/useMusicPlayer';
import { useMusicQueue } from '@/hooks/useMusicQueue';
import {
  normalizeEpisodes, normalizeShows, recentFromRaw, type Episode, type RawRecent, type RecentResume, type Show,
} from '@/lib/musicSpotify';

/** What `music_resume_get` returns per id. */
export interface LocalResume { positionMs: number; durationMs: number; updatedAt: string }

type RawResume = { position_ms?: number; duration_ms?: number; updated_at?: string };

/** The most recent episodes Atlas kept a place in, newest first. Re-read whenever a place is written. */
export type { RecentResume } from '@/lib/musicSpotify';

export function useRecentEpisodes(limit = 5): RecentResume[] {
  const m = useMusicPlayer();
  const { resumeTick } = useMusicQueue();
  const [rows, setRows] = useState<RecentResume[]>([]);
  useEffect(() => {
    if (!m.available) return;
    let live = true;
    musicInvoke<RawRecent[]>('music_resume_recent', { limit })
      .then((r) => { if (live) setRows((r ?? []).map(recentFromRaw).filter((x) => x.track?.kind === 'episode')); })
      .catch(() => { /* an empty widget says so; nothing to add */ });
    return () => { live = false; };
  }, [m.available, limit, resumeTick]);
  return rows;
}

export interface PodcastsState {
  shows: Show[];
  showsStatus: 'idle' | 'loading' | 'ready' | 'error';
  showsError: string | null;
  showId: string | null;
  episodes: Episode[];
  episodesStatus: 'idle' | 'loading' | 'ready' | 'error';
  episodesError: string | null;
  /** Atlas's own places, by episode id. */
  local: Record<string, LocalResume>;
  selectShow: (id: string) => void;
}

/** Saved shows and the selected show's episodes, read while `enabled` (the full view is open). */
export function usePodcasts(enabled: boolean): PodcastsState {
  const m = useMusicPlayer();
  const { resumeTick } = useMusicQueue();
  const live = enabled && m.available && m.connected;
  const [shows, setShows] = useState<Show[]>([]);
  const [showsStatus, setShowsStatus] = useState<PodcastsState['showsStatus']>('idle');
  const [showsError, setShowsError] = useState<string | null>(null);
  const [showId, setShowId] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [episodesStatus, setEpisodesStatus] = useState<PodcastsState['episodesStatus']>('idle');
  const [episodesError, setEpisodesError] = useState<string | null>(null);
  const [local, setLocal] = useState<Record<string, LocalResume>>({});
  const showsRef = useRef<Show[]>([]);

  useEffect(() => {
    if (!live) return;
    let on = true;
    setShowsStatus('loading');
    musicInvoke<Parameters<typeof normalizeShows>[0]>('music_shows', { offset: 0, limit: 50 })
      .then((raw) => {
        if (!on) return;
        const list = normalizeShows(raw);
        showsRef.current = list;
        setShows(list);
        setShowsStatus('ready');
        setShowsError(null);
        setShowId((cur) => cur ?? list[0]?.id ?? null);
      })
      .catch((e) => { if (on) { setShowsStatus('error'); setShowsError(String(e)); } });
    return () => { on = false; };
  }, [live]);

  useEffect(() => {
    if (!live || !showId) return;
    const show = showsRef.current.find((s) => s.id === showId);
    if (!show) return;
    let on = true;
    setEpisodesStatus('loading');
    musicInvoke<Parameters<typeof normalizeEpisodes>[0]>('music_show_episodes', { showId, offset: 0, limit: 20 })
      .then((raw) => {
        if (!on) return;
        setEpisodes(normalizeEpisodes(raw, show));
        setEpisodesStatus('ready');
        setEpisodesError(null);
      })
      .catch((e) => { if (on) { setEpisodesStatus('error'); setEpisodesError(String(e)); } });
    return () => { on = false; };
  }, [live, showId]);

  // Atlas's own places for the episodes on screen; re-read after each write.
  const ids = episodes.map((e) => e.id).join(',');
  useEffect(() => {
    if (!live || !ids) return;
    let on = true;
    musicInvoke<Record<string, RawResume>>('music_resume_get', { ids: ids.split(',') })
      .then((raw) => {
        if (!on) return;
        const out: Record<string, LocalResume> = {};
        for (const [id, r] of Object.entries(raw ?? {})) {
          out[id] = { positionMs: Math.max(0, r.position_ms ?? 0), durationMs: Math.max(0, r.duration_ms ?? 0), updatedAt: r.updated_at ?? '' };
        }
        setLocal(out);
      })
      .catch(() => { /* without local places the episodes start from Spotify's, or the top */ });
    return () => { on = false; };
  }, [live, ids, resumeTick]);

  const selectShow = useCallback((id: string) => setShowId(id), []);

  return { shows, showsStatus, showsError, showId, episodes, episodesStatus, episodesError, local, selectShow };
}
