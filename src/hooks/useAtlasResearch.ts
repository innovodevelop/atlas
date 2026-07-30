import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';
import { useToast } from '@/hooks/use-toast';

// Research runs on the local brain sidecar.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- brain sidecar returns free-form JSON; `unknown` here would force a cast at every call site without adding safety
async function brainPost(path: string, body: unknown): Promise<{ data: any; error: any }> {
  const brain = await getBrainEndpoint();
  if (!brain) return { data: null, error: new Error('Research is only available in the desktop app.') };
  try {
    const res = await fetch(`${brain.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}`, 'x-sidecar-token': brain.token },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return res.ok ? { data, error: null } : { data: null, error: new Error(data.error || 'Request failed') };
  } catch (e) {
    return { data: null, error: e };
  }
}

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
        () => {
          // Local realtime events carry no row data — re-query instead.
          fetchTopics();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [fetchTopics]);

  const startResearch = useCallback(async (topic: string, _description?: string) => {
    toast({
      title: 'Starting Research',
      description: `Initiating deep research on: ${topic}`,
    });

    // Create and start research on the local brain sidecar
    try {
      const { data, error } = await brainPost('/research', { action: 'create', topic });

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
      // Trigger the research pass on the local brain sidecar
      const { error: resumeError } = await brainPost('/research', { action: 'resume', topicId: id });
      if (resumeError) console.log('Research resume failed:', resumeError);
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
