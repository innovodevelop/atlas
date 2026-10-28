/**
 * The Like button, shared by the listening room and the Now playing widget.
 *
 * It saves the record to (or removes it from) the user's Spotify Liked Songs
 * through `music_save_tracks`, which needs the `user-library-modify` scope.
 * A grant made before Atlas asked for that scope cannot do it, so the button
 * then stays disabled and says why; the screen around it offers the one
 * reconnect. Episodes cannot be liked (Spotify saves shows, not episodes), so
 * no button is drawn for them.
 *
 * The icon set has no heart, so the design's own glyph is drawn here.
 */
import { useEffect } from 'react';
import { musicQueue, likedOf, useMusicQueue } from '@/hooks/useMusicQueue';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { LIKE_SCOPES, isEpisode, lacks, type Track } from '@/lib/musicSpotify';

export function HeartGlyph({ filled, size = 18 }: { filled: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
    </svg>
  );
}

export function MusicLike({ track, className, size = 18 }: { track: Track | null; className: string; size?: number }) {
  const m = useMusicPlayer();
  const q = useMusicQueue();
  // Ask Spotify once whether this record is liked: the store only asks by
  // itself for records Atlas's engine plays, and this one may be on a phone.
  const askId = track && !isEpisode(track) && m.connected ? track.id : null;
  useEffect(() => { if (askId) void musicQueue.checkLiked([askId]); }, [askId]);
  if (!track || isEpisode(track) || !m.available || !m.connected) return null;
  const missing = lacks(m.scopes, LIKE_SCOPES);
  const liked = likedOf(q, m.library, track) === true;
  const title = missing
    ? 'Liking a song needs a permission this Spotify connection does not have. Reconnect Spotify to turn on Like.'
    : liked ? 'Remove from your Liked Songs on Spotify' : 'Save to your Liked Songs on Spotify';
  return (
    <button
      type="button"
      className={`${className}${liked ? ' on' : ''}`}
      aria-label={liked ? 'Unlike' : 'Like'}
      aria-pressed={liked}
      title={title}
      disabled={missing || q.likeBusy}
      onClick={(e) => { e.stopPropagation(); void musicQueue.toggleLike(track); }}
    >
      <HeartGlyph filled={liked} size={size} />
    </button>
  );
}
