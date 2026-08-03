/**
 * Atlas Music Player v2 — the compact widget. Design handoff §8.
 *
 * The dashboard's Now-Playing tile. Same player, same renderer, same palette
 * pipeline as the full-screen one, at 412×~102: one wash, the particle field
 * at 85 % opacity, artwork, two lines of metadata, a live equaliser, play, and
 * a 3px progress hairline along the bottom.
 *
 * THE TILE'S COLOUR COMES FROM THE RECORD. It replaces a flat `--acc` blue
 * card, which is why this is the one dashboard tile that is not on the paper
 * scale: the whole point of the surface is that the artwork drives it. It is
 * still the shared `<Card>` — the grid span, the entry stagger, the hover lift
 * and the keyboard affordance are the primitive's, not re-implemented here.
 *
 * THE EQUALISER IS REAL, AND ONLY APPEARS WHEN IT CAN BE. It is driven by the
 * `music:level` envelope librespot emits at 30Hz, so it is only rendered while
 * Atlas itself is decoding this track. When Spotify is playing on another
 * device Atlas receives no envelope, and five bars bouncing to a fixed CSS
 * keyframe — which is what the tile used to draw — would be inventing the
 * sound of audio it cannot hear.
 */
import { useCallback, useRef } from 'react';
import { AtlasSphereCanvas } from '../AtlasSphereCanvas';
import { Card } from '../primitives';
import { PauseGlyph, PlayGlyph } from './musicIcons';
import { drawEq, eqStep, EQ_BARS } from './musicWave';
import { useMusicStage, type StageFrame } from './useMusicStage';
import { useMusicSurface, WHY_NO_PLAY, WHY_TAKEOVER } from './useMusicSurface';
import type { MusicChrome } from './musicPalette';
import '@/styles/surfaces/music.css';

export function MusicPlayerCompact({ onOpen }: { onOpen?: () => void }) {
  const s = useMusicSurface();
  const { m, track, isPlaying, durationMs } = s;

  const washRef = useRef<HTMLImageElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const eqRef = useRef<HTMLCanvasElement | null>(null);
  const eqBars = useRef<number[]>(new Array(EQ_BARS).fill(0));

  const onChrome = useCallback((c: MusicChrome) => {
    if (washRef.current) washRef.current.style.filter = c.washC;
    if (scrimRef.current) scrimRef.current.style.background = c.scrimC;
    if (playRef.current) playRef.current.style.color = c.ink;
  }, []);

  const liveIn = useRef({ durationMs, readPosition: m.readPosition });
  liveIn.current = { durationMs, readPosition: m.readPosition };

  const lastTs = useRef(0);
  const lastW = useRef('');
  const onFrame = useCallback((f: StageFrame) => {
    const { durationMs: dur, readPosition } = liveIn.current;
    const pos = dur > 0 ? Math.min(dur, readPosition()) : 0;
    // Only when it moves. The hairline is 3px tall and the widget sits on the
    // dashboard for the whole session, so a frozen position — anything playing
    // on another device, or nothing playing — must not cost a style write per
    // frame forever.
    if (fillRef.current) {
      const w = `${dur > 0 ? ((100 * pos) / dur).toFixed(2) : 0}%`;
      if (lastW.current !== w) { lastW.current = w; fillRef.current.style.width = w; }
    }

    const cv = eqRef.current;
    if (!cv) { lastTs.current = 0; return; }
    // The stage does not hand out a dt (nothing else needs one), so the EQ
    // keeps its own. Clamped the same way the stage clamps its own: a tab that
    // was backgrounded for a minute must not arrive as a one-minute step.
    const now = performance.now();
    const dt = lastTs.current ? Math.min(0.05, (now - lastTs.current) / 1000) : 0.016;
    lastTs.current = now;
    drawEq(cv, eqStep(eqBars.current, f.amp, now / 1000, dt));
  }, []);

  const stage = useMusicStage({
    palette: s.art.palette,
    isPlaying,
    reactivity: s.reactivity,
    reduced: s.reduced,
    onChrome,
    onFrame,
  });

  // Only claim to visualise audio Atlas can actually hear.
  const eqLive = s.atlasOwnsAudio && isPlaying && !stage.reduced;

  const title = track?.title ?? (m.connected ? 'Nothing playing' : 'Atlas Music');
  const sub = track?.artist ?? (s.blocker ? s.blocker.short : 'Open the player');

  return (
    <Card
      size="s"
      skin="ink"
      delay={8}
      className="mp2c"
      onOpen={onOpen}
      bleed={(
        <>
          {s.art.src ? <img className="mp2cwash" ref={washRef} src={s.art.src} alt="" /> : null}
          <AtlasSphereCanvas
            className="mp2ccv"
            state="listening"
            count={2200}
            dens={0.7}
            size={0.55}
            radius={0.34}
            cx={0.62}
            alphaGain={0.96}
            glow={0.1}
            fieldSpread={1.14}
            sphereFrac={0.72}
            maxDpr={1.3}
            spin={0.0011}
            adaptive
            live={stage.live}
          />
          <div className="mp2cscrim" ref={scrimRef} />
        </>
      )}
    >
      <div className="mp2cbody">
        <span className="mp2cart" title={s.coverNote}>
          {s.art.src ? <img src={s.art.src} alt="" /> : null}
          <span className="mp2coversheen" aria-hidden />
        </span>
        <span className="mp2ctext">
          <span className="mp2ceyebrow">Now playing</span>
          <span className="mp2ctitle">{title}</span>
          <span className="mp2csub">{sub}</span>
        </span>
        {eqLive && (
          <canvas
            className="mp2ceq"
            ref={eqRef}
            aria-hidden
            title="Atlas’s own output level, from the audio it is decoding right now."
          />
        )}
        <button
          type="button"
          className="mp2cplay"
          ref={playRef}
          aria-label={s.showPause ? 'Pause' : 'Play'}
          disabled={!s.canPlay}
          title={!s.canPlay ? (s.blocker?.short ?? WHY_NO_PLAY) : s.takeover ? WHY_TAKEOVER : undefined}
          onClick={(e) => { e.stopPropagation(); s.onPlayPause(); }}
        >
          {s.showPause ? <PauseGlyph size={20} /> : <PlayGlyph size={20} nudge={2} />}
        </button>
      </div>
      <div className="mp2cprog" aria-hidden><span ref={fillRef} /></div>
    </Card>
  );
}
