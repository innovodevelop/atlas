/**
 * The Beta Music — `/music`, the listening room (Beta redesign phase 4,
 * `Atlas Music Beta.dc.html`).
 *
 * The hero is the record: the cover with its disc, the title, the progress
 * ribbon (click to seek), the transport and Atlas's output volume. Beside it
 * the aside holds Up next and a Spotify search; under both, the station row
 * is the account's own playlists, with the liked songs first.
 *
 * Everything reads and writes the same `useMusicPlayer` store the Home widget
 * and the Workshop player use, and the rules for what may be offered come
 * from `useMusicSurface` (read its header before adding a control). One thing
 * is new here: a queue. The Rust engine holds a one-element queue, so its own
 * Next and Previous do nothing; this screen keeps the list (liked songs, a
 * playlist, a search) and steps through it by handing the engine the next
 * track with its metadata (`load(uri, track)`), including when the engine
 * reports a track has ended (`nowPlaying.ended`). The queue therefore only
 * advances while this screen is open; the choice survives leaving it.
 *
 * Left out, because Atlas has no source for them: lyrics, rooms and
 * per-speaker volume (the engine plays on this Mac only), ducking (nothing
 * lowers the engine when someone speaks), the like button (the Spotify grant
 * has no `user-library-modify`) and the mood stations, which are the
 * account's real playlists instead.
 *
 * Keys, the design's: Space play/pause · ← previous · → next · / search · Esc Home.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { engineHoldsUri, type Playlist, type SearchResults, type Track } from '@/hooks/useMusicPlayer';
import { fmt, useMusicSurface } from '@/components/atlas-ui/music/useMusicSurface';
import { drawWave, seedFromId, waveFor } from '@/components/atlas-ui/music/musicWave';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { useAtlasState } from '@/lib/atlasStateBus';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import {
  DEFAULT_PREFS, PREFS_KEY, STATIONS_SHOWN, WAVE_BARS, afterEnd, neighbour, outputLine, parsePrefs, prevIntent,
  queueSummary, ratioAt, sameSource, sourceLabel, startOf, stationLine, volumeLabel,
  type MusicPrefs, type QueueSource,
} from '@/lib/betaMusic';
import { isTyping } from './atlasHelpers';
import '@/styles/beta/music.css';

export const surface = {
  path: '/music',
  label: 'Music',
  icon: 'Music',
  entry: 'menu' as const,
  mock: false,
  edition: 'consumer' as const,
};

const LIBRARY: QueueSource = { kind: 'library' };
/** `loadLibrary`'s page size; a page shorter than this was the last one. */
const LIBRARY_PAGE = 50;
const SEARCH_DEBOUNCE_MS = 320;

interface QueueState { source: QueueSource; tracks: Track[] }

/**
 * The queue the room last played from. Module scope, so leaving the screen
 * and coming back finds the same list rather than falling back to the liked
 * songs; nothing is persisted beyond the session.
 */
let lastQueue: QueueState = { source: LIBRARY, tracks: [] };

function readPrefs(): MusicPrefs {
  try { return parsePrefs(window.localStorage.getItem(PREFS_KEY)); } catch { return { ...DEFAULT_PREFS }; }
}
function writePrefs(p: MusicPrefs): void {
  // A per-viewer convenience: a private window or blocked storage just forgets.
  try { window.localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* nothing to do */ }
}

const rgb = (c: readonly number[]): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

