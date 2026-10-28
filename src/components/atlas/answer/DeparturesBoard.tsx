/**
 * The departures shape (`Atlas Answer Views Beta.dc.html`, left-out row 26):
 * Rejseplanen's live board for the stop the user chose, optionally only the
 * departures that pass where the question was going.
 *
 * Every line on it is Rejseplanen's: the times, the realtime delay, the
 * platform, a cancellation. The headline and the note under the board are
 * worded from the board itself (src/lib/transit.ts) — no model is asked.
 * It refreshes once a minute while it is on screen and the window is
 * visible, which keeps a day of looking well inside the access ID's
 * monthly allowance.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import type { UseTransit } from '@/hooks/useTransit';
import { boardNote, countdown, departureNote, departuresHeadline, type Departure, type TransitStop } from '@/lib/transit';

const REFRESH_MS = 60_000;
const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

export interface DeparturesBoardProps {
  transit: UseTransit;
  stop: TransitStop;
  /** Where the question was going ("to Lund"), when it said. */
  to: string | null;
  /** The header's sentence, once the board has loaded (or failed). */
  onHeadline?: (line: string) => void;
  onChangeStop?: () => void;
}

export function DeparturesBoard({ transit, stop, to, onHeadline, onChangeStop }: DeparturesBoardProps) {
  const [deps, setDeps] = useState<Departure[] | null>(null);
  const [toStop, setToStop] = useState<TransitStop | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(false);
  const headline = useRef(onHeadline);
  headline.current = onHeadline;
  const { departures, findStops } = transit;

  const load = useCallback(async (direction: TransitStop | null) => {
    setLoading(true);
    try {
      const list = await departures(stop, direction);
      setDeps(list);
      setError(null);
      setNow(new Date());
      headline.current?.(departuresHeadline(list, stop.name, direction?.name ?? null));
    } catch (e) {
      const line = e instanceof Error ? e.message : 'Rejseplanen did not answer.';
      setError(line);
      headline.current?.(line);
    } finally {
      setLoading(false);
    }
  }, [departures, stop]);

  // Resolve where the question was going to a stop once, then load. When
  // Rejseplanen knows no stop by that name the board shows every departure
  // and says so, rather than guessing a direction.
  useEffect(() => {
    let live = true;
    void (async () => {
      let direction: TransitStop | null = null;
      if (to) {
        try {
          direction = (await findStops(to))[0] ?? null;
        } catch {
          direction = null;
        }
      }
      if (!live) return;
      setToStop(direction);
      await load(direction);
    })();
    return () => { live = false; };
  }, [stop.id, to, findStops, load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(toStop);
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [load, toStop]);

  const note = deps ? boardNote(deps) : null;
  const title = toStop ? `${stop.name} → ${toStop.name}` : stop.name;

  return (
    <section className="b-answer-board" aria-label={`Departures from ${stop.name}`}>
      <div className="b-answer-board-head">
        <span className="b-answer-board-t">{title}</span>
        <span className="b-answer-board-clock b-num">{CLOCK.format(now)}</span>
      </div>
      {to && deps && !toStop ? <p className="b-answer-board-fine">Rejseplanen knows no stop called “{to}”, so these are every departure from {stop.name}.</p> : null}
      {error ? <p role="alert" className="b-answer-board-err">{error}</p> : null}
      {deps === null && !error ? <p className="b-answer-board-fine">Asking Rejseplanen…</p> : null}
      {deps && deps.length === 0 ? <p className="b-answer-board-fine">{departuresHeadline(deps, stop.name, toStop?.name ?? null)}</p> : null}
      {deps && deps.length ? (
        <ol className="b-answer-board-rows">
          {deps.slice(0, 6).map((d, i) => (
            <li key={d.key} className={`b-answer-dep${i === 0 && !d.cancelled ? ' next' : ''}${d.cancelled ? ' off' : ''}`}>
              <span className="b-answer-dep-time b-num">{d.planned}</span>
              <span className="b-answer-dep-line">
                <b>{d.line}{d.direction ? ` · ${d.direction}` : ''}</b>
                <small>{departureNote(d)}</small>
              </span>
              <span className="b-answer-dep-track">
                {d.track ? <><small>Platform</small><b className="b-num">{d.track}</b></> : null}
              </span>
              <span className="b-answer-dep-cd">{d.cancelled ? '—' : countdown(d, now)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {note ? <p className="b-answer-board-note">{note}</p> : null}
      <div className="b-answer-board-foot">
        <span>Live from Rejseplanen. The stop and this question’s destination went to rejseplanen.dk; nothing else did.</span>
        <span className="b-answer-board-acts">
          <button type="button" className="b-btn b-btn--row b-answer-board-btn" disabled={loading} onClick={() => void load(toStop)}>
            <AtlasIcon name="sync" size={14} />{loading ? 'Refreshing…' : 'Refresh'}
          </button>
          {onChangeStop ? (
            <button type="button" className="b-btn b-btn--row b-answer-board-btn" onClick={onChangeStop}>
              <AtlasIcon name="location" size={14} />Change stop
            </button>
          ) : null}
          <button
            type="button"
            className="b-btn b-btn--row b-answer-board-btn"
            title="Delete the access ID from this Mac’s Keychain. Departures stop until you add one again."
            onClick={() => { void transit.removeKey().then((err) => { if (err) setError(err); }); }}
          >
            <AtlasIcon name="key" size={14} />Remove access ID
          </button>
        </span>
      </div>
    </section>
  );
}
