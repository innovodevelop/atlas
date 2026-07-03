import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface NewsArticle {
  title: string;
  description: string;
  url: string;
  source: string;
  publishedAt: string;
  category: string;
}

interface ProcessedNews {
  topic: string;
  description: string;
  priority: number;
  source_url: string;
  source_name: string;
  category: string;
}

// News categories to monitor
const NEWS_CATEGORIES = ["general", "technology", "science", "business", "health"];

// Priority scoring based on keywords
const PRIORITY_KEYWORDS: Record<string, number> = {
  "breaking": 0.9,
  "urgent": 0.9,
  "exclusive": 0.85,
  "developing": 0.8,
  "ai": 0.8,
  "artificial intelligence": 0.85,
  "breakthrough": 0.8,
  "discovery": 0.75,
  "research": 0.7,
  "study": 0.65,
  "announces": 0.7,
  "launches": 0.7,
  "reveals": 0.7,
};

function calculatePriority(title: string, description: string): number {
  const text = `${title} ${description}`.toLowerCase();
  let maxPriority = 0.5;

  for (const [keyword, priority] of Object.entries(PRIORITY_KEYWORDS)) {
    if (text.includes(keyword)) {
      maxPriority = Math.max(maxPriority, priority);
    }
  }

  return maxPriority;
}

// Deduplicate news by checking similarity
async function isDuplicate(
  supabase: any,
  topic: string
): Promise<boolean> {
  // Check research queue for similar topics
  const { data: queueItems } = await supabase
    .from("atlas_research_queue")
    .select("topic")
    .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()); // Last 24h

  if (queueItems) {
    const topicLower = topic.toLowerCase();
    for (const item of queueItems) {
      const existingLower = item.topic.toLowerCase();
      // Simple similarity check - if first 50 chars match closely
      if (topicLower.slice(0, 50) === existingLower.slice(0, 50)) {
        return true;
      }
      // Check for significant word overlap
      const topicWords = new Set(topicLower.split(/\s+/).filter((w: string) => w.length > 4));
      const existingWords = new Set(existingLower.split(/\s+/).filter((w: string) => w.length > 4));
      const overlap = [...topicWords].filter(w => existingWords.has(w)).length;
      if (overlap >= 3 && overlap >= topicWords.size * 0.6) {
        return true;
      }
    }
  }

  // Check knowledge entries
  const { data: knowledgeItems } = await supabase
    .from("atlas_knowledge_entries")
    .select("topic")
    .gte("created_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()); // Last 48h

  if (knowledgeItems) {
    const topicLower = topic.toLowerCase();
    for (const item of knowledgeItems) {
      if (item.topic.toLowerCase().includes(topicLower.slice(0, 30))) {
        return true;
      }
    }
  }

  return false;
}

