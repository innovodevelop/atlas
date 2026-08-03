/**
 * Atlas Music Player v2 — the full-screen player.
 *
 * Design handoff `design_handoff_atlas_suite_v2`, README §5 and
 * `Atlas Music Player v2.dc.html`. Layers back to front: two static cover
 * washes → a palette-derived tint whose alpha follows the artwork's luminance →
 * a vignette → an unfiltered glow whose OPACITY rides the beat → the shared
 * particle renderer → chrome. Every colour comes from `atlasCover`; `--acc2`
 * belongs to the voice indicator and is not touched here.
 *
 * What is real and what is not — and the reason each dead control is dead —
 * lives in `music/useMusicSurface.tsx`, shared with the other two
 * presentations. Read that file before adding a control to any of them.
 *
 * TWO LAYOUTS, ONE PLAYER. Below `FULL_MIN_H` of window height this renders
 * the sleeve variant instead (`music/MusicPlayerSleeve.tsx`). The full layout
 * is vertical by construction — a 96px cover card pinned below the header, a
 * 316px reserved footer, an 84px transport — and the handoff gives its section
 * `min-height: 700px`. Below that the cover card can no longer expand at all
 * and the footer starts eating the transport. The sleeve is the same player
 * laid out horizontally, so it fits. Only one of the two is ever mounted, which
 * is what keeps this to one animation frame and one palette crossfade.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { occludeAllExcept } from '@/lib/atlasSphere';
import { AtlasSphereCanvas } from './AtlasSphereCanvas';
import { Empty } from './primitives';
import { MusicCoverCard, type CoverVariant } from './music/MusicCoverCard';
import { MusicPlayerSleeve } from './music/MusicPlayerSleeve';
import { BARS, drawWave, seedFromId, waveFor } from './music/musicWave';
import { GLOW_REST, useMusicStage, type StageFrame } from './music/useMusicStage';
import {
  fmt, useMusicSurface, WHY_LIKE, WHY_NEXT, WHY_NO_PLAY, WHY_NO_RESTART, WHY_NO_VOLUME,
  WHY_QUEUE, WHY_RESTART, WHY_RIBBON_INERT, WHY_RIBBON_LIVE, WHY_SHUFFLE, WHY_TAKEOVER,
  WHY_VOLUME,
} from './music/useMusicSurface';
import {
  HeartGlyph, NextGlyph, PauseGlyph, PlayGlyph, PrevGlyph, QueueGlyph, ShuffleGlyph, VolumeGlyph,
} from './music/musicIcons';
import type { MusicChrome } from './music/musicPalette';
import '@/styles/surfaces/music.css';

/**
 * The handoff's `min-height` for the full player's section. Below it the layout
 * has nowhere to put the cover card, so the sleeve takes over.
 */
const FULL_MIN_H = 700;
/** Hysteresis, so dragging a window edge across the threshold cannot thrash. */
const SWAP_BAND = 40;

