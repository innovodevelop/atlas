import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';

export interface WatchlistItem {
  id: string;
  symbol: string;
  name: string | null;
  created_at: string;
}

const DEFAULT_WATCHLIST = [
  { symbol: 'AAPL', name: 'Apple Inc.' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.' },
  { symbol: 'MSFT', name: 'Microsoft Corporation' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation' },
];

export const useWatchlist = () => {
  const { user } = useAuth();
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWatchlist = useCallback(async () => {
    if (!user) return;
    
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('user_watchlist')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;
      
      // If no watchlist exists, create default
      if (!data || data.length === 0) {
        const defaultItems = await Promise.all(
          DEFAULT_WATCHLIST.map(item => 
            supabase
              .from('user_watchlist')
              .insert({ user_id: user.id, symbol: item.symbol, name: item.name })
              .select()
              .single()
          )
        );
        const validItems = defaultItems.filter(r => r.data).map(r => r.data!);
        setWatchlist(validItems);
      } else {
        setWatchlist(data);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error');
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const addSymbol = useCallback(async (symbol: string, name?: string) => {
    if (!user) return null;

    try {
      const { data, error } = await supabase
        .from('user_watchlist')
        .insert({
          user_id: user.id,
          symbol: symbol.toUpperCase(),
          name: name || null,
        })
        .select()
        .single();

      if (error) throw error;
      setWatchlist(prev => [...prev, data]);
      return data;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error');
      return null;
    }
  }, [user]);

  const removeSymbol = useCallback(async (symbol: string) => {
    try {
      const { error } = await supabase
        .from('user_watchlist')
        .delete()
        .eq('symbol', symbol.toUpperCase());

      if (error) throw error;
      setWatchlist(prev => prev.filter(item => item.symbol !== symbol.toUpperCase()));
      return true;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error');
      return false;
    }
  }, []);

  useEffect(() => {
    fetchWatchlist();
  }, [fetchWatchlist]);

  const symbols = useMemo(() => watchlist.map(w => w.symbol), [watchlist]);

  return {
    watchlist,
    symbols,
    isLoading,
    error,
    addSymbol,
    removeSymbol,
    refetch: fetchWatchlist,
  };
};
