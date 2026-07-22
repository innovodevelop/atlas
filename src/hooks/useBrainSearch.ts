import { useState, useMemo, useCallback } from 'react';
import { useDebouncedValue } from './useDebouncedValue';
import { useAtlasKnowledge } from './useAtlasKnowledge';
import { useAtlasResearch } from './useAtlasResearch';
import { getToken } from '@/lib/authClient';
import { getBrainEndpoint } from '@/lib/brainClient';

// Search runs on the local brain sidecar (embed + local recall).
async function brainPost(path: string, body: unknown): Promise<{ data: any; error: any }> {
  const brain = await getBrainEndpoint();
  if (!brain) return { data: null, error: new Error('Search is only available in the desktop app.') };
  try {
    const res = await fetch(`${brain.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken() ?? ''}`, 'x-sidecar-token': brain.token },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return res.ok ? { data, error: null } : { data: null, error: new Error(data.error || 'Search failed') };
  } catch (e) {
    return { data: null, error: e };
  }
}

export type BrainResultType = 'knowledge' | 'research' | 'finding';
export type SearchMode = 'keyword' | 'semantic' | 'hybrid';

export interface BrainSearchResult {
  id: string;
  type: BrainResultType;
  title: string;
  preview: string;
  category?: string;
  confidence?: number;
  status?: string;
  createdAt: string;
  metadata: Record<string, unknown>;
  matchScore: number;
  similarity?: number;
  source?: 'keyword' | 'semantic';
}

export interface BrainSearchOptions {
  types?: BrainResultType[];
  categories?: string[];
  minConfidence?: number;
  limit?: number;
  searchMode?: SearchMode;
}

const highlightMatch = (text: string, query: string): string => {
  if (!query || !text) return text;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  let result = text;
  words.forEach(word => {
    const regex = new RegExp(`(${word})`, 'gi');
    result = result.replace(regex, '**$1**');
  });
  return result;
};

const calculateMatchScore = (item: { title: string; content: string }, query: string): number => {
  if (!query) return 0;
  
  const queryLower = query.toLowerCase();
  const titleLower = item.title.toLowerCase();
  const contentLower = item.content.toLowerCase();
  
  let score = 0;
  
  // Exact title match = highest score
  if (titleLower === queryLower) score += 100;
  else if (titleLower.includes(queryLower)) score += 50;
  
  // Word matches
  const words = queryLower.split(/\s+/).filter(Boolean);
  words.forEach(word => {
    if (titleLower.includes(word)) score += 20;
    if (contentLower.includes(word)) score += 5;
  });
  
  return score;
};

const extractContent = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (typeof content === 'object' && content !== null) {
    const obj = content as Record<string, unknown>;
    // Try common content fields
    if (typeof obj.summary === 'string') return obj.summary;
    if (typeof obj.text === 'string') return obj.text;
    if (typeof obj.description === 'string') return obj.description;
    // Stringify for searching
    return JSON.stringify(content).slice(0, 500);
  }
  return '';
};

