import { useState, useEffect, useCallback } from 'react';
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
  agent?: {
    name: string;
  };
}

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

  const fetchRunSteps = useCallback(async (runId: string) => {
    try {
      const { data, error } = await supabase
        .from('run_steps')
        .select('*')
        .eq('run_id', runId)
        .order('step_index', { ascending: true });

      if (error) throw error;
      setRunSteps(data || []);
    } catch (error) {
      console.error('Error fetching run steps:', error);
    }
  }, []);

  const cancelRun = useCallback(async (runId: string) => {
    try {
      const { error } = await supabase
        .from('runs')
        .update({ status: 'cancelled', finished_at: new Date().toISOString() })
        .eq('id', runId);

      if (error) throw error;
      await fetchRuns();
    } catch (error) {
      console.error('Error cancelling run:', error);
    }
  }, [fetchRuns]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

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