function useShortWindow(): boolean {
  const [short, setShort] = useState(
    () => typeof window !== 'undefined' && window.innerHeight < FULL_MIN_H,
  );
  useEffect(() => {
    const on = () => setShort((was) => window.innerHeight < FULL_MIN_H + (was ? SWAP_BAND : 0));
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return short;
}

export function MusicPlayerFull({ onClose }: { onClose?: () => void }) {
  const short = useShortWindow();
  const rootRef = useRef<HTMLDivElement | null>(null);

  // This sheet is opaque, fixed and full-bleed, so every sphere outside it is
  // painting pixels nobody can see — the dashboard keeps its header orb (26 000
  // particles, no `count` prop) mounted above the focus view for the whole time
  // the player is open. The shared renderer's `visible()` is a viewport test
  // with no notion of occlusion, so the overlay has to say so itself.
  useEffect(() => occludeAllExcept(rootRef.current), []);

  // Portal to <body>: this is position:fixed, and the focus-view wrapper's
  // animation leaves a transform behind that would become its containing block.
  return createPortal(
    <div ref={rootRef} className={`mp2${short ? ' mp2short' : ''}`} data-screen-label="Atlas — Music">
      {short ? <MusicPlayerSleeve onClose={onClose} /> : <FullLayout onClose={onClose} />}
    </div>,
    document.body,
  );
}

function FullLayout({ onClose }: { onClose?: () => void }) {
  const s = useMusicSurface();
  const { m, track, isPlaying, durationMs } = s;

  const [variant, setVariant] = useState<CoverVariant>('sleeve');
  const [coverOpen, setCoverOpen] = useState(false);
  const [volOpen, setVolOpen] = useState(false);
  const [volume, setVolume] = useState(1);

  // --- element handles the frame loop writes to ---------------------------
  const wash1Ref = useRef<HTMLImageElement | null>(null);
  const wash2Ref = useRef<HTMLImageElement | null>(null);
  const tintRef = useRef<HTMLDivElement | null>(null);
  const glowRef = useRef<HTMLDivElement | null>(null);
  const scrimRef = useRef<HTMLDivElement | null>(null);
  const discRef = useRef<HTMLSpanElement | null>(null);
  const playRef = useRef<HTMLButtonElement | null>(null);
  const waveRef = useRef<HTMLCanvasElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const formationRef = useRef<HTMLSpanElement | null>(null);
  const hoverRef = useRef<number | null>(null);

  const onChrome = useCallback((c: MusicChrome) => {
    if (wash1Ref.current) wash1Ref.current.style.filter = c.wash1;
    if (wash2Ref.current) wash2Ref.current.style.filter = c.wash2;
    if (tintRef.current) tintRef.current.style.background = c.tint;
    if (scrimRef.current) scrimRef.current.style.background = c.scrim;
    if (playRef.current) playRef.current.style.color = c.ink;
    if (discRef.current) discRef.current.style.background = c.disc;
  }, []);

  // --- the progress ribbon ------------------------------------------------
  const waveSeed = track ? seedFromId(track.id) : 1;
  const waveData = useRef<number[]>(waveFor(waveSeed, BARS));
  const waveKey = useRef(waveSeed);
  if (waveKey.current !== waveSeed) { waveKey.current = waveSeed; waveData.current = waveFor(waveSeed, BARS); }

  // Per-frame inputs the loop must see without re-subscribing. Written during
  // render, read inside rAF — the same idiom `useAudioReactivity` uses.
  const liveIn = useRef({ durationMs, inert: !s.canSeek, readPosition: m.readPosition });
  liveIn.current = { durationMs, inert: !s.canSeek, readPosition: m.readPosition };

  /**
   * Last ribbon frame, so an unchanged one is not repainted.
   *
   * `drawWave` builds a 108-bar Path2D (432 arcTos) and fills it twice, once
   * inside a clip. Nothing about the ribbon moves while the position is
   * frozen — playback on another device, or paused — the envelope settles to a
   * constant within a second of the last `music:level`, and `hoverX` is null
   * unless the pointer is on it. Without this the surface repainted a
   * pixel-identical 108-bar ribbon 60–120 times a second, on top of the
   * sphere's own 14 000 particles, for as long as the player was open.
   *
   * Ratio is compared on the canvas's own device-pixel grid, not as a float:
   * the clip edge is `ratio * width`, so a change that cannot move it by half
   * a device pixel cannot change a single pixel of the output.
   */
  const lastWave = useRef({ r: -1, a: -1, hover: -1 as number | null, inert: false, w: 0, h: 0, dpr: 0, seed: 0 });

  const onFrame = useCallback((f: StageFrame) => {
    // THE BEAT LIVES HERE and nowhere else: one opacity write on an unfiltered
    // gradient. Never move it onto a wash layer's transform or filter — that
    // re-rasters a 96px blur every frame.
    if (glowRef.current) {
      glowRef.current.style.opacity = (0.1 + f.amp * 0.46 + f.pulse * 0.16).toFixed(3);
    }
    const { durationMs: dur, inert, readPosition } = liveIn.current;
    const pos = dur > 0 ? Math.min(dur, readPosition()) : 0;
    const cv = waveRef.current;
    if (cv) {
      const ratio = dur > 0 ? pos / dur : 0;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = Math.round(ratio * w * dpr);
      const a = Math.round(f.amp * 255);
      const hover = hoverRef.current;
      // The silhouette itself, so a track change repaints even if the ratio
      // and the envelope happen to land on the same rung.
      const seed = waveKey.current;
      const L = lastWave.current;
      if (r !== L.r || a !== L.a || hover !== L.hover || inert !== L.inert
        || w !== L.w || h !== L.h || dpr !== L.dpr || seed !== L.seed) {
        L.r = r; L.a = a; L.hover = hover; L.inert = inert;
        L.w = w; L.h = h; L.dpr = dpr; L.seed = seed;
        drawWave(cv, { data: waveData.current, ratio, amp: f.amp, hoverX: hover, inert });
      }
    }
    const t = timeRef.current;
    if (t) {
      const txt = fmt(pos);
      if (t.textContent !== txt) t.textContent = txt;
    }
    const el = formationRef.current;
    if (el) {
      const txt = f.settled ? 'Sphere · settled' : 'Field · in motion';
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

  // Under reduced motion there is no loop to pick up a glow value, so pin it to
  // the rest value of `0.1 + amp*0.46 + pulse*0.16`: the wash stays lit, but
  // nothing on this surface pulses.
  useEffect(() => {
    if (stage.reduced && glowRef.current) glowRef.current.style.opacity = GLOW_REST;
  }, [stage.reduced]);

  // Switching to Vinyl mounts a disc the palette has already finished moving
  // past, so without this it wears the stylesheet's default navy for the rest
  // of the track instead of the record's own tones.
  const { repaintChrome } = stage;
  useEffect(() => { repaintChrome(); }, [variant, repaintChrome]);

  const onSeekClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!s.canSeek) return;
    const r = e.currentTarget.getBoundingClientRect();
    s.seekToRatio((e.clientX - r.left) / r.width);
    if (stage.reduced) stage.paintNow();
  }, [s, stage]);

  const onVolume = useCallback((v: number) => {
    setVolume(v);
    m.setVolume(v).catch(() => {});
  }, [m]);

  // The blocker, as a block. Where it goes depends on WHAT it blocks: no
  // bridge and no account leave nothing truthful to show, so it replaces the
  // footer's body. Premium blocks playback alone — the record, the artwork, the
  // palette, the elapsed time and the duration are all still real — so there it
  // stands in for the transport only, which is the one part a Free account
  // genuinely cannot use. It previously replaced everything, under a body
  // reading "Everything else on this screen still works".
  const gate = s.blocker ? (
    <div className="mp2gate">
      <Empty
        size="block"
        icon={s.blocker.icon}
        title={s.blocker.title}
        body={s.blocker.body}
        status={s.blocker.status}
        action={s.blocker.action}
      />
    </div>
  ) : null;

  return (
    <>
      <div className="mp2layers" aria-hidden>
        {s.art.src ? <img className="mp2wash1" ref={wash1Ref} src={s.art.src} alt="" /> : null}
        {s.art.src ? <img className="mp2wash2" ref={wash2Ref} src={s.art.src} alt="" /> : null}
        <div className="mp2tint" ref={tintRef} />
        <div className="mp2vig" />
        <div className="mp2glow" ref={glowRef} />
      </div>

      {/* One renderer, the shared one. Live values go through `live` so the
          morph tween and the audio envelope never wait on a React commit. */}
      <AtlasSphereCanvas
        className="mp2hero"
        state="listening"
        count={14000}
        dens={0.7}
        size={0.6}
        radius={0.29}
        cy={0.46}
        alphaGain={1.22}
        glow={0.2}
        fieldSpread={1.12}
        sphereFrac={0.72}
        maxDpr={1.2}
        spin={0.0011}
        adaptive
        live={stage.live}
      />
      <div className="mp2scrim" ref={scrimRef} />

      <header className="mp2head">
        <span className="mp2chip">
          <span className={`mp2chipdot${m.connected ? '' : ' off'}`} aria-hidden />{s.chip}
        </span>
        <span className="mp2status">{s.status}</span>
        <span className="mp2headr">
          <span className="mp2formation" ref={formationRef}>Sphere · settled</span>
          <span className="mp2switch" role="group" aria-label="Cover style">
            {(['sleeve', 'vinyl'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={variant === v ? 'on' : undefined}
                aria-pressed={variant === v}
                onClick={() => setVariant(v)}
              >
                {v}
              </button>
            ))}
          </span>
          {onClose && (
            <button type="button" className="mp2close" onClick={onClose} aria-label="Close the player">
              <ChevronDown className="i20" />
            </button>
          )}
        </span>
      </header>

      <div className="mp2coverwrap">
        <MusicCoverCard
          variant={variant}
          src={s.art.src}
          open={coverOpen}
          onToggle={() => setCoverOpen((v) => !v)}
          discRef={discRef}
          note={s.coverNote}
        />
      </div>

      <div className="mp2spacer" />

      <footer className="mp2foot">
        {s.blockerHidesTrack ? gate : (
          <>
            <div className="mp2metarow">
              <div className="mp2text">
                <p className="mp2eyebrow">Now playing</p>
                <h1 className="mp2title">{track ? track.title : 'Nothing playing'}</h1>
                {track ? (
                  <p className="mp2sub">{track.artist}{track.album ? <> · <em>{track.album}</em></> : null}</p>
                ) : (
                  <Empty
                    size="inline"
                    body="Start something in Spotify and Atlas will pick it up, or press play once a track is showing."
                    status="resting"
                  />
                )}
              </div>
              <div className="mp2acts">
                <button type="button" className="mp2act" aria-label="Like" title={WHY_LIKE} disabled>
                  <HeartGlyph size={20} />
                </button>
                <button type="button" className="mp2act" aria-label="Queue" title={WHY_QUEUE} disabled>
                  <QueueGlyph size={20} />
                </button>
              </div>
            </div>

            <div>
              <canvas
                ref={waveRef}
                className={`mp2wave${s.canSeek ? ' live' : ''}`}
                onClick={onSeekClick}
                onMouseMove={(e) => {
                  if (!s.canSeek) return;
                  hoverRef.current = e.clientX - e.currentTarget.getBoundingClientRect().left;
                  if (stage.reduced) stage.paintNow();
                }}
                onMouseLeave={() => {
                  hoverRef.current = null;
                  if (stage.reduced) stage.paintNow();
                }}
                title={s.canSeek ? WHY_RIBBON_LIVE : WHY_RIBBON_INERT}
              />
              <div className="mp2times">
                <span ref={timeRef}>0:00</span>
                <span>{fmt(durationMs)}</span>
              </div>
            </div>

            {s.blocker ? gate : (
            <div className="mp2transport">
              <button type="button" className="mp2tbtn mp2tsm" aria-label="Shuffle" title={WHY_SHUFFLE} disabled>
                <ShuffleGlyph size={20} />
              </button>
              <button
                type="button"
                className="mp2tbtn mp2tmd"
                aria-label="Restart track"
                title={s.canSeek ? WHY_RESTART : WHY_NO_RESTART}
                disabled={!s.canSeek}
                onClick={s.restart}
              >
                <PrevGlyph size={26} />
              </button>
              <button
                type="button"
                className="mp2tbtn mp2tplay"
                ref={playRef}
                aria-label={s.showPause ? 'Pause' : 'Play'}
                disabled={!s.canPlay}
                title={!s.canPlay ? (s.blocker?.short ?? WHY_NO_PLAY) : s.takeover ? WHY_TAKEOVER : undefined}
                onClick={s.onPlayPause}
              >
                {s.showPause ? <PauseGlyph size={34} /> : <PlayGlyph size={34} nudge={4} />}
              </button>
              {/* 54, not 46: the handoff sizes Prev and Next identically either
                  side of the 84px play control, and building this one at 46
                  shifted the row's visual centre off the play button. */}
              <button type="button" className="mp2tbtn mp2tmd" aria-label="Next" title={WHY_NEXT} disabled>
                <NextGlyph size={26} />
              </button>
              <span className="mp2vol">
                <button
                  type="button"
                  className="mp2tbtn mp2tsm"
                  aria-label="Output volume"
                  aria-expanded={volOpen}
                  disabled={!s.canVolume}
                  title={s.canVolume ? WHY_VOLUME : WHY_NO_VOLUME}
                  onClick={() => setVolOpen((v) => !v)}
                >
                  <VolumeGlyph size={20} />
                </button>
                {volOpen && s.canVolume && (
                  <span className="mp2volpop">
                    <input
                      className="mp2volrange"
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={volume}
                      aria-label="Output volume"
                      onChange={(e) => onVolume(Number(e.currentTarget.value))}
                    />
                    <span className="mp2volval">{Math.round(volume * 100)}%</span>
                  </span>
                )}
              </span>
            </div>
            )}
          </>
        )}

        {m.error && <p className="mp2note bad">{m.error}</p>}
      </footer>
    </>
  );
}
