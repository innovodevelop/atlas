/**
 * Podcast — Home's Podcast widget opened into its full view
 * (`Atlas Widget Screens Beta.dc.html`, the Podcast screen).
 *
 * The hero is the episode: the cover with the show over the title, the play
 * button (the sphere speaks while it plays, as the design draws it) and the
 * progress. Beside it, where the design lists chapters, are the user's saved
 * shows and the chosen show's episodes, each with how much is left. Chapters
 * stay out: Spotify publishes none, and there is no other public source.
 *
 * Playback goes through Atlas's own engine on this Mac (librespot decodes
 * `spotify:episode:` URIs like tracks) and resumes where the user stopped:
 * Atlas's own place first, else Spotify's (`resumeFrom`). Some episodes have
 * no audio librespot may decode (hosted elsewhere, or published as video);
 * the engine says so (`music:unavailable`) and this view then offers the
 * account's Spotify Connect speakers instead.
 *
 * What leaves the Mac: the shows and episodes are read from Spotify, and
 * playback is Spotify's, through the connected account. Where the user
 * stopped is kept on this Mac.
 */
import { useEffect, useMemo, useState } from 'react';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { VeilSphere } from '@/components/atlas/VeilSphere';
import { fmt, useMusicSurface } from '@/components/atlas-ui/music/useMusicSurface';
import { bootMusicQueue, musicQueue, useMusicQueue } from '@/hooks/useMusicQueue';
import { usePodcasts, useRecentEpisodes } from '@/hooks/usePodcasts';
import { episodeLeft, resumeFrom } from '@/lib/betaMusic';
import {
  RESUME_SCOPES, ROOM_SCOPES, episodeAsTrack, isEpisode, lacks, type Episode, type Track,
} from '@/lib/musicSpotify';
import { useTick } from './useTick';

/** The episode the hero shows, with where a press of Play starts it. */
interface HeroEpisode { track: Track; startMs: number; showName: string }

const dateLine = (d: string | null): string => {
  if (!d) return '';
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : d;
};

