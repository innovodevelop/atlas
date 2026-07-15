import { useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useDataFetching, UseDataFetchingReturn } from './useDataFetching';

export interface UseSupabaseQueryOptions<T> {
  select?: string;
  orderBy?: { column: string; ascending?: boolean };
  filter?: Record<string, unknown>;
  enabled?: boolean;
  fallbackData?: T[];
  refreshInterval?: number;
  onSuccess?: (data: T[]) => void;
  onError?: (error: Error) => void;
  /** Transform each row before storing */
  transform?: (row: unknown) => T;
}

export function useSupabaseQuery<T>(
  table: string,
  options: UseSupabaseQueryOptions<T> = {}
): UseDataFetchingReturn<T[]> {
  const {
    select = '*',
    orderBy,
    filter,
    transform,
    ...dataFetchingOptions
  } = options;

  // Stabilize filter reference
  const filterKey = useMemo(() => JSON.stringify(filter), [filter]);
  const stableFilter = useMemo(() => filter, [filterKey]);

  const fetcher = useCallback(async (): Promise<T[]> => {
    // Use type assertion to avoid deep type instantiation issues
    const baseQuery = supabase.from(table as any).select(select) as any;
    let query = baseQuery;

    // Apply filters
    if (stableFilter) {
      Object.entries(stableFilter).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          query = query.eq(key, value);
        }
      });
    }

    // Apply ordering
    if (orderBy) {
      query = query.order(orderBy.column, { ascending: orderBy.ascending ?? true });
    }

    const { data, error } = await query;

    if (error) throw error;

    if (transform && data) {
      return (data as unknown[]).map(transform);
    }

    return (data || []) as T[];
  }, [table, select, stableFilter, orderBy, transform]);

  return useDataFetching<T[]>({
    fetcher,
    initialData: [],
    ...dataFetchingOptions,
  });
}
