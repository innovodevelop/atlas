/**
 * The watchlist the Watchlist screen edits and the Home widget reads (Beta
 * row 7) — pure, so the ordering, the symbol rule and the threshold are
 * tested without a database.
 *
 * Membership lives in the `user_watchlist` table (one row per ticker), the
 * same table the brain's "add to my watchlist" op writes — so a ticker added
 * by voice shows up on Home, and one added here is one the brain can read.
 * The table has no order column, so the order the user drags into and the
 * ± move that counts as news are this Mac's preferences, in local storage
 * under `atlas:watchlist`, beside the Home layout's own.
 *
 * Until the user edits anything, an empty table shows Atlas's four starting
 * tickers, said to be that. The first edit writes them into the table, so
 * nothing the user was looking at disappears when they add their own.
 */

/** What Home showed before the watchlist could be edited. */
export const STARTING_TICKERS: readonly string[] = ['AAPL', 'GOOGL', 'MSFT', 'NVDA'];
/** Each ticker is two quote calls per refresh; a dozen keeps the feed's rate sane. */
export const MAX_TICKERS = 12;

export const THRESHOLD_DEFAULT = 3;
export const THRESHOLD_MIN = 0.5;
export const THRESHOLD_MAX = 20;
export const THRESHOLD_STEP = 0.5;

export const WATCH_PREFS_KEY = 'atlas:watchlist';

export interface WatchPrefs {
  /** Tickers in the order the user put them; ones not listed follow, oldest first. */
  order: string[];
  /** The ± daily move, in percent, that makes the widget ask for attention. */
  threshold: number;
  /** True once the user has changed the list; until then an empty table shows the starting tickers. */
  edited: boolean;
}

export const DEFAULT_WATCH_PREFS: WatchPrefs = { order: [], threshold: THRESHOLD_DEFAULT, edited: false };

/**
 * A ticker as the brain's watchlist op accepts it (control/ops_write.rs
 * `as_symbol`): up to 12 characters, capitals, digits, '.' or '-'. Anything
 * else is not a ticker — most often a company name typed in its place.
 */
export function normalizeSymbol(raw: string): string | null {
  const s = raw.trim().toUpperCase();
  return s.length > 0 && s.length <= 12 && /^[A-Z0-9.-]+$/.test(s) ? s : null;
}

export function clampThreshold(v: number): number {
  if (!Number.isFinite(v)) return THRESHOLD_DEFAULT;
  const stepped = Math.round(v / THRESHOLD_STEP) * THRESHOLD_STEP;
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, stepped));
}

/** One step up or down the threshold's scale. */
export function stepThreshold(v: number, dir: 1 | -1): number {
  return clampThreshold(v + dir * THRESHOLD_STEP);
}

/** "±3%" · "±2.5%". */
export function thresholdLabel(v: number): string {
  return `±${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)}%`;
}

export function parseWatchPrefs(raw: string | null): WatchPrefs {
  const out: WatchPrefs = { ...DEFAULT_WATCH_PREFS, order: [] };
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof WatchPrefs, unknown>>;
    if (Array.isArray(v.order)) {
      const seen = new Set<string>();
      for (const s of v.order) {
        const n = typeof s === 'string' ? normalizeSymbol(s) : null;
        if (n && !seen.has(n)) { seen.add(n); out.order.push(n); }
      }
    }
    if (typeof v.threshold === 'number') out.threshold = clampThreshold(v.threshold);
    if (v.edited === true) out.edited = true;
  } catch { /* a corrupt preference is the default, not a crash */ }
  return out;
}

export interface WatchRow { symbol: string; created_at?: string | null }

/** The table's tickers in the user's order; ones the order does not know yet (added by the brain) follow, oldest first. */
export function orderedSymbols(rows: readonly WatchRow[], order: readonly string[]): string[] {
  const have = new Map<string, WatchRow>();
  for (const r of rows) {
    const s = normalizeSymbol(r.symbol);
    if (s && !have.has(s)) have.set(s, r);
  }
  const first = order.filter((s) => have.has(s));
  const rest = [...have.values()]
    .filter((r) => !first.includes(normalizeSymbol(r.symbol) ?? ''))
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
    .map((r) => normalizeSymbol(r.symbol) ?? '');
  return [...first, ...rest];
}

/** What the screen and the widget show, and whether it is the starting list rather than the user's. */
export function shownSymbols(rows: readonly WatchRow[], prefs: WatchPrefs): { symbols: string[]; starting: boolean } {
  if (rows.length) return { symbols: orderedSymbols(rows, prefs.order), starting: false };
  if (!prefs.edited) return { symbols: [...STARTING_TICKERS], starting: true };
  return { symbols: [], starting: false };
}

/** The list with one ticker moved one place up (-1) or down (+1); unchanged at an end. */
export function moveSymbol(list: readonly string[], symbol: string, delta: -1 | 1): string[] {
  const i = list.indexOf(symbol);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

export type AddCheck = { ok: true; symbol: string } | { ok: false; reason: string };

/** Whether a typed ticker can join the list, and the reason when it cannot. */
export function checkAdd(raw: string, list: readonly string[]): AddCheck {
  const s = normalizeSymbol(raw);
  if (!s) return { ok: false, reason: 'A ticker is up to 12 letters, digits, "." or "-", such as AAPL or BRK.B.' };
  if (list.includes(s)) return { ok: false, reason: `${s} is already on the list.` };
  if (list.length >= MAX_TICKERS) return { ok: false, reason: `The watchlist holds ${MAX_TICKERS} tickers. Remove one first.` };
  return { ok: true, symbol: s };
}
