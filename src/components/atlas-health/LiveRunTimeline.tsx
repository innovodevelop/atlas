import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Zap, 
  Brain, 
  Wrench, 
  CheckCircle, 
  AlertCircle, 
  Clock,
  ChevronDown,
  ChevronUp,
  Loader2
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDistanceToNow } from 'date-fns';

interface RunStep {
  id: string;
  run_id: string;
  step_index: number;
  kind: string;
  input_json: unknown;
  output_json: unknown;
  model_used: string | null;
  model_tier: string | null;
  tokens_used: number;
  started_at: string;
  finished_at: string | null;
}

interface ActiveRun {
  id: string;
  goal_text: string;
  status: string;
  agent_name?: string;
}

const stepIcons: Record<string, React.ReactNode> = {
  plan: <Brain className="w-4 h-4" />,
  execute: <Zap className="w-4 h-4" />,
  tool_call: <Wrench className="w-4 h-4" />,
  verify: <CheckCircle className="w-4 h-4" />,
};

const tierColors: Record<string, string> = {
  planner: 'text-purple-400 bg-purple-400/10 border-purple-400/30',
  worker: 'text-blue-400 bg-blue-400/10 border-blue-400/30',
  reasoner: 'text-amber-400 bg-amber-400/10 border-amber-400/30',
};

