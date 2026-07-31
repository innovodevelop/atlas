import { useState, useEffect, useCallback } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { isWindowActive } from '@/hooks/useWindowActivity';

interface AtlasStats {
  knowledgeCount: number;
  knowledgeTrend?: number;
  activeResearch: number;
  errorRate: number;
  errorTrend?: number;
  healthScore: number;
}

export const useAtlasHealth = () => {
  const [stats, setStats] = useState<AtlasStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchStats = useCallback(async () => {
    setIsLoading(true);

    try {
      // Fetch knowledge count
      const { count: knowledgeCount } = await supabase
        .from('atlas_knowledge_entries')
        .select('*', { count: 'exact', head: true });

      // Fetch active research count
      const { count: activeResearch } = await supabase
        .from('atlas_research_topics')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'researching');

      // Fetch recent errors (last 24 hours)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { count: recentErrors } = await supabase
        .from('atlas_error_logs')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', oneDayAgo)
        .eq('resolved', false);

      // Calculate error rate (errors per 100 operations - simplified)
      const errorRate = recentErrors ? Math.min((recentErrors / 100) * 100, 100) : 0;

      // Health score calculation
      const healthScore = Math.max(0, 100 - errorRate - (activeResearch || 0 > 10 ? 5 : 0));

      setStats({
        knowledgeCount: knowledgeCount || 0,
        activeResearch: activeResearch || 0,
        errorRate: Math.round(errorRate * 10) / 10,
        healthScore: Math.round(healthScore),
      });
    } catch (error) {
      console.error('Error fetching Atlas health stats:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();

    // Refresh stats every 30 seconds — but not while the window is
    // hidden/blurred (background polling is wasted work in a desktop app)
    const interval = setInterval(() => {
      if (isWindowActive()) fetchStats();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  return {
    stats,
    isLoading,
    refetch: fetchStats,
  };
};
