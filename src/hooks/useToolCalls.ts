import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface ToolCall {
  id: string;
  run_id: string | null;
  step_id: string | null;
  tool_name: string;
  args_json: unknown;
  result_json: unknown;
  status: string;
  cost_estimate: number;
  error_message: string | null;
  requires_approval: boolean;
  sandboxed: boolean;
  created_at: string;
  completed_at: string | null;
}

export function useToolCalls(limit = 20) {
  const { user } = useAuth();
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchToolCalls = useCallback(async () => {
    if (!user) return;
    
    try {
      const { data, error } = await supabase
        .from('tool_calls')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw error;
      
      const typedData = (data || []).map(tc => ({
        ...tc,
        requires_approval: tc.requires_approval || false,
        sandboxed: tc.sandboxed || false,
        cost_estimate: tc.cost_estimate || 0
      }));
      
      setToolCalls(typedData);
    } catch (error) {
      console.error('Error fetching tool calls:', error);
    } finally {
      setIsLoading(false);
    }
  }, [user, limit]);

  useEffect(() => {
    fetchToolCalls();
  }, [fetchToolCalls]);

  // Subscribe to realtime updates
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('tool-calls-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tool_calls',
          filter: `user_id=eq.${user.id}`
        },
        () => {
          fetchToolCalls();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, fetchToolCalls]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'text-green-400';
      case 'failed': return 'text-red-400';
      case 'pending': return 'text-yellow-400';
      case 'running': return 'text-blue-400';
      case 'approved': return 'text-green-400';
      case 'rejected': return 'text-red-400';
      default: return 'text-muted-foreground';
    }
  };

  return {
    toolCalls,
    isLoading,
    fetchToolCalls,
    getStatusColor,
  };
}
