import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface Schedule {
  id: string;
  agent_id: string;
  name: string;
  description: string | null;
  cron_expression: string;
  payload_json: unknown;
  enabled: boolean;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_id: string | null;
  next_run_at: string | null;
  created_at: string;
  agent?: {
    name: string;
  };
}

export function useSchedules() {
  const { user } = useAuth();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const fetchSchedules = useCallback(async () => {
    if (!user) return;
    
    try {
      const { data, error } = await supabase
        .from('schedules')
        .select(`
          *,
          agent:agents(name)
        `)
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) throw error;
      
      const typedData = (data || []).map(s => ({
        ...s,
        enabled: s.enabled ?? true,
        agent: s.agent as { name: string } | undefined
      }));
      
      setSchedules(typedData);
    } catch (error) {
      console.error('Error fetching schedules:', error);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const toggleSchedule = useCallback(async (scheduleId: string, enabled: boolean) => {
    try {
      const { error } = await supabase
        .from('schedules')
        .update({ enabled })
        .eq('id', scheduleId);

      if (error) throw error;
      await fetchSchedules();
    } catch (error) {
      console.error('Error toggling schedule:', error);
      throw error;
    }
  }, [fetchSchedules]);

  const runNow = useCallback(async (scheduleId: string) => {
    if (!user) return;

    try {
      const schedule = schedules.find(s => s.id === scheduleId);
      if (!schedule) throw new Error('Schedule not found');

      // Create a new run from this schedule
      const { data: run, error: runError } = await supabase
        .from('runs')
        .insert({
          user_id: user.id,
          agent_id: schedule.agent_id,
          goal_text: `Scheduled run: ${schedule.name}`,
          status: 'pending',
        })
        .select()
        .single();

      if (runError) throw runError;

      // Update schedule's last run info
      await supabase
        .from('schedules')
        .update({
          last_run_at: new Date().toISOString(),
          last_run_id: run.id,
          last_run_status: 'pending',
        })
        .eq('id', scheduleId);

      await fetchSchedules();
      return run;
    } catch (error) {
      console.error('Error running schedule:', error);
      throw error;
    }
  }, [user, schedules, fetchSchedules]);

  const deleteSchedule = useCallback(async (scheduleId: string) => {
    try {
      const { error } = await supabase
        .from('schedules')
        .delete()
        .eq('id', scheduleId);

      if (error) throw error;
      await fetchSchedules();
    } catch (error) {
      console.error('Error deleting schedule:', error);
      throw error;
    }
  }, [fetchSchedules]);

  useEffect(() => {
    fetchSchedules();
  }, [fetchSchedules]);

  return {
    schedules,
    isLoading,
    fetchSchedules,
    toggleSchedule,
    runNow,
    deleteSchedule,
  };
}
