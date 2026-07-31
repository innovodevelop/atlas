import { useCallback, useMemo } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useDataFetching, UseDataFetchingReturn } from './useDataFetching';

export interface UseEdgeFunctionOptions<T> {
  fallbackData?: T;
  refreshInterval?: number;
  enabled?: boolean;
  onSuccess?: (data: T) => void;
  onError?: (error: Error) => void;
  retryCount?: number;
  /** Transform the response data before storing */
  transform?: (data: unknown) => T;
}

export function useEdgeFunction<T>(
  functionName: string,
  body?: Record<string, unknown>,
  options: UseEdgeFunctionOptions<T> = {}
): UseDataFetchingReturn<T> {
  const { transform, ...dataFetchingOptions } = options;
  
  // Stabilize body reference
  const bodyKey = useMemo(() => JSON.stringify(body), [body]);
  const stableBody = useMemo(() => body, [bodyKey]);

  const fetcher = useCallback(async (): Promise<T> => {
    const { data, error } = await supabase.functions.invoke(functionName, {
      body: stableBody,
    });

    if (error) throw error;
    
    return transform ? transform(data) : data;
  }, [functionName, stableBody, transform]);

  return useDataFetching<T>({
    fetcher,
    ...dataFetchingOptions,
  });
}
