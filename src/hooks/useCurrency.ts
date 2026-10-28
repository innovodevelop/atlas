/**
 * The Currency widget's rate (Beta row 15): ECB reference rates through
 * Frankfurter, fetched in Rust (`fetch_fx`) because the webview's CSP rightly
 * allows no third-party hosts. One shared poll per pair (sharedStore.ts),
 * hourly — the ECB publishes once a working day, so more often buys nothing.
 * The pair and the amount are a module store over local storage, so the
 * widget and its screen agree the moment either changes them.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { isTauri } from '@/integrations/local/localClient';
import { createSharedPoll } from '@/lib/sharedStore';
import {
  CURRENCY_KEY, clampAmount, parseCurrencyPrefs, type Currency, type CurrencyPrefs, type FxReading,
} from '@/lib/betaCurrency';

const REFRESH_MS = 60 * 60 * 1000;

type Listener = () => void;
const listeners = new Set<Listener>();
let prefs: CurrencyPrefs = (() => {
  try { return parseCurrencyPrefs(window.localStorage.getItem(CURRENCY_KEY)); } catch { return parseCurrencyPrefs(null); }
})();

function setPrefs(next: CurrencyPrefs): void {
  prefs = next;
  try { window.localStorage.setItem(CURRENCY_KEY, JSON.stringify(next)); } catch { /* private window: this session keeps it */ }
  listeners.forEach((l) => l());
}
const subscribe = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };
const getPrefs = () => prefs;

export function setCurrencyBase(base: Currency): void {
  // Picking the other side's currency swaps the pair rather than making it 1:1.
  setPrefs(base === prefs.quote ? { ...prefs, base, quote: prefs.base } : { ...prefs, base });
}
export function setCurrencyQuote(quote: Currency): void {
  setPrefs(quote === prefs.base ? { ...prefs, quote, base: prefs.quote } : { ...prefs, quote });
}
export function swapCurrencies(): void {
  setPrefs({ ...prefs, base: prefs.quote, quote: prefs.base });
}
export function setCurrencyAmount(amount: number): void {
  setPrefs({ ...prefs, amount: clampAmount(amount) });
}

export function useCurrency() {
  const p = useSyncExternalStore(subscribe, getPrefs, getPrefs);
  const poll = useMemo(
    () =>
      createSharedPoll<FxReading>({
        key: `fx:${p.base}:${p.quote}`,
        fetch: async () => {
          if (!isTauri()) throw new Error('Rates come through the Mac app.');
          const { invoke } = await import('@tauri-apps/api/core');
          return invoke<FxReading>('fetch_fx', { base: p.base, quote: p.quote });
        },
        intervalMs: REFRESH_MS,
      }),
    [p.base, p.quote],
  );
  const snap = useSyncExternalStore(poll.subscribe, poll.getSnapshot, poll.getSnapshot);
  return {
    prefs: p,
    reading: snap.data ?? null,
    isLoading: snap.isLoading,
    error: snap.error,
    refetch: poll.refresh,
  };
}
