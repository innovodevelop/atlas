import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Play, Pause, SkipBack, SkipForward, Shuffle, Heart, Music, ChevronDown } from 'lucide-react';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { useAudioReactivity } from '@/hooks/useAudioReactivity';
import { MusicSphere } from './MusicSphere';

// Full-screen Atlas Sphere music player (design "Atlas Music Player", v4.4):
// an immersive takeover — the Field sphere fills the whole background, the track
// title/artist/album sit centred at top, transport flat at the bottom. Uses only
// the Field form (the other forms stay in MusicSphere but aren't exposed). Esc or
// the collapse control returns to the dashboard.
const FORM = 'field' as const;

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function Waveform({ ratio, onSeek }: { ratio: number; onSeek: (r: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bars = useMemo(
    () => Array.from({ length: 120 }, (_, i) =>
      0.26 + 0.74 * Math.abs(Math.sin(i * 0.5) * 0.6 + Math.sin(i * 0.17 + 1.3) * 0.4 + Math.sin(i * 1.1) * 0.2)),
    [],
  );
  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const x = cv.getContext('2d'); if (!x) return;
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
    const n = bars.length, bw = w / n, cy = h / 2;
    for (let i = 0; i < n; i++) {
      const p = i / n; const bh = Math.min(bars[i] * (h * 0.86), h);
      x.fillStyle = p <= ratio ? '#fff' : 'rgba(255,255,255,.30)';
      x.beginPath();
      const bx = i * bw + bw * 0.2, by = cy - bh / 2, bwid = bw * 0.6, r = Math.min(bw * 0.3, bh / 2);
      x.moveTo(bx + r, by); x.arcTo(bx + bwid, by, bx + bwid, by + bh, r);
      x.arcTo(bx + bwid, by + bh, bx, by + bh, r); x.arcTo(bx, by + bh, bx, by, r);
      x.arcTo(bx, by, bx + bwid, by, r); x.closePath(); x.fill();
    }
  }, [bars, ratio]);
  return (
    <canvas
      ref={ref}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
      }}
      className="mpwave"
    />
  );
}

export function MusicPlayerFull({ onClose }: { onClose?: () => void }) {
  const m = useMusicPlayer();
  const isPlaying = m.nowPlaying?.isPlaying ?? false;
  const reactivity = useAudioReactivity(m.levelRef, isPlaying);
  const [liked, setLiked] = useState(false);

  const track = m.nowPlaying?.track ?? null;
  const durationMs = track?.durationMs ?? 0;
  const positionMs = m.nowPlaying?.positionMs ?? 0;
  const ratio = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;

  const notice =
    !m.available ? 'Open the Atlas desktop app to play music.'
      : (m.connected && !m.premium) ? 'Spotify Premium is required to play full tracks.'
        : null;
  const showControls = m.connected && m.available && m.premium;

  // Portal to <body>: the full-screen takeover must escape the focused-view
  // wrapper, whose animation leaves a transform that would otherwise trap this
  // position:fixed element (containing-block).
  return createPortal(
    <div className="mpfull">
      {/* Field fills the whole background. */}
      <div className="mpbg"><MusicSphere form={FORM} reactivity={reactivity} className="mpbgsphere" /></div>
      <div className="mptopglow" />
      <div className="mpbottomfade" />
      <div className="mpminiglow" />

      {onClose && (
        <button className="mpcollapse" onClick={onClose} aria-label="Collapse">
          <ChevronDown className="i20" />
        </button>
      )}

      <div className="mphead">
        <p className="mpeyebrow">Now playing</p>
        <p className="mptitle">
          {track?.title ?? (m.connected ? 'Nothing playing' : 'Atlas Music')}
          {track?.artist && <span className="mpartist"> · {track.artist}</span>}
        </p>
        <p className="mpalbum">{track?.album ?? (m.connected ? '' : 'Your sphere, listening')}</p>
      </div>

      <div className="mpdock">
        {!m.connected && m.available ? (
          <div className="mpconnect">
            <button className="mpconnectbtn" onClick={() => m.connect()} disabled={m.isConnecting}>
              <Music className="i16" />{m.isConnecting ? 'Waiting for Spotify…' : 'Connect Spotify'}
            </button>
            {m.error && <p className="mpnote">{m.error}</p>}
          </div>
        ) : notice ? (
          <p className="mpnote">{notice}</p>
        ) : null}

        {showControls && (
          <div className="mpseek">
            <Waveform ratio={ratio} onSeek={(r) => m.seek(Math.round(r * durationMs))} />
            <div className="mptimes"><span>{fmt(positionMs)}</span><span>{fmt(durationMs)}</span></div>
          </div>
        )}

        <div className="mptransport">
          <button className="mpbtn" aria-label="Shuffle"><Shuffle className="i20" /></button>
          <button className="mpbtn" aria-label="Previous" onClick={() => m.prev()}><SkipBack className="i24" /></button>
          <button className="mpbtn mpplay" aria-label={isPlaying ? 'Pause' : 'Play'} onClick={() => (isPlaying ? m.pause() : m.play())}>
            {isPlaying ? <Pause className="i24" /> : <Play className="i24" />}
          </button>
          <button className="mpbtn" aria-label="Next" onClick={() => m.next()}><SkipForward className="i24" /></button>
          <button className={`mpbtn${liked ? ' liked' : ''}`} aria-label="Like" onClick={() => setLiked((v) => !v)}>
            <Heart className="i20" fill={liked ? 'currentColor' : 'none'} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
