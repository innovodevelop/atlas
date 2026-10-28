/**
 * Watchlist — the tickers Home's Watchlist widget follows, editable (Beta
 * row 7): add a ticker, remove one, move one up or down, and set the ± move
 * that makes the widget ask for attention.
 *
 * The list is `useWatchlist` (the `user_watchlist` table the brain's
 * watchlist op writes too, plus this Mac's order and threshold); the quotes
 * are `useStocks` on that list, the same shared poll the widget reads, so
 * the two never disagree. Until the user edits anything the list is Atlas's
 * starting four, and the screen says so. Quotes come from Finnhub through
 * the Mac app with the key already on this Mac: the tickers are what leaves.
 */
import { useState } from 'react';
import { useWatchlist } from '@/hooks/useWatchlist';
import { useStocks } from '@/hooks/useStocks';
import { AtlasIcon } from '@/components/atlas/AtlasIcon';
import { fmtPct } from '@/pages/atlas/atlasHelpers';
import { MAX_TICKERS, THRESHOLD_MAX, THRESHOLD_MIN, stepThreshold, thresholdLabel } from '@/lib/betaWatchlist';
import { watchAttention } from '@/lib/betaWidgetCatalog';
import { escapeBlurs } from './fieldKeys';

export function StocksView() {
  const watch = useWatchlist();
  const { stocks, indices, isFallback, isLoading, error } = useStocks(watch.loaded ? watch.symbols : []);
  const [draft, setDraft] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const bySymbol = new Map(stocks.map((s) => [s.symbol.toUpperCase(), s]));
  const attention = isFallback ? null : watchAttention(stocks, watch.threshold);

  const submit = async () => {
    if (!draft.trim()) return;
    const err = await watch.add(draft);
    setAddError(err);
    if (!err) setDraft('');
  };

  return (
    <div className="b-wv-two b-wv-two--start">
      <section className="b-wv-tasks b-wv-watch" aria-label="Watchlist">
        <div className="b-wv-watch-head">
          <span className="b-wv-eyebrow">
            Watchlist · {watch.symbols.length} {watch.symbols.length === 1 ? 'ticker' : 'tickers'}
            {isFallback ? <span className="b-wv-stamp" title="Sample quotes — the market feed has not answered">Sample</span> : null}
          </span>
          <span className="b-wv-h1">{attention ? attention.text : watch.symbols.length ? 'Nothing past your threshold' : 'No tickers yet'}</span>
          <span className="b-wv-sub">
            {watch.starting
              ? 'Atlas’s starting four. Add, remove or reorder and the list becomes yours.'
              : `Up to ${MAX_TICKERS} tickers. Atlas can add one too: “add ASML to my watchlist”.`}
          </span>
        </div>

        {watch.symbols.map((sym, i) => {
          const q = bySymbol.get(sym);
          const tone = q ? (q.changePercent > 0 ? 'up' : q.changePercent < 0 ? 'down' : 'flat') : 'flat';
          return (
            <div key={sym} className="b-wv-task b-wv-tick">
              <span className="b-wv-tick-sym b-num">{sym}</span>
              <span className="b-wv-task-main">
                <span className="b-wv-task-t">{q?.name ?? (isLoading ? 'Fetching…' : 'No quote')}</span>
                {q ? <span className="b-wv-task-due b-num">{q.price.toFixed(2)}</span> : null}
              </span>
              <span className={`b-wv-tick-move b-num b-wv-tick-move--${tone}`}>{q ? fmtPct(q.changePercent) : '—'}</span>
              <span className="b-wv-tick-tools">
                <button type="button" className="b-wv-x" disabled={watch.busy || i === 0} aria-label={`Move ${sym} up`} title="Move up" onClick={() => void watch.move(sym, -1)}>↑</button>
                <button type="button" className="b-wv-x" disabled={watch.busy || i === watch.symbols.length - 1} aria-label={`Move ${sym} down`} title="Move down" onClick={() => void watch.move(sym, 1)}>↓</button>
                <button type="button" className="b-wv-x" disabled={watch.busy} aria-label={`Remove ${sym}`} title="Remove" onClick={() => void watch.remove(sym)}><AtlasIcon name="close" size={14} /></button>
              </span>
            </div>
          );
        })}
        {watch.loaded && !watch.symbols.length ? <div className="b-wv-empty">The list is empty. Add a ticker below.</div> : null}

        <div className="b-wv-add">
          <input
            className="b-wv-add-in"
            placeholder="Add a ticker, such as ASML or BRK.B"
            aria-label="New ticker"
            value={draft}
            maxLength={12}
            autoCapitalize="characters"
            onChange={(e) => { setDraft(e.target.value); setAddError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); else escapeBlurs(e); }}
          />
          <button type="button" className="b-wv-add-btn" onClick={() => void submit()} disabled={!draft.trim() || watch.busy || watch.symbols.length >= MAX_TICKERS}>Add</button>
        </div>
        {addError || watch.error ? <p className="b-wv-err">{addError ?? watch.error}</p> : null}
        {error && !isFallback ? <p className="b-wv-err">The market feed did not answer the last refresh; the quotes above are the last ones that arrived.</p> : null}
      </section>

      <aside className="b-wv-take" aria-label="Alert threshold">
        <span className="b-wv-take-t">When Atlas flags a move</span>
        <div className="b-wv-take-card">
          <span className="b-wv-take-card-d">Home’s Watchlist asks for attention when a ticker moves past this much today, up or down.</span>
          <div className="b-wv-stepper" role="group" aria-label="Threshold">
            <button type="button" className="b-wv-x" disabled={watch.threshold <= THRESHOLD_MIN} aria-label="Lower the threshold" onClick={() => watch.setThreshold(stepThreshold(watch.threshold, -1))}>−</button>
            <span className="b-wv-stepper-v b-num" aria-live="polite">{thresholdLabel(watch.threshold)}</span>
            <button type="button" className="b-wv-x" disabled={watch.threshold >= THRESHOLD_MAX} aria-label="Raise the threshold" onClick={() => watch.setThreshold(stepThreshold(watch.threshold, 1))}>+</button>
          </div>
        </div>
        {indices.length ? (
          <div className="b-wv-take-card">
            <span className="b-wv-take-card-t">Markets</span>
            {indices.map((x) => (
              <span key={x.label} className="b-wv-take-card-d b-wv-index"><span>{x.label}</span><span className="b-num">{fmtPct(x.changePercent)}</span></span>
            ))}
          </div>
        ) : null}
        <span className="b-wv-free-note">Quotes come from Finnhub through the Mac app. The tickers are what leaves this Mac; the order and the threshold stay on it.</span>
      </aside>
    </div>
  );
}
