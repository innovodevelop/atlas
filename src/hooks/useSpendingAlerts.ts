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
  /**
   * Whether ANY spend was actually recorded for the window. False means Atlas
   * has no usage log to read — NOT that nothing was spent. Every consumer that
   * prints a dollar figure or a percentage must check this first, or it is
   * reporting a measurement it never took.
   */
  hasSpendData: boolean;
  isApproachingDailyLimit: boolean;
  isApproachingWeeklyLimit: boolean;
  isDailyLimitExceeded: boolean;
  isWeeklyLimitExceeded: boolean;
  isDailyCritical: boolean;
  isWeeklyCritical: boolean;
}

interface UsageRow {
  date: string;
  estimated_cost: number | string | null;
}

/**
 * WHERE THE DOLLARS COME FROM — and where they used to come from.
 *
 * This hook previously multiplied `atlas_provider_status.successful_calls` by a
 * literal "estimate 500 tokens per call" and a hardcoded price table for
 * lovable_ai / perplexity / openai / anthropic / firecrawl — four of which this
 * build does not call at all. Every figure it produced was invented twice over,
 * and it fed both the live Budget panel ("$3.40 of $5.00") and a Cost-controls
 * rule that told the user "62% of today's budget is gone". Neither number was a
 * measurement of anything.
 *
 * It now sums `atlas_usage_history.estimated_cost`, the only per-day spend Atlas
 * records. Nothing writes that table today (its writer was a Postgres trigger
 * removed with Supabase; the local Rust layer never replaced it), so the honest
 * answer on every current install is "no spend log" — which `hasSpendData`
 * says, instead of a confident $0.00 or a confident 62%.
 */

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

  // Recorded spend for the last 7 days. `date` is a plain YYYY-MM-DD column.
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const { data: usage, isLoading: usageLoading } = useQuery({
    queryKey: ["atlas-usage-history-window", weekAgo],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("atlas_usage_history")
        .select("date, estimated_cost")
        .gte("date", weekAgo);

      if (error) throw error;
      return (data ?? []) as UsageRow[];
    },
    refetchInterval: () => (isWindowActive() ? 60000 : false), // Refresh every minute
  });

  // Calculate current spending
  const calculateSpending = (): SpendingState => {
    const empty: SpendingState = {
      dailySpending: 0,
      weeklySpending: 0,
      dailyBudgetUsedPct: 0,
      weeklyBudgetUsedPct: 0,
      hasSpendData: false,
      isApproachingDailyLimit: false,
      isApproachingWeeklyLimit: false,
      isDailyLimitExceeded: false,
      isWeeklyLimitExceeded: false,
      isDailyCritical: false,
      isWeeklyCritical: false,
    };

    if (!usage || !budgetSettings) return empty;

    const cost = (r: UsageRow) => Number(r.estimated_cost) || 0;
    const dailySpending = usage.filter((r) => r.date === today).reduce((n, r) => n + cost(r), 0);
    const weeklySpending = usage.reduce((n, r) => n + cost(r), 0);

    // No rows means no log, not a zero bill. Reporting 0% of a budget the app
    // cannot measure is the same lie as reporting 62%.
    if (usage.length === 0) return empty;

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
      hasSpendData: true,
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
    isLoading: budgetLoading || usageLoading,
    ...spendingState,
    updateBudgetSettings: updateBudgetMutation.mutate,
    isUpdating: updateBudgetMutation.isPending,
  };
}
