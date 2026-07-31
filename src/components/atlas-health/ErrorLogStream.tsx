import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, AlertCircle, Info, XCircle, Check, Clock } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { localClient as supabase } from '@/integrations/local/localClient';

interface ErrorLog {
  id: string;
  error_type: string;
  error_message: string;
  stack_trace?: string;
  context?: Record<string, unknown>;
  severity: string;
  resolved: boolean;
  created_at: string;
}

interface ErrorLogStreamProps {
  compact?: boolean;
  limit?: number;
}

const severityConfig: Record<string, { icon: typeof AlertTriangle; color: string; bg: string }> = {
  info: { icon: Info, color: 'text-blue-400', bg: 'bg-blue-500/20' },
  warning: { icon: AlertTriangle, color: 'text-amber-400', bg: 'bg-amber-500/20' },
  error: { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-500/20' },
  critical: { icon: XCircle, color: 'text-red-600', bg: 'bg-red-600/20' },
};

export const ErrorLogStream = ({ compact = false, limit }: ErrorLogStreamProps) => {
  const [errors, setErrors] = useState<ErrorLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [filter, setFilter] = useState<string | null>(null);

  useEffect(() => {
    const fetchErrors = async () => {
      const query = supabase
        .from('atlas_error_logs')
        .select('*')
        .order('created_at', { ascending: false });

      if (limit) {
        query.limit(limit);
      }

      const { data, error } = await query;
      
      if (!error && data) {
        setErrors(data as ErrorLog[]);
      }
      setIsLoading(false);
    };

    fetchErrors();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('atlas_error_logs_changes')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'atlas_error_logs' },
        () => {
          // Local realtime events carry no row data — re-query instead.
          fetchErrors();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [limit]);

  const markResolved = async (id: string) => {
    const { error } = await supabase
      .from('atlas_error_logs')
      .update({ resolved: true })
      .eq('id', id);

    if (!error) {
      setErrors(prev => prev.map(e => e.id === id ? { ...e, resolved: true } : e));
    }
  };

  const filteredErrors = errors.filter(e => !filter || e.severity === filter);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!compact && (
        <div className="flex items-center gap-2">
          {['info', 'warning', 'error', 'critical'].map(sev => {
            const config = severityConfig[sev];
            const Icon = config.icon;
            const count = errors.filter(e => e.severity === sev && !e.resolved).length;
            
            return (
              <Button
                key={sev}
                variant={filter === sev ? 'default' : 'outline'}
                size="sm"
                onClick={() => setFilter(filter === sev ? null : sev)}
                className="flex items-center gap-2"
              >
                <Icon className={`w-4 h-4 ${config.color}`} />
                <span className="capitalize">{sev}</span>
                {count > 0 && (
                  <Badge variant="secondary" className="ml-1">
                    {count}
                  </Badge>
                )}
              </Button>
            );
          })}
        </div>
      )}

      <div className="space-y-2 max-h-[400px] overflow-y-auto scrollbar-thin">
        <AnimatePresence mode="popLayout">
          {filteredErrors.length === 0 ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center py-8 text-muted-foreground"
            >
              <Check className="w-12 h-12 mx-auto mb-4 text-green-500 opacity-50" />
              <p>No errors to display</p>
              <p className="text-sm">System is running smoothly</p>
            </motion.div>
          ) : (
            filteredErrors.map((error, index) => {
              const config = severityConfig[error.severity] || severityConfig.error;
              const Icon = config.icon;
              
              return (
                <motion.div
                  key={error.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 20 }}
                  transition={{ delay: index * 0.03 }}
                  className={`p-4 rounded-xl border transition-colors ${
                    error.resolved 
                      ? 'bg-background/20 border-border/20 opacity-60' 
                      : `${config.bg} border-border/30`
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <Icon className={`w-5 h-5 mt-0.5 ${config.color}`} />
                    
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm">{error.error_type}</span>
                        {error.resolved && (
                          <Badge variant="secondary" className="text-xs">
                            Resolved
                          </Badge>
                        )}
                      </div>
                      
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {error.error_message}
                      </p>
                      
                      <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                        <Clock className="w-3 h-3" />
                        <span>{new Date(error.created_at).toLocaleString()}</span>
                      </div>
                    </div>

                    {!error.resolved && !compact && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => markResolved(error.id)}
                      >
                        <Check className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </motion.div>
              );
            })
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
