/**
 * The Beta Music — `/music`, the listening room (Beta redesign phase 4,
 * `Atlas Music Beta.dc.html`).
 *
 * The hero is the record: the cover with its disc, the album line with the
 * release year, the title with Like, the progress ribbon (click to seek), the
 * transport, Atlas's output volume and the ducking switch. Beside it the
 * aside holds Up next, Lyrics, Rooms and a Spotify search; under both, the
 * station row: Atlas's four mood stations, the liked songs and the account's
 * own playlists.
 *
 * The record and the engine come from `useMusicPlayer`; the queue, shuffle,
 * repeat, volume, ducking, Like, the stations and Rooms come from the music
 * queue store (`useMusicQueue`), which BetaShell keeps running on every
 * screen — so Up next goes on advancing after this screen is left. The rules
 * for what may be offered come from `useMusicSurface` (read its header before
 * adding a control).
 *
 * What leaves the Mac from here, and the screen says so where it happens:
 * Like, Rooms, search and playback go to Spotify through the connected
 * account; Lyrics sends the song's title, artist, album and length to
 * LRCLIB; a mood station sends the titles and artists of liked songs to
 * Atlas's AI model. Ducking and Wind down stay on this Mac.
 *
 * Left out: the design's "Matches your pace" for Run — no pace reaches a Mac.
 *
 * Keys, the design's: Space play/pause · ← previous · → next · / search · Esc Home.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { Playlist, SearchResults, Track } from '@/hooks/useMusicPlayer';
import { bootMusicQueue, musicQueue, queueOf, useMusicQueue } from '@/hooks/useMusicQueue';
import { fmt, useMusicSurface } from '@/components/atlas-ui/music/useMusicSurface';
import { drawWave, seedFromId, waveFor } from '@/components/atlas-ui/music/musicWave';
import { MusicLike } from '@/components/atlas/music/MusicLike';
import { MusicLyrics } from '@/components/atlas/music/MusicLyrics';
import { MusicRooms } from '@/components/atlas/music/MusicRooms';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { useAtlasState } from '@/lib/atlasStateBus';
import { openTalk, setTalkAnchor } from '@/lib/talkBus';
import { useBetaNavigate } from '@/lib/viewTransitions';
import {
  MOODS, PLAYLISTS_SHOWN, STATION_POOL, WAVE_BARS, albumLine, neighbour, outputLine, queueSummary, ratioAt, sameSource,
  sourceLabel, stationLine, volumeLabel, type QueueSource,
} from '@/lib/betaMusic';
import { LIKE_SCOPES, ROOM_SCOPES, lacks, reconnectLabel } from '@/lib/musicSpotify';
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

type Tab = 'queue' | 'lyrics' | 'rooms' | 'search';
const TABS: readonly [Tab, string][] = [['queue', 'Up next'], ['lyrics', 'Lyrics'], ['rooms', 'Rooms'], ['search', 'Search']];

const rgb = (c: readonly number[]): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

const BetaMusic = () => {
  const navigate = useBetaNavigate();
  const s = useMusicSurface();
  const { m, track, isPlaying, durationMs } = s;
  const np = m.nowPlaying;
  const q = useMusicQueue();
  const bus = useAtlasState();

  const canBrowse = m.available && m.connected;
  const canQueue = canBrowse && m.premium;

  const [tab, setTab] = useState<Tab>('queue');
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

  // BetaShell already runs the store; booting it here too (it is ref-counted)
  // keeps this screen whole if it is ever shown outside the shell.
  useEffect(() => bootMusicQueue(), []);
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
  const queue = queueOf(q, m.library);
  const currentId = track?.id ?? null;
  const { prefs } = q;

  // ── stations and search ──────────────────────────────────────────────────

  const playStation = useCallback(async (p: Playlist) => {
    if (!canQueue) return;
    setStationBusy(p.id);
    setNotice(null);
    try {
      const tracks = await loadPlaylistTracks(p.id);
      if (!tracks.length) { setNotice(`${p.name} has no tracks Atlas can play.`); return; }
      await musicQueue.playList({ kind: 'playlist', id: p.id, name: p.name }, tracks);
      setTab('queue');
    } catch (e) {
      setNotice(`Could not open ${p.name}: ${String(e)}`);
    } finally {
      setStationBusy(null);
    }
  }, [canQueue, loadPlaylistTracks]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) { if (e.key === 'Escape') (e.target as HTMLElement).blur(); return; }
      // Space on a focused button is that button's click; do not press play as well.
      const onControl = !!(e.target as HTMLElement | null)?.closest?.('button, a');
      switch (e.key) {
        case 'Escape': navigate('/'); break;
        case ' ': if (!onControl) { e.preventDefault(); void musicQueue.togglePlay(); } break;
        case 'ArrowRight': musicQueue.next(); break;
        case 'ArrowLeft': musicQueue.prev(); break;
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
    : s.takeover ? 'Play this here, through Atlas. The other device is paused, so the record moves rather than plays twice.' : undefined;
  const error = notice ?? q.notice ?? m.error;

  const likeMissing = canBrowse && lacks(m.scopes, LIKE_SCOPES);
  const roomsMissing = canBrowse && lacks(m.scopes, ROOM_SCOPES);
  const reconnect = reconnectLabel(likeMissing, roomsMissing);
  const onReconnect = useCallback(() => { void m.connect(); }, [m]);

  const duckLine = !prefs.duck ? 'Music stays at full volume, even when Atlas speaks.'
    : q.ducked ? 'Lowered now, while Atlas listens or speaks.'
      : 'Atlas lowers the music when someone talks, and when it speaks to you.';

  const visibleLists = allStations ? m.playlists : m.playlists.slice(0, PLAYLISTS_SHOWN);

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
        {results.tracks.map((t) => rowFor(t, () => void musicQueue.playTrack(t, { source, tracks: results.tracks }), `s-${t.id}`))}
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

  const tabBody = () => {
    if (tab === 'search') return searchBody();
    if (tab === 'lyrics') return <MusicLyrics track={s.blockerHidesTrack ? null : track} readPosition={m.readPosition} scroller={listRef} reduced={s.reduced} />;
    if (tab === 'rooms') return <MusicRooms atlasOwnsAudio={s.atlasOwnsAudio} onReconnect={onReconnect} />;
    return queueBody ?? (
      <>
        {queue.map((t, i) => rowFor(t, () => void musicQueue.playTrack(t), `${i}-${t.id}`))}
        {canLoadMore ? (
          <button type="button" className="b-mu-btn b-mu-btn--quiet b-mu-loadmore" disabled={more?.busy} onClick={() => void loadMore()}>
            {more?.busy ? 'Reading…' : `Load ${LIBRARY_PAGE} more`}
          </button>
        ) : null}
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
                  <div className="b-mu-titlerow">
                    <div className="b-mu-titletext">
                      <span className="b-mu-album">{track ? albumLine(track) : 'Nothing playing'}</span>
                      <h1 className="b-mu-title" key={currentId ?? 'none'}>{track ? track.title : 'Pick something'}</h1>
                      <span className="b-mu-artist">{track ? track.artist : queue.length ? 'Press play to start Up next, or choose a station.' : 'Choose a station, or search Spotify.'}</span>
                    </div>
                    <MusicLike track={track} className="b-mu-like" />
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
                        <button type="button" className={`b-mu-tbtn b-mu-tbtn--sm${prefs.shuffle ? ' on' : ''}`} aria-label="Shuffle" aria-pressed={prefs.shuffle} title="Shuffle Up next" onClick={() => musicQueue.setPrefs({ shuffle: !prefs.shuffle })}>
                          <AtlasIcon name="shuffle" size={18} weight={1.6} />
                        </button>
                        <button type="button" className="b-mu-tbtn b-mu-tbtn--md flip" aria-label="Previous" title="Previous · ←. More than four seconds in, it restarts the track." disabled={!canPrev} onClick={() => musicQueue.prev()}>
                          <AtlasIcon name="skip" size={22} weight={1.6} />
                        </button>
                        <button type="button" className="b-mu-tbtn b-mu-tbtn--play" aria-label={s.showPause ? 'Pause' : 'Play'} title={playTitle} disabled={!canPlayBtn} onClick={() => void musicQueue.togglePlay()}>
                          <AtlasIcon name={s.showPause ? 'pause' : 'play'} size={30} weight={1.8} />
                        </button>
                        <button type="button" className="b-mu-tbtn b-mu-tbtn--md" aria-label="Next" title="Next · →" disabled={!canNext} onClick={() => musicQueue.next()}>
                          <AtlasIcon name="skip" size={22} weight={1.6} />
                        </button>
                        <button type="button" className={`b-mu-tbtn b-mu-tbtn--sm${prefs.repeat ? ' on' : ''}`} aria-label="Repeat" aria-pressed={prefs.repeat} title="Repeat this track" onClick={() => musicQueue.setPrefs({ repeat: !prefs.repeat })}>
                          <AtlasIcon name="repeat" size={18} weight={1.6} />
                        </button>
                      </div>

                      <div className={`b-mu-volrow${s.canVolume ? '' : ' off'}`}>
                        <AtlasIcon name="speaker" size={18} weight={1.6} />
                        <span>{s.canVolume ? 'Atlas’s own output on this Mac. Your speakers keep their own volume, in Rooms.' : 'Volume applies once Atlas is the one playing.'}</span>
                        <input type="range" min={0} max={1} step={0.01} value={prefs.volume} disabled={!s.canVolume} aria-label="Atlas output volume" onChange={(e) => musicQueue.setPrefs({ volume: Number(e.currentTarget.value) })} />
                        <span className="b-mu-volval">{volumeLabel(prefs.volume)}</span>
                      </div>

                      <div className="b-mu-duck">
                        <span className={`b-mu-duck-dot${prefs.duck ? ' on' : ''}`} aria-hidden />
                        <span className="b-mu-duck-line">{duckLine}</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={prefs.duck}
                          aria-label="Lower music when someone speaks"
                          title="Ducking lowers Atlas’s own output on this Mac while Atlas listens, thinks or speaks. Nothing leaves the Mac."
                          className={`b-mu-switch${prefs.duck ? ' on' : ''}`}
                          onClick={() => musicQueue.setPrefs({ duck: !prefs.duck })}
                        ><span /></button>
                      </div>
                    </>
                  )}
                </>
              )}
              {reconnect ? (
                <div className="b-mu-reconnect">
                  <p>Spotify only lets Atlas change your Liked Songs and steer your other speakers once you allow it. Reconnecting opens Spotify in your browser; the new permission is kept in your macOS Keychain.</p>
                  <button type="button" className="b-mu-btn b-mu-btn--quiet" disabled={m.isConnecting} onClick={onReconnect}>
                    {m.isConnecting ? 'Waiting for Spotify…' : reconnect}
                  </button>
                </div>
              ) : null}
              {error ? <p className="b-mu-err" role="status">{error}</p> : null}
            </div>
          </div>
        </section>

        <aside className="b-mu-aside" aria-label="Up next, lyrics, rooms and search">
          <div className="b-mu-tabs" role="tablist">
            {TABS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                className={tab === k ? 'on' : ''}
                onClick={() => { setTab(k); if (k === 'search') window.setTimeout(() => searchRef.current?.focus(), 0); }}
              >
                {label}{k === 'queue' && queue.length ? <span className="b-num">{queue.length}</span> : null}
              </button>
            ))}
          </div>

          {tab === 'search' ? (
            <label className="b-mu-search">
              <AtlasIcon name="search" size={16} weight={1.6} />
              <input ref={searchRef} type="search" value={query} placeholder="Tracks, artists, playlists" aria-label="Search Spotify" disabled={!canBrowse} onChange={(e) => setQuery(e.target.value)} />
              {query ? <button type="button" aria-label="Clear search" onClick={() => { setQuery(''); searchRef.current?.focus(); }}><AtlasIcon name="close" size={14} /></button> : <kbd>/</kbd>}
            </label>
          ) : tab === 'queue' && queue.length ? (
            <div className="b-mu-listhead"><b>{sourceLabel(q.source)}</b><span>{queueSummary(queue)}</span></div>
          ) : null}

          <div className="b-mu-list nosb" ref={listRef} role="tabpanel">
            {tabBody()}
          </div>
        </aside>
      </div>

      {canBrowse ? (
        <section className="b-mu-stations" aria-label="Stations">
          {MOODS.map((mood) => {
            const on = q.source.kind === 'mood' && q.source.mood === mood.key && !!track && queue.some((t) => t.id === currentId);
            const st = q.station?.mood === mood.key ? q.station : null;
            const line = st ? st.note : on && isPlaying ? 'Playing' : mood.line;
            return (
              <button
                type="button"
                key={mood.key}
                className={`b-mu-station${on ? ' on' : ''}${st?.status === 'error' ? ' err' : ''}`}
                disabled={!canQueue || (q.station?.status === 'picking' && !st)}
                aria-busy={st?.status === 'picking'}
                title={`Atlas picks this station from your liked songs: it sends the titles and artists of up to ${STATION_POOL} of them to its AI model, and nothing else.`}
                onClick={() => void musicQueue.startStation(mood.key)}
              >
                <span className="b-mu-swatch" style={{ background: mood.swatch, color: 'var(--b-card)' }}><AtlasIcon name="sparkle" size={20} weight={1.6} /></span>
                <span className="b-mu-station-text"><b>{mood.title}</b><span>{line}</span></span>
              </button>
            );
          })}
          <button
            type="button"
            className={`b-mu-station${sameSource(q.source, LIBRARY) && track && queue.some((t) => t.id === currentId) ? ' on' : ''}`}
            disabled={!canQueue || m.library.length === 0}
            onClick={() => void musicQueue.playLibrary()}
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
          {m.playlists.length > PLAYLISTS_SHOWN ? (
            <button type="button" className="b-mu-station b-mu-station--more" aria-expanded={allStations} onClick={() => setAllStations((v) => !v)}>
              {allStations ? 'Fewer stations' : `All ${m.playlists.length} playlists`}
            </button>
          ) : null}
          <p className="b-mu-stations-note">
            Focus, Wind down, Cooking and Run are picked by Atlas from your liked songs: their titles and artists go to Atlas’s AI model, nothing else. Wind down plays a little softer every ten minutes.
          </p>
        </section>
      ) : null}
    </div>
  );
};

export default BetaMusic;
