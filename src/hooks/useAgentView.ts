import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { adminGet, adminPost, ADMIN_REFETCH_INTERVAL_MS, ADMIN_QUERY_OPTIONS } from './useAdminApi';

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

/**
 * The admin interval is right for a surface nobody watches (see useAdminApi).
 * The Beta Agent View is watched — its log is the screen's point — so it asks
 * for a shorter one while the selected session is live. The brain's JSONL
 * watcher re-ingests about two seconds after a transcript changes, so there is
 * fresh data to poll for; react-query still pauses the interval when the
 * window is in the background.
 */
export interface AgentViewPolling {
  /** Milliseconds between refetches; defaults to ADMIN_REFETCH_INTERVAL_MS. */
  refetchMs?: number;
}

/** GET /admin/agent-sessions — backs the "Active Sessions" panel on /agent-view. */
export function useAgentSessions(status?: string, polling: AgentViewPolling = {}) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'agent-sessions', status ?? null],
    queryFn: () => adminGet<AgentSessionRow[]>(`/admin/agent-sessions${status ? `?status=${encodeURIComponent(status)}` : ''}`),
    staleTime: 10_000,
    refetchInterval: polling.refetchMs ?? ADMIN_REFETCH_INTERVAL_MS,
    ...ADMIN_QUERY_OPTIONS,
  });
  return { sessions: data ?? [], isLoading, error: error as Error | null, refetch };
}

/** GET /admin/agent-events/:sessionId — backs the "Event Feed" panel. */
export function useAgentEvents(sessionId: string | null, polling: AgentViewPolling = {}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['admin', 'agent-events', sessionId],
    queryFn: () => adminGet<AgentEventRow[]>(`/admin/agent-events/${encodeURIComponent(sessionId!)}`),
    enabled: !!sessionId,
    staleTime: 5_000,
    refetchInterval: polling.refetchMs ?? ADMIN_REFETCH_INTERVAL_MS,
    ...ADMIN_QUERY_OPTIONS,
  });
  return { events: data ?? [], isLoading, error: error as Error | null };
}

/** POST /admin/ingest-sessions — scan ~/.claude/projects/ and upsert sessions. */
export function useIngestSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => adminPost<{ sessions_upserted: number; events_inserted: number }>('/admin/ingest-sessions'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin', 'agent-sessions'] }); },
  });
}

/**
 * POST /admin/agent-sessions/:id/stop — stop a live session the brain tracks:
 * a CI pipeline is cancelled on GitHub (`gh run cancel`), a self-repair is
 * stopped inside the brain. A Claude Code session is refused (Atlas only reads
 * its transcript). The brain's error text comes back as the thrown message.
 */
export function useStopSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: string) =>
      adminPost<{ ok: true; session_type: string; outcome: string }>(`/admin/agent-sessions/${encodeURIComponent(sessionId)}/stop`),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['admin', 'agent-sessions'] }); },
  });
}

/** What the brain's stop route answers (services/atlas-brain/src/agentRunner.ts `StopResult`). */
export interface StopRunResult {
  ok: true;
  /** False when the run had already ended before the stop arrived. */
  stopped: boolean;
  /** Questions of the run still waiting that the stop closed unanswered. */
  approvalsClosed: number;
  undo?: {
    undone: Array<{ stepId: string; label: string; message: string }>;
    failed: Array<{ stepId: string; label: string; message: string }>;
    cannot: Array<{ stepId: string; label: string; reason: string }>;
  } | 'after-step';
}

/**
 * Pause, resume and stop an agent run. They go to the brain because the
 * brain's runner is what works the run (services/atlas-brain/src/agentRunner.ts):
 * it waits between steps while the run is paused, refuses further calls once
 * it is stopped, and holds the inverses an undo runs. Kept here, beside the
 * other admin calls, rather than in useAgentRuns, which Home also uses — a
 * consumer build has no Agent View and no business carrying its controls.
 * Each throws the brain's error for the caller to show.
 */
export const agentRunControls = {
  pause: (runId: string) => adminPost<{ ok: true }>(`/admin/agent-runs/${encodeURIComponent(runId)}/pause`),
  resume: (runId: string) => adminPost<{ ok: true }>(`/admin/agent-runs/${encodeURIComponent(runId)}/resume`),
  stop: (runId: string, opts: { undo: boolean }) =>
    adminPost<StopRunResult>(`/admin/agent-runs/${encodeURIComponent(runId)}/stop${opts.undo ? '?undo=1' : ''}`),
};

/** POST /admin/ci-runs — fetch GitHub Actions runs and upsert as ci-pipeline sessions. */
export function useSyncCiRuns() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => adminPost<{ synced: number }>('/admin/ci-runs'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['admin', 'agent-sessions'] }); },
  });
}
