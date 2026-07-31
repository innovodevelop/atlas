import { useQuery } from "@tanstack/react-query";
import { localClient as supabase } from '@/integrations/local/localClient';
import { useMemo } from "react";
import { subDays, startOfWeek, format, parseISO } from "date-fns";

interface UsageHistoryEntry {
  id: string;
  date: string;
  provider: string;
  total_calls: number;
  successful_calls: number;
  failed_calls: number;
  estimated_cost: number;
  tokens_used: number;
  created_at: string;
}

interface AggregatedUsage {
  date: string;
  total: number;
  lovable_ai: number;
  perplexity: number;
  openai: number;
  anthropic: number;
  firecrawl: number;
  [key: string]: string | number;
}

export function useUsageHistory(granularity: 'daily' | 'weekly' = 'daily', days: number = 30) {
  const startDate = subDays(new Date(), days);

  const { data: rawHistory, isLoading } = useQuery({
    queryKey: ["atlas-usage-history", days],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("atlas_usage_history")
        .select("*")
        .gte("date", format(startDate, "yyyy-MM-dd"))
        .order("date", { ascending: true });
      
      if (error) throw error;
      return data as UsageHistoryEntry[];
    },
    staleTime: 60000, // Cache for 1 minute
  });

  // Aggregate data by date or week
  const aggregatedHistory = useMemo(() => {
    if (!rawHistory || rawHistory.length === 0) return [];

    const grouped = new Map<string, AggregatedUsage>();

    rawHistory.forEach((entry) => {
      const dateKey = granularity === 'weekly' 
        ? format(startOfWeek(parseISO(entry.date)), "yyyy-MM-dd")
        : entry.date;

      if (!grouped.has(dateKey)) {
        grouped.set(dateKey, {
          date: dateKey,
          total: 0,
          lovable_ai: 0,
          perplexity: 0,
          openai: 0,
          anthropic: 0,
          firecrawl: 0,
        });
      }

      const current = grouped.get(dateKey)!;
      current.total += Number(entry.estimated_cost) || 0;
      
      const providerKey = entry.provider.toLowerCase().replace(/\s+/g, '_');
      if (providerKey in current) {
        (current[providerKey] as number) += Number(entry.estimated_cost) || 0;
      }
    });

    return Array.from(grouped.values()).sort((a, b) => 
      new Date(a.date).getTime() - new Date(b.date).getTime()
    );
  }, [rawHistory, granularity]);

  // Calculate summary statistics
  const stats = useMemo(() => {
    if (!aggregatedHistory.length) {
      return {
        totalSpent: 0,
        avgDailySpend: 0,
        projectedWeeklySpend: 0,
        topProvider: null as string | null,
      };
    }

    const totalSpent = aggregatedHistory.reduce((sum, day) => sum + day.total, 0);
    const avgDailySpend = totalSpent / aggregatedHistory.length;
    const projectedWeeklySpend = avgDailySpend * 7;

    // Find top spending provider
    const providerTotals: Record<string, number> = {};
    aggregatedHistory.forEach((day) => {
      ['lovable_ai', 'perplexity', 'openai', 'anthropic', 'firecrawl'].forEach((provider) => {
        providerTotals[provider] = (providerTotals[provider] || 0) + (day[provider] as number);
      });
    });

    const topProvider = Object.entries(providerTotals)
      .sort(([, a], [, b]) => b - a)[0]?.[0] || null;

    return {
      totalSpent,
      avgDailySpend,
      projectedWeeklySpend,
      topProvider,
    };
  }, [aggregatedHistory]);

  return {
    history: aggregatedHistory,
    isLoading,
    ...stats,
  };
}
