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
  semver?: string;
  created_at: string;
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
        .order('created_at', { ascending: false });
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

/** The app's own build commit, or null when the build didn't record one
 *  (or outside Vite, e.g. under bun test, where the define doesn't exist). */
export const BUILD_COMMIT: string | null =
  typeof __ATLAS_BUILD_COMMIT__ === 'string' && __ATLAS_BUILD_COMMIT__ ? __ATLAS_BUILD_COMMIT__ : null;

const buildQuery = () => (BUILD_COMMIT ? `?build=${BUILD_COMMIT}` : '');

/** Mirrors PlanSyncStatus in services/atlas-brain/src/planSync.ts. */
export interface PlanSyncStatus {
  checkedAt: string;
  repo: string;
  ref: string;
  github: {
    ok: boolean;
    error: string | null;
    headSha: string | null;
    plan: { sha: string; date: string | null; message: string | null } | null;
    applied: boolean;
  };
  local: {
    path: string | null;
    headSha: string | null;
    branch: string | null;
    planDirty: boolean;
    containsPlan: boolean | null;
    behindBy: number | null;
    error: string | null;
  };
  app: { buildSha: string | null; containsPlan: boolean | null; behindBy: number | null };
  githubOnly: { id: string; title: string; github: string; local: string | null }[];
  source: 'github' | 'local' | null;
}

async function brainFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');
  const brain = await getBrainEndpoint();
  if (!brain) throw new Error('Atlas brain is only available in the desktop app.');
  return fetch(`${brain.baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'x-sidecar-token': brain.token },
  });
}

/**
 * Where the roadmap stands across GitHub, this Mac's checkout and the running
 * build. The brain re-checks GitHub every 5 minutes on its own and caches the
 * answer for a minute, so polling here is cheap. A tick that applied a new
 * plan also refreshes the version queries.
 */
export function usePlanSyncStatus() {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['admin', 'plan-sync-status'],
    queryFn: async (): Promise<PlanSyncStatus> => {
      const res = await brainFetch(`/admin/versions/sync-status${buildQuery()}`);
      if (!res.ok) throw new Error(await res.text());
      const status = (await res.json()) as PlanSyncStatus;
      if (status.github.applied) {
        qc.invalidateQueries({ queryKey: ['admin', 'versions'] });
        qc.invalidateQueries({ queryKey: ['admin', 'version-detail'] });
      }
      return status;
    },
    refetchInterval: 60_000,
    ...ADMIN_QUERY_OPTIONS,
  });
}

export function useSyncVersionPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await brainFetch(`/admin/versions/sync${buildQuery()}`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      return res.json() as Promise<{ status: PlanSyncStatus }>;
    },
    onSuccess: (data) => {
      qc.setQueryData(['admin', 'plan-sync-status'], data.status);
      qc.invalidateQueries({ queryKey: ['admin', 'versions'] });
      qc.invalidateQueries({ queryKey: ['admin', 'version-detail'] });
    },
  });
}