export const useBrainSearch = (options: BrainSearchOptions = {}) => {
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>(options.searchMode || 'keyword');
  const [semanticResults, setSemanticResults] = useState<BrainSearchResult[]>([]);
  const [isSemanticSearching, setIsSemanticSearching] = useState(false);
  const debouncedQuery = useDebouncedValue(query, 300);
  
  const { knowledge, isLoading: knowledgeLoading, categories: knowledgeCategories } = useAtlasKnowledge();
  const { topics, isLoading: researchLoading } = useAtlasResearch();
  
  const { types = ['knowledge', 'research', 'finding'], categories, minConfidence = 0, limit = 50 } = options;
  
  const isLoading = knowledgeLoading || researchLoading;
  
  // Keyword search results
  const keywordResults = useMemo(() => {
    if (!debouncedQuery.trim() || searchMode === 'semantic') return [];
    
    const allResults: BrainSearchResult[] = [];
    const queryLower = debouncedQuery.toLowerCase();
    
    // Search knowledge entries
    if (types.includes('knowledge')) {
      knowledge.forEach(entry => {
        const contentStr = extractContent(entry.content);
        const searchableText = `${entry.topic} ${contentStr} ${entry.category}`.toLowerCase();
        
        if (!searchableText.includes(queryLower)) {
          const words = queryLower.split(/\s+/).filter(Boolean);
          const hasMatch = words.some(word => searchableText.includes(word));
          if (!hasMatch) return;
        }
        
        if (categories && categories.length > 0 && !categories.includes(entry.category)) return;
        if (entry.confidence < minConfidence) return;
        
        const matchScore = calculateMatchScore({ title: entry.topic, content: contentStr }, debouncedQuery);
        
        allResults.push({
          id: entry.id,
          type: 'knowledge',
          title: entry.topic,
          preview: highlightMatch(contentStr.slice(0, 200), debouncedQuery),
          category: entry.category,
          confidence: entry.confidence,
          createdAt: entry.created_at,
          source: 'keyword',
          metadata: {
            source: entry.source,
            accessCount: entry.access_count,
            relevanceScore: entry.relevance_score,
          },
          matchScore,
        });
      });
    }
    
    // Search research topics
    if (types.includes('research')) {
      topics.forEach(topic => {
        const searchableText = `${topic.topic} ${topic.description || ''}`.toLowerCase();
        
        if (!searchableText.includes(queryLower)) {
          const words = queryLower.split(/\s+/).filter(Boolean);
          const hasMatch = words.some(word => searchableText.includes(word));
          if (!hasMatch) return;
        }
        
        const matchScore = calculateMatchScore({ 
          title: topic.topic, 
          content: topic.description || '' 
        }, debouncedQuery);
        
        allResults.push({
          id: topic.id,
          type: 'research',
          title: topic.topic,
          preview: highlightMatch(topic.description?.slice(0, 200) || 'No description', debouncedQuery),
          status: topic.status,
          createdAt: topic.created_at,
          source: 'keyword',
          metadata: {
            findings: topic.findings,
            sources: topic.sources,
            depthLevel: topic.depth_level,
          },
          matchScore,
        });
      });
    }
    
    // Search findings within research topics
    if (types.includes('finding')) {
      topics.forEach(topic => {
        const findings = topic.findings as unknown[];
        if (!Array.isArray(findings)) return;
        
        findings.forEach((finding, index) => {
          const findingStr = typeof finding === 'string' 
            ? finding 
            : JSON.stringify(finding);
          
          if (!findingStr.toLowerCase().includes(queryLower)) {
            const words = queryLower.split(/\s+/).filter(Boolean);
            const hasMatch = words.some(word => findingStr.toLowerCase().includes(word));
            if (!hasMatch) return;
          }
          
          const matchScore = calculateMatchScore({ 
            title: `Finding from: ${topic.topic}`, 
            content: findingStr 
          }, debouncedQuery);
          
          allResults.push({
            id: `${topic.id}-finding-${index}`,
            type: 'finding',
            title: `Finding from: ${topic.topic}`,
            preview: highlightMatch(findingStr.slice(0, 200), debouncedQuery),
            createdAt: topic.created_at,
            source: 'keyword',
            metadata: {
              parentTopicId: topic.id,
              parentTopic: topic.topic,
              findingIndex: index,
            },
            matchScore,
          });
        });
      });
    }
    
    return allResults
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, limit);
  }, [debouncedQuery, knowledge, topics, types, categories, minConfidence, limit, searchMode]);
  
  // Semantic search effect
  const runSemanticSearch = useCallback(async (searchQuery: string) => {
    if (!searchQuery.trim()) {
      setSemanticResults([]);
      return;
    }
    
    setIsSemanticSearching(true);
    try {
      const { data, error } = await brainPost('/search', { query: searchQuery, threshold: 0.3, limit });
      
      if (error) {
        console.error('Semantic search error:', error);
        setSemanticResults([]);
        return;
      }
      
      const results: BrainSearchResult[] = (data?.results || []).map((r: Record<string, unknown>) => ({
        id: r.id,
        type: r.type === 'memory' ? 'knowledge' : r.type,
        title: r.title,
        preview: r.preview,
        category: r.category,
        confidence: r.confidence,
        similarity: r.similarity,
        createdAt: r.createdAt,
        source: 'semantic' as const,
        metadata: r.metadata || {},
        matchScore: Math.round((r.similarity || 0) * 100),
      }));
      
      setSemanticResults(results);
    } catch (e) {
      console.error('Semantic search failed:', e);
      setSemanticResults([]);
    } finally {
      setIsSemanticSearching(false);
    }
  }, [limit]);
  
  // Trigger semantic search when query changes and mode is semantic/hybrid
  useMemo(() => {
    if (searchMode === 'semantic' || searchMode === 'hybrid') {
      if (debouncedQuery.trim()) {
        runSemanticSearch(debouncedQuery);
      } else {
        setSemanticResults([]);
      }
    }
  }, [debouncedQuery, searchMode, runSemanticSearch]);
  
  // Combine results based on search mode
  const results = useMemo(() => {
    if (searchMode === 'keyword') {
      return keywordResults;
    }
    
    if (searchMode === 'semantic') {
      return semanticResults;
    }
    
    // Hybrid mode: combine and dedupe
    const combined = new Map<string, BrainSearchResult>();
    
    // Add keyword results
    keywordResults.forEach(r => {
      combined.set(r.id, r);
    });
    
    // Add/merge semantic results
    semanticResults.forEach(r => {
      const existing = combined.get(r.id);
      if (existing) {
        // Boost score for items found by both methods
        existing.matchScore = Math.min(100, existing.matchScore + 20);
        existing.similarity = r.similarity;
      } else {
        combined.set(r.id, r);
      }
    });
    
    return Array.from(combined.values())
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, limit);
  }, [searchMode, keywordResults, semanticResults, limit]);
  
  const allCategories = useMemo(() => {
    const cats = new Set<string>();
    knowledgeCategories.forEach(c => cats.add(c));
    return Array.from(cats).sort();
  }, [knowledgeCategories]);
  
  const resultsByType = useMemo(() => {
    return {
      knowledge: results.filter(r => r.type === 'knowledge'),
      research: results.filter(r => r.type === 'research'),
      finding: results.filter(r => r.type === 'finding'),
    };
  }, [results]);
  
  const clearSearch = useCallback(() => {
    setQuery('');
    setSemanticResults([]);
  }, []);

  // Generate embeddings for new content
  const generateEmbeddings = useCallback(async (batchSize = 10) => {
    try {
      const { data, error } = await brainPost('/embed-backfill', { batchSize });
      if (error) throw error;
      return data;
    } catch (e) {
      console.error('Generate embeddings error:', e);
      throw e;
    }
  }, []);
  
  return {
    query,
    setQuery,
    results,
    resultsByType,
    isLoading: isLoading || isSemanticSearching,
    isSearching: query !== debouncedQuery || isSemanticSearching,
    allCategories,
    totalResults: results.length,
    clearSearch,
    searchMode,
    setSearchMode,
    generateEmbeddings,
    hasSemanticResults: semanticResults.length > 0,
  };
};