export function LiveRunTimeline() {
  const { user } = useAuth();
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const [steps, setSteps] = useState<RunStep[]>([]);
  const [isExpanded, setIsExpanded] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch active run and its steps
  const fetchActiveRun = useCallback(async () => {
    if (!user) return;
    
    try {
      const { data: runs, error: runsError } = await supabase
        .from('runs')
        .select(`
          id,
          goal_text,
          status,
          agent:agents(name)
        `)
        .eq('user_id', user.id)
        .in('status', ['running', 'pending'])
        .order('created_at', { ascending: false })
        .limit(1);

      if (runsError) throw runsError;

      if (runs && runs.length > 0) {
        const run = runs[0];
        setActiveRun({
          id: run.id,
          goal_text: run.goal_text,
          status: run.status,
          agent_name: (run.agent as { name?: string } | null)?.name,
        });

        // Fetch steps for active run
        const { data: stepsData, error: stepsError } = await supabase
          .from('run_steps')
          .select('*')
          .eq('run_id', run.id)
          .order('step_index', { ascending: true });

        if (stepsError) throw stepsError;
        setSteps(stepsData || []);
      } else {
        setActiveRun(null);
        setSteps([]);
      }
    } catch (error) {
      console.error('Error fetching active run:', error);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchActiveRun();
  }, [fetchActiveRun]);

  // Subscribe to real-time updates for runs
  useEffect(() => {
    if (!user) return;

    const runsChannel = supabase
      .channel('live-runs')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'runs',
          filter: `user_id=eq.${user.id}`
        },
        () => {
          fetchActiveRun();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(runsChannel);
    };
  }, [user, fetchActiveRun]);

  // Subscribe to real-time updates for run_steps when active run exists
  useEffect(() => {
    if (!activeRun) return;

    const stepsChannel = supabase
      .channel(`run-steps-${activeRun.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'run_steps',
          filter: `run_id=eq.${activeRun.id}`
        },
        (payload) => {
          setSteps((prev) => [...prev, payload.new as RunStep]);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'run_steps',
          filter: `run_id=eq.${activeRun.id}`
        },
        (payload) => {
          setSteps((prev) =>
            prev.map((s) => (s.id === payload.new.id ? (payload.new as RunStep) : s))
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(stepsChannel);
    };
  }, [activeRun]);

  if (isLoading) {
    return (
      <div className="glass-card p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-green-400/10">
            <Zap className="w-5 h-5 text-green-400" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">Live Run Timeline</h3>
        </div>
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!activeRun) {
    return (
      <div className="glass-card p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-lg bg-muted">
            <Clock className="w-5 h-5 text-muted-foreground" />
          </div>
          <h3 className="text-lg font-semibold text-foreground">Live Run Timeline</h3>
        </div>
        <div className="text-center py-8">
          <p className="text-sm text-muted-foreground">No active runs</p>
          <p className="text-xs text-muted-foreground mt-1">
            Start an agent run to see live progress
          </p>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      className="glass-card p-6"
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="p-2 rounded-lg bg-green-400/10">
              <Zap className="w-5 h-5 text-green-400" />
            </div>
            <span className="absolute -top-1 -right-1 w-3 h-3 bg-green-400 rounded-full animate-pulse" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-foreground">Live Run Timeline</h3>
            <p className="text-xs text-muted-foreground truncate max-w-[200px]">
              {activeRun.goal_text}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="bg-green-400/10 text-green-400 border-green-400/30">
            {activeRun.agent_name || 'Running'}
          </Badge>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Timeline */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="relative pl-6 space-y-3 max-h-[400px] overflow-y-auto scrollbar-thin">
              {/* Timeline line */}
              <div className="absolute left-2.5 top-0 bottom-0 w-0.5 bg-gradient-to-b from-green-400/50 via-primary/30 to-transparent" />

              {steps.map((step, index) => {
                const isLatest = index === steps.length - 1;
                const isComplete = !!step.finished_at;
                const tierClass = step.model_tier ? tierColors[step.model_tier] : '';

                return (
                  <motion.div
                    key={step.id}
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.3, delay: index * 0.05 }}
                    className={`relative flex items-start gap-3 p-3 rounded-lg transition-colors ${
                      isLatest ? 'bg-primary/10 border border-primary/20' : 'bg-muted/30'
                    }`}
                  >
                    {/* Timeline dot */}
                    <div
                      className={`absolute -left-[22px] w-3 h-3 rounded-full border-2 ${
                        isLatest && !isComplete
                          ? 'bg-green-400 border-green-400 animate-pulse'
                          : isComplete
                          ? 'bg-primary border-primary'
                          : 'bg-muted border-muted-foreground'
                      }`}
                    />

                    {/* Step icon */}
                    <div className={`p-1.5 rounded-md ${isComplete ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
                      {stepIcons[step.kind] || <Zap className="w-4 h-4" />}
                    </div>

                    {/* Step content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium capitalize text-foreground">
                          {step.kind.replace('_', ' ')}
                        </span>
                        {step.model_tier && (
                          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${tierClass}`}>
                            {step.model_tier}
                          </Badge>
                        )}
                        {!isComplete && isLatest && (
                          <Loader2 className="w-3 h-3 animate-spin text-green-400" />
                        )}
                      </div>

                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {step.model_used && (
                          <span className="truncate max-w-[120px]">{step.model_used}</span>
                        )}
                        {step.tokens_used > 0 && (
                          <span>{step.tokens_used.toLocaleString()} tokens</span>
                        )}
                        <span>
                          {formatDistanceToNow(new Date(step.started_at), { addSuffix: true })}
                        </span>
                      </div>

                      {/* Show output preview for completed steps */}
                      {isComplete && step.output_json && (
                        <div className="mt-2 p-2 rounded bg-muted/50 text-xs text-muted-foreground line-clamp-2">
                          {typeof step.output_json === 'string'
                            ? step.output_json
                            : JSON.stringify(step.output_json).slice(0, 100)}
                          ...
                        </div>
                      )}
                    </div>

                    {/* Status indicator */}
                    <div className="flex-shrink-0">
                      {isComplete ? (
                        <CheckCircle className="w-4 h-4 text-green-400" />
                      ) : isLatest ? (
                        <div className="w-4 h-4 rounded-full border-2 border-green-400 border-t-transparent animate-spin" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-muted-foreground" />
                      )}
                    </div>
                  </motion.div>
                );
              })}

              {/* Waiting indicator when no steps yet */}
              {steps.length === 0 && (
                <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Waiting for first step...</span>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
