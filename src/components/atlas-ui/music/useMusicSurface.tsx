/**
 * What the player is allowed to say and do — shared by all three presentations.
 *
 * WHAT IS REAL AND WHAT IS NOT. Read this before adding a control anywhere on
 * the music surface.
 *
 * Real: the track (id/title/artist/album/art/duration), play, pause, seek,
 * volume, position (anchored to the engine's own `position_ms` and
 * interpolated), the audio envelope behind the sphere and the crest at the
 * playhead, and the palette when the artwork can be sampled.
 *
 * Not real, and therefore DISABLED wherever it appears, with the reason on the
 * control:
 *   • shuffle and skip — `music_engine.rs` holds a one-element queue, so both
 *     are silent no-ops in Rust today;
 *   • like — writing the Spotify library needs `user-library-modify`, absent
 *     from the scope string in `music.rs` and not addable without every
 *     connected user reconnecting;
 *   • the queue button — there is no queue to open.
 *
 * The reasons live here as constants so the three presentations cannot drift
 * into three different explanations of the same limitation. If one of these
 * becomes real, delete its constant — the compile error will find every
 * surface that was making the excuse.
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Laptop, Music2, ShieldAlert } from 'lucide-react';
import { engineHoldsUri, useMusicPlayer, type MusicPlayer, type Track } from '@/hooks/useMusicPlayer';
import { useAudioReactivity, type Reactivity } from '@/hooks/useAudioReactivity';
import { useReducedMotion } from './useMusicStage';
import { useCoverArt, type CoverArt } from './useCoverArt';
import type { RefObject } from 'react';

export const WHY_SHUFFLE =
  'Shuffle needs a queue. Atlas loads one track at a time — the local engine holds a single-element queue until playlist queueing lands.';
export const WHY_NEXT =
  'Skip needs a queue. Atlas loads one track at a time, so there is nothing after this one yet.';
export const WHY_LIKE =
  'Atlas cannot save to your Spotify library: that needs the user-library-modify permission, which it has never asked for. Adding it would require every connected account to reconnect.';
export const WHY_QUEUE = 'There is no queue yet — Atlas plays a single track at a time.';
export const WHY_RESTART = 'Restart this track. There is no previous track: Atlas plays one at a time.';
/**
 * Restart is a seek, so it dies for the same reason the ribbon does. It used to
 * keep `WHY_RESTART` when disabled — the one greyed control on the surface that
 * explained its label instead of its deadness.
 */
export const WHY_NO_RESTART =
  'Restarting is a seek, and seeking needs Atlas to be the one playing.';
export const WHY_NO_PLAY = 'Nothing to play yet.';
/** Pressing play when the audio is somewhere else moves it here. */
export const WHY_TAKEOVER =
  'Play this through Atlas instead. It will start here, on this Mac; the other device keeps its own copy of the queue.';
export const WHY_VOLUME =
  'Atlas’s own output volume. It sets the local engine; it does not read the value back, so it starts where librespot does.';
export const WHY_NO_VOLUME = 'Volume applies to Atlas’s own playback, which has not started yet.';
export const WHY_RIBBON_LIVE =
  'Playback position. The pattern is a per-track signature, not an analysis of the audio — click to seek.';
export const WHY_RIBBON_INERT =
  'Playback position. The pattern is a per-track signature, not an analysis of the audio. Seeking needs Atlas to be the one playing.';

/** Why the surface cannot play anything at all, if it cannot. */
export interface MusicBlocker {
  kind: 'desktop' | 'connect' | 'premium';
  icon: ReactNode;
  title: string;
  /** The full explanation. The full player has room for it. */
  body: string;
  /** One line, for presentations that do not. */
  short: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  status: 'stale' | 'error';
}

export interface MusicSurface {
  m: MusicPlayer;
  track: Track | null;
  isPlaying: boolean;
  durationMs: number;
  art: CoverArt;
  reactivity: RefObject<Reactivity>;
  reduced: boolean;
  /** True when the local engine holds THIS track — i.e. Atlas is the player. */
  atlasOwnsAudio: boolean;
  canPlay: boolean;
  canSeek: boolean;
  canVolume: boolean;
  /** Non-null when playback is impossible; every presentation must show it. */
  blocker: MusicBlocker | null;
  /**
   * True when the blocker also means there is nothing truthful to show — no
   * bridge, or no account — so a presentation should replace its body with it.
   *
   * False for the Premium blocker, which stops PLAYBACK and nothing else: the
   * track, the artwork, the palette, the elapsed time and the duration are all
   * still real and still Atlas's to show. Hiding them behind a notice reading
   * "Everything else on this screen still works" was the notice contradicting
   * itself.
   */
  blockerHidesTrack: boolean;
  /**
   * True when the play button will MOVE playback to Atlas rather than pause or
   * resume it — i.e. something is playing on another device.
   */
  takeover: boolean;
  /** Whether the play control should read as Pause. See `takeover`. */
  showPause: boolean;
  /** Source chip copy: `Spotify · Premium` and its honest variants. */
  chip: string;
  /** One-line transport state. */
  status: string;
  /** Extra context about the artwork, or undefined when there is none. */
  coverNote: string | undefined;
  onPlayPause: () => void;
  /** Seek by fraction of the track. No-op unless `canSeek`. */
  seekToRatio: (ratio: number) => void;
  /** Back to 0:00. No-op unless `canSeek`. */
  restart: () => void;
}

