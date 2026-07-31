import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { isWindowActive } from '@/hooks/useWindowActivity';

export type ProviderName = 'lovable_ai' | 'perplexity' | 'anthropic' | 'jina' | 'openai';
export type ProviderStatusType = 'healthy' | 'degraded' | 'error' | 'rate_limited' | 'credits_exhausted' | 'unknown';

export interface ProviderStatus {
  id: string;
  provider: ProviderName;
  status: ProviderStatusType;
  last_success: string | null;
  last_error: string | null;
  error_count: number;
  rate_limit_until: string | null;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  avg_response_time_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface SystemSettings {
  id: string;
  learning_enabled: boolean;
  learning_mode: 'on_demand' | 'scheduled' | 'disabled';
  max_topics_per_session: number;
  max_research_depth: number;
  auto_validation: boolean;
  auto_knowledge_extraction: boolean;
  // Lovable AI control fields
  lovable_ai_enabled: boolean;
  auto_switch_enabled: boolean;
  budget_switch_threshold_pct: number;
  preferred_cheap_provider: string;
  disable_reason: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface LearningLog {
  id: string;
  session_id: string | null;
  user_id: string | null;
  trigger_type: 'voice' | 'text' | 'manual' | 'scheduled';
  intent_detected: string | null;
  topic_requested: string | null;
  topics_learned: number;
  max_topics_allowed: number;
  status: 'started' | 'learning' | 'completed' | 'stopped' | 'error';
  error_message: string | null;
  provider_errors: Record<string, string> | null;
  created_at: string;
  completed_at: string | null;
}

export function useAtlasProviderStatus() {
  const queryClient = useQueryClient();
  const [realtimeProviders, setRealtimeProviders] = useState<ProviderStatus[]>([]);

  // Fetch provider status
  const { data: providers, isLoading: providersLoading } = useQuery({
    queryKey: ['atlas-provider-status'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('atlas_provider_status')
        .select('*')
        .order('provider');

      if (error) throw error;
      return (data || []) as ProviderStatus[];
    },
    // Gated: React Query keeps constant intervals firing even when the
    // window is inactive — that churn heats the Networking process.
    refetchInterval: () => (isWindowActive() ? 30000 : false),
  });

  // Fetch system settings
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['atlas-system-settings'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('atlas_system_settings')
        .select('*, lovable_ai_enabled, auto_switch_enabled, budget_switch_threshold_pct, preferred_cheap_provider, disable_reason, disabled_at')
        .limit(1)
        .single();

      if (error) throw error;
      return data as SystemSettings;
    },
    refetchInterval: () => (isWindowActive() ? 10000 : false),
  });

  // Fetch recent learning logs
  const { data: learningLogs, isLoading: logsLoading } = useQuery({
    queryKey: ['atlas-learning-logs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('atlas_learning_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);

      if (error) throw error;
      return (data || []) as LearningLog[];
    },
    refetchInterval: () => (isWindowActive() ? 15000 : false),
  });

  // Subscribe to realtime updates
  useEffect(() => {
    const channel = supabase
      .channel('atlas-provider-status-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'atlas_provider_status' },
        () => {
          // Local realtime events carry no row data — refetch via react-query.
          queryClient.invalidateQueries({ queryKey: ['atlas-provider-status'] });
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'atlas_system_settings' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['atlas-system-settings'] });
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'atlas_learning_logs' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['atlas-learning-logs'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // Merge realtime updates with fetched data
  const mergedProviders = providers?.map(p => {
    const realtime = realtimeProviders.find(rp => rp.id === p.id);
    return realtime || p;
  }) || [];

  // Toggle learning mutation
  const toggleLearningMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      // The settings table holds a single row; target it by id (the local
      // shim's writes only support .eq() filters — .neq() would be refused).
      if (!settings?.id) throw new Error('System settings not loaded yet');
      const { error } = await supabase
        .from('atlas_system_settings')
        .update({
          learning_enabled: enabled,
          updated_at: new Date().toISOString()
        })
        .eq('id', settings.id);

      if (error) throw error;
      return enabled;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['atlas-system-settings'] });
    },
  });

  // Update settings mutation
  const updateSettingsMutation = useMutation({
    mutationFn: async (updates: Partial<SystemSettings>) => {
      if (!settings?.id) throw new Error('System settings not loaded yet');
      const { error } = await supabase
        .from('atlas_system_settings')
        .update({
          ...updates,
          updated_at: new Date().toISOString()
        })
        .eq('id', settings.id);

      if (error) throw error;
      return updates;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['atlas-system-settings'] });
    },
  });

  // Reset provider mutation
  const resetProviderMutation = useMutation({
    mutationFn: async (provider: ProviderName) => {
      const { error } = await supabase
        .from('atlas_provider_status')
        .update({
          status: 'unknown',
          error_count: 0,
          last_error: null,
          rate_limit_until: null,
          updated_at: new Date().toISOString(),
        })
        .eq('provider', provider);

      if (error) throw error;
      return provider;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['atlas-provider-status'] });
    },
  });

  // Computed values
  const isSystemHealthy = mergedProviders.every(
    p => p.status === 'healthy' || p.status === 'unknown'
  );

  const criticalProvidersDown = mergedProviders.filter(
    p => p.provider === 'lovable_ai' && (p.status === 'error' || p.status === 'credits_exhausted')
  );

  const hasCreditsIssue = mergedProviders.some(p => p.status === 'credits_exhausted');
  const hasRateLimitIssue = mergedProviders.some(p => p.status === 'rate_limited');

  const getProviderStatus = (name: ProviderName) => 
    mergedProviders.find(p => p.provider === name);

  // Lovable AI control computed values
  const lovableAIEnabled = settings?.lovable_ai_enabled ?? true;
  const autoSwitchEnabled = settings?.auto_switch_enabled ?? true;
  
  // Calculate current routing mode
  const calculateRoutingMode = (): 'normal' | 'budget_saving' | 'minimal' | 'disabled' => {
    if (!lovableAIEnabled) return 'disabled';
    // Additional budget-based calculation would require spending data
    return 'normal';
  };

  return {
    // Data
    providers: mergedProviders,
    settings,
    learningLogs,
    
    // Loading states
    isLoading: providersLoading || settingsLoading,
    isLogsLoading: logsLoading,
    
    // Computed
    isSystemHealthy,
    criticalProvidersDown,
    hasCreditsIssue,
    hasRateLimitIssue,
    learningEnabled: settings?.learning_enabled ?? false,
    learningMode: settings?.learning_mode ?? 'disabled',
    
    // Lovable AI control
    lovableAIEnabled,
    autoSwitchEnabled,
    currentRoutingMode: calculateRoutingMode(),
    
    // Helpers
    getProviderStatus,
    
    // Mutations
    toggleLearning: toggleLearningMutation.mutate,
    updateSettings: updateSettingsMutation.mutate,
    resetProvider: resetProviderMutation.mutate,
    
    // Mutation states
    isToggling: toggleLearningMutation.isPending,
    isUpdating: updateSettingsMutation.isPending,
  };
}
