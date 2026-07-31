import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { BarChart3, Brain, Zap, Lightbulb, TrendingUp, Loader2, DollarSign, AlertTriangle, Settings2, Sparkles } from 'lucide-react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { useAuth } from '@/hooks/useAuth';
import { Badge } from '@/components/ui/badge';
import { useAtlasProviderStatus } from '@/hooks/useAtlasProviderStatus';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { UsageHistoryChart } from './UsageHistoryChart';
import { BudgetSettingsPanel } from './BudgetSettingsPanel';
import { CostOptimizationPanel } from './CostOptimizationPanel';

interface TokenStats {
  planner: number;
  worker: number;
  reasoner: number;
  total: number;
}

interface DailyUsage {
  date: string;
  planner: number;
  worker: number;
  reasoner: number;
}

const COST_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  'lovable_ai': { input: 0.00015, output: 0.0006 },
  'perplexity': { input: 0.001, output: 0.001 },
  'anthropic': { input: 0.003, output: 0.015 },
  'openai': { input: 0.0025, output: 0.01 },
  'jina': { input: 0.0001, output: 0.0001 },
};

const PROVIDER_COLORS: Record<string, string> = {
  'lovable_ai': 'bg-purple-400',
  'perplexity': 'bg-blue-400',
  'anthropic': 'bg-amber-400',
  'openai': 'bg-green-400',
  'jina': 'bg-pink-400',
};

const tierConfig = {
  planner: { label: 'Planner', icon: Brain, color: 'bg-purple-400', textColor: 'text-purple-400' },
  worker: { label: 'Worker', icon: Zap, color: 'bg-blue-400', textColor: 'text-blue-400' },
  reasoner: { label: 'Reasoner', icon: Lightbulb, color: 'bg-amber-400', textColor: 'text-amber-400' },
};

