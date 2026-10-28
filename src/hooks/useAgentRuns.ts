import { useState, useEffect, useCallback, useRef } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';

export interface AgentRun {
  id: string;
  agent_id: string;
  status: string;
  goal_text: string;
  cost_estimate: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  tokens_planner: number;
  tokens_worker: number;
  tokens_reasoner: number;
  /** The brain runner's plan, every step with its status (agentRunner.ts `RunPlan`). */
  plan_json?: unknown;
  /** Set while the run is paused; absent on a database the brain has not migrated yet. */
  paused_at?: string | null;
  agent?: {
    name: string;
  };
}

/**
 * How often runs are re-read while one is live. The brain's runner writes
 * through bun:sqlite, which emits no `db:changed`, so without this a working
 * run would look frozen until something else touched the tables.
 */
export const LIVE_RUN_POLL_MS = 4_000;
const LIVE_STATUSES = new Set(['pending', 'planning', 'running', 'verifying']);

export interface RunStep {
  id: string;
  run_id: string;
  step_index: number;
  kind: string;
  input_json: unknown;
  output_json: unknown;
  model_used: string | null;
  model_tier: string | null;
  tokens_used: number;
  started_at: string;
  finished_at: string | null;
}

export function useAgentRuns(limit = 10) {
  const { user } = useAuth();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [activeRun, setActiveRun] = useState<AgentRun | null>(null);
  const [runSteps, setRunSteps] = useState<RunStep[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchRuns = useCallback(async () => {
    // See useAgents: signed out is a finished, empty load — not a pending one.
    if (!user) { setIsLoading(false); return; }

    try {
      // The local shim has no relational embeds (`agent:agents(name)` would be
      // silently dropped) — resolve agent names with a second tiny query.
      const [{ data, error }, { data: agentRows, error: agentsError }] = await Promise.all([
        supabase
          .from('runs')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(limit),
        supabase.from('agents').select('id, name'),
      ]);

      if (error) throw error;
      if (agentsError) throw agentsError;

      const agentNames = new Map<string, string>(
        (agentRows || []).map((a: { id: string; name: string }) => [a.id, a.name])
      );

      const typedData = (data || []).map(run => {
        const name = agentNames.get(run.agent_id);
        return {
          ...run,
          tokens_planner: run.tokens_planner || 0,
          tokens_worker: run.tokens_worker || 0,
          tokens_reasoner: run.tokens_reasoner || 0,
          agent: name != null ? { name } : undefined,
        };
      });
      
      setRuns(typedData);
      
      // Find active run
      const active = typedData.find(r => r.status === 'running' || r.status === 'pending');
      setActiveRun(active || null);
    } catch (error) {
      console.error('Error fetching runs:', error);
    } finally {
      setIsLoading(false);
    }
  }, [user, limit]);

  // The run whose steps are on screen. `runSteps` holds one run at a time, so a
  // reply for a run the user has already left must not overwrite the one they
  // moved to, and a change to `run_steps` re-reads this run and no other.
  const stepsRunId = useRef<string | null>(null);

  const fetchRunSteps = useCallback(async (runId: string) => {
    stepsRunId.current = runId;
    try {
      const { data, error } = await supabase
        .from('run_steps')
        .select('*')
        .eq('run_id', runId)
        .order('step_index', { ascending: true });

      if (error) throw error;
      if (stepsRunId.current === runId) setRunSteps(data || []);
    } catch (error) {
      console.error('Error fetching run steps:', error);
    }
  }, []);

  /** Resolves true once the row is cancelled, false when the write failed (the caller says so). */
  const cancelRun = useCallback(async (runId: string): Promise<boolean> => {
    try {
      const { error } = await supabase
        .from('runs')
        .update({ status: 'cancelled', finished_at: new Date().toISOString() })
        .eq('id', runId);

      if (error) throw error;
      await fetchRuns();
      return true;
    } catch (error) {
      console.error('Error cancelling run:', error);
      return false;
    }
  }, [fetchRuns]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  // While any run is live, follow it: the runs (status, plan progress, pause)
  // and the open run's steps. Skipped while the window is hidden; nothing is
  // polled once every run has ended.
  const anyLive = runs.some((r) => LIVE_STATUSES.has(r.status));
  useEffect(() => {
    if (!user || !anyLive) return;
    const t = window.setInterval(() => {
      if (document.hidden) return;
      void fetchRuns();
      const runId = stepsRunId.current;
      if (runId) void fetchRunSteps(runId);
    }, LIVE_RUN_POLL_MS);
    return () => window.clearInterval(t);
  }, [user, anyLive, fetchRuns, fetchRunSteps]);

  // Subscribe to realtime updates
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('runs-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'runs',
          filter: `user_id=eq.${user.id}`
        },
        () => {
          fetchRuns();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, fetchRuns]);

  // Steps are written while a run works, often without its `runs` row changing,
  // so the open run's steps follow their own table. The local channel ignores
  // filters (every change to the table fires), hence the re-read of one run.
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('run-steps-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'run_steps' }, () => {
        const runId = stepsRunId.current;
        if (runId) void fetchRunSteps(runId);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, fetchRunSteps]);

  return {
    runs,
    activeRun,
    runSteps,
    isLoading,
    fetchRuns,
    fetchRunSteps,
    cancelRun,
  };
}
