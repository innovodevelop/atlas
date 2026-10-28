/**
 * What the departures shape needs before it can show a board: Rejseplanen's
 * access ID, then a stop. Real controls, dormant until the user acts — the
 * card says plainly where to get the ID, where it is kept and what leaves the
 * Mac once it is there (src-tauri/src/transit.rs makes every request).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { openExternal } from '@/components/atlas-ui/answerViews/openExternal';
import type { UseTransit } from '@/hooks/useTransit';
import type { TransitStop } from '@/lib/transit';

/** Rejseplanen Labs' request form; "Private user" is the free tier. */
export const REJSEPLANEN_REQUEST_URL = 'https://labs.rejseplanen.dk/hc/da/requests/new';

export function TransitKeyCard({ transit }: { transit: UseTransit }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (transit.status === 'unavailable') {
    return (
      <section className="b-answer-transit" aria-label="Departures">
        <p className="b-answer-transit-t">Departures need the Atlas app on your Mac.</p>
        <p className="b-answer-transit-d">Rejseplanen is asked by the app itself, so the access ID stays in this Mac’s Keychain. The browser preview cannot do that.</p>
      </section>
    );
  }

  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    const err = await transit.saveKey(key.trim());
    setBusy(false);
    // Cleared either way: the field never keeps a secret on screen longer than the save.
    setKey('');
    if (err) setError(err);
  };

  return (
    <section className="b-answer-transit" aria-label="Connect Rejseplanen">
      <span className="b-answer-transit-k">Rejseplanen · not connected</span>
      <p className="b-answer-transit-t">Live departures need a Rejseplanen access ID.</p>
      <p className="b-answer-transit-d">
        It is free for private use. Ask Rejseplanen Labs for one — choose “Private user” — and it arrives by email, good for 50,000 lookups a month.
      </p>
      <form className="b-answer-transit-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input
          type="password"
          value={key}
          onChange={(e) => { setKey(e.target.value); setError(null); }}
          placeholder="Paste your access ID"
          aria-label="Rejseplanen access ID"
          autoComplete="off"
          spellCheck={false}
          disabled={transit.status === 'loading'}
        />
        <button type="submit" className="b-btn b-btn--primary" disabled={!key.trim() || busy}>{busy ? 'Saving…' : 'Save'}</button>
      </form>
      {error ? <p role="alert" className="b-answer-transit-err">{error}</p> : null}
      <div className="b-answer-transit-row">
        <button type="button" className="b-btn b-btn--card b-btn--row" onClick={() => void openExternal(REJSEPLANEN_REQUEST_URL)}>
          <AtlasIcon name="open" size={14} />Request an access ID
        </button>
      </div>
      <p className="b-answer-transit-fine">
        Kept in this Mac’s Keychain, never in Atlas’s files. When you look up departures, the stop you ask about and this ID go to rejseplanen.dk — nothing else.
      </p>
    </section>
  );
}

export function TransitStopPicker({ transit, initial, onPicked }: { transit: UseTransit; initial?: string | null; onPicked?: (stop: TransitStop) => void }) {
  const [query, setQuery] = useState(initial ?? '');
  const [results, setResults] = useState<TransitStop[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searched = useRef(false);
  const inFlight = useRef(false);
  const { findStops } = transit;

  const search = useCallback(async (q: string) => {
    const t = q.trim();
    if (t.length < 2 || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      setResults(await findStops(t));
    } catch (e) {
      setResults(null);
      setError(e instanceof Error ? e.message : 'Rejseplanen did not answer.');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [findStops]);

  // A stop named in the question is searched once, so the picker opens on it.
  useEffect(() => {
    if (searched.current || !initial || initial.trim().length < 2) return;
    searched.current = true;
    void search(initial);
  }, [initial, search]);

  return (
    <section className="b-answer-transit" aria-label="Choose your stop">
      <span className="b-answer-transit-k">Rejseplanen · connected</span>
      <p className="b-answer-transit-t">Which stop do you leave from?</p>
      <form className="b-answer-transit-form" onSubmit={(e) => { e.preventDefault(); void search(query); }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nørreport St., Aarhus H, a bus stop…" aria-label="Stop name" maxLength={80} />
        <button type="submit" className="b-btn b-btn--primary" disabled={query.trim().length < 2 || busy}>{busy ? 'Searching…' : 'Search'}</button>
      </form>
      {error ? <p role="alert" className="b-answer-transit-err">{error}</p> : null}
      {results ? (
        results.length ? (
          <div className="b-answer-transit-stops">
            {results.map((s) => (
              <button key={s.id} type="button" className="b-answer-transit-stop" onClick={() => { transit.chooseStop(s); onPicked?.(s); }}>
                <AtlasIcon name="location" size={15} />{s.name}
              </button>
            ))}
          </div>
        ) : <p className="b-answer-transit-d">Rejseplanen knows no stop by that name. Try the station’s full name.</p>
      ) : null}
      <p className="b-answer-transit-fine">The stop is remembered on this Mac. Searching sends the name you type to rejseplanen.dk.</p>
    </section>
  );
}
