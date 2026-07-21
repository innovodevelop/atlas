import { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, Shuffle, Heart, Music } from 'lucide-react';
import { useMusicPlayer } from '@/hooks/useMusicPlayer';
import { useAudioReactivity } from '@/hooks/useAudioReactivity';
import { MusicSphere } from './MusicSphere';

// The player uses only the "Field" sphere form (the other forms remain in
// MusicSphere but are intentionally not exposed / selectable here).
const FORM = 'field' as const;

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// A static-but-progress-aware waveform; click to seek.
function Waveform({ ratio, onSeek }: { ratio: number; onSeek: (r: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const bars = useMemo(
    () => Array.from({ length: 96 }, (_, i) =>
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
      x.fillStyle = p <= ratio ? '#fff' : 'rgba(255,255,255,.32)';
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

/** Full-screen Atlas Sphere music player — the 'music' focused widget. */
export function MusicPlayerFull() {
  const m = useMusicPlayer();
  const isPlaying = m.nowPlaying?.isPlaying ?? false;
  const reactivity = useAudioReactivity(m.levelRef, isPlaying);
  const [liked, setLiked] = useState(false);

  const track = m.nowPlaying?.track ?? null;
  const durationMs = track?.durationMs ?? 0;
  const positionMs = m.nowPlaying?.positionMs ?? 0;
  const ratio = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;

  // Non-desktop / not-connected states.
  const notice =
    !m.available ? 'Open the Atlas desktop app to play music.'
      : !m.connected ? null
        : (m.connected && !m.premium) ? 'Spotify Premium is required to play full tracks.'
          : null;

  return (
    <div className="mpfull">
      <div className="mptop">
        <p className="mpeyebrow">Now playing</p>
        <p className="mptitle">{track?.title ?? (m.connected ? 'Nothing playing' : 'Atlas Music')}</p>
        <p className="mpartist">{track?.artist ?? (m.connected ? '' : 'Your sphere, listening')}</p>
      </div>

      <div className="mpstage">
        <MusicSphere form={FORM} reactivity={reactivity} className="mpsphere" />
      </div>

      {!m.connected && m.available ? (
        <div className="mpconnect">
          <button className="mpconnectbtn" onClick={() => m.connect()} disabled={m.isConnecting}>
            <Music className="i16" />{m.isConnecting ? 'Waiting for Spotify…' : 'Connect Spotify'}
          </button>
          {m.error && <p className="mpnote">{m.error}</p>}
        </div>
      ) : notice ? (
        <p className="mpnote">{notice}</p>
      ) : (
        <>
          <div className="mpseek">
            <Waveform ratio={ratio} onSeek={(r) => m.seek(Math.round(r * durationMs))} />
            <div className="mptimes"><span>{fmt(positionMs)}</span><span>{fmt(durationMs)}</span></div>
          </div>

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
        </>
      )}
    </div>
  );
}
