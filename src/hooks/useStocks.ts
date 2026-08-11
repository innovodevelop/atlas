import { useMemo, useSyncExternalStore } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { createSharedPoll, type SharedPollSnapshot } from '@/lib/sharedStore';

export interface StockData {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  sparkline: number[];
  open?: number | null;
  high?: number | null;
  low?: number | null;
  prevClose?: number | null;
  marketCap?: number | null;
}

export interface MarketIndex {
  label: string;
  price: number;
  changePercent: number;
}

interface StocksResponse {
  stocks: StockData[];
  indices?: MarketIndex[];
}

const MOCK_STOCKS: StockData[] = [
  { symbol: 'AAPL', name: 'Apple Inc.', price: 189.84, change: 1.24, changePercent: 0.66, sparkline: [65, 70, 68, 72, 75, 73, 78, 82, 80, 85, 83, 88] },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', price: 141.16, change: -0.89, changePercent: -0.63, sparkline: [80, 78, 82, 79, 75, 77, 73, 70, 72, 68, 70, 69] },
  { symbol: 'MSFT', name: 'Microsoft', price: 378.91, change: 4.12, changePercent: 1.10, sparkline: [60, 62, 65, 68, 70, 72, 75, 78, 80, 82, 85, 88] },
  { symbol: 'NVDA', name: 'NVIDIA', price: 495.22, change: 12.55, changePercent: 2.60, sparkline: [45, 50, 55, 58, 62, 68, 72, 78, 82, 88, 92, 95] },
];

const REFRESH_MS = 5 * 60 * 1000;

const EMPTY: StocksResponse = { stocks: [], indices: [] };

// The disabled path (empty watchlist). Both must be frozen module identities:
// `useSyncExternalStore` compares the subscribe function and the snapshot by
// identity, so a fresh arrow per render would resubscribe and re-render forever.
// The snapshot keeps `isLoading` true, which is what the old `enabled: false`
// path did — it never ran a fetch, so it never left its initial loading state.
const NEVER_CHANGES = () => () => {};
const IDLE: SharedPollSnapshot<StocksResponse> = { data: undefined, isLoading: true, error: null };
const IDLE_SNAPSHOT = () => IDLE;

/**
 * ONE fetch per watchlist for the whole app — the dashboard card, the expanded
 * view, the widget catalog and the band narration all mount this. See
 * `src/lib/sharedStore.ts` for why that used to cost four calls and four timers.
 *
 * The key is the symbols IN CALLER ORDER, not sorted. A store's key has to
 * determine its request: sorting would let two callers with the same set in a
 * different order share one store, and then the response order matches only one
 * of them — the other renders its cards in somebody else's order.
 */
export const useStocks = (symbols: string[]) => {
  // Stabilize symbols for memoization
  const symbolsKey = useMemo(() => JSON.stringify(symbols), [symbols]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: callers pass fresh array literals every render; keying on the serialized value is the whole point, depending on `symbols` would defeat the stabilization
  const stableSymbols = useMemo(() => symbols, [symbolsKey]);

  const fallbackData = useMemo(
    () => MOCK_STOCKS.filter(s => stableSymbols.includes(s.symbol)),
    [stableSymbols]
  );

  const fallbackResponse = useMemo<StocksResponse>(
    () => ({ stocks: fallbackData, indices: [] }),
    [fallbackData]
  );

  const poll = useMemo(
    () =>
      createSharedPoll<StocksResponse>({
        key: `stocks:${symbolsKey}`,
        fetch: async () => {
          const { data, error } = await supabase.functions.invoke('get-stocks', {
            body: { symbols: stableSymbols },
          });
          if (error) throw error;
          return (data ?? EMPTY) as StocksResponse;
        },
        intervalMs: REFRESH_MS,
      }),
    [symbolsKey, stableSymbols],
  );

  // An empty watchlist has nothing to ask for. Subscribing anyway would arm a
  // 5-minute timer around a request for no symbols.
  const enabled = stableSymbols.length > 0;
  const snap = useSyncExternalStore(
    enabled ? poll.subscribe : NEVER_CHANGES,
    enabled ? poll.getSnapshot : IDLE_SNAPSHOT,
    enabled ? poll.getSnapshot : IDLE_SNAPSHOT,
  );

  // Exactly the old three-way behaviour: empty while the first fetch is in
  // flight (the card must not flash mock prices at every launch), the built-in
  // sample if that fetch fails, and — new — the real quotes kept rather than
  // replaced by the sample when a LATER refresh fails.
  const value = snap.data ?? (snap.error ? fallbackResponse : EMPTY);

  return {
    stocks: value.stocks ?? EMPTY.stocks,
    indices: value.indices ?? EMPTY.indices,
    /** The rows above are the built-in sample, not quotes. See useWeather. */
    isFallback: snap.data == null && !!snap.error,
    isLoading: snap.isLoading,
    error: snap.error,
    refetch: poll.refresh,
  };
};
