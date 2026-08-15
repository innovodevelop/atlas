import { useQuery } from '@tanstack/react-query';
import { adminGet, ADMIN_REFETCH_INTERVAL_MS, ADMIN_QUERY_OPTIONS } from './useAdminApi';

export interface DesignSyncRow {
  id: string;
  bundle_name: string;
  sha256: string;
  version_id: string | null;
  status: 'received' | 'auditing' | 'implementing' | 'complete' | 'rejected';
  surfaces: string; // JSON array, stored as text
  audit_notes: string | null;
  synced_at: string;
  completed_at: string | null;
}

/** GET /admin/design-syncs — backs the "Design Bundles" panel on /design-sync. */
export function useDesignSyncs() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'design-syncs'],
    queryFn: () => adminGet<DesignSyncRow[]>('/admin/design-syncs'),
    staleTime: 10_000,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    ...ADMIN_QUERY_OPTIONS,
  });
  return { syncs: data ?? [], isLoading, error: error as Error | null, refetch };
}