export function useMusicSurface(): MusicSurface {
  const m = useMusicPlayer();
  const track = m.nowPlaying?.track ?? null;
  const isPlaying = m.nowPlaying?.isPlaying ?? false;
  const durationMs = track?.durationMs ?? 0;

  const reduced = useReducedMotion();
  const reactivity = useAudioReactivity(m.levelRef, isPlaying, { reactive: !reduced });
  const art = useCoverArt(track);

  // Bumped after a successful `music_load` so `engineHoldsUri` — module state,
  // not React state — is re-read on the next render.
  const [, setLoadTick] = useState(0);

  const atlasOwnsAudio = m.audioReady && engineHoldsUri(track?.uri);
  const canPlay = m.available && m.connected && m.premium && !!track;
  /** Seeking touches the engine, so it is only offered once Atlas holds the track. */
  const canSeek = canPlay && durationMs > 0 && atlasOwnsAudio;
  const canVolume = m.available && m.connected && m.premium && m.audioReady;

  const blocker: MusicBlocker | null = !m.available
    ? {
      kind: 'desktop',
      icon: <Laptop className="i20" />,
      title: 'Open Atlas on your Mac',
      body: 'Music is decoded natively by the desktop app. The browser preview has no audio engine and no bridge to one, so nothing here would play.',
      short: 'Playback lives in the desktop app.',
      status: 'stale',
    }
    : !m.connected
      ? {
        kind: 'connect',
        icon: <Music2 className="i20" />,
        title: 'Connect Spotify',
        body: 'Atlas plays through your own Spotify account, on this Mac. Connecting opens Spotify in your browser once; the token is kept in your macOS Keychain.',
        short: m.isConnecting ? 'Waiting for Spotify…' : 'Connect Spotify in Settings to play.',
        action: {
          label: m.isConnecting ? 'Waiting for Spotify…' : 'Connect Spotify',
          onClick: () => { void m.connect(); },
          disabled: m.isConnecting,
        },
        status: 'stale',
      }
      : !m.premium
        ? {
          kind: 'premium',
          icon: <ShieldAlert className="i20" />,
          title: 'Spotify Premium is required',
          body: 'Spotify only permits full-track playback for Premium accounts, so Atlas cannot start audio on this one. Everything else on this screen still works.',
          short: 'Full-track playback needs Spotify Premium.',
          status: 'error',
        }
        : null;

  /**
   * PAUSE ONLY MEANS PAUSE WHEN ATLAS IS THE ONE PLAYING.
   *
   * `music_pause` reaches `player.pause()` on Atlas's own librespot Player.
   * When the audio is coming out of the user's phone, Atlas's player holds
   * nothing, so the call spawns an engine and pauses silence: the button
   * animated, the phone kept playing, and the surface went on saying "Playing
   * on iPhone". A control that does nothing while looking like it did
   * something is the exact failure this surface is not allowed to ship, so the
   * button reads Play in that state and its press moves playback here.
   */
  const showPause = isPlaying && atlasOwnsAudio;
  const takeover = !!track && isPlaying && !atlasOwnsAudio;

  const onPlayPause = useCallback(() => {
    if (!track) return;
    void (async () => {
      try {
        if (isPlaying && atlasOwnsAudio) { await m.pause(); return; }
        // `music_play` on an engine that was never handed a track plays
        // silence: librespot's queue is empty until `music_load`. Load first,
        // which also starts playback (`player.load(uri, start_playing, 0)`).
        if (!engineHoldsUri(track.uri)) {
          await m.load(track.uri);
          setLoadTick((n) => n + 1);
          return;
        }
        await m.play();
      } catch {
        // `useMusicPlayer` already surfaced it on `error`; every presentation
        // renders that.
      }
    })();
  }, [atlasOwnsAudio, isPlaying, m, track]);

  const seekToRatio = useCallback((ratio: number) => {
    if (!canSeek || !durationMs) return;
    const r = ratio > 0 ? (ratio < 1 ? ratio : 1) : 0;
    m.seek(Math.round(r * durationMs)).catch(() => {});
  }, [canSeek, durationMs, m]);

  const restart = useCallback(() => {
    if (!canSeek) return;
    m.seek(0).catch(() => {});
  }, [canSeek, m]);

  const chip = !m.available ? 'Spotify · Desktop only'
    : !m.connected ? 'Spotify · Not connected'
      : m.premium ? 'Spotify · Premium' : 'Spotify · Free';

  const status = !m.available ? 'Desktop app required'
    : !m.connected ? 'Not connected'
      : !m.premium ? 'Playback needs Premium'
        : !track ? 'Nothing playing'
          : isPlaying
            ? (atlasOwnsAudio ? 'Playing through Atlas' : `Playing on ${m.nowPlaying?.deviceName ?? 'Spotify'}`)
            : (atlasOwnsAudio ? 'Paused' : 'Paused elsewhere');

  const coverNote = art.procedural
    ? 'No artwork on this release, so Atlas generated a sleeve from the track id.'
    : art.sampled ? undefined
      : 'Colours could not be read from this sleeve — Spotify’s CDN did not allow it — so Atlas is using its own palette.';

  return {
    m,
    track,
    isPlaying,
    durationMs,
    art,
    reactivity,
    reduced,
    atlasOwnsAudio,
    canPlay,
    canSeek,
    canVolume,
    blocker,
    blockerHidesTrack: blocker !== null && blocker.kind !== 'premium',
    takeover,
    showPause,
    chip,
    status,
    coverNote,
    onPlayPause,
    seekToRatio,
    restart,
  };
}

/** `m:ss`, clamped at zero. */
export const fmt = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
