/**
 * Atlas Music Player v2 — the sleeve variant. Design handoff §7,
 * "Secondary · sleeve player".
 *
 * The same player as the full-screen one, laid out horizontally: one wash
 * instead of two, no vignette, no beat glow, no ribbon. Artwork on the left,
 * metadata and a plain progress bar on the right, the particle field pushed to
 * `cx: 0.79` so it sits behind the text rather than under the sleeve.
 *
 * It shares `useMusicSurface` (what is real, what is disabled and why) and
 * `useMusicStage` (palette crossfade, morph tween, the single frame) with the
 * other two presentations, so the three cannot drift apart.
 *
 * WHERE IT IS USED: `MusicPlayerFull` renders this instead of the full layout
 * when the window is too short for it. That is not a decorative choice — the
 * full player's own geometry needs the height (the handoff gives its section
 * `min-height: 700px`, and the cover card's sizing formula runs out of room
 * below ~552px), so on a short window the full layout crowds its own transport.
 * The sleeve is horizontal and fits.
 */
import { useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { AtlasSphereCanvas } from '../AtlasSphereCanvas';
import { Button } from '../primitives';
import { NextGlyph, PauseGlyph, PlayGlyph, PrevGlyph } from './musicIcons';
import { useMusicStage, type StageFrame } from './useMusicStage';
import {
  fmt, useMusicSurface, WHY_NEXT, WHY_NO_PLAY, WHY_NO_RESTART, WHY_RESTART, WHY_TAKEOVER,
} from './useMusicSurface';
import type { MusicChrome } from './musicPalette';
import '@/styles/surfaces/music.css';

export function MusicPlayerSleeve({ onClose }: { onClose?: () => void }) {
  const s = useMusicSurface();
  const { m, track, isPlaying, durationMs } = s;

  const washRef = useRef<HTMLImageElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const formationRef = useRef<HTMLSpanElement | null>(null);

  const onChrome = useCallback((c: MusicChrome) => {
    if (washRef.current) washRef.current.style.filter = c.washS;
    if (scrimRef.current) scrimRef.current.style.background = c.scrimS;
    if (playRef.current) playRef.current.style.color = c.ink;
  }, []);

  // Per-frame inputs the loop must see without re-subscribing.
  const liveIn = useRef({ durationMs, readPosition: m.readPosition });
  liveIn.current = { durationMs, readPosition: m.readPosition };
  const lastW = useRef('');

  const onFrame = useCallback((f: StageFrame) => {
    const { durationMs: dur, readPosition } = liveIn.current;
    const pos = dur > 0 ? Math.min(dur, readPosition()) : 0;
    // A width and a text node: no filter, no transform, nothing that repaints
    // the blurred wash behind them. Written only when the value actually
    // moves — the position is frozen whenever Atlas is not the one playing,
    // and re-assigning an identical inline width still dirties style on the
    // element every frame for nothing.
    if (fillRef.current) {
      const w = `${dur > 0 ? ((100 * pos) / dur).toFixed(2) : 0}%`;
      if (lastW.current !== w) { lastW.current = w; fillRef.current.style.width = w; }
    }
    const t = timeRef.current;
    if (t) {
      const txt = fmt(pos);
      if (t.textContent !== txt) t.textContent = txt;
    }
    const el = formationRef.current;
    if (el) {
      // The short form the handoff uses on this presentation.
      const txt = f.settled ? 'Sphere' : 'Field';
      if (el.textContent !== txt) el.textContent = txt;
    }
  }, []);

  const stage = useMusicStage({
    palette: s.art.palette,
    isPlaying,
    reactivity: s.reactivity,
    reduced: s.reduced,
    onChrome,
    onFrame,
  });

  const onSeekBar = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!s.canSeek) return;
    const r = e.currentTarget.getBoundingClientRect();
    s.seekToRatio((e.clientX - r.left) / r.width);
    if (stage.reduced) stage.paintNow();
  }, [s, stage]);

  return (
    <div className="mp2s">
      {s.art.src ? <img className="mp2swash" ref={washRef} src={s.art.src} alt="" aria-hidden /> : null}
      <AtlasSphereCanvas
        className="mp2scv"
        state="listening"
        count={9000}
        dens={0.7}
        size={0.6}
        radius={0.52}
        cx={0.79}
        alphaGain={0.98}
        glow={0.16}
        fieldSpread={1.1}
        sphereFrac={0.72}
        maxDpr={1.3}
        spin={0.0011}
        adaptive
        live={stage.live}
      />
      <div className="mp2sscrim" ref={scrimRef} aria-hidden />

      {onClose && (
        <button type="button" className="mp2sclose" onClick={onClose} aria-label="Close the player">
          <X className="i16" />
        </button>
      )}

      <div className="mp2sbody">
        <div className="mp2sart" title={s.coverNote}>
          {s.art.src ? <img src={s.art.src} alt="" /> : null}
          <span className="mp2coversheen" aria-hidden />
        </div>

        <div className="mp2stext">
          <div>
            <p className="mp2seyebrow">{s.blocker ? s.chip : (track?.album || 'Now playing')}</p>
            <p className="mp2stitle">{track ? track.title : 'Nothing playing'}</p>
            <p className="mp2sartist">{track ? track.artist : s.status}</p>
          </div>

          {/* Premium blocks playback, not the record: the title, artist,
              elapsed time and duration above and below are all real and all
              Atlas's to show, so only the transport is replaced. The other two
              blockers mean there is nothing truthful to show at all. */}
          {s.blockerHidesTrack && s.blocker ? (
            <div className="mp2sblock">
              <p className="mp2note">{s.blocker.short}</p>
              {s.blocker.action && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={s.blocker.action.onClick}
                  disabled={s.blocker.action.disabled}
                >
                  {s.blocker.action.label}
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="mp2sprog">
                <span ref={timeRef}>0:00</span>
                <div
                  className={`mp2sbar${s.canSeek ? ' live' : ''}`}
                  onClick={onSeekBar}
                  title={s.canSeek ? 'Click to seek.' : 'Seeking needs Atlas to be the one playing.'}
                >
                  <span ref={fillRef} />
                </div>
                <span>{fmt(durationMs)}</span>
              </div>

              <div className="mp2strans">
                <button
                  type="button"
                  className="mp2stbtn"
                  aria-label="Restart track"
                  title={s.canSeek ? WHY_RESTART : WHY_NO_RESTART}
                  disabled={!s.canSeek}
                  onClick={s.restart}
                >
                  <PrevGlyph size={20} />
                </button>
                <button
                  type="button"
                  className="mp2stbtn mp2stplay"
                  ref={playRef}
                  aria-label={s.showPause ? 'Pause' : 'Play'}
                  disabled={!s.canPlay}
                  title={!s.canPlay ? (s.blocker?.short ?? WHY_NO_PLAY) : s.takeover ? WHY_TAKEOVER : undefined}
                  onClick={s.onPlayPause}
                >
                  {s.showPause ? <PauseGlyph size={24} /> : <PlayGlyph size={24} nudge={3} />}
                </button>
                <button type="button" className="mp2stbtn" aria-label="Next" title={WHY_NEXT} disabled>
                  <NextGlyph size={20} />
                </button>
                <span className="mp2sformation" ref={formationRef}>Sphere</span>
              </div>
              {s.blocker && <p className="mp2note">{s.blocker.short}</p>}
            </>
          )}

          {m.error && <p className="mp2note bad">{m.error}</p>}
        </div>
      </div>
    </div>
  );
}
