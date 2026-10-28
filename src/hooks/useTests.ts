import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminGet, adminPost, ADMIN_REFETCH_INTERVAL_MS, ADMIN_QUERY_OPTIONS } from './useAdminApi';

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
  /**
   * What the run's bun test step reported — counts per file, durations and
   * the coverage figure (services/atlas-brain/src/testReport.ts). Null for a
   * job with no test step, a run still going, or a brain that predates it.
   */
  report?: TestReportRow | null;
}

export interface TestReportRow {
  totals: { pass: number; fail: number; skip: number; todo: number; errors: number; tests: number; files: number; ms: number | null };
  files: Array<{ path: string; pass: number; fail: number; skip: number; todo: number; ms: number; failed: string[] }>;
  coverage: { lines: number | null; funcs: number | null; files: number } | null;
}

/** GET /admin/tests/suites — backs the "Test Suites" panel on /tests. */
export function useTestSuites() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'test-suites'],
    queryFn: () => adminGet<TestSuiteRow[]>('/admin/tests/suites'),
    staleTime: 10_000,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    ...ADMIN_QUERY_OPTIONS,
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
    ...ADMIN_QUERY_OPTIONS,
  });
  return { runs: data ?? [], isLoading, error: error as Error | null };
}

/**
 * GET /admin/tests/runs with no suite — the newest 50 runs across every
 * suite, for the Beta dev tools' durations and log tails. Each row carries
 * up to 20 KB of output, so this does not poll: the page refetches it when a
 * run it was watching finishes.
 */
export function useRecentTestRuns() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'test-runs-recent'],
    queryFn: () => adminGet<TestRunRow[]>('/admin/tests/runs'),
    staleTime: 10_000,
    ...ADMIN_QUERY_OPTIONS,
  });
  return { runs: data ?? [], isLoading, error: error as Error | null, refetch };
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
