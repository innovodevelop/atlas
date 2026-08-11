import { useState, useEffect, useCallback, useRef } from 'react';
import { isWindowActive } from '@/hooks/useWindowActivity';

/**
 * THE OLD PATH. `src/lib/sharedStore.ts` is the canonical one — reach for it
 * first, and do not add new callers here without a reason you can write down.
 *
 * What is wrong with this hook is structural, not a bug in it: state and timer
 * are per MOUNT, so the cost of a source scales with how many components happen
 * to draw it. `useWeather` is mounted five times on the plain dashboard and was
 * therefore making ten calls to a rate-limited external API and running five
 * 30-minute timers (audit findings C6/C7). `createSharedPoll` replaces that with
 * one module-scoped store per source, read through `useSyncExternalStore`, and
 * `useWeather`/`useStocks`/`useNews` are ported onto it.
 *
 * What is still here, and why:
 *  - `useTasks`, `useNotes`, `useCalendarEvents` — these read the LOCAL SQLite
 *    core, not the network, so the duplicate work is a few in-process calls
 *    rather than API quota. They also each layer `useCrudOperations` and an
 *    `onSuccess` that writes into the caller's own `useState`, which the shared
 *    store deliberately has no equivalent for. Porting them is a separate job
 *    (R2's second half) and is not worth half-doing from another hook's ticket.
 *  - `useEdgeFunction` — the wrapper the three ported hooks used to go through.
 *    It now has ZERO importers and is a deletion candidate; it was left in place
 *    only because this change owns neither that file nor the dead-code pass.
 *
 * The retry/backoff and `isRefetching` machinery below has no equivalent in
 * `createSharedPoll`: nothing that was ported used `retryCount`, and the shared
 * store's background refreshes are silent by design. If a future caller needs
 * retries, add them to the store rather than staying here for them.
 */

export interface UseDataFetchingOptions<T> {
  fetcher: () => Promise<T>;
  initialData?: T | null;
  fallbackData?: T;
  refreshInterval?: number;
  enabled?: boolean;
  onSuccess?: (data: T) => void;
  onError?: (error: Error) => void;
  retryCount?: number;
  retryDelay?: number;
}

export interface UseDataFetchingReturn<T> {
  data: T | null;
  isLoading: boolean;
  isRefetching: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  reset: () => void;
}

export function useDataFetching<T>({
  fetcher,
  initialData = null,
  fallbackData,
  refreshInterval,
  enabled = true,
  onSuccess,
  onError,
  retryCount = 0,
  retryDelay = 1000,
}: UseDataFetchingOptions<T>): UseDataFetchingReturn<T> {
  const [data, setData] = useState<T | null>(initialData);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefetching, setIsRefetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const hasInitialFetch = useRef(false);
  const retryCountRef = useRef(0);

  const fetchData = useCallback(async (isRefetch = false) => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }

    if (isRefetch) {
      setIsRefetching(true);
    } else {
      setIsLoading(true);
    }

    try {
      const result = await fetcher();
      setData(result);
      setError(null);
      retryCountRef.current = 0;
      onSuccess?.(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'An error occurred';
      setError(errorMessage);
      
      // Use fallback data if available
      if (fallbackData !== undefined) {
        setData(fallbackData);
      }
      
      onError?.(err instanceof Error ? err : new Error(errorMessage));
      
      // Retry logic with exponential backoff
      if (retryCountRef.current < retryCount) {
        retryCountRef.current++;
        const delay = retryDelay * Math.pow(2, retryCountRef.current - 1);
        setTimeout(() => fetchData(isRefetch), delay);
        return;
      }
    } finally {
      setIsLoading(false);
      setIsRefetching(false);
    }
  }, [fetcher, enabled, fallbackData, onSuccess, onError, retryCount, retryDelay]);

  const refetch = useCallback(async () => {
    await fetchData(hasInitialFetch.current);
  }, [fetchData]);

  const reset = useCallback(() => {
    setData(initialData);
    setError(null);
    setIsLoading(true);
    setIsRefetching(false);
    hasInitialFetch.current = false;
    retryCountRef.current = 0;
  }, [initialData]);

  // Initial fetch
  useEffect(() => {
    if (enabled) {
      fetchData(false);
      hasInitialFetch.current = true;
    }
  }, [enabled, fetchData]);

  // Refresh interval — skipped while the window is hidden/blurred
  useEffect(() => {
    if (!refreshInterval || !enabled) return;

    const interval = setInterval(() => {
      if (isWindowActive()) fetchData(true);
    }, refreshInterval);

    return () => clearInterval(interval);
  }, [refreshInterval, enabled, fetchData]);

  return {
    data,
    isLoading,
    isRefetching,
    error,
    refetch,
    reset,
  };
}
