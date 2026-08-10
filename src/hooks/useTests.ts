import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminGet, adminPost, ADMIN_REFETCH_INTERVAL_MS } from './useAdminApi';

export interface TestSuiteRow {
  id: string;
  name: string;
  description: string | null;
  ci_job: string | null;
  version_id: string | null;
  total_runs: number;
  last_status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | null;
  last_run_at: string | null;
}

export interface TestRunRow {
  id: string;
  suite_id: string;
  version_id: string | null;
  status: 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
  duration_ms: number | null;
  output: string | null;
  error_message: string | null;
  triggered_by: string;
  run_at: string;
}

/** GET /admin/tests/suites — backs the "Test Suites" panel on /tests. */
export function useTestSuites() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'test-suites'],
    queryFn: () => adminGet<TestSuiteRow[]>('/admin/tests/suites'),
    staleTime: 10_000,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
  });
  return { suites: data ?? [], isLoading, error: error as Error | null, refetch };
}

/** GET /admin/tests/runs — used for the run history of a selected suite. */
export function useTestRuns(suiteId: string | null) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'test-runs', suiteId],
    queryFn: () => adminGet<TestRunRow[]>(`/admin/tests/runs${suiteId ? `?suite_id=${encodeURIComponent(suiteId)}` : ''}`),
    enabled: !!suiteId,
    staleTime: 5_000,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
  });
  return { runs: data ?? [], isLoading, error: error as Error | null };
}

/** POST /admin/tests/run/:suiteId — fires a suite off via runTest's CI_JOBS allowlist. */
export function useRunTest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (suiteId: string) => adminPost<{ runId: string; status: string }>(`/admin/tests/run/${encodeURIComponent(suiteId)}`),
    onSuccess: (_data, suiteId) => {
      qc.invalidateQueries({ queryKey: ['admin', 'test-suites'] });
      qc.invalidateQueries({ queryKey: ['admin', 'test-runs', suiteId] });
    },
  });
}

/**
 * POST /admin/tests/discover — globs tests/ and services/*\/src/*.test.ts on
 * the brain side and upserts atlas_test_suites. Invalidates test-suites so
 * the panel picks up newly discovered rows without waiting for the next poll.
 */
export function useDiscoverTests() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => adminPost<{ discovered: number }>('/admin/tests/discover'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'test-suites'] });
    },
  });
}
