/**
 * The Rooms tab of the listening room (`Atlas Music Beta.dc.html`): where the
 * music plays, and how loud, in each place.
 *
 * Real rooms only: this Mac (Atlas's own engine) and the account's Spotify
 * Connect devices, from `GET /me/player/devices`. Spotify plays on one device
 * at a time, so a room is a choice, not a toggle — tapping one moves what is
 * playing there (see `roomMove` in src/lib/betaMusic.ts for the three ways it
 * can move). Atlas itself is not a Connect device, so Spotify never lists it;
 * this Mac is added here. The list is re-read every ten seconds while the tab
 * is open, because speakers come and go.
 */
import { useEffect } from 'react';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { musicQueue, useMusicQueue } from '@/hooks/useMusicQueue';
import { roomsFrom } from '@/lib/betaMusic';
import { ROOM_SCOPES, lacks } from '@/lib/musicSpotify';

const REFRESH_MS = 10_000;

export function MusicRooms({ atlasOwnsAudio, onReconnect }: { atlasOwnsAudio: boolean; onReconnect: () => void }) {
  const m = useMusicPlayer();
  const q = useMusicQueue();
  const roomsMissing = lacks(m.scopes, ROOM_SCOPES);
  const live = m.available && m.connected && !roomsMissing;

  useEffect(() => {
    if (!live) return;
    void musicQueue.refreshRooms();
    const id = window.setInterval(() => { if (!document.hidden) void musicQueue.refreshRooms(); }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [live]);

  const empty = (title: string, body: string, action?: { label: string; onClick: () => void }) => (
    <div className="b-mu-empty">
      <b>{title}</b>{body}
      {action ? <div className="b-mu-empty-act"><button type="button" className="b-mu-btn" onClick={action.onClick}>{action.label}</button></div> : null}
    </div>
  );

  if (!m.available) return empty('Mac app only', 'Rooms are your Spotify speakers, reached from the Atlas desktop app.');
  if (!m.connected) return empty('Not connected', 'Connect Spotify and your speakers show here.');
  if (roomsMissing) {
    return empty(
      'Rooms needs one more permission',
      'Spotify only lets Atlas see and steer your other speakers once you reconnect and allow it.',
      { label: 'Reconnect Spotify to turn on Rooms', onClick: onReconnect },
    );
  }

  const isPlaying = !!m.nowPlaying?.isPlaying;
  const rooms = roomsFrom(q.devices, { atlasOwnsAudio, isPlaying, macVolume: q.prefs.volume });
  const loading = q.rooms.status === 'loading' && q.rooms.at === 0;

  return (
    <div className="b-mu-rooms">
      {rooms.map((r) => {
        const moving = q.rooms.moving === r.id;
        return (
          <div key={r.id} className={`b-mu-room${r.active ? ' on' : ''}`}>
            <div className="b-mu-room-row">
              <button
                type="button"
                className="b-mu-room-ico"
                aria-pressed={r.active}
                aria-label={r.active ? `${r.name}, playing here` : `Play on ${r.name}`}
                title={r.restricted ? 'This device does not take remote control from Spotify.' : r.active ? 'The music is here' : `Move the music to ${r.name}`}
                disabled={r.restricted || q.rooms.moving !== null}
                onClick={() => void musicQueue.moveTo(r.id)}
              >
                <AtlasIcon name={r.icon} size={18} weight={1.5} />
              </button>
              <span className="b-mu-room-text"><b>{r.name}</b><span>{moving ? 'Moving the music here…' : r.detail}</span></span>
              <span className="b-mu-room-vol">{r.volume == null ? '—' : `${r.volume}%`}</span>
            </div>
            {r.active && r.volume != null ? (
              <input
                type="range"
                min={0}
                max={100}
                value={r.volume}
                aria-label={`${r.name} volume`}
                onChange={(e) => musicQueue.setRoomVolume(r.id, Number(e.currentTarget.value))}
              />
            ) : null}
          </div>
        );
      })}
      {loading ? <p className="b-mu-note">Asking Spotify for your speakers…</p> : null}
      {q.rooms.error ? <p className="b-mu-err" role="status">{q.rooms.error}</p> : null}
      <p className="b-mu-note">
        Your Spotify Connect speakers. A speaker shows once it is on and signed in to Spotify; choosing one moves what is
        playing there, through Spotify. This Mac is Atlas itself, and ducking only lowers it.
      </p>
    </div>
  );
}
