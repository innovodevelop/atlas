import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface KnowledgeEntry {
  id: string;
  user_id?: string;
  category: string;
  topic: string;
  content: Record<string, unknown>;
  source: string;
  confidence: number;
  relevance_score: number;
  last_accessed?: string;
  access_count: number;
  created_at: string;
  updated_at: string;
}

export const useAtlasKnowledge = () => {
  const [knowledge, setKnowledge] = useState<KnowledgeEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchKnowledge = async () => {
      setIsLoading(true);

      const { data, error } = await supabase
        .from('atlas_knowledge_entries')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(100);

      if (!error && data) {
        setKnowledge(data as KnowledgeEntry[]);
      }
      setIsLoading(false);
    };

    fetchKnowledge();

    // Subscribe to realtime updates
    const channel = supabase
      .channel('atlas_knowledge_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'atlas_knowledge_entries' },
        () => {
          // Local realtime events carry no row data — re-query instead.
          fetchKnowledge();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const categories = useMemo(() => {
    const cats = new Set(knowledge.map(k => k.category));
    return Array.from(cats);
  }, [knowledge]);

  const addKnowledge = async (entry: { topic: string; content: unknown; category?: string; source?: string; confidence?: number; relevance_score?: number }) => {
    const { data: { user } } = await supabase.auth.getUser();
    
    const { error } = await supabase
      .from('atlas_knowledge_entries')
      .insert([{
        topic: entry.topic,
        content: entry.content,
        category: entry.category || 'general',
        source: entry.source || 'conversation',
        confidence: entry.confidence || 0.5,
        relevance_score: entry.relevance_score || 0.5,
        user_id: user?.id,
      }] as never);

    return !error;
  };

  return {
    knowledge,
    isLoading,
    categories,
    addKnowledge,
  };
};
