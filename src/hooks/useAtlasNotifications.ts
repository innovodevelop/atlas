import { useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useHolographicToast } from '@/hooks/useHolographicToast';

interface NotificationConfig {
  enabled?: boolean;
  soundEnabled?: boolean;
}

export const useAtlasNotifications = (config: NotificationConfig = {}) => {
  const { enabled = true, soundEnabled = false } = config;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { knowledge, research, learning, info } = useHolographicToast();

  // Play notification sound
  const playNotificationSound = useCallback(() => {
    if (soundEnabled && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(() => {});
    }
  }, [soundEnabled]);

  // Show toast notification
  const showNotification = useCallback((
    title: string,
    description: string,
    type: 'knowledge' | 'research' | 'learning' | 'discovery'
  ) => {
    const toastFn = {
      knowledge,
      research,
      learning,
      discovery: info,
    }[type];

    toastFn({ title, description, duration: 5000 });
    playNotificationSound();
  }, [playNotificationSound, knowledge, research, learning, info]);

  useEffect(() => {
    if (!enabled) return;

    // Subscribe to knowledge entries
    const knowledgeChannel = supabase
      .channel('atlas_knowledge_notifications')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'atlas_knowledge_entries' },
        (payload) => {
          // Local realtime events carry no row data (payload.new is null) —
          // skip rather than crash; the dashboards re-query on change.
          const entry = payload.new as {
            topic: string;
            category: string;
            confidence: number;
          } | null;
          if (!entry) return;
          showNotification(
            'New Knowledge Discovered',
            `Topic: ${entry.topic} (${entry.category}) - ${Math.round(entry.confidence * 100)}% confidence`,
            'knowledge'
          );
        }
      )
      .subscribe();

    // Subscribe to research topics
    const researchChannel = supabase
      .channel('atlas_research_notifications')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'atlas_research_topics' },
        (payload) => {
          const topic = payload.new as {
            topic: string;
            status: string;
            findings: unknown;
          } | null;

          if (topic && topic.status === 'completed' && topic.findings) {
            showNotification(
              'Research Complete',
              `Findings available for: ${topic.topic}`,
              'research'
            );
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'atlas_research_topics' },
        (payload) => {
          const topic = payload.new as { topic: string } | null;
          if (!topic) return;
          showNotification(
            'Research Started',
            `Now researching: ${topic.topic}`,
            'research'
          );
        }
      )
      .subscribe();

    // Subscribe to learning sessions
    const learningChannel = supabase
      .channel('atlas_learning_notifications')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'atlas_learning_sessions' },
        (payload) => {
          const session = payload.new as {
            topic: string;
            status: string;
            discoveries: unknown;
          } | null;

          if (session && session.status === 'completed' && session.discoveries) {
            showNotification(
              'Learning Session Complete',
              `New discoveries for: ${session.topic}`,
              'learning'
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(knowledgeChannel);
      supabase.removeChannel(researchChannel);
      supabase.removeChannel(learningChannel);
    };
  }, [enabled, showNotification]);

  return { showNotification };
};
