/**
 * The Currency widget (Beta row 15, `Atlas Widgets Beta.dc.html` "Currency":
 * a split face, "€1 Euro | $1.09 US dollar", "Rate today"). Pure: the
 * currencies, the saved choice, the conversion and the month's line.
 *
 * The rates are the European Central Bank's daily reference rates, served
 * without a key by Frankfurter (api.frankfurter.app) and fetched in Rust
 * (src-tauri/src/datafetch.rs `fetch_fx`) — only the two currency codes leave
 * the Mac. The base currency, the other one and the amount are this Mac's
 * preference, in local storage 'atlas:currency'.
 */

/** The ECB reference currencies — the only ones Frankfurter quotes. */
export const ECB_CURRENCIES = [
  'AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK',
  'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR',
] as const;
export type Currency = (typeof ECB_CURRENCIES)[number];
export const isCurrency = (v: unknown): v is Currency => typeof v === 'string' && (ECB_CURRENCIES as readonly string[]).includes(v);

export const CURRENCY_KEY = 'atlas:currency';
export const AMOUNT_MAX = 1e9;

export interface CurrencyPrefs { base: Currency; quote: Currency; amount: number }
export const DEFAULT_CURRENCY: CurrencyPrefs = { base: 'EUR', quote: 'USD', amount: 1 };

export function clampAmount(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  return Math.min(AMOUNT_MAX, Math.round(v * 100) / 100);
}

export function parseCurrencyPrefs(raw: string | null): CurrencyPrefs {
  const out = { ...DEFAULT_CURRENCY };
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (isCurrency(v.base)) out.base = v.base;
    if (isCurrency(v.quote)) out.quote = v.quote;
    if (typeof v.amount === 'number') out.amount = clampAmount(v.amount);
  } catch { /* a corrupt preference is the default */ }
  return out;
}

/** "Euro" · "US dollar" — the reader's own language's name for a code. */
export function currencyName(code: string, locale?: string): string {
  try {
    const dn = new Intl.DisplayNames(locale ? [locale] : undefined, { type: 'currency' });
    const n = dn.of(code);
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : code;
  } catch {
    return code;
  }
}

/** "€1" · "$1.09" · "kr 7.46" — an amount in a currency, the way the reader's locale writes it. */
export function fmtMoney(v: number, code: string, locale?: string): string {
  // Big amounts in whole units, everyday ones to the cent, tiny rates (0.0134)
  // to four places; a whole small amount ("€1") without the ".00".
  const max = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 1 ? 2 : 4;
  const min = Number.isInteger(v) && Math.abs(v) < 100 ? 0 : max;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: code, minimumFractionDigits: min, maximumFractionDigits: max }).format(v);
  } catch {
    return `${v.toFixed(max)} ${code}`;
  }
}

export interface FxReading {
  base: string;
  quote: string;
  /** The day the ECB rate is for, "2026-10-27". */
  date: string;
  rate: number;
  series: { date: string; rate: number }[];
}

/** The rate's move over the month the line shows, in percent; null without a line. */
export function monthMove(r: Pick<FxReading, 'series' | 'rate'>): number | null {
  const first = r.series[0]?.rate;
  if (!first || r.series.length < 2) return null;
  return ((r.rate - first) / first) * 100;
}

/** "Rate for Tue 27 Oct" — the ECB publishes once a working day, so the date matters. */
export function rateDateLabel(date: string, locale?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return 'Rate today';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return `Rate for ${d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })}`;
}