// Fetch news from NewsAPI
async function fetchFromNewsAPI(
  apiKey: string,
  category: string
): Promise<NewsArticle[]> {
  try {
    const url = `https://newsapi.org/v2/top-headlines?country=us&category=${category}&pageSize=10&apiKey=${apiKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.error(`[news-pulse] NewsAPI error for ${category}:`, response.status);
      return [];
    }

    const data = await response.json();
    return (data.articles || []).map((article: any) => ({
      title: article.title,
      description: article.description || "",
      url: article.url,
      source: article.source?.name || "Unknown",
      publishedAt: article.publishedAt,
      category,
    }));
  } catch (error) {
    console.error(`[news-pulse] Error fetching ${category}:`, error);
    return [];
  }
}

// Fetch trending topics from Perplexity
async function fetchTrendingFromPerplexity(
  apiKey: string
): Promise<ProcessedNews[]> {
  try {
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content: "You are a news analyst. Return ONLY a JSON array with no other text.",
          },
          {
            role: "user",
            content: `List the top 5 most important breaking news stories happening right now globally. 
            
            Return a JSON array like this:
            [
              {
                "topic": "headline as research topic",
                "description": "brief explanation",
                "priority": 0.8,
                "category": "technology|science|business|world|health"
              }
            ]`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error("[news-pulse] Perplexity error:", response.status);
      return [];
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "[]";
    const citations = data.citations || [];

    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed.map((item: any, idx: number) => ({
          topic: item.topic,
          description: item.description,
          priority: item.priority || 0.7,
          source_url: citations[idx] || "",
          source_name: "Perplexity Trending",
          category: item.category || "general",
        }));
      }
    } catch (parseError) {
      console.error("[news-pulse] Failed to parse Perplexity response:", parseError);
    }

    return [];
  } catch (error) {
    console.error("[news-pulse] Perplexity fetch error:", error);
    return [];
  }
}

// Scrape article content with Firecrawl
async function scrapeArticleContent(
  firecrawlKey: string,
  url: string
): Promise<string | null> {
  try {
    const response = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${firecrawlKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return data.data?.markdown || data.markdown || null;
  } catch (error) {
    console.error("[news-pulse] Firecrawl error:", error);
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { categories = NEWS_CATEGORIES, scrapeContent = false } = await req.json().catch(() => ({}));

    const NEWS_API_KEY = Deno.env.get("NEWS_API_KEY");
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // News-pulse fed the research queue with up to 20 global topics per run —
    // one of the two engines of the endless-research loop. Disabled unless
    // explicitly re-enabled in settings.
    const { data: settings } = await supabase
      .from("atlas_system_settings")
      .select("global_discovery_enabled")
      .limit(1)
      .maybeSingle();
    if (!settings?.global_discovery_enabled) {
      console.log("[news-pulse] global_discovery_enabled is false, skipping");
      return new Response(
        JSON.stringify({ success: true, disabled: true, newsCollected: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log("[news-pulse] Starting news collection...");
    console.log(`[news-pulse] Providers: NewsAPI=${!!NEWS_API_KEY}, Perplexity=${!!PERPLEXITY_API_KEY}, Firecrawl=${!!FIRECRAWL_API_KEY}`);

    const allNews: ProcessedNews[] = [];

    // Collect from all sources in parallel
    const collectionPromises: Promise<any>[] = [];

    // NewsAPI - fetch from each category in parallel
    if (NEWS_API_KEY) {
      for (const category of categories) {
        collectionPromises.push(
          fetchFromNewsAPI(NEWS_API_KEY, category).then((articles) =>
            articles.map((a) => ({
              topic: a.title,
              description: a.description,
              priority: calculatePriority(a.title, a.description),
              source_url: a.url,
              source_name: a.source,
              category: a.category,
            }))
          )
        );
      }
    }

    // Perplexity trending
    if (PERPLEXITY_API_KEY) {
      collectionPromises.push(fetchTrendingFromPerplexity(PERPLEXITY_API_KEY));
    }

    const results = await Promise.all(collectionPromises);
    for (const newsItems of results) {
      if (Array.isArray(newsItems)) {
        allNews.push(...newsItems);
      }
    }

    console.log(`[news-pulse] Collected ${allNews.length} raw news items`);

    // Deduplicate and filter
    const uniqueNews: ProcessedNews[] = [];
    for (const news of allNews) {
      // Skip items with empty or very short titles
      if (!news.topic || news.topic.length < 20) continue;
      
      // Skip removed/error articles
      if (news.topic.toLowerCase().includes("[removed]")) continue;

      const isDupe = await isDuplicate(supabase, news.topic);
      if (!isDupe) {
        uniqueNews.push(news);
      }
    }

    console.log(`[news-pulse] ${uniqueNews.length} unique news items after deduplication`);

    // Sort by priority and take top items
    uniqueNews.sort((a, b) => b.priority - a.priority);
    const topNews = uniqueNews.slice(0, 20);

    // Optionally scrape full content for high-priority items
    if (scrapeContent && FIRECRAWL_API_KEY) {
      const highPriorityNews = topNews.filter((n) => n.priority >= 0.75);
      console.log(`[news-pulse] Scraping content for ${highPriorityNews.length} high-priority items`);

      await Promise.all(
        highPriorityNews.slice(0, 5).map(async (news) => {
          const content = await scrapeArticleContent(FIRECRAWL_API_KEY, news.source_url);
          if (content) {
            news.description = content.slice(0, 1000); // Limit content length
          }
        })
      );
    }

    // Insert into research queue
    const queueEntries = topNews.map((news) => ({
      topic: news.topic,
      description: news.description?.slice(0, 500) || null,
      priority_score: news.priority,
      source: "news_pulse",
      category: news.category,
      status: "queued",
      metadata: {
        source_url: news.source_url,
        source_name: news.source_name,
        collected_at: new Date().toISOString(),
      },
    }));

    if (queueEntries.length > 0) {
      const { error: insertError } = await supabase
        .from("atlas_research_queue")
        .insert(queueEntries);

      if (insertError) {
        console.error("[news-pulse] Error inserting to queue:", insertError);
      } else {
        console.log(`[news-pulse] Added ${queueEntries.length} items to research queue`);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        newsCollected: topNews.length,
        totalRaw: allNews.length,
        sources: {
          newsApi: !!NEWS_API_KEY,
          perplexity: !!PERPLEXITY_API_KEY,
          firecrawl: !!FIRECRAWL_API_KEY,
        },
        topTopics: topNews.slice(0, 5).map((n) => ({ topic: n.topic, priority: n.priority })),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[news-pulse] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
