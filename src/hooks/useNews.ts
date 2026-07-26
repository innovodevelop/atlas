import { useEdgeFunction } from './useEdgeFunction';

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

export const useNews = (category?: string) => {
  const { data, isLoading, error, refetch } = useEdgeFunction<NewsItem[]>(
    'get-news',
    { category },
    {
      fallbackData: FALLBACK_NEWS,
      refreshInterval: 15 * 60 * 1000, // 15 minutes
      transform: (response) => (response as { articles?: NewsItem[] } | null)?.articles || [],
    }
  );

  return {
    news: data || [],
    isLoading,
    error,
    refetch,
  };
};
