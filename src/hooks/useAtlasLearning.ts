import { useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { localClient as supabase } from '@/integrations/local/localClient';
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';
import { isWindowActive } from '@/hooks/useWindowActivity';

interface BrainRun {
  id: string;
  run_type: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  news_collected: number;
  topics_generated: number;
  research_completed: number;
  entries_validated: number;
  error_message: string | null;
  metrics: Record<string, unknown>;
}

interface QueueItem {
  id: string;
  topic: string;
  source: string;
  status: string;
  priority_score: number;
  category: string | null;
  attempts: number;
  created_at: string;
  scheduled_for: string | null;
  metadata: Record<string, unknown>;
}

interface ValidationLog {
  id: string;
  entry_id: string;
  entry_type: string;
  verdict: string;
  confidence: number;
  validator_model: string;
  reasoning: string | null;
  processing_time_ms: number | null;
  created_at: string;
}

interface LearningMetrics {
  knowledgeVelocity: number; // entries per hour
  researchVelocity: number; // topics per hour
  validationRate: number; // validations per hour
  queueDepth: number;
  processingCount: number;
  successRate: number;
}

export function useAtlasLearning() {
  const queryClient = useQueryClient();
  const [realtimeQueue, setRealtimeQueue] = useState<QueueItem[]>([]);
  const [realtimeRuns, setRealtimeRuns] = useState<BrainRun[]>([]);
  const [realtimeValidations, setRealtimeValidations] = useState<ValidationLog[]>([]);
  const [isTriggering, setIsTriggering] = useState(false);

  // Fetch brain runs
  const { data: brainRuns = [], isLoading: runsLoading } = useQuery({
    queryKey: ['atlas-brain-runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('atlas_brain_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(20);
      
      if (error) throw error;
      return data as BrainRun[];
    },
    refetchInterval: () => (isWindowActive() ? 30000 : false)
  });

  // Fetch research queue
  const { data: researchQueue = [], isLoading: queueLoading } = useQuery({
    queryKey: ['atlas-research-queue'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('atlas_research_queue')
        .select('*')
        .order('priority_score', { ascending: false })
        .limit(50);
      
      if (error) throw error;
      return data as QueueItem[];
    },
    refetchInterval: () => (isWindowActive() ? 15000 : false)
  });

  // Fetch validation logs
  const { data: validationLogs = [], isLoading: validationLoading } = useQuery({
    queryKey: ['atlas-validation-logs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('validation_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(50);
      
      if (error) throw error;
      return data as ValidationLog[];
    },
    refetchInterval: () => (isWindowActive() ? 30000 : false)
  });

  // Calculate learning metrics
  const { data: learningMetrics } = useQuery({
    queryKey: ['atlas-learning-metrics'],
    queryFn: async (): Promise<LearningMetrics> => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      
      // Get knowledge entries in last hour
      const { count: knowledgeCount } = await supabase
        .from('atlas_knowledge_entries')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', oneHourAgo);

      // Get research topics in last hour
      const { count: researchCount } = await supabase
        .from('atlas_research_topics')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', oneHourAgo);

      // Get validations in last hour
      const { count: validationCount } = await supabase
        .from('validation_logs')
        .select('*', { count: 'exact', head: true })
        .gte('created_at', oneHourAgo);

      // Get queue stats
      const { data: queueStats } = await supabase
        .from('atlas_research_queue')
        .select('status')
        .in('status', ['queued', 'processing']);

      const queueDepth = queueStats?.filter(q => q.status === 'queued').length ?? 0;
      const processingCount = queueStats?.filter(q => q.status === 'processing').length ?? 0;

      // Get success rate from recent validations
      const { data: recentValidations } = await supabase
        .from('validation_logs')
        .select('verdict')
        .gte('created_at', oneHourAgo);

      const validCount = recentValidations?.filter(v => v.verdict === 'valid').length ?? 0;
      const totalValidations = recentValidations?.length ?? 1;
      const successRate = Math.round((validCount / totalValidations) * 100);

      return {
        knowledgeVelocity: knowledgeCount ?? 0,
        researchVelocity: researchCount ?? 0,
        validationRate: validationCount ?? 0,
        queueDepth,
        processingCount,
        successRate
      };
    },
    refetchInterval: () => (isWindowActive() ? 60000 : false)
  });

  // Set up realtime subscriptions
  useEffect(() => {
    // Subscribe to brain runs
    const runsChannel = supabase
      .channel('brain-runs-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'atlas_brain_runs' },
        () => {
          // Local realtime events carry no row data — refetch via react-query.
          queryClient.invalidateQueries({ queryKey: ['atlas-brain-runs'] });
        }
      )
      .subscribe();

    // Subscribe to research queue
    const queueChannel = supabase
      .channel('research-queue-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'atlas_research_queue' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['atlas-research-queue'] });
        }
      )
      .subscribe();

    // Subscribe to validation logs
    const validationChannel = supabase
      .channel('validation-logs-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'validation_logs' },
        () => {
          queryClient.invalidateQueries({ queryKey: ['atlas-validation-logs'] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(runsChannel);
      supabase.removeChannel(queueChannel);
      supabase.removeChannel(validationChannel);
    };
  }, [queryClient]);

  // Merge realtime data with query data
  const mergedRuns = [...realtimeRuns, ...brainRuns].reduce((acc, run) => {
    if (!acc.find(r => r.id === run.id)) acc.push(run);
    return acc;
  }, [] as BrainRun[]).slice(0, 20);

  const mergedQueue = [...realtimeQueue, ...researchQueue].reduce((acc, item) => {
    if (!acc.find(i => i.id === item.id)) acc.push(item);
    return acc;
  }, [] as QueueItem[]).slice(0, 50);

  const mergedValidations = [...realtimeValidations, ...validationLogs].reduce((acc, log) => {
    if (!acc.find(l => l.id === log.id)) acc.push(log);
    return acc;
  }, [] as ValidationLog[]).slice(0, 50);

  // Get current active run
  const activeRun = mergedRuns.find(run => run.status === 'running');
  const lastRun = mergedRuns[0];

  // Trigger brain cycle manually (runs on the local brain sidecar)
  const triggerBrainCycle = useCallback(async () => {
    setIsTriggering(true);
    try {
      const brain = await getBrainEndpoint();
      if (!brain) throw new Error('Learning is only available in the desktop app.');
      const res = await fetch(`${brain.baseUrl}/learning/cycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}`, 'x-sidecar-token': brain.token },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Brain cycle failed');
      // The route returns 200 {ok:false, error} when no AI key is configured —
      // surface that instead of toasting success over a no-op.
      if (data && data.ok === false) throw new Error(data.error || 'Brain cycle failed');

      // Refresh data
      queryClient.invalidateQueries({ queryKey: ['atlas-brain-runs'] });
      queryClient.invalidateQueries({ queryKey: ['atlas-research-queue'] });
      
      return data;
    } catch (error) {
      console.error('Failed to trigger brain cycle:', error);
      throw error;
    } finally {
      setIsTriggering(false);
    }
  }, [queryClient]);

  return {
    // Brain runs
    brainRuns: mergedRuns,
    activeRun,
    lastRun,
    isRunning: !!activeRun,
    
    // Research queue
    researchQueue: mergedQueue,
    queuedCount: mergedQueue.filter(q => q.status === 'queued').length,
    processingCount: mergedQueue.filter(q => q.status === 'processing').length,
    
    // Validations
    validationLogs: mergedValidations,
    
    // Metrics
    learningMetrics: learningMetrics ?? {
      knowledgeVelocity: 0,
      researchVelocity: 0,
      validationRate: 0,
      queueDepth: 0,
      processingCount: 0,
      successRate: 0
    },
    
    // Actions
    triggerBrainCycle,
    isTriggering,
    
    // Loading states
    isLoading: runsLoading || queueLoading || validationLoading
  };
}