export function PodcastView() {
  useEffect(() => bootMusicQueue(), []);
  const s = useMusicSurface();
  const { m } = s;
  const q = useMusicQueue();
  const pods = usePodcasts(true);
  const recent = useRecentEpisodes(1);
  const [chosen, setChosen] = useState<HeroEpisode | null>(null);

  const np = m.nowPlaying;
  const nowEpisode = np?.track && isEpisode(np.track) ? np.track : null;
  const playingHere = !!nowEpisode && !!np?.isPlaying;
  useTick(1000, playingHere);

  const startOf = (e: Episode): number =>
    resumeFrom({ local: pods.local[e.id] ?? null, spotify: e.resume, durationMs: e.durationMs });

  // What the hero holds: the episode playing now, else the one last chosen
  // here, else where the user last stopped, else the newest of the first show.
  const hero: HeroEpisode | null = useMemo(() => {
    if (nowEpisode) return { track: nowEpisode, startMs: 0, showName: nowEpisode.artist };
    if (chosen) return chosen;
    const last = recent[0];
    if (last?.track) {
      return { track: last.track, startMs: resumeFrom({ local: { positionMs: last.positionMs }, spotify: null, durationMs: last.durationMs }), showName: last.track.artist };
    }
    const first = pods.episodes[0];
    return first ? { track: episodeAsTrack(first), startMs: 0, showName: first.showName } : null;
  }, [nowEpisode, chosen, recent, pods.episodes]);

  const isNow = !!hero && !!nowEpisode && hero.track.id === nowEpisode.id;
  const durationMs = hero?.track.durationMs ?? 0;
  const pos = isNow ? Math.min(durationMs || Infinity, m.readPosition()) : hero?.startMs ?? 0;
  const pct = durationMs > 0 ? Math.max(0, Math.min(100, (pos / durationMs) * 100)) : 0;
  const canPlay = !s.blocker;
  const unavailable = !!hero && m.unavailable === hero.track.uri;
  const roomsMissing = m.connected && lacks(m.scopes, ROOM_SCOPES);
  const resumeMissing = m.connected && lacks(m.scopes, RESUME_SCOPES);

  // An episode Atlas cannot decode can still play on a speaker: list them.
  useEffect(() => {
    if (unavailable && !roomsMissing) void musicQueue.refreshRooms();
  }, [unavailable, roomsMissing]);

  const play = (h: HeroEpisode) => {
    setChosen(h);
    void musicQueue.playTrack(h.track, undefined, h.startMs);
  };

  const onHeroPlay = () => {
    if (!hero || !canPlay) return;
    if (isNow) { void musicQueue.togglePlay(); return; }
    play(hero);
  };

  const showPause = isNow && s.showPause;
  const episodeRows = pods.episodes;

  const listBody = () => {
    if (!m.available) return <div className="b-wv-empty">Podcasts play through Spotify in the Atlas desktop app.</div>;
    if (!m.connected) return <div className="b-wv-empty">Connect Spotify and your saved shows appear here.</div>;
    if (pods.showsStatus === 'loading' && !pods.shows.length) return <div className="b-wv-empty">Reading your saved shows…</div>;
    if (pods.showsStatus === 'error') return <div className="b-wv-empty">Spotify did not list your shows: {pods.showsError}</div>;
    if (!pods.shows.length) return <div className="b-wv-empty">No saved shows on this Spotify account. Follow a show in Spotify and it appears here.</div>;
    return (
      <>
        <div className="b-wv-pod-shows" role="tablist" aria-label="Your shows">
          {pods.shows.map((sh) => (
            <button
              key={sh.id}
              type="button"
              role="tab"
              aria-selected={pods.showId === sh.id}
              className={`b-wv-pod-show${pods.showId === sh.id ? ' on' : ''}`}
              onClick={() => pods.selectShow(sh.id)}
            >
              <span className="b-wv-pod-show-art">{sh.artUrl ? <img src={sh.artUrl} alt="" loading="lazy" /> : <AtlasIcon name="voice" size={14} />}</span>
              <span>{sh.name}</span>
            </button>
          ))}
        </div>
        {pods.episodesStatus === 'loading' && !episodeRows.length ? <div className="b-wv-empty">Reading the episodes…</div> : null}
        {pods.episodesStatus === 'error' ? <div className="b-wv-empty">Spotify did not list the episodes: {pods.episodesError}</div> : null}
        {episodeRows.map((e) => {
          const at = startOf(e);
          const placed = pods.local[e.id]?.positionMs ?? (e.resume && !e.resume.fullyPlayed ? e.resume.positionMs : e.resume?.fullyPlayed ? e.durationMs : 0);
          const on = hero?.track.id === e.id;
          return (
            <button
              key={e.id}
              type="button"
              className={`b-wv-pod-ep${on ? ' on' : ''}`}
              disabled={!canPlay || !e.playable}
              title={!e.playable ? 'Spotify does not offer this episode for playback here.' : at > 0 ? `Resume at ${fmt(at)}` : 'Play from the start'}
              onClick={() => play({ track: episodeAsTrack(e), startMs: at, showName: e.showName })}
            >
              <span className="b-wv-pod-ep-at">{dateLine(e.releaseDate)}</span>
              <span className="b-wv-pod-ep-text">
                <b>{e.title}</b>
                {e.description ? <span>{e.description}</span> : null}
              </span>
              <span className="b-wv-pod-ep-left">{episodeLeft(e.durationMs, placed)}</span>
            </button>
          );
        })}
      </>
    );
  };

  return (
    <>
      <section className="b-wv-pod" aria-label="Podcast">
        <div className="b-wv-pod-hero">
          <div className="b-wv-pod-cover">
            {hero?.track.artUrl
              ? <><img src={hero.track.artUrl} alt="" /><span className="b-wv-pod-shade" aria-hidden /></>
              : <span className="b-wv-pod-cover-moon" aria-hidden />}
            <span className="b-wv-pod-cover-show">{hero ? hero.showName : 'Podcast'}</span>
            <span className="b-wv-pod-cover-title">{hero ? hero.track.title : 'Nothing started yet'}</span>
          </div>
          <div className="b-wv-pod-play">
            <button
              type="button"
              className="b-wv-pod-playbtn"
              aria-label={showPause ? 'Pause' : 'Play'}
              disabled={!hero || !canPlay}
              title={!canPlay ? s.blocker?.short : hero && !isNow && hero.startMs > 0 ? `Resume at ${fmt(hero.startMs)}` : undefined}
              onClick={onHeroPlay}
            >
              <VeilSphere size="mini" ink bg="#26262d" count={1600} alpha={0.55} state={showPause ? 'speaking' : 'idle'} />
              <span className="b-wv-pod-playglyph"><AtlasIcon name={showPause ? 'pause' : 'play'} size={22} weight={1.8} /></span>
            </button>
            <div className="b-wv-pod-progress">
              <span className="b-wv-pod-track"><span style={{ width: `${pct.toFixed(1)}%` }} /></span>
              <span className="b-wv-pod-times"><span>{fmt(pos)}</span><span>{durationMs ? fmt(durationMs) : '—'}</span></span>
            </div>
          </div>
          {s.blocker ? (
            <div className="b-wv-pod-note">
              <p><b>{s.blocker.title}.</b> {s.blocker.body}</p>
              {s.blocker.action ? <button type="button" className="b-wv-pod-btn" disabled={s.blocker.action.disabled} onClick={s.blocker.action.onClick}>{s.blocker.action.label}</button> : null}
            </div>
          ) : null}
          {unavailable ? (
            <div className="b-wv-pod-note">
              <p>This episode can’t play inside Atlas: Spotify has no audio Atlas may decode for it. It can play on one of your Spotify speakers.</p>
              {roomsMissing ? (
                <button type="button" className="b-wv-pod-btn" disabled={m.isConnecting} onClick={() => void m.connect()}>Reconnect Spotify to turn on Rooms</button>
              ) : q.devices.length ? (
                <span className="b-wv-pod-rooms">
                  {q.devices.filter((d) => !d.restricted).map((d) => (
                    <button key={d.id} type="button" className="b-wv-pod-btn" disabled={q.rooms.moving !== null} onClick={() => void musicQueue.moveTo(d.id)}>
                      {q.rooms.moving === d.id ? 'Moving…' : `Play on ${d.name}`}
                    </button>
                  ))}
                </span>
              ) : (
                <p>{q.rooms.status === 'loading' ? 'Looking for your speakers…' : 'No Spotify speaker is on right now. Open Spotify on a phone or speaker, then try again.'}</p>
              )}
            </div>
          ) : null}
          {q.notice && !unavailable ? <p className="b-wv-pod-err" role="status">{q.notice}</p> : null}
        </div>

        <div className="b-wv-pod-list">
          <span className="b-wv-pod-head">{pods.shows.find((sh) => sh.id === pods.showId)?.name ?? 'Your shows'} · Episodes</span>
          {listBody()}
        </div>
      </section>
      <p className="b-wv-pod-foot">
        Your saved shows and episodes come from Spotify through your connected account, and play through Atlas on this Mac. Where you stopped is kept on this Mac.
        {resumeMissing ? ' Places you reached on your phone show here once you reconnect Spotify.' : ''}
      </p>
    </>
  );
}
