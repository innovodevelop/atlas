import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface WorkspaceSettings {
  id: string;
  daily_budget_limit: number;
  daily_run_limit: number;
  daily_tool_call_limit: number;
  auto_approve_low_risk: boolean;
  require_approval_for_risky: boolean;
  settings_json: unknown;
}

export interface UsageStats {
  dailySpent: number;
  runsToday: number;
  toolCallsToday: number;
  budgetPercent: number;
  runsPercent: number;
  toolCallsPercent: number;
}

export function useWorkspaceSettings() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [usage, setUsage] = useState<UsageStats>({
    dailySpent: 0,
    runsToday: 0,
    toolCallsToday: 0,
    budgetPercent: 0,
    runsPercent: 0,
    toolCallsPercent: 0,
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchSettings = useCallback(async () => {
    if (!user) return;
    
    try {
      // Get or create workspace settings
      // eslint-disable-next-line prefer-const -- `data` is reassigned below when creating defaults
      let { data, error } = await supabase
        .from('workspace_settings')
        .select('*')
        .eq('user_id', user.id)
        .single();

      if (error && error.code === 'PGRST116') {
        // No settings exist, create default
        const { data: newData, error: insertError } = await supabase
          .from('workspace_settings')
          .insert({
            user_id: user.id,
            daily_budget_limit: 10.00,
            daily_run_limit: 100,
            daily_tool_call_limit: 500,
          })
          .select()
          .single();

        if (insertError) throw insertError;
        data = newData;
      } else if (error) {
        throw error;
      }

      const typedData: WorkspaceSettings = {
        id: data.id,
        daily_budget_limit: data.daily_budget_limit || 10,
        daily_run_limit: data.daily_run_limit || 100,
        daily_tool_call_limit: data.daily_tool_call_limit || 500,
        auto_approve_low_risk: data.auto_approve_low_risk ?? true,
        require_approval_for_risky: data.require_approval_for_risky ?? true,
        settings_json: data.settings_json || {},
      };

      setSettings(typedData);
    } catch (error) {
      console.error('Error fetching workspace settings:', error);
    }
  }, [user]);

  const fetchUsage = useCallback(async () => {
    if (!user || !settings) return;
    
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayISO = today.toISOString();

      // Get today's runs
      const { data: runsData, error: runsError } = await supabase
        .from('runs')
        .select('cost_estimate')
        .eq('user_id', user.id)
        .gte('created_at', todayISO);

      if (runsError) throw runsError;

      // Get today's tool calls
      const { data: toolCallsData, error: toolCallsError } = await supabase
        .from('tool_calls')
        .select('cost_estimate')
        .eq('user_id', user.id)
        .gte('created_at', todayISO);

      if (toolCallsError) throw toolCallsError;

      const runsToday = runsData?.length || 0;
      const toolCallsToday = toolCallsData?.length || 0;
      const dailySpent = (toolCallsData || []).reduce((sum, tc) => sum + (tc.cost_estimate || 0), 0);

      setUsage({
        dailySpent,
        runsToday,
        toolCallsToday,
        budgetPercent: Math.min(100, (dailySpent / settings.daily_budget_limit) * 100),
        runsPercent: Math.min(100, (runsToday / settings.daily_run_limit) * 100),
        toolCallsPercent: Math.min(100, (toolCallsToday / settings.daily_tool_call_limit) * 100),
      });
    } catch (error) {
      console.error('Error fetching usage:', error);
    } finally {
      setIsLoading(false);
    }
  }, [user, settings]);

  const updateSettings = useCallback(async (updates: Partial<WorkspaceSettings>) => {
    if (!user || !settings) return;

    try {
      const { error } = await supabase
        .from('workspace_settings')
        .update(updates)
        .eq('id', settings.id);

      if (error) throw error;
      await fetchSettings();
    } catch (error) {
      console.error('Error updating settings:', error);
      throw error;
    }
  }, [user, settings, fetchSettings]);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    if (settings) {
      fetchUsage();
    }
  }, [settings, fetchUsage]);

  const healthStatus = useMemo(() => {
    if (!settings) return 'unknown';
    if (usage.budgetPercent >= 90 || usage.runsPercent >= 90) return 'critical';
    if (usage.budgetPercent >= 70 || usage.runsPercent >= 70) return 'warning';
    return 'healthy';
  }, [settings, usage]);

  return {
    settings,
    usage,
    healthStatus,
    isLoading,
    fetchSettings,
    fetchUsage,
    updateSettings,
  };
}
