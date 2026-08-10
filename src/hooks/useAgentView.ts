import { useQuery } from '@tanstack/react-query';
import { adminGet, ADMIN_REFETCH_INTERVAL_MS } from './useAdminApi';

export interface AgentSessionRow {
  id: string;
  session_type: 'claude-code' | 'ci-pipeline' | 'autonomous';
  source_id: string | null;
  version_id: string | null;
  feature_id: string | null;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
  task_summary: string | null;
  started_at: string;
  ended_at: string | null;
  metadata: string;
}

export interface AgentEventRow {
  id: string;
  session_id: string;
  event_type: 'file_edit' | 'tool_call' | 'milestone' | 'question' | 'discovery' | 'error' | 'log';
  payload: string;
  ts: string;
}

/** GET /admin/agent-sessions — backs the "Active Sessions" panel on /agent-view. */
export function useAgentSessions(status?: string) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'agent-sessions', status ?? null],
    queryFn: () => adminGet<AgentSessionRow[]>(`/admin/agent-sessions${status ? `?status=${encodeURIComponent(status)}` : ''}`),
    staleTime: 10_000,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
  });
  return { sessions: data ?? [], isLoading, error: error as Error | null, refetch };
}

/** GET /admin/agent-events/:sessionId — backs the "Event Feed" panel. */
export function useAgentEvents(sessionId: string | null) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'agent-events', sessionId],
    queryFn: () => adminGet<AgentEventRow[]>(`/admin/agent-events/${encodeURIComponent(sessionId!)}`),
    enabled: !!sessionId,
    staleTime: 5_000,
    refetchInterval: ADMIN_REFETCH_INTERVAL_MS,
  });
  return { events: data ?? [], isLoading, error: error as Error | null };
}
