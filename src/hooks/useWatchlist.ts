/**
 * The editable watchlist (Beta row 7): the tickers in `user_watchlist` — the
 * table the brain's watchlist op writes too — in the order and with the ±
 * threshold this Mac keeps (src/lib/betaWatchlist.ts says why the split).
 *
 * Both halves are module stores, so the Watchlist screen, the Home widget
 * and every catalog cell agree the moment either changes, and the table is
 * read once for all of them: on the first subscriber, again whenever the
 * table changes (the local realtime event fires for the brain's writes as
 * well as ours), and dropped with the last subscriber.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from './useAuth';
import {
  WATCH_PREFS_KEY, checkAdd, clampThreshold, moveSymbol, parseWatchPrefs, shownSymbols,
  type WatchPrefs, type WatchRow,
} from '@/lib/betaWatchlist';

type Listener = () => void;
/** One empty list, so a signed-out reader's memo does not change every render. */
const NO_ROWS: WatchRow[] = [];

// --- Preferences: order, threshold, edited ----------------------------------------------

const prefListeners = new Set<Listener>();
let prefs: WatchPrefs = (() => {
  try { return parseWatchPrefs(window.localStorage.getItem(WATCH_PREFS_KEY)); } catch { return parseWatchPrefs(null); }
})();

function setPrefs(next: WatchPrefs): void {
  prefs = next;
  try { window.localStorage.setItem(WATCH_PREFS_KEY, JSON.stringify(next)); } catch { /* private window: this session keeps it */ }
  prefListeners.forEach((l) => l());
}
const subscribePrefs = (l: Listener) => { prefListeners.add(l); return () => { prefListeners.delete(l); }; };
const getPrefs = () => prefs;

// --- Rows: the table, read once for every reader ------------------------------------------

interface RowsState { userId: string | null; rows: WatchRow[]; loaded: boolean; error: string | null }
const rowListeners = new Set<Listener>();
let rowsState: RowsState = { userId: null, rows: [], loaded: false, error: null };
let channel: ReturnType<typeof supabase.channel> | null = null;
let users = 0;

function setRows(patch: Partial<RowsState>): void {
  rowsState = { ...rowsState, ...patch };
  rowListeners.forEach((l) => l());
}

/** The read in flight, so readers mounting together (a page of catalog cells) share one. */
let inflight: { userId: string | null; done: Promise<void> } | null = null;

function loadRows(userId: string | null): Promise<void> {
  if (inflight && inflight.userId === userId) return inflight.done;
  const done = (async () => {
    if (!userId) { setRows({ userId, rows: [], loaded: true, error: null }); return; }
    const { data, error } = await supabase.from('user_watchlist').select('*').eq('user_id', userId);
    // A sign-out or a different user meanwhile: this answer is not theirs.
    if (rowsState.userId !== userId) return;
    if (error) setRows({ loaded: true, error: error.message });
    else setRows({ rows: ((data ?? []) as WatchRow[]).map((r) => ({ symbol: r.symbol, created_at: r.created_at })), loaded: true, error: null });
  })().finally(() => { if (inflight?.done === done) inflight = null; });
  inflight = { userId, done };
  return done;
}

function attach(userId: string | null): () => void {
  users += 1;
  if (rowsState.userId !== userId) {
    setRows({ userId, rows: [], loaded: false, error: null });
    void loadRows(userId);
  } else if (!rowsState.loaded) {
    void loadRows(userId);
  }
  if (!channel) {
    channel = supabase
      .channel('beta-watchlist')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'user_watchlist' }, () => { void loadRows(rowsState.userId); })
      .subscribe();
  }
  return () => {
    users -= 1;
    if (users === 0 && channel) { supabase.removeChannel(channel); channel = null; }
  };
}

const subscribeRows = (l: Listener) => { rowListeners.add(l); return () => { rowListeners.delete(l); }; };
const getRows = () => rowsState;

/** Just the threshold, for readers that do not need the rows. */
export function useWatchThreshold(): number {
  return useSyncExternalStore(subscribePrefs, getPrefs, getPrefs).threshold;
}

export function useWatchlist() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const p = useSyncExternalStore(subscribePrefs, getPrefs, getPrefs);
  const r = useSyncExternalStore(subscribeRows, getRows, getRows);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => attach(userId), [userId]);

  const mine = r.userId === userId;
  const rows = mine ? r.rows : NO_ROWS;
  const loaded = mine && r.loaded;
  const shown = useMemo(() => shownSymbols(rows, p), [rows, p]);

  /** Run a write, then re-read the table once whatever happened. */
  const run = useCallback(async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setActionError(null);
    try {
      const err = await fn();
      if (err) setActionError(err);
      // A read that began before the write answers for the old table: let it
      // land, then read again.
      if (inflight) await inflight.done;
      await loadRows(userId);
    } finally {
      setBusy(false);
    }
  }, [userId]);

  /** Rows for these tickers; the first edit of the starting list writes it in, so what the user saw stays. */
  const insert = useCallback(async (symbols: readonly string[]): Promise<string | null> => {
    if (!userId || !symbols.length) return null;
    const { error } = await supabase.from('user_watchlist').insert(symbols.map((symbol) => ({ user_id: userId, symbol })));
    return error ? error.message : null;
  }, [userId]);

  const add = useCallback(async (raw: string): Promise<string | null> => {
    const check = checkAdd(raw, shown.symbols);
    // `in`, not `!check.ok`: without strictNullChecks a boolean discriminant does not narrow.
    if ('reason' in check) return check.reason;
    if (!userId) return 'Sign in to keep a watchlist.';
    await run(async () => {
      const err = await insert(shown.starting ? [...shown.symbols, check.symbol] : [check.symbol]);
      if (!err) setPrefs({ ...prefs, order: [...shown.symbols, check.symbol], edited: true });
      return err;
    });
    return null;
  }, [shown, userId, run, insert]);

  const remove = useCallback(async (symbol: string) => {
    if (!userId) return;
    await run(async () => {
      let err: string | null;
      if (shown.starting) {
        // Nothing is in the table yet: write the starting list minus this one.
        err = await insert(shown.symbols.filter((s) => s !== symbol));
      } else {
        const { error } = await supabase.from('user_watchlist').delete().eq('user_id', userId).eq('symbol', symbol);
        err = error ? error.message : null;
      }
      if (!err) setPrefs({ ...prefs, order: shown.symbols.filter((s) => s !== symbol), edited: true });
      return err;
    });
  }, [shown, userId, run, insert]);

  const move = useCallback(async (symbol: string, delta: -1 | 1) => {
    const order = moveSymbol(shown.symbols, symbol, delta);
    if (!shown.starting) { setPrefs({ ...prefs, order, edited: true }); return; }
    await run(async () => {
      const err = await insert(shown.symbols);
      if (!err) setPrefs({ ...prefs, order, edited: true });
      return err;
    });
  }, [shown, run, insert]);

  const setThreshold = useCallback((v: number) => {
    setPrefs({ ...prefs, threshold: clampThreshold(v) });
  }, []);

  return {
    symbols: shown.symbols,
    /** True while the list is Atlas's starting four, not one the user made. */
    starting: shown.starting,
    threshold: p.threshold,
    loaded,
    busy,
    error: actionError ?? (mine ? r.error : null),
    add,
    remove,
    move,
    setThreshold,
  };
}
