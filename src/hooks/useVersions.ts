import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { localClient as supabase } from '@/integrations/local/localClient';

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
  });
  return { features: data?.features ?? [], changelog: data?.changelog ?? [], isLoading };
}

export function useSyncVersionPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const port = 4830;
      const res = await fetch(`http://127.0.0.1:${port}/admin/versions/sync`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'versions'] });
      qc.invalidateQueries({ queryKey: ['admin', 'version-detail'] });
    },
  });
}
