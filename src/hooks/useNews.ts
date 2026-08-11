import { useMemo, useSyncExternalStore } from 'react';
import { localClient as supabase } from '@/integrations/local/localClient';
import { createSharedPoll } from '@/lib/sharedStore';

export interface NewsItem {
  id: string;
  title: string;
  description?: string;
  source: string;
  time: string;
  url: string;
  category: string;
  trending: boolean;
}

const FALLBACK_NEWS: NewsItem[] = [
  { id: '1', title: 'AI Breakthrough: New Language Models Show Human-Level Reasoning', source: 'TechCrunch', time: '2h ago', url: '#', trending: true, category: 'Technology' },
  { id: '2', title: 'Global Markets Rally on Positive Economic Data', source: 'Bloomberg', time: '4h ago', url: '#', trending: true, category: 'Finance' },
  { id: '3', title: 'Space Agency Announces New Moon Mission Timeline', source: 'Reuters', time: '6h ago', url: '#', trending: false, category: 'Science' },
];

const REFRESH_MS = 15 * 60 * 1000;

// One identity, not a fresh `[]` per render: consumers put `news` in dependency
// arrays.
const NO_NEWS: NewsItem[] = [];

/**
 * ONE fetch per category for the whole app (dashboard card, expanded view,
 * widget catalog, band narration all mount this). See `src/lib/sharedStore.ts`.
 *
 * `news` is never null and the fields are the same as before the shared store —
 * every caller destructures `{ news }` or `{ news, error }` and none of them
 * changed.
 */
export const useNews = (category?: string) => {
  const poll = useMemo(
    () =>
      createSharedPoll<NewsItem[]>({
        // Serialized rather than interpolated so "no category" cannot collide
        // with a real category that happens to be spelled the same way: the key
        // decides who shares a store, so an ambiguous one hands a caller
        // somebody else's headlines.
        key: `news:${JSON.stringify(category ?? null)}`,
        fetch: async () => {
          const { data, error } = await supabase.functions.invoke('get-news', {
            body: { category },
          });
          if (error) throw error;
          return (data as { articles?: NewsItem[] } | null)?.articles || [];
        },
        intervalMs: REFRESH_MS,
      }),
    [category],
  );

  const snap = useSyncExternalStore(poll.subscribe, poll.getSnapshot, poll.getSnapshot);

  return {
    // Exactly the old three-way behaviour: empty while the first fetch is in
    // flight (the card must not flash canned headlines at every launch), the
    // built-in sample if that fetch fails, and — new — the real headlines kept
    // rather than replaced by the sample when a LATER refresh fails.
    news: snap.data ?? (snap.error ? FALLBACK_NEWS : NO_NEWS),
    /** The headlines above are the built-in sample, not news. See useWeather. */
    isFallback: snap.data == null && !!snap.error,
    isLoading: snap.isLoading,
    error: snap.error,
    refetch: poll.refresh,
  };
};
