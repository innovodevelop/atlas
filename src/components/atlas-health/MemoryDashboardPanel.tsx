import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Brain,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Sparkles,
  Clock,
  TrendingUp,
  RefreshCw,
  Layers,
  Shield,
  Zap,
  GitMerge,
  Eye,
  EyeOff,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { localClient as supabase } from '@/integrations/local/localClient';
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';
import { useToast } from '@/hooks/use-toast';

interface ValidationLog {
  id: string;
  entry_id: string;
  entry_type: string;
  validator_model: string;
  verdict: 'valid' | 'suspicious' | 'fake';
  confidence: number;
  reasoning: string;
  processing_time_ms: number;
  created_at: string;
}

interface SynthesisLog {
  id: string;
  operation_type: string;
  input_count: number;
  output_count: number;
  conflicts_resolved: number;
  insights_extracted: number;
  duration_ms: number;
  created_at: string;
}

interface MemoryStats {
  totalMemories: number;
  validatedCount: number;
  fakeCount: number;
  suspiciousCount: number;
  avgValidationScore: number;
  recentValidations: ValidationLog[];
  recentSynthesis: SynthesisLog[];
}

export function MemoryDashboardPanel() {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunningSync, setIsRunningSync] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const { toast } = useToast();

  const fetchStats = async () => {
    try {
      // Parallel fetch all stats
      const [
        memoriesResult,
        knowledgeResult,
        validationLogsResult,
        synthesisLogsResult,
      ] = await Promise.all([
        supabase.from('ai_memory').select('id, is_validated, is_fake, validation_score'),
        supabase.from('atlas_knowledge_entries').select('id, is_validated, is_fake, validation_score'),
        supabase.from('validation_logs').select('*').order('created_at', { ascending: false }).limit(20),
        supabase.from('memory_synthesis_logs').select('*').order('created_at', { ascending: false }).limit(10),
      ]);

      const memories = memoriesResult.data || [];
      const knowledge = knowledgeResult.data || [];
      const allEntries = [...memories, ...knowledge];

      const validatedCount = allEntries.filter(e => e.is_validated).length;
      const fakeCount = allEntries.filter(e => e.is_fake).length;
      const suspiciousCount = allEntries.filter(e => 
        e.is_validated && !e.is_fake && (e.validation_score || 0) < 0.7
      ).length;

      const scores = allEntries.filter(e => e.validation_score).map(e => e.validation_score || 0);
      const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

      setStats({
        totalMemories: allEntries.length,
        validatedCount,
        fakeCount,
        suspiciousCount,
        avgValidationScore: avgScore,
        recentValidations: (validationLogsResult.data || []) as ValidationLog[],
        recentSynthesis: (synthesisLogsResult.data || []) as SynthesisLog[],
      });
    } catch (error) {
      console.error('Failed to fetch memory stats:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, 30000);
    return () => clearInterval(interval);
  }, []);

  const runMemorySynthesis = async (operation: string) => {
    setIsRunningSync(true);
    try {
      // Maintenance runs on the local brain sidecar
      const brain = await getBrainEndpoint();
      if (!brain) throw new Error('Memory maintenance is only available in the desktop app.');
      const res = await fetch(`${brain.baseUrl}/memory/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}`, 'x-sidecar-token': brain.token },
        body: JSON.stringify({ operation }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Maintenance failed');

      toast({
        title: 'Memory Synthesis Complete',
        description: `${operation}: ${data.consolidated || 0} duplicates removed, ${data.insights || 0} insights extracted`,
      });

      fetchStats();
    } catch (error) {
      toast({
        title: 'Synthesis Failed',
        description: error instanceof Error ? error.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setIsRunningSync(false);
    }
  };

  const getVerdictIcon = (verdict: string) => {
    switch (verdict) {
      case 'valid':
        return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
      case 'fake':
        return <XCircle className="w-4 h-4 text-red-400" />;
      default:
        return <AlertTriangle className="w-4 h-4 text-amber-400" />;
    }
  };

  const getVerdictColor = (verdict: string) => {
    switch (verdict) {
      case 'valid':
        return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
      case 'fake':
        return 'bg-red-500/20 text-red-400 border-red-500/30';
      default:
        return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-violet-500/20 to-purple-500/20 flex items-center justify-center">
            <Brain className="w-5 h-5 text-violet-400" />
          </div>
          <div>
            <h3 className="text-lg font-semibold">Memory Core</h3>
            <p className="text-sm text-muted-foreground">Multi-model validation & synthesis</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => runMemorySynthesis('consolidate')}
            disabled={isRunningSync}
            className="backdrop-blur-xl bg-background/40 border-border/30"
          >
            <GitMerge className="w-4 h-4 mr-2" />
            Consolidate
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => runMemorySynthesis('full')}
            disabled={isRunningSync}
            className="backdrop-blur-xl bg-background/40 border-border/30"
          >
            {isRunningSync ? (
              <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Zap className="w-4 h-4 mr-2" />
            )}
            Full Sync
          </Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="p-4 rounded-xl bg-gradient-to-br from-violet-500/10 to-purple-500/10 border border-violet-500/20"
        >
          <div className="flex items-center gap-2 mb-2">
            <Layers className="w-4 h-4 text-violet-400" />
            <span className="text-sm text-muted-foreground">Total Entries</span>
          </div>
          <p className="text-2xl font-bold">{stats?.totalMemories || 0}</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="p-4 rounded-xl bg-gradient-to-br from-emerald-500/10 to-green-500/10 border border-emerald-500/20"
        >
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span className="text-sm text-muted-foreground">Validated</span>
          </div>
          <p className="text-2xl font-bold text-emerald-400">{stats?.validatedCount || 0}</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="p-4 rounded-xl bg-gradient-to-br from-red-500/10 to-rose-500/10 border border-red-500/20"
        >
          <div className="flex items-center gap-2 mb-2">
            <EyeOff className="w-4 h-4 text-red-400" />
            <span className="text-sm text-muted-foreground">Flagged Fake</span>
          </div>
          <p className="text-2xl font-bold text-red-400">{stats?.fakeCount || 0}</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3 }}
          className="p-4 rounded-xl bg-gradient-to-br from-primary/10 to-secondary/10 border border-primary/20"
        >
          <div className="flex items-center gap-2 mb-2">
            <Shield className="w-4 h-4 text-primary" />
            <span className="text-sm text-muted-foreground">Avg Score</span>
          </div>
          <p className="text-2xl font-bold">{((stats?.avgValidationScore || 0) * 100).toFixed(0)}%</p>
        </motion.div>
      </div>

      {/* Validation Confidence Bar */}
      <div className="p-4 rounded-xl bg-background/30 border border-border/30">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm font-medium">Validation Distribution</span>
          <span className="text-xs text-muted-foreground">
            {stats?.validatedCount || 0} / {stats?.totalMemories || 0} validated
          </span>
        </div>
        <div className="flex gap-1 h-3 rounded-full overflow-hidden bg-muted/30">
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${((stats?.validatedCount || 0) / Math.max(stats?.totalMemories || 1, 1)) * 100}%` }}
            className="bg-emerald-500 rounded-l-full"
          />
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${((stats?.suspiciousCount || 0) / Math.max(stats?.totalMemories || 1, 1)) * 100}%` }}
            className="bg-amber-500"
          />
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${((stats?.fakeCount || 0) / Math.max(stats?.totalMemories || 1, 1)) * 100}%` }}
            className="bg-red-500 rounded-r-full"
          />
        </div>
        <div className="flex justify-between mt-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-emerald-500" /> Valid
          </span>
          <span className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-amber-500" /> Suspicious
          </span>
          <span className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-red-500" /> Fake
          </span>
        </div>
      </div>

      {/* Tabs for Validation Logs & Synthesis */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="bg-background/40 border border-border/30">
          <TabsTrigger value="overview" className="data-[state=active]:bg-primary/20">
            <Eye className="w-4 h-4 mr-2" />
            Validations
          </TabsTrigger>
          <TabsTrigger value="synthesis" className="data-[state=active]:bg-secondary/20">
            <Sparkles className="w-4 h-4 mr-2" />
            Synthesis
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <div className="space-y-3 max-h-64 overflow-y-auto">
            <AnimatePresence>
              {stats?.recentValidations.map((log, index) => (
                <motion.div
                  key={log.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="p-3 rounded-lg bg-background/30 border border-border/30 flex items-center gap-3"
                >
                  {getVerdictIcon(log.verdict)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className={getVerdictColor(log.verdict)}>
                        {log.verdict}
                      </Badge>
                      <span className="text-xs text-muted-foreground">{log.validator_model}</span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-1">
                      {log.reasoning?.slice(0, 80)}...
                    </p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    <div>{(log.confidence * 100).toFixed(0)}%</div>
                    <div>{log.processing_time_ms}ms</div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            {(!stats?.recentValidations || stats.recentValidations.length === 0) && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No validation logs yet
              </p>
            )}
          </div>
        </TabsContent>

        <TabsContent value="synthesis" className="mt-4">
          <div className="space-y-3 max-h-64 overflow-y-auto">
            <AnimatePresence>
              {stats?.recentSynthesis.map((log, index) => (
                <motion.div
                  key={log.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.05 }}
                  className="p-3 rounded-lg bg-background/30 border border-border/30"
                >
                  <div className="flex items-center justify-between mb-2">
                    <Badge variant="outline" className="bg-violet-500/20 text-violet-400 border-violet-500/30">
                      {log.operation_type}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {new Date(log.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">Input:</span>{' '}
                      <span className="font-medium">{log.input_count}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Merged:</span>{' '}
                      <span className="font-medium text-amber-400">{log.conflicts_resolved}</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Insights:</span>{' '}
                      <span className="font-medium text-emerald-400">{log.insights_extracted}</span>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            {(!stats?.recentSynthesis || stats.recentSynthesis.length === 0) && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No synthesis logs yet
              </p>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default MemoryDashboardPanel;
