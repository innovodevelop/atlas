import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface ResearchTopic {
  id: string;
  parent_id?: string;
  user_id?: string;
  topic: string;
  description?: string;
  status: string;
  depth_level: number;
  findings: unknown[];
  sources: unknown[];
  priority: number;
  auto_generated: boolean;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export const useAtlasResearch = () => {
  const [topics, setTopics] = useState<ResearchTopic[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  const fetchTopics = useCallback(async () => {
    setIsLoading(true);

    const { data, error } = await supabase
      .from('atlas_research_topics')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (!error && data) {
      setTopics(data as ResearchTopic[]);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    fetchTopics();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('atlas_research_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'atlas_research_topics' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setTopics(prev => [payload.new as ResearchTopic, ...prev]);
          } else if (payload.eventType === 'UPDATE') {
            setTopics(prev => 
              prev.map(t => t.id === payload.new.id ? payload.new as ResearchTopic : t)
            );
          } else if (payload.eventType === 'DELETE') {
            setTopics(prev => prev.filter(t => t.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchTopics]);

  const startResearch = useCallback(async (topic: string, description?: string) => {
    const { data: { user } } = await supabase.auth.getUser();

    toast({
      title: 'Starting Research',
      description: `Initiating deep research on: ${topic}`,
    });

    // Use the edge function to create and start research
    try {
      const { data, error } = await supabase.functions.invoke('atlas-research', {
        body: {
          action: 'create',
          topic,
          description,
          userId: user?.id,
          autoDeepen: true,
          // depth is decided server-side from atlas_system_settings
        },
      });

      if (error) throw error;

      toast({
        title: 'Research Started',
        description: `Atlas is now researching: ${topic}`,
      });

      // Refetch to get the new topic
      fetchTopics();
      return data;
    } catch (e) {
      console.error('Research start failed:', e);
      toast({
        title: 'Error',
        description: 'Failed to start research',
        variant: 'destructive',
      });
      return null;
    }
  }, [toast, fetchTopics]);

  const pauseResearch = useCallback(async (id: string) => {
    const { error } = await supabase
      .from('atlas_research_topics')
      .update({ status: 'paused' })
      .eq('id', id);

    if (!error) {
      toast({
        title: 'Research Paused',
        description: 'You can resume this research later',
      });
    }
  }, [toast]);

  const resumeResearch = useCallback(async (id: string) => {
    const { error } = await supabase
      .from('atlas_research_topics')
      .update({ status: 'researching' })
      .eq('id', id);

    if (!error) {
      // Trigger the research edge function
      try {
        await supabase.functions.invoke('atlas-research', {
          body: { topicId: id, action: 'resume' },
        });
      } catch (e) {
        console.log('Research function not available yet');
      }
    }
  }, []);

  return {
    topics,
    isLoading,
    startResearch,
    pauseResearch,
    resumeResearch,
    refetch: fetchTopics,
  };
};
