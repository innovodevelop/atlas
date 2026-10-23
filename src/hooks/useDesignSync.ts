import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminGet, adminPost, ADMIN_REFETCH_INTERVAL_MS, ADMIN_QUERY_OPTIONS } from './useAdminApi';

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

export interface DesignSyncResult {
  synced: number;
  /** Manifest entries that were not written, with the reason. */
  skipped: string[];
}

/**
 * POST /admin/design-syncs/sync — mirror design/.sync-manifest.json into
 * atlas_design_syncs (brain designSync.ts). The manifest is the source of
 * truth; this only copies it, so syncing twice changes nothing.
 */
export function useSyncDesignManifest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => adminPost<DesignSyncResult>('/admin/design-syncs/sync'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin', 'design-syncs'] }),
  });
}

/** `surfaces` arrives as JSON text; anything malformed reads as none. */
export function parseSurfaces(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}
