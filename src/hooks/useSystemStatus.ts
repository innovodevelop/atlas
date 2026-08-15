import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminGet, adminPost, ADMIN_REFETCH_INTERVAL_MS, ADMIN_QUERY_OPTIONS } from './useAdminApi';

export interface SystemHealthSnapshot {
  health_score: number;
  uptime_seconds: number;
  error_count_24h: number;
  warning_count_24h: number;
  brain_status: 'healthy' | 'degraded' | 'down';
  services: ServiceStatus[];
}

export interface ServiceStatus {
  name: string;
  status: 'healthy' | 'degraded' | 'down';
  latency_ms: number | null;
  last_check: string;
  error?: string;
}

export interface ErrorLogEntry {
  id: string;
  error_type: string;
  error_message: string;
  stack_trace: string | null;
  context: string | null;
  severity: 'critical' | 'error' | 'warning' | 'info';
  resolved: boolean;
  created_at: string;
}

export interface RepairAttempt {
  id: string;
  error_id: string;
  status: 'auditing' | 'proposing' | 'testing' | 'applying' | 'verified' | 'failed' | 'rejected';
  diagnosis: string | null;
  proposed_fix: string | null;
  test_result: string | null;
  test_passed: boolean | null;
  affected_files: string[];
  created_at: string;
  completed_at: string | null;
}

export function useSystemHealth() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'system-health'],
    queryFn: () => adminGet<SystemHealthSnapshot>('/admin/system/health'),
    staleTime: 5_000,
    refetchInterval: 10_000,
    ...ADMIN_QUERY_OPTIONS,
  });
  return { health: data ?? null, isLoading, error: error as Error | null };
}

export function useErrorLogs(limit = 50) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'error-logs', limit],
    queryFn: () => adminGet<ErrorLogEntry[]>(`/admin/system/errors?limit=${limit}`),
    staleTime: 5_000,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    ...ADMIN_QUERY_OPTIONS,
  });
  return { errors: data ?? [], isLoading, error: error as Error | null, refetch };
}

export function useRepairAttempts() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'repair-attempts'],
    queryFn: () => adminGet<RepairAttempt[]>('/admin/system/repairs'),
    staleTime: 10_000,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
    ...ADMIN_QUERY_OPTIONS,
  });
  return { repairs: data ?? [], isLoading, error: error as Error | null };
}

export function useResolveError() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (errorId: string) => adminPost<{ ok: true }>(`/admin/system/errors/${encodeURIComponent(errorId)}/resolve`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'error-logs'] });
      qc.invalidateQueries({ queryKey: ['admin', 'system-health'] });
    },
  });
}

export function useInitiateRepair() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (errorId: string) => adminPost<RepairAttempt>(`/admin/system/errors/${encodeURIComponent(errorId)}/repair`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'repair-attempts'] });
      qc.invalidateQueries({ queryKey: ['admin', 'error-logs'] });
    },
  });
}

export function useScanErrors() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => adminPost<{ scanned: number; new_errors: number }>('/admin/system/scan'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'error-logs'] });
      qc.invalidateQueries({ queryKey: ['admin', 'system-health'] });
    },
  });
}
