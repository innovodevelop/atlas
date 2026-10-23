import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localClient as supabase } from '@/integrations/local/localClient';
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';

// The brain never emits db:changed for its own writes — it hits atlas.db
// directly through bun:sqlite, bypassing the Rust db_* commands that are the
// only source of that event. So there is no realtime channel to subscribe to
// here; polling is the only way this surface learns the brain changed rows
// out from under it. Keep the interval modest — these are admin surfaces,
// not something a user stares at waiting for updates.
const ADMIN_REFETCH_INTERVAL_MS = 30_000;
const ADMIN_QUERY_OPTIONS = { retry: 1, retryDelay: 2_000 } as const;

export interface VersionRow {
  id: string;
  semver: string;
  codename: string | null;
  status: 'planned' | 'in-progress' | 'released' | 'archived';
  target_date: string | null;
  released_at: string | null;
  notes: string | null;
  feature_count: number;
  done_count: number;
  created_at: string;
}

export interface FeatureRow {
  id: string;
  version_id: string;
  title: string;
  description: string | null;
  status: 'planned' | 'in-progress' | 'blocked' | 'done';
  assigned_agent: string | null;
  design_ref: string | null;
  priority: number;
}

export interface ChangelogRow {
  id: string;
  version_id: string | null;
  category: 'added' | 'changed' | 'fixed' | 'removed' | 'security' | 'infrastructure';
  title: string;
  description: string | null;
  related_feature: string | null;
  semver?: string;
  created_at: string;
}

/**
 * The changelog is the git log filed against versions (brain changelog.ts), so
 * a long-lived version holds hundreds of rows. The panel shows the newest.
 */
export const CHANGELOG_PAGE = 50;

/** POST /admin/versions/sync's response. */
export interface SyncPlanResult {
  synced: number;
  features: number;
  /** Changelog rows written, or null when git was unavailable. */
  changelog: number | null;
  changelog_error?: string;
}

export function useVersions() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'versions'],
    queryFn: async (): Promise<VersionRow[]> => {
      const { data, error } = await supabase
        .from('atlas_versions')
        .select('*')
        .order('semver', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as VersionRow[];
    },
    staleTime: 30_000,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    ...ADMIN_QUERY_OPTIONS,
  });
  return { versions: data ?? [], isLoading, error, refetch };
}

export function useVersionDetail(versionId: string | null) {
  const { data, isLoading } = useQuery({
    queryKey: ['admin', 'version-detail', versionId],
    queryFn: async () => {
      if (!versionId) return null;
      const { data: features } = await supabase
        .from('atlas_version_features')
        .select('*')
        .eq('version_id', versionId)
        .order('priority', { ascending: true });
      const { data: changelog } = await supabase
        .from('atlas_changelog')
        .select('*')
        .eq('version_id', versionId)
        .order('created_at', { ascending: false })
        .limit(CHANGELOG_PAGE);
      return {
        features: (features ?? []) as unknown as FeatureRow[],
        changelog: (changelog ?? []) as unknown as ChangelogRow[],
      };
    },
    enabled: !!versionId,
    staleTime: 10_000,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    ...ADMIN_QUERY_OPTIONS,
  });
  return { features: data?.features ?? [], changelog: data?.changelog ?? [], isLoading };
}

export function useSyncVersionPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<SyncPlanResult> => {
      const token = getToken();
      if (!token) {
        throw new Error('Not authenticated');
      }
      const brain = await getBrainEndpoint();
      if (!brain) {
        throw new Error('Atlas brain is only available in the desktop app.');
      }
      const res = await fetch(`${brain.baseUrl}/admin/versions/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-sidecar-token': brain.token,
        },
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'versions'] });
      qc.invalidateQueries({ queryKey: ['admin', 'version-detail'] });
    },
  });
}
