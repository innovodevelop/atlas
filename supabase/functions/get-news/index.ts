import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse } from "../_shared/cors.ts";

const NEWS_API_KEY = Deno.env.get('NEWS_API_KEY');

// Mock data for when API is not available
const MOCK_NEWS = [
  { 
    id: '1', 
    title: 'AI Breakthrough: New Language Models Show Human-Level Reasoning', 
    source: 'TechCrunch', 
    time: '2h ago', 
    url: 'https://techcrunch.com', 
    trending: true, 
    category: 'Technology' 
  },
  { 
    id: '2', 
    title: 'Global Markets Rally on Positive Economic Data', 
    source: 'Bloomberg', 
    time: '4h ago', 
    url: 'https://bloomberg.com', 
    trending: true, 
    category: 'Finance' 
  },
  { 
    id: '3', 
    title: 'Space Agency Announces New Moon Mission Timeline', 
    source: 'Reuters', 
    time: '6h ago', 
    url: 'https://reuters.com', 
    trending: false, 
    category: 'Science' 
  },
  { 
    id: '4', 
    title: 'Climate Summit Reaches Historic Agreement on Emissions', 
    source: 'BBC', 
    time: '8h ago', 
    url: 'https://bbc.com', 
    trending: true, 
    category: 'World' 
  },
];

const getTimeAgo = (dateStr: string) => {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  
  if (diffHours < 1) return 'Just now';
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  return `${diffDays}d ago`;
};

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { category = 'general' } = await req.json();
    
    // If no API key, return mock data
    if (!NEWS_API_KEY) {
      console.log('No NEWS_API_KEY configured, returning mock data');
      return jsonResponse({ articles: MOCK_NEWS });
    }

    const url = `https://newsapi.org/v2/top-headlines?country=us&category=${category}&pageSize=5&apiKey=${NEWS_API_KEY}`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`News API error: ${response.status}`);
    }

    const data = await response.json();
    
    const articles = data.articles?.map((article: any, index: number) => ({
      id: String(index + 1),
      title: article.title,
      description: article.description || '',
      source: article.source?.name || 'Unknown',
      time: getTimeAgo(article.publishedAt),
      url: article.url,
      trending: index < 2,
      category: category.charAt(0).toUpperCase() + category.slice(1),
    })) || [];

    return jsonResponse({ articles });

  } catch (error) {
    console.error('News function error:', error);
    // Return mock data on error
    return jsonResponse({ articles: MOCK_NEWS });
  }
});
