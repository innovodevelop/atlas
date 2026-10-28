/**
 * One health metric over time, from the Rust store's `health_series`
 * (newest day first, one row per day). What the Beta Health screen draws its
 * bars and sparklines from; `[]` outside the Mac app, where there is no store.
 */
import { useEffect, useState } from 'react';
import { isTauri } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';

export interface SeriesRow {
  /** YYYY-MM-DD. */
  day: string;
  raw: number;
  /** Already formatted by Rust — "7h 12m", "8,213". */
  value: string;
  unit: string;
  low: number | null;
  high: number | null;
  sampleCount: number;
}

export function useHealthSeries(metric: string, days: number, version: string | null | undefined): { rows: SeriesRow[]; loading: boolean } {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [rows, setRows] = useState<SeriesRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId || !isTauri()) { setRows([]); return; }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const out = await invoke<unknown>('health_series', { userId, metric, days });
        if (cancelled) return;
        setRows(Array.isArray(out) ? (out as SeriesRow[]).filter((r) => r && typeof r.day === 'string' && typeof r.raw === 'number') : []);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId, metric, days, version]);

  return { rows, loading };
}
