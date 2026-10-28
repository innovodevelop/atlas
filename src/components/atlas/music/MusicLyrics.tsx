/**
 * The Lyrics tab of the listening room (`Atlas Music Beta.dc.html`): the
 * song's lines, the one being sung large and bright, the sung ones dimmed.
 *
 * Timed lines follow the engine's own clock (`readPosition`, read per
 * animation frame; the component renders only when the line changes). Plain
 * lyrics stand still. The note under them says where they come from and what
 * was sent to find them. Asking happens only while this tab is open.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLyrics } from '@/hooks/useLyrics';
import { INSTRUMENTAL, NO_LYRICS, lineAt } from '@/lib/musicLyrics';
import { isEpisode, type Track } from '@/lib/musicSpotify';

export interface MusicLyricsProps {
  track: Track | null;
  readPosition: () => number;
  /** The scrolling list the lines sit in; the current line is kept in view inside it. */
  scroller: RefObject<HTMLDivElement | null>;
  reduced: boolean;
}

export function MusicLyrics({ track, readPosition, scroller, reduced }: MusicLyricsProps) {
  const { status, view, error } = useLyrics(track, true);
  const [line, setLine] = useState(-1);
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const pos = useRef(readPosition);
  pos.current = readPosition;

  useEffect(() => {
    setLine(-1);
    if (view.kind !== 'synced') return;
    const lines = view.lines;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      const i = lineAt(lines, pos.current());
      setLine((prev) => (prev === i ? prev : i));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [view]);

  // Keep the sung line about a third of the way down, inside the list only.
  useEffect(() => {
    const box = scroller.current;
    const el = line >= 0 ? lineRefs.current[line] : null;
    if (!box || !el) return;
    const target = Math.max(0, el.offsetTop - box.clientHeight / 3);
    if (Math.abs(box.scrollTop - target) < 4) return;
    if (reduced) box.scrollTop = target;
    else box.scrollTo({ top: target, behavior: 'smooth' });
  }, [line, scroller, reduced]);

  const empty = (title: string, body: string) => <div className="b-mu-empty"><b>{title}</b>{body}</div>;

  if (!track) return empty('Nothing playing', 'Lyrics follow the record that is playing.');
  if (isEpisode(track)) return empty('A podcast episode', 'Lyrics are for songs; episodes have none.');

  const source = (
    <p className="b-mu-lyr-note">
      Lyrics from LRCLIB. To find them, Atlas sends this song’s title, artist, album and length to lrclib.net, then keeps the answer on this Mac.
    </p>
  );

  if (status === 'loading' || status === 'idle') return <>{empty('Finding the lyrics…', `Asking LRCLIB for “${track.title}”.`)}{source}</>;
  if (status === 'error') return <>{empty('Lyrics could not be fetched', error ?? 'LRCLIB did not answer.')}{source}</>;

  return (
    <div className="b-mu-lyrics" aria-live="off">
      {view.kind === 'synced' ? view.lines.map((l, i) => (
        <p
          key={`${l.ms}-${i}`}
          ref={(el) => { lineRefs.current[i] = el; }}
          className={`b-mu-lyr${i === line ? ' now' : i < line ? ' past' : ''}`}
          aria-current={i === line ? 'true' : undefined}
        >
          {l.text || '♪'}
        </p>
      )) : null}
      {view.kind === 'plain' ? (
        <>
          <p className="b-mu-lyr-plainnote">LRCLIB has these lyrics without timing, so they do not follow the song.</p>
          {view.lines.map((t, i) => <p key={i} className={`b-mu-lyr b-mu-lyr--plain${t ? '' : ' gap'}`}>{t || ' '}</p>)}
        </>
      ) : null}
      {view.kind === 'instrumental' ? <p className="b-mu-lyr-none">{INSTRUMENTAL}</p> : null}
      {view.kind === 'none' ? <p className="b-mu-lyr-none">{NO_LYRICS}</p> : null}
      {source}
    </div>
  );
}
