/**
 * Currency — the Currency widget's pair in full (Beta row 15): the amount
 * and the two currencies to change, the converted amount, the ECB reference
 * rate and its last month as a line.
 *
 * `useCurrency` throughout: the pair and the amount are this Mac's
 * preference (local storage), the rate is Frankfurter's copy of the European
 * Central Bank's daily reference, fetched in Rust with no key. Only the two
 * currency codes leave the Mac. The ECB publishes once a working day, so the
 * screen names the day the rate is for.
 */
import { useEffect, useState } from 'react';
import {
  setCurrencyAmount, setCurrencyBase, setCurrencyQuote, swapCurrencies, useCurrency,
} from '@/hooks/useCurrency';
import { ECB_CURRENCIES, currencyName, fmtMoney, isCurrency, monthMove, rateDateLabel } from '@/lib/betaCurrency';
import { escapeBlurs } from './fieldKeys';

/** The month's line as an SVG path in a 600×160 box. */
function linePath(values: readonly number[], w = 600, h = 160): string {
  if (values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  return values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * w).toFixed(1)} ${(h - 10 - ((v - min) / span) * (h - 20)).toFixed(1)}`).join(' ');
}

export function CurrencyView() {
  const { prefs, reading, isLoading, error, refetch } = useCurrency();
  const [amount, setAmount] = useState(String(prefs.amount));
  useEffect(() => { setAmount(String(prefs.amount)); }, [prefs.amount]);
  const rate = reading && reading.base === prefs.base && reading.quote === prefs.quote ? reading : null;
  const move = rate ? monthMove(rate) : null;
  const values = rate?.series.map((p) => p.rate) ?? [];
  const commit = () => {
    const n = Number(amount.replace(',', '.'));
    setCurrencyAmount(n);
  };
  const picker = (value: string, onPick: (c: (typeof ECB_CURRENCIES)[number]) => void, label: string) => (
    <select className="b-wv-fx-pick" value={value} aria-label={label} onKeyDown={escapeBlurs} onChange={(e) => { if (isCurrency(e.target.value)) onPick(e.target.value); }}>
      {ECB_CURRENCIES.map((c) => <option key={c} value={c}>{c} · {currencyName(c)}</option>)}
    </select>
  );

  return (
    <div className="b-wv-two b-wv-two--start">
      <section className="b-wv-tasks b-wv-fx" aria-label="Currency">
        <span className="b-wv-eyebrow">Currency · {rate ? rateDateLabel(rate.date) : 'ECB reference rates'}</span>
        <div className="b-wv-fx-row">
          <input
            className="b-wv-add-in b-wv-fx-amount b-num"
            inputMode="decimal"
            aria-label="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); else escapeBlurs(e); }}
          />
          {picker(prefs.base, setCurrencyBase, 'From currency')}
        </div>
        <button type="button" className="b-wv-fx-swap" onClick={swapCurrencies} aria-label="Swap the currencies" title="Swap">⇅</button>
        <div className="b-wv-fx-row">
          <span className="b-wv-fx-out b-num">{rate ? fmtMoney(prefs.amount * rate.rate, prefs.quote) : isLoading ? '…' : '—'}</span>
          {picker(prefs.quote, setCurrencyQuote, 'To currency')}
        </div>
        {rate ? (
          <span className="b-wv-sub b-num">
            1 {prefs.base} = {rate.rate.toFixed(4)} {prefs.quote}
            {move != null ? ` · ${move >= 0 ? '+' : '−'}${Math.abs(move).toFixed(1)}% over 30 days` : ''}
          </span>
        ) : null}
        {values.length > 1 ? (
          <svg className="b-wv-fx-line" viewBox="0 0 600 160" preserveAspectRatio="none" aria-label={`The rate over the last ${values.length} working days`}>
            <path d={linePath(values)} fill="none" stroke={move != null && move < 0 ? 'var(--b-red)' : 'var(--b-green-deep)'} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
          </svg>
        ) : null}
        {error ? (
          <p className="b-wv-err">
            {rate ? 'The rate service did not answer the last refresh; this is the last rate that arrived. ' : `${error} `}
            <button type="button" className="b-wv-why-ask" onClick={() => void refetch()}>Try again</button>
          </p>
        ) : null}
      </section>
      <aside className="b-wv-take" aria-label="About the rates">
        <span className="b-wv-take-t">Where the rate comes from</span>
        <span className="b-wv-take-card-d">
          The European Central Bank’s reference rates, published once a working day around 16:00 CET and served by
          Frankfurter (frankfurter.app) without a key. The Mac app asks for the two currency codes and nothing else;
          the amount and your choice stay on this Mac. Reference rates are not what a bank or card charges.
        </span>
      </aside>
    </div>
  );
}
