import { useState, useEffect, useCallback } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';

export interface Approval {
  id: string;
  run_id: string | null;
  tool_call_id: string;
  status: string;
  action_summary: string;
  reason: string | null;
  risk_level: string | null;
  approved_by: string | null;
  approved_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export function useApprovals() {
  const { user } = useAuth();
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  const fetchApprovals = useCallback(async () => {
    if (!user) return;
    
    try {
      const { data, error } = await supabase
        .from('approvals')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) throw error;
      
      const typedData = (data || []).map(a => ({
        ...a,
        risk_level: a.risk_level || 'medium'
      }));
      
      setApprovals(typedData);
      setPendingCount(typedData.filter(a => a.status === 'pending').length);
    } catch (error) {
      console.error('Error fetching approvals:', error);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const approveRequest = useCallback(async (approvalId: string, reason?: string) => {
    if (!user) return;

    try {
      const { error } = await supabase
        .from('approvals')
        .update({
          status: 'approved',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
          reason: reason || null,
        })
        .eq('id', approvalId);

      if (error) throw error;
      
      // Also update the associated tool call
      const approval = approvals.find(a => a.id === approvalId);
      if (approval) {
        await supabase
          .from('tool_calls')
          .update({ status: 'approved' })
          .eq('id', approval.tool_call_id);
      }
      
      await fetchApprovals();
    } catch (error) {
      console.error('Error approving request:', error);
      throw error;
    }
  }, [user, approvals, fetchApprovals]);

  const rejectRequest = useCallback(async (approvalId: string, reason: string) => {
    if (!user) return;

    try {
      const { error } = await supabase
        .from('approvals')
        .update({
          status: 'rejected',
          approved_by: user.id,
          approved_at: new Date().toISOString(),
          reason,
        })
        .eq('id', approvalId);

      if (error) throw error;
      
      // Also update the associated tool call
      const approval = approvals.find(a => a.id === approvalId);
      if (approval) {
        await supabase
          .from('tool_calls')
          .update({ status: 'rejected' })
          .eq('id', approval.tool_call_id);
      }
      
      await fetchApprovals();
    } catch (error) {
      console.error('Error rejecting request:', error);
      throw error;
    }
  }, [user, approvals, fetchApprovals]);

  useEffect(() => {
    fetchApprovals();
  }, [fetchApprovals]);

  // Subscribe to realtime updates
  useEffect(() => {
    if (!user) return;

    const channel = supabase
      .channel('approvals-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'approvals',
          filter: `user_id=eq.${user.id}`
        },
        () => {
          fetchApprovals();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, fetchApprovals]);

  const getRiskColor = (level: string) => {
    switch (level) {
      case 'high': return 'text-red-400 bg-red-400/10';
      case 'medium': return 'text-yellow-400 bg-yellow-400/10';
      case 'low': return 'text-green-400 bg-green-400/10';
      default: return 'text-muted-foreground bg-muted';
    }
  };

  return {
    approvals,
    pendingCount,
    isLoading,
    fetchApprovals,
    approveRequest,
    rejectRequest,
    getRiskColor,
  };
}
