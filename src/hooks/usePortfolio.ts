import { useCallback, useEffect, useState } from 'react';

// Portfolio data comes from the LOCAL Rust engine (SnapTrade → DuckDB) exposed
// via Tauri commands — never Supabase. In the browser preview there is no Tauri
// backend, so everything degrades to an "available in the desktop app" state.

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface PortfolioSummary {
  total_value: number;
  total_cost: number;
  unrealized_pnl: number;
  unrealized_pct: number;
  cash: number;
  holdings_count: number;
  accounts_count: number;
  currency: string;
}
export interface PortfolioHolding {
  symbol: string; description: string; quantity: number; price: number;
  market_value: number; cost_basis: number; pnl: number; account: string; asset_type: string;
}
export interface HistoryPoint { date: string; value: number }
export interface AllocSlice { label: string; value: number }

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export function usePortfolio() {
  const [available] = useState(isTauri);
  const [hasCredentials, setHasCredentials] = useState(false);
  const [connected, setConnected] = useState(false);
  const [summary, setSummary] = useState<PortfolioSummary | null>(null);
  const [holdings, setHoldings] = useState<PortfolioHolding[]>([]);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [allocation, setAllocation] = useState<AllocSlice[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    if (!isTauri) return;
    try {
      const [s, h, hist, alloc] = await Promise.all([
        invoke<PortfolioSummary>('portfolio_summary'),
        invoke<PortfolioHolding[]>('portfolio_holdings'),
        invoke<HistoryPoint[]>('portfolio_history'),
        invoke<AllocSlice[]>('portfolio_allocation'),
      ]);
      setSummary(s); setHoldings(h); setHistory(hist); setAllocation(alloc);
    } catch (e) {
      console.error('[portfolio] load failed:', e);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!isTauri) return;
    try {
      const st = await invoke<{ has_credentials: boolean; connected: boolean }>('portfolio_status');
      setHasCredentials(st.has_credentials);
      setConnected(st.connected);
      if (st.connected) loadData();
    } catch (e) {
      console.error('[portfolio] status failed:', e);
    }
  }, [loadData]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const sync = useCallback(async () => {
    if (!isTauri) return;
    setIsSyncing(true); setError(null);
    try {
      const s = await invoke<PortfolioSummary>('portfolio_sync');
      setSummary(s);
      await loadData();
      setConnected(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsSyncing(false);
    }
  }, [loadData]);

  // Opens SnapTrade's connection portal in the system browser; the user links
  // their brokerage there, then we poll until holdings appear and sync.
  const connect = useCallback(async () => {
    if (!isTauri) return;
    setIsConnecting(true); setError(null);
    try {
      const url = await invoke<string>('portfolio_connect_url');
      const { openUrl } = await import('@tauri-apps/plugin-opener');
      await openUrl(url);
      // Poll for a completed link for up to 3 minutes, then one sync.
      const started = Date.now();
      const poll = setInterval(async () => {
        try {
          const st = await invoke<{ connected: boolean }>('portfolio_status');
          if (st.connected || Date.now() - started > 3 * 60 * 1000) {
            clearInterval(poll);
            setIsConnecting(false);
            await sync();
          }
        } catch { /* keep polling */ }
      }, 4000);
      // Also allow a manual sync to resolve it sooner.
      setTimeout(() => setIsConnecting(false), 8000);
    } catch (e) {
      setError(String(e));
      setIsConnecting(false);
    }
  }, [sync]);

  const disconnect = useCallback(async () => {
    if (!isTauri) return;
    await invoke('portfolio_disconnect');
    setConnected(false); setSummary(null); setHoldings([]); setHistory([]); setAllocation([]);
  }, []);

  return {
    available, hasCredentials, connected, summary, holdings, history, allocation,
    isSyncing, isConnecting, error, connect, sync, disconnect, refresh: loadData,
  };
}
