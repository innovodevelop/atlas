/**
 * The Model Lab's measured readings: the brain's model-call ledger for the
 * last thirty days (`GET /admin/model-calls`, services/atlas-brain/src/
 * modelCalls.ts) — usage per model with its list-price cost, p95 latency per
 * lane, and which lane the running brain is actually on.
 *
 * The brain writes atlas.db through bun:sqlite, which never raises the
 * `db:changed` event, so this polls at the admin surfaces' interval like every
 * other /admin/* reader (useAdminApi.ts explains why).
 *
 * Outside the desktop app there is no brain to ask. That is a different fact
 * from "nothing recorded", so the query is off and `available` says why.
 */
import { useQuery } from '@tanstack/react-query';
import { isTauri } from '@/integrations/local/localClient';
import { adminGet, ADMIN_QUERY_OPTIONS, ADMIN_REFETCH_INTERVAL_MS } from '@/hooks/useAdminApi';
import type { ModelCallsSummary } from '@/lib/betaModelLab';

export interface ModelLabReadings {
  available: boolean;
  summary: ModelCallsSummary | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useModelLabReadings(days = 30): ModelLabReadings {
  const available = isTauri();
  const q = useQuery({
    queryKey: ['beta-model-lab', 'model-calls', days],
    enabled: available,
    staleTime: 15_000,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    queryFn: () => adminGet<ModelCallsSummary>(`/admin/model-calls?days=${days}`),
    ...ADMIN_QUERY_OPTIONS,
  });

  return {
    available,
    summary: q.data ?? null,
    loading: available && q.isLoading,
    error: q.error ? (q.error instanceof Error ? q.error.message : String(q.error)) : null,
    reload: () => { void q.refetch(); },
  };
}
