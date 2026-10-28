/**
 * Lyrics for one track, from LRCLIB through `music_lyrics` (music.rs), which
 * keeps every answer in SQLite on this Mac. This hook adds a per-run memory
 * on top, so flipping between tabs does not even cross the bridge, and asks
 * only while `enabled` — the Lyrics tab is open — because asking sends the
 * title, artist, album and length to lrclib.net.
 */
import { useEffect, useState } from 'react';
import { musicBridgeAvailable, musicInvoke } from '@/hooks/useMusicPlayer';
import { lyricsView, type LyricsAnswer, type LyricsView } from '@/lib/musicLyrics';
import { isEpisode, type Track } from '@/lib/musicSpotify';

export interface LyricsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  view: LyricsView;
  error: string | null;
}

const memo = new Map<string, LyricsAnswer>();

async function ask(t: Track): Promise<LyricsAnswer> {
  const durationS = Math.round(t.durationMs / 1000);
  const first = await musicInvoke<LyricsAnswer>('music_lyrics', { track: t.title, artist: t.artist, album: t.album, durationS });
  // Spotify joins several artists with ", "; LRCLIB usually files the song
  // under the first. One more try with that, only when the full line missed.
  const lead = t.artist.split(', ')[0];
  if (first.found || first.instrumental || !lead || lead === t.artist) return first;
  return musicInvoke<LyricsAnswer>('music_lyrics', { track: t.title, artist: lead, album: t.album, durationS });
}

export function useLyrics(track: Track | null, enabled: boolean): LyricsState {
  const [st, setSt] = useState<LyricsState>({ status: 'idle', view: { kind: 'none' }, error: null });
  const id = track?.id ?? null;

  useEffect(() => {
    if (!track || !enabled || isEpisode(track) || !musicBridgeAvailable || track.durationMs <= 0) {
      setSt({ status: 'idle', view: { kind: 'none' }, error: null });
      return;
    }
    const known = memo.get(track.id);
    if (known) { setSt({ status: 'ready', view: lyricsView(known), error: null }); return; }
    let live = true;
    setSt({ status: 'loading', view: { kind: 'none' }, error: null });
    ask(track)
      .then((a) => {
        memo.set(track.id, a);
        if (live) setSt({ status: 'ready', view: lyricsView(a), error: null });
      })
      .catch((e) => { if (live) setSt({ status: 'error', view: { kind: 'none' }, error: String(e) }); });
    return () => { live = false; };
    // The record is identified by its id; its other fields do not change under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, enabled]);

  return st;
}
