import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { localClient as supabase } from '@/integrations/local/localClient';
import { useEffect, useRef } from "react";
import { useHolographicToast } from "@/hooks/useHolographicToast";
import { isWindowActive } from "@/hooks/useWindowActivity";

interface BudgetSettings {
  id: string;
  daily_budget_usd: number;
  weekly_budget_usd: number;
  alert_threshold_pct: number;
  critical_threshold_pct: number;
  auto_disable_on_limit: boolean;
  alerts_enabled: boolean;
  last_daily_alert_at: string | null;
  last_weekly_alert_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SpendingState {
  dailySpending: number;
  weeklySpending: number;
  dailyBudgetUsedPct: number;
  weeklyBudgetUsedPct: number;
  isApproachingDailyLimit: boolean;
  isApproachingWeeklyLimit: boolean;
  isDailyLimitExceeded: boolean;
  isWeeklyLimitExceeded: boolean;
  isDailyCritical: boolean;
  isWeeklyCritical: boolean;
}

// Cost estimates per 1K tokens by provider
const COST_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  lovable_ai: { input: 0.00025, output: 0.00125 },
  perplexity: { input: 0.001, output: 0.001 },
  openai: { input: 0.01, output: 0.03 },
  anthropic: { input: 0.008, output: 0.024 },
  firecrawl: { input: 0.0001, output: 0.0001 },
};

export function useSpendingAlerts() {
  const queryClient = useQueryClient();
  const toast = useHolographicToast();
  const lastAlertRef = useRef<{ daily: number; weekly: number }>({ daily: 0, weekly: 0 });

  // Fetch budget settings
  const { data: budgetSettings, isLoading: budgetLoading } = useQuery({
    queryKey: ["atlas-budget-settings"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("atlas_budget_settings")
        .select("*")
        .limit(1)
        .single();
      
      if (error) throw error;
      return data as BudgetSettings;
    },
    staleTime: 30000,
  });

  // Fetch provider status for spending calculation
  const { data: providers, isLoading: providersLoading } = useQuery({
    queryKey: ["atlas-provider-status"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("atlas_provider_status")
        .select("*");
      
      if (error) throw error;
      return data;
    },
    refetchInterval: () => (isWindowActive() ? 60000 : false), // Refresh every minute
  });

  // Calculate current spending
  const calculateSpending = (): SpendingState => {
    if (!providers || !budgetSettings) {
      return {
        dailySpending: 0,
        weeklySpending: 0,
        dailyBudgetUsedPct: 0,
        weeklyBudgetUsedPct: 0,
        isApproachingDailyLimit: false,
        isApproachingWeeklyLimit: false,
        isDailyLimitExceeded: false,
        isWeeklyLimitExceeded: false,
        isDailyCritical: false,
        isWeeklyCritical: false,
      };
    }

    // Calculate estimated daily spending from provider stats
    const dailySpending = providers.reduce((total, provider) => {
      const costs = COST_PER_1K_TOKENS[provider.provider] || { input: 0.001, output: 0.001 };
      // Estimate 500 tokens per successful call
      const estimatedCost = (provider.successful_calls || 0) * 500 * (costs.input + costs.output) / 1000;
      return total + estimatedCost;
    }, 0);

    // For weekly, we'd need historical data - for now, estimate based on daily
    const weeklySpending = dailySpending; // In production, sum last 7 days from atlas_usage_history

    const dailyBudgetUsedPct = budgetSettings.daily_budget_usd > 0 
      ? (dailySpending / budgetSettings.daily_budget_usd) * 100 
      : 0;
    
    const weeklyBudgetUsedPct = budgetSettings.weekly_budget_usd > 0 
      ? (weeklySpending / budgetSettings.weekly_budget_usd) * 100 
      : 0;

    return {
      dailySpending,
      weeklySpending,
      dailyBudgetUsedPct,
      weeklyBudgetUsedPct,
      isApproachingDailyLimit: dailyBudgetUsedPct >= budgetSettings.alert_threshold_pct && dailyBudgetUsedPct < 100,
      isApproachingWeeklyLimit: weeklyBudgetUsedPct >= budgetSettings.alert_threshold_pct && weeklyBudgetUsedPct < 100,
      isDailyLimitExceeded: dailyBudgetUsedPct >= 100,
      isWeeklyLimitExceeded: weeklyBudgetUsedPct >= 100,
      isDailyCritical: dailyBudgetUsedPct >= budgetSettings.critical_threshold_pct,
      isWeeklyCritical: weeklyBudgetUsedPct >= budgetSettings.critical_threshold_pct,
    };
  };

  const spendingState = calculateSpending();

  // Update budget settings mutation
  const updateBudgetMutation = useMutation({
    mutationFn: async (updates: Partial<BudgetSettings>) => {
      if (!budgetSettings?.id) throw new Error("No budget settings found");
      
      const { data, error } = await supabase
        .from("atlas_budget_settings")
        .update(updates)
        .eq("id", budgetSettings.id)
        .select()
        .single();
      
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["atlas-budget-settings"] });
      toast.success({ title: "Budget settings updated" });
    },
    onError: (error) => {
      toast.error({ title: "Failed to update budget settings", description: error.message });
    },
  });

  // Trigger alerts when thresholds are crossed
  useEffect(() => {
    if (!budgetSettings?.alerts_enabled) return;
    
    const now = Date.now();
    const ALERT_COOLDOWN = 60000; // 1 minute cooldown between alerts

    // Daily alerts
    if (spendingState.isDailyLimitExceeded && now - lastAlertRef.current.daily > ALERT_COOLDOWN) {
      toast.error({
        title: "Daily Budget Exceeded",
        description: `You've exceeded your daily budget of $${budgetSettings.daily_budget_usd.toFixed(2)}`,
      });
      lastAlertRef.current.daily = now;
    } else if (spendingState.isDailyCritical && !spendingState.isDailyLimitExceeded && now - lastAlertRef.current.daily > ALERT_COOLDOWN) {
      toast.warning({
        title: "Daily Budget Critical",
        description: `You've used ${spendingState.dailyBudgetUsedPct.toFixed(0)}% of your daily budget`,
      });
      lastAlertRef.current.daily = now;
    } else if (spendingState.isApproachingDailyLimit && !spendingState.isDailyCritical && now - lastAlertRef.current.daily > ALERT_COOLDOWN) {
      toast.warning({
        title: "Approaching Daily Budget",
        description: `You've used ${spendingState.dailyBudgetUsedPct.toFixed(0)}% of your daily budget`,
      });
      lastAlertRef.current.daily = now;
    }

    // Weekly alerts
    if (spendingState.isDailyLimitExceeded && now - lastAlertRef.current.weekly > ALERT_COOLDOWN) {
      toast.error({
        title: "Weekly Budget Exceeded",
        description: `You've exceeded your weekly budget of $${budgetSettings.weekly_budget_usd.toFixed(2)}`,
      });
      lastAlertRef.current.weekly = now;
    }
  }, [spendingState, budgetSettings, toast]);

  return {
    budgetSettings,
    isLoading: budgetLoading || providersLoading,
    ...spendingState,
    updateBudgetSettings: updateBudgetMutation.mutate,
    isUpdating: updateBudgetMutation.isPending,
  };
}