export function ModelUsageAnalytics() {
  const { user } = useAuth();
  const { providers, isLoading: providersLoading } = useAtlasProviderStatus();
  const [timeRange, setTimeRange] = useState<'7d' | '30d' | 'all'>('7d');
  const [stats, setStats] = useState<TokenStats>({ planner: 0, worker: 0, reasoner: 0, total: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'credits' | 'tokens' | 'trends' | 'budget' | 'optimize'>('credits');

  useEffect(() => {
    const fetchStats = async () => {
      if (!user) return;
      setIsLoading(true);
      try {
        let dateFilter = '';
        const now = new Date();
        if (timeRange === '7d') {
          dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        } else if (timeRange === '30d') {
          dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        }

        let query = supabase.from('runs').select('tokens_planner, tokens_worker, tokens_reasoner').eq('user_id', user.id);
        if (dateFilter) query = query.gte('created_at', dateFilter);

        const { data: runs } = await query;
        const aggregated = (runs || []).reduce(
          (acc, run) => ({
            planner: acc.planner + (run.tokens_planner || 0),
            worker: acc.worker + (run.tokens_worker || 0),
            reasoner: acc.reasoner + (run.tokens_reasoner || 0),
          }),
          { planner: 0, worker: 0, reasoner: 0 }
        );
        setStats({ ...aggregated, total: aggregated.planner + aggregated.worker + aggregated.reasoner });
      } finally {
        setIsLoading(false);
      }
    };
    fetchStats();
  }, [user, timeRange]);

  const providerCosts = useMemo(() => {
    return providers.map(provider => {
      const costs = COST_PER_1K_TOKENS[provider.provider] || { input: 0.001, output: 0.001 };
      const estimatedCost = provider.successful_calls * 500 * (costs.input + costs.output) / 1000;
      const successRate = provider.total_calls > 0 ? ((provider.successful_calls / provider.total_calls) * 100).toFixed(1) : '100';
      return { ...provider, estimatedCost, successRate, color: PROVIDER_COLORS[provider.provider] || 'bg-gray-400' };
    });
  }, [providers]);

  const totalEstimatedCost = useMemo(() => providerCosts.reduce((sum, p) => sum + p.estimatedCost, 0), [providerCosts]);
  const totalCalls = useMemo(() => providers.reduce((sum, p) => sum + p.total_calls, 0), [providers]);
  const failedCalls = useMemo(() => providers.reduce((sum, p) => sum + p.failed_calls, 0), [providers]);

  if (isLoading || providersLoading) {
    return (
      <div className="glass-card p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-primary/10"><BarChart3 className="w-5 h-5 text-primary" /></div>
          <h3 className="text-lg font-semibold text-foreground">Model Usage Analytics</h3>
        </div>
        <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      </div>
    );
  }

  return (
    <motion.div className="glass-card p-6" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10"><BarChart3 className="w-5 h-5 text-primary" /></div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">Model Usage Analytics</h3>
            <p className="text-xs text-muted-foreground">Token consumption & estimated costs</p>
          </div>
        </div>
        <Select value={timeRange} onValueChange={(v) => setTimeRange(v as typeof timeRange)}>
          <SelectTrigger className="w-[100px] h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
            <SelectItem value="all">All time</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'credits' | 'tokens' | 'trends' | 'budget' | 'optimize')}>
        <TabsList className="grid w-full grid-cols-5 mb-4">
          <TabsTrigger value="credits" className="text-xs"><DollarSign className="w-3 h-3 mr-1" />Credits</TabsTrigger>
          <TabsTrigger value="tokens" className="text-xs"><Zap className="w-3 h-3 mr-1" />Tokens</TabsTrigger>
          <TabsTrigger value="trends" className="text-xs"><TrendingUp className="w-3 h-3 mr-1" />Trends</TabsTrigger>
          <TabsTrigger value="budget" className="text-xs"><Settings2 className="w-3 h-3 mr-1" />Budget</TabsTrigger>
          <TabsTrigger value="optimize" className="text-xs"><Sparkles className="w-3 h-3 mr-1" />Optimize</TabsTrigger>
        </TabsList>

        <TabsContent value="credits">
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50 text-center">
                <DollarSign className="w-4 h-4 mx-auto text-green-400 mb-1" />
                <p className="text-lg font-bold text-foreground">${totalEstimatedCost.toFixed(3)}</p>
                <p className="text-[10px] text-muted-foreground">Est. Total Cost</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50 text-center">
                <Zap className="w-4 h-4 mx-auto text-blue-400 mb-1" />
                <p className="text-lg font-bold text-foreground">{totalCalls.toLocaleString()}</p>
                <p className="text-[10px] text-muted-foreground">Total API Calls</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50 text-center">
                <AlertTriangle className="w-4 h-4 mx-auto text-red-400 mb-1" />
                <p className="text-lg font-bold text-foreground">{failedCalls}</p>
                <p className="text-[10px] text-muted-foreground">Failed Calls</p>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">Provider Breakdown</p>
              {providerCosts.map(provider => (
                <div key={provider.provider} className="flex items-center justify-between p-3 rounded-lg bg-muted/20">
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${provider.color}`} />
                    <div>
                      <p className="text-sm font-medium text-foreground">{provider.provider.replace('_', ' ').toUpperCase()}</p>
                      <p className="text-xs text-muted-foreground">{provider.total_calls} calls • {provider.successRate}% success</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-medium text-foreground">${provider.estimatedCost.toFixed(3)}</p>
                    <Badge variant={provider.status === 'healthy' ? 'secondary' : 'destructive'} className="text-[10px]">{provider.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="tokens">
          {stats.total === 0 ? (
            <div className="text-center py-8">
              <TrendingUp className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm text-muted-foreground">No token data yet</p>
            </div>
          ) : (
            <>
              <div className="text-center mb-6">
                <p className="text-3xl font-bold text-foreground">{stats.total.toLocaleString()}</p>
                <p className="text-sm text-muted-foreground">Total Tokens</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {(Object.keys(tierConfig) as Array<keyof typeof tierConfig>).map((tier) => {
                  const config = tierConfig[tier];
                  const Icon = config.icon;
                  const value = stats[tier];
                  const pct = stats.total > 0 ? Math.round((value / stats.total) * 100) : 0;
                  return (
                    <div key={tier} className="p-3 rounded-lg bg-muted/30 border border-border/50">
                      <div className="flex items-center gap-2 mb-2">
                        <Icon className={`w-4 h-4 ${config.textColor}`} />
                        <span className="text-xs font-medium text-foreground">{config.label}</span>
                      </div>
                      <p className="text-lg font-semibold text-foreground">{value.toLocaleString()}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                          <motion.div className={`h-full ${config.color}`} initial={{ width: 0 }} animate={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground">{pct}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="trends">
          <UsageHistoryChart />
        </TabsContent>

        <TabsContent value="budget">
          <BudgetSettingsPanel />
        </TabsContent>

        <TabsContent value="optimize">
          <CostOptimizationPanel />
        </TabsContent>
      </Tabs>
    </motion.div>
  );
}