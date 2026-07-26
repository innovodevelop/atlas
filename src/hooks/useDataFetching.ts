import { useState, useEffect, useCallback, useRef } from 'react';
import { isWindowActive } from '@/hooks/useWindowActivity';

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