const BetaMusic = () => {
  const navigate = useBetaNavigate();
  const s = useMusicSurface();
  const { m, track, isPlaying, durationMs } = s;
  const np = m.nowPlaying;
  const bus = useAtlasState();

  const canBrowse = m.available && m.connected;
  const canQueue = canBrowse && m.premium;

  const [tab, setTab] = useState<'queue' | 'search'>('queue');
  const [q, setQ] = useState<QueueState>(lastQueue);
  const [prefs, setPrefs] = useState<MusicPrefs>(readPrefs);
  const [libLoading, setLibLoading] = useState(false);
  const [listsLoading, setListsLoading] = useState(false);
  const [more, setMore] = useState<{ busy: boolean; from: number } | null>(null);
  const [allStations, setAllStations] = useState(false);
  const [stationBusy, setStationBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [sphereEl, setSphereEl] = useState<HTMLButtonElement | null>(null);

  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);
  const waveRef = useRef<HTMLCanvasElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const hoverRef = useRef<number | null>(null);

  useEffect(() => { lastQueue = q; }, [q]);
  useEffect(() => { setTalkAnchor(sphereEl); return () => setTalkAnchor(null); }, [sphereEl]);

  // The liked songs are the room's default queue and the playlists are its
  // stations, so both are read once on arrival. Asked once per mount: an
  // account with no liked songs must not be asked again on every render.
  const { loadLibrary, loadPlaylists, loadPlaylistTracks, search } = m;
  const askedLib = useRef(false);
  const askedLists = useRef(false);
  useEffect(() => {
    if (!canBrowse) return;
    if (!askedLib.current && m.library.length === 0) {
      askedLib.current = true;
      setLibLoading(true);
      void loadLibrary().finally(() => setLibLoading(false));
    }
    if (!askedLists.current && m.playlists.length === 0) {
      askedLists.current = true;
      setListsLoading(true);
      void loadPlaylists().finally(() => setListsLoading(false));
    }
  }, [canBrowse, loadLibrary, loadPlaylists, m.library.length, m.playlists.length]);

  /** The list Up next shows and Next steps through. The liked songs stay live. */
  const queue = q.source.kind === 'library' ? m.library : q.tracks;
  const currentId = track?.id ?? null;

  const updatePrefs = useCallback((next: Partial<MusicPrefs>) => {
    setPrefs((p) => { const v = { ...p, ...next }; writePrefs(v); return v; });
  }, []);

  // ── transport ────────────────────────────────────────────────────────────

  /** Hand the engine `t` (with its record, so every surface shows it), optionally switching lists. */
  const playTrack = useCallback(async (t: Track, next?: QueueState) => {
    if (!canQueue) return;
    if (next) setQ(next);
    setNotice(null);
    try { await m.load(t.uri, t); } catch { /* `useMusicPlayer` puts it on `error`, which the hero shows. */ }
  }, [canQueue, m]);

  const step = useCallback((dir: 1 | -1) => {
    const t = neighbour(queue, currentId, dir, prefs.shuffle);
    if (t) void playTrack(t);
  }, [queue, currentId, prefs.shuffle, playTrack]);

  const onNext = useCallback(() => step(1), [step]);

  // The design's rule: more than four seconds in, Previous restarts the track.
  const onPrev = useCallback(() => {
    if (s.canSeek && prevIntent(m.readPosition()) === 'restart') { s.restart(); return; }
    step(-1);
  }, [s, m, step]);

  /**
   * Pause only means pause when Atlas is the one playing (see
   * useMusicSurface). Otherwise the press plays the record here: loading it
   * when the engine does not hold it or has finished it, resuming when it
   * does. With nothing showing at all it starts the queue.
   */
  const onPlayPause = useCallback(() => {
    if (!canQueue) return;
    if (!track) {
      const first = startOf(queue, prefs.shuffle);
      if (first) void playTrack(first);
      return;
    }
    if (s.showPause) { m.pause().catch(() => {}); return; }
    if (np?.ended || !engineHoldsUri(track.uri)) { void playTrack(track); return; }
    m.play().catch(() => {});
  }, [canQueue, track, queue, prefs.shuffle, s.showPause, np?.ended, m, playTrack]);

  // Advance when the engine reports the end of a track. Once per ending: the
  // guard is cleared only by real progress on the next record, so a load that
  // fails (and restores the ended record) cannot retry in a loop. A record
  // that had already ended before the screen opened counts as handled —
  // opening Music must not start something by itself.
  const advanced = useRef<string | null>(np?.ended ? np.track?.id ?? null : null);
  useEffect(() => {
    if (!np) return;
    if (!np.ended) { if (np.positionMs > 0) advanced.current = null; return; }
    const ended = np.track;
    if (!ended || advanced.current === ended.id || !canQueue) return;
    advanced.current = ended.id;
    const t = afterEnd(queue, ended, prefs.repeat, prefs.shuffle);
    if (t) void playTrack(t);
  }, [np, queue, prefs.repeat, prefs.shuffle, canQueue, playTrack]);

  // The engine never reports its volume, so the room sets it to the value it
  // shows as soon as there is an engine to set — the slider is then a fact.
  const volumeApplied = useRef(false);
  useEffect(() => {
    if (!s.canVolume) { volumeApplied.current = false; return; }
    if (volumeApplied.current) return;
    volumeApplied.current = true;
    m.setVolume(prefs.volume).catch(() => {});
  }, [s.canVolume, m, prefs.volume]);

  const onVolume = useCallback((v: number) => {
    updatePrefs({ volume: v });
    if (s.canVolume) m.setVolume(v).catch(() => {});
  }, [updatePrefs, s.canVolume, m]);

  // ── stations and search ──────────────────────────────────────────────────

  const playLibrary = useCallback(() => {
    const first = startOf(m.library, prefs.shuffle);
    if (first) void playTrack(first, { source: LIBRARY, tracks: [] });
  }, [m.library, prefs.shuffle, playTrack]);

  const playStation = useCallback(async (p: Playlist) => {
    if (!canQueue) return;
    setStationBusy(p.id);
    setNotice(null);
    try {
      const tracks = await loadPlaylistTracks(p.id);
      const first = startOf(tracks, prefs.shuffle);
      if (!first) { setNotice(`${p.name} has no tracks Atlas can play.`); return; }
      await playTrack(first, { source: { kind: 'playlist', id: p.id, name: p.name }, tracks });
      setTab('queue');
    } catch (e) {
      setNotice(`Could not open ${p.name}: ${String(e)}`);
    } finally {
      setStationBusy(null);
    }
  }, [canQueue, loadPlaylistTracks, prefs.shuffle, playTrack]);

  const loadMore = useCallback(async () => {
    const from = m.library.length;
    setMore({ busy: true, from });
    await loadLibrary(from, LIBRARY_PAGE);
    setMore({ busy: false, from });
  }, [m.library.length, loadLibrary]);
  // A page that came back short was the last one.
  const libEnd = more !== null && !more.busy && m.library.length - more.from < LIBRARY_PAGE;
  const libMaybeMore = m.library.length >= LIBRARY_PAGE && m.library.length % LIBRARY_PAGE === 0 && !libEnd;
  const canLoadMore = q.source.kind === 'library' && libMaybeMore;

  // Debounced, and a stale answer is dropped by its sequence number.
  const searchSeq = useRef(0);
  useEffect(() => {
    const text = query.trim();
    const seq = ++searchSeq.current;
    if (!text || !canBrowse) { setResults(null); setSearching(false); return; }
    setSearching(true);
    const t = window.setTimeout(() => {
      search(text)
        .then((r) => { if (seq === searchSeq.current) setResults(r); })
        .catch((e) => { if (seq === searchSeq.current) { setResults({ tracks: [], playlists: [] }); setNotice(`Search failed: ${String(e)}`); } })
        .finally(() => { if (seq === searchSeq.current) setSearching(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, canBrowse, search]);

  // ── keys ─────────────────────────────────────────────────────────────────

  const keys = useRef({ onPlayPause, onNext, onPrev });
  keys.current = { onPlayPause, onNext, onPrev };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) { if (e.key === 'Escape') (e.target as HTMLElement).blur(); return; }
      // Space on a focused button is that button's click; do not press play as well.
      const onControl = !!(e.target as HTMLElement | null)?.closest?.('button, a');
      switch (e.key) {
        case 'Escape': navigate('/'); break;
        case ' ': if (!onControl) { e.preventDefault(); keys.current.onPlayPause(); } break;
        case 'ArrowRight': keys.current.onNext(); break;
        case 'ArrowLeft': keys.current.onPrev(); break;
        case '/': e.preventDefault(); setTab('search'); window.setTimeout(() => searchRef.current?.focus(), 0); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  // ── the ribbon and the clock, per frame, without rendering ───────────────

  const waveData = useMemo(() => waveFor(currentId ? seedFromId(currentId) : 1, WAVE_BARS), [currentId]);
  const live = useRef({ durationMs, inert: !s.canSeek, data: waveData, readPosition: m.readPosition, reactivity: s.reactivity, reduced: s.reduced });
  live.current = { durationMs, inert: !s.canSeek, data: waveData, readPosition: m.readPosition, reactivity: s.reactivity, reduced: s.reduced };

  useEffect(() => {
    let raf = 0;
    // The last painted frame, so an unchanged ribbon is not repainted (see
    // MusicPlayerFull for why that matters next to a particle sphere). The
    // canvas itself is part of it: a gate unmounts the ribbon, and the one
    // that comes back is blank whatever the numbers say.
    const last = { cv: null as HTMLCanvasElement | null, r: -1, a: -1, hover: null as number | null, inert: false, w: 0, h: 0, data: null as number[] | null };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const L = live.current;
      const pos = L.durationMs > 0 ? Math.min(L.durationMs, L.readPosition()) : 0;
      const t = timeRef.current;
      if (t) { const txt = fmt(pos); if (t.textContent !== txt) t.textContent = txt; }
      const cv = waveRef.current;
      if (!cv) return;
      const ratio = L.durationMs > 0 ? pos / L.durationMs : 0;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = Math.round(ratio * w * dpr);
      // The crest at the playhead is the real envelope; reduced motion holds it flat.
      const amp = L.reduced ? 0 : (L.reactivity.current?.amp ?? 0);
      const a = Math.round(amp * 255);
      const hover = hoverRef.current;
      if (cv === last.cv && r === last.r && a === last.a && hover === last.hover && L.inert === last.inert
        && w === last.w && h === last.h && L.data === last.data) return;
      Object.assign(last, { cv, r, a, hover, inert: L.inert, w, h, data: L.data });
      drawWave(cv, { data: L.data, ratio, amp, hoverX: hover, inert: L.inert });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onSeek = useCallback((e: ReactMouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    s.seekToRatio(ratioAt(e.clientX, r.left, r.width));
  }, [s]);

  // Keep the playing row in view inside the list, without scrolling the page.
  useEffect(() => {
    const list = listRef.current;
    const row = activeRowRef.current;
    if (!list || !row || tab !== 'queue') return;
    const top = row.offsetTop;
    if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = Math.max(0, top - 8);
  }, [currentId, tab, queue.length]);

  // ── what the screen says ─────────────────────────────────────────────────

  const atlasPlaying = isPlaying && s.atlasOwnsAudio;
  // The design: the sphere works while the music plays. Anything the bus is
  // saying (listening, thinking, speaking) wins over that.
  const sphereState = bus === 'idle' && atlasPlaying ? 'working' : undefined;
  const room = outputLine({ hasTrack: !!track, atlasOwnsAudio: s.atlasOwnsAudio, deviceName: np?.deviceName ?? null });
  const tier = s.chip.replace(/^Spotify · /, '');
  const canNext = canQueue && neighbour(queue, currentId, 1) !== null;
  const canPrev = canQueue && (s.canSeek || neighbour(queue, currentId, -1) !== null);
  const canPlayBtn = canQueue && (!!track || queue.length > 0);
  const playTitle = !canQueue ? (s.blocker?.short ?? 'Nothing to play yet.')
    : s.takeover ? 'Play this through Atlas, here on this Mac. The other device keeps its own queue.' : undefined;
  const error = notice ?? m.error;

  const visibleLists = allStations ? m.playlists : m.playlists.slice(0, STATIONS_SHOWN - 1);

  const rowFor = (t: Track, onClick: () => void, key: string) => {
    const on = t.id === currentId;
    return (
      <button
        type="button"
        key={key}
        ref={on ? activeRowRef : undefined}
        className={`b-mu-row${on ? ' on' : ''}`}
        disabled={!canQueue}
        title={canQueue ? undefined : s.blocker?.short}
        onClick={onClick}
      >
        <span className="b-mu-thumb">{t.artUrl ? <img src={t.artUrl} alt="" loading="lazy" /> : <AtlasIcon name="music" size={18} weight={1.6} />}</span>
        <span className="b-mu-row-text"><b>{t.title}</b><span>{t.artist}</span></span>
        <span className="b-mu-row-right">{on ? (isPlaying ? 'Playing' : 'Paused') : fmt(t.durationMs)}</span>
      </button>
    );
  };

  const listEmpty = (title: string, body: string) => <div className="b-mu-empty"><b>{title}</b>{body}</div>;

  const queueBody = !m.available ? listEmpty('Mac app only', 'Up next fills from your Spotify account in the Atlas desktop app.')
    : !m.connected ? listEmpty('Not connected', 'Connect Spotify and your liked songs line up here.')
      : queue.length === 0
        ? (q.source.kind === 'library' && libLoading
          ? listEmpty('Reading your liked songs…', 'One moment.')
          : listEmpty('Nothing lined up', q.source.kind === 'library' ? 'No liked songs on this account yet. Search, or pick a station below.' : 'This list is empty. Pick a station below.'))
        : null;

  const searchBody = () => {
    if (!canBrowse) return listEmpty(m.available ? 'Not connected' : 'Mac app only', 'Search reaches Spotify through your connected account.');
    if (!query.trim()) return listEmpty('Search Spotify', 'A track, an artist or a playlist. Press / from anywhere on this screen.');
    if (searching && !results) return listEmpty('Searching…', `Looking for “${query.trim()}”.`);
    if (!results || (results.tracks.length === 0 && results.playlists.length === 0)) return listEmpty('Nothing found', `Spotify has nothing for “${query.trim()}”.`);
    const source: QueueSource = { kind: 'search', query: query.trim() };
    return (
      <>
        {results.tracks.length ? <div className="b-mu-group">Tracks</div> : null}
        {results.tracks.map((t) => rowFor(t, () => void playTrack(t, { source, tracks: results.tracks }), `s-${t.id}`))}
        {results.playlists.length ? <div className="b-mu-group">Playlists</div> : null}
        {results.playlists.map((p) => (
          <button type="button" key={`p-${p.id}`} className="b-mu-row" disabled={!canQueue || stationBusy !== null} onClick={() => void playStation(p)}>
            <span className="b-mu-thumb">{p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" /> : <AtlasIcon name="music" size={18} weight={1.6} />}</span>
            <span className="b-mu-row-text"><b>{p.name}</b><span>{stationBusy === p.id ? 'Opening…' : stationLine(p)}</span></span>
            <span className="b-mu-row-right"><AtlasIcon name="play" size={14} /></span>
          </button>
        ))}
      </>
    );
  };

  return (
    <div className="b-mu" data-beta-tone="ink" data-screen-label="Beta — Music">
      <div className="b-mu-grid">
        <section className="b-mu-hero" aria-label="Now playing">
          <div className="b-mu-head">
            <div className="b-mu-id">
              <button type="button" ref={setSphereEl} className="b-mu-back-sphere" aria-label="Talk to Atlas" title="Talk to Atlas · ⌥ Space" onClick={() => openTalk()}>
                <VeilSphere size="mini" ink bg="#26262d" count={3500} alpha={0.5} state={sphereState} />
              </button>
              <button type="button" className="b-mu-back" title="Back to Home · Esc" onClick={() => navigate('/')}>
                <span className="b-mu-back-text"><span>Music · {room}</span><span>{s.status}</span></span>
              </button>
            </div>
            <span className={`b-mu-chip${m.connected ? '' : ' off'}`} title={s.chip}><i aria-hidden />Spotify<span>&nbsp;· {tier}</span></span>
          </div>

          <div className="b-mu-stage">
            <div className="b-mu-coverwrap">
              <div className={`b-mu-disc${isPlaying ? ' spinning' : ''}`} aria-hidden>
                <span style={{ background: rgb(s.art.palette.mid) }} /><span />
              </div>
              <div className="b-mu-cover" key={currentId ?? 'none'}>
                {track && s.art.src && !s.blockerHidesTrack
                  ? <img src={s.art.src} alt={`${track.album || track.title} cover`} title={s.coverNote} />
                  : <AtlasIcon name="music" size={56} weight={1.4} className="b-mu-cover-empty" />}
              </div>
            </div>

            <div className="b-mu-text">
              {s.blockerHidesTrack && s.blocker ? (
                <div className="b-mu-gate">
                  <span className="b-mu-album">{s.blocker.kind === 'desktop' ? 'Mac app only' : 'Spotify'}</span>
                  <h1 className="b-mu-title">{s.blocker.title}</h1>
                  <p>{s.blocker.body}</p>
                  {s.blocker.action ? (
                    <div className="b-mu-gate-actions">
                      <button type="button" className="b-mu-btn" disabled={s.blocker.action.disabled} onClick={s.blocker.action.onClick}>{s.blocker.action.label}</button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <>
                  <div>
                    <span className="b-mu-album">{track ? (track.album || 'Single') : 'Nothing playing'}</span>
                    <h1 className="b-mu-title" key={currentId ?? 'none'}>{track ? track.title : 'Pick something'}</h1>
                    <span className="b-mu-artist">{track ? track.artist : queue.length ? 'Press play to start Up next, or choose a station.' : 'Choose a station, or search Spotify.'}</span>
                  </div>

                  <div className="b-mu-ribbon">
                    <button
                      type="button"
                      className={`b-mu-wave${s.canSeek ? ' live' : ''}`}
                      aria-label="Seek"
                      disabled={!s.canSeek}
                      title={s.canSeek ? 'Click to seek. The pattern is a per-track signature, not an analysis of the audio.' : 'Seeking needs Atlas to be the one playing.'}
                      onClick={onSeek}
                      onMouseMove={(e) => { if (s.canSeek) hoverRef.current = e.clientX - e.currentTarget.getBoundingClientRect().left; }}
                      onMouseLeave={() => { hoverRef.current = null; }}
                    >
                      <canvas ref={waveRef} aria-hidden />
                    </button>
                    <div className="b-mu-times"><span ref={timeRef}>0:00</span><span>{fmt(durationMs)}</span></div>
                  </div>

                  {s.blocker ? (
                    <div className="b-mu-gate">
                      <p><b>{s.blocker.title}.</b> {s.blocker.body}</p>
                    </div>
                  ) : (
                    <>
                      <div className="b-mu-transport">
                        <button type="button" className={`b-mu-tbtn b-mu-tbtn--sm${prefs.shuffle ? ' on' : ''}`} aria-label="Shuffle" aria-pressed={prefs.shuffle} title="Shuffle Up next" onClick={() => updatePrefs({ shuffle: !prefs.shuffle })}>
                          <AtlasIcon name="shuffle" size={18} weight={1.6} />
                        </button>
                        <button type="button" className="b-mu-tbtn b-mu-tbtn--md flip" aria-label="Previous" title="Previous · ←. More than four seconds in, it restarts the track." disabled={!canPrev} onClick={onPrev}>
                          <AtlasIcon name="skip" size={22} weight={1.6} />
                        </button>
                        <button type="button" className="b-mu-tbtn b-mu-tbtn--play" aria-label={s.showPause ? 'Pause' : 'Play'} title={playTitle} disabled={!canPlayBtn} onClick={onPlayPause}>
                          <AtlasIcon name={s.showPause ? 'pause' : 'play'} size={30} weight={1.8} />
                        </button>
                        <button type="button" className="b-mu-tbtn b-mu-tbtn--md" aria-label="Next" title="Next · →" disabled={!canNext} onClick={onNext}>
                          <AtlasIcon name="skip" size={22} weight={1.6} />
                        </button>
                        <button type="button" className={`b-mu-tbtn b-mu-tbtn--sm${prefs.repeat ? ' on' : ''}`} aria-label="Repeat" aria-pressed={prefs.repeat} title="Repeat this track" onClick={() => updatePrefs({ repeat: !prefs.repeat })}>
                          <AtlasIcon name="repeat" size={18} weight={1.6} />
                        </button>
                      </div>

                      <div className={`b-mu-volrow${s.canVolume ? '' : ' off'}`}>
                        <AtlasIcon name="speaker" size={18} weight={1.6} />
                        <span>{s.canVolume ? 'Atlas’s own output on this Mac. Spotify on your other devices keeps its own volume.' : 'Volume applies once Atlas is the one playing.'}</span>
                        <input type="range" min={0} max={1} step={0.01} value={prefs.volume} disabled={!s.canVolume} aria-label="Atlas output volume" onChange={(e) => onVolume(Number(e.currentTarget.value))} />
                        <span className="b-mu-volval">{volumeLabel(prefs.volume)}</span>
                      </div>
                    </>
                  )}
                </>
              )}
              {error ? <p className="b-mu-err" role="status">{error}</p> : null}
            </div>
          </div>
        </section>

        <aside className="b-mu-aside" aria-label="Up next and search">
          <div className="b-mu-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'queue'} className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>
              Up next{queue.length ? <span className="b-num">{queue.length}</span> : null}
            </button>
            <button type="button" role="tab" aria-selected={tab === 'search'} className={tab === 'search' ? 'on' : ''} onClick={() => { setTab('search'); window.setTimeout(() => searchRef.current?.focus(), 0); }}>
              Search
            </button>
          </div>

          {tab === 'search' ? (
            <label className="b-mu-search">
              <AtlasIcon name="search" size={16} weight={1.6} />
              <input ref={searchRef} type="search" value={query} placeholder="Tracks, artists, playlists" aria-label="Search Spotify" disabled={!canBrowse} onChange={(e) => setQuery(e.target.value)} />
              {query ? <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><AtlasIcon name="close" size={14} /></button> : <kbd>/</kbd>}
            </label>
          ) : queue.length ? (
            <div className="b-mu-listhead"><b>{sourceLabel(q.source)}</b><span>{queueSummary(queue)}</span></div>
          ) : null}

          <div className="b-mu-list nosb" ref={listRef} role="tabpanel">
            {tab === 'queue' ? (
              queueBody ?? (
                <>
                  {queue.map((t, i) => rowFor(t, () => void playTrack(t), `${i}-${t.id}`))}
                  {canLoadMore ? (
                    <button type="button" className="b-mu-btn b-mu-btn--quiet b-mu-loadmore" disabled={more?.busy} onClick={() => void loadMore()}>
                      {more?.busy ? 'Reading…' : `Load ${LIBRARY_PAGE} more`}
                    </button>
                  ) : null}
                </>
              )
            ) : searchBody()}
          </div>
        </aside>
      </div>

      {canBrowse ? (
        <section className="b-mu-stations" aria-label="Stations">
          <button
            type="button"
            className={`b-mu-station${sameSource(q.source, LIBRARY) && track && queue.some((t) => t.id === currentId) ? ' on' : ''}`}
            disabled={!canQueue || m.library.length === 0}
            onClick={playLibrary}
          >
            <span className="b-mu-swatch b-mu-swatch--blue"><AtlasIcon name="star" size={20} weight={1.6} /></span>
            <span className="b-mu-station-text"><b>Liked songs</b><span>{libLoading ? 'Reading…' : m.library.length ? `${m.library.length}${libMaybeMore ? '+' : ''} tracks` : 'None yet'}</span></span>
          </button>
          {visibleLists.map((p) => {
            const on = q.source.kind === 'playlist' && q.source.id === p.id;
            return (
              <button type="button" key={p.id} className={`b-mu-station${on ? ' on' : ''}`} disabled={!canQueue || stationBusy !== null} onClick={() => void playStation(p)}>
                <span className="b-mu-swatch">{p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" /> : <AtlasIcon name="music" size={20} weight={1.6} />}</span>
                <span className="b-mu-station-text"><b>{p.name}</b><span>{stationBusy === p.id ? 'Opening…' : on && isPlaying ? 'Playing' : stationLine(p)}</span></span>
              </button>
            );
          })}
          {listsLoading && m.playlists.length === 0 ? (
            <div className="b-mu-station b-mu-station--more" aria-live="polite">Reading your playlists…</div>
          ) : null}
          {m.playlists.length > STATIONS_SHOWN - 1 ? (
            <button type="button" className="b-mu-station b-mu-station--more" aria-expanded={allStations} onClick={() => setAllStations((v) => !v)}>
              {allStations ? 'Fewer stations' : `All ${m.playlists.length} playlists`}
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
};

export default BetaMusic;
