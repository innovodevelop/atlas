import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { aiChatCompletion, hasAIKey } from "../_shared/aiGateway.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface DiscoveredTopic {
  topic: string;
  description: string;
  priority: number;
  category: string;
  reasoning: string;
}

interface KnowledgeGap {
  area: string;
  reason: string;
  priority: number;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { maxTopics = 5, userId = null } = await req.json().catch(() => ({}));

    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!hasAIKey()) {
      throw new Error("No AI key configured (GEMINI_API_KEY)");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    console.log("[topic-discovery] Analyzing knowledge base for gaps...");

    // Gather existing knowledge context
    const [
      { data: recentKnowledge },
      { data: recentResearch },
      { data: userMemories },
      { data: recentNews },
    ] = await Promise.all([
      supabase
        .from("atlas_knowledge_entries")
        .select("topic, category, created_at")
        .order("created_at", { ascending: false })
        .limit(50),
      supabase
        .from("atlas_research_topics")
        .select("topic, status, created_at")
        .order("created_at", { ascending: false })
        .limit(30),
      userId
        ? supabase
            .from("ai_memory")
            .select("key, category")
            .eq("user_id", userId)
            .limit(20)
        : Promise.resolve({ data: [] }),
      supabase
        .from("atlas_research_queue")
        .select("topic, category")
        .eq("source", "news_pulse")
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    // Build context summary
    const existingTopics = [
      ...(recentKnowledge || []).map((k: any) => k.topic),
      ...(recentResearch || []).map((r: any) => r.topic),
    ];

    const existingCategories = [
      ...(recentKnowledge || []).map((k: any) => k.category),
    ].reduce((acc: Record<string, number>, cat) => {
      acc[cat] = (acc[cat] || 0) + 1;
      return acc;
    }, {});

    const userInterests = (userMemories || [])
      .filter((m: any) => m.category === "preferences" || m.category === "interests")
      .map((m: any) => m.key);

    const recentNewsTopics = (recentNews || []).map((n: any) => n.topic).slice(0, 10);

    console.log(`[topic-discovery] Context: ${existingTopics.length} existing topics, ${userInterests.length} user interests`);

    // Use AI to discover new topics based on gaps
    const discoveryPromises: Promise<DiscoveredTopic[]>[] = [];

    // Primary discovery with Gemini
    discoveryPromises.push(
      discoverWithGemini(
        existingTopics,
        existingCategories,
        userInterests,
        recentNewsTopics,
        maxTopics
      )
    );

    // If Perplexity available, also discover trending topics
    if (PERPLEXITY_API_KEY) {
      discoveryPromises.push(
        discoverTrendingWithPerplexity(PERPLEXITY_API_KEY, existingTopics, maxTopics)
      );
    }

    const results = await Promise.all(discoveryPromises);
    const allDiscoveredTopics = results.flat();

    // Deduplicate discovered topics
    const uniqueTopics: DiscoveredTopic[] = [];
    const seenTopics = new Set<string>();

    for (const topic of allDiscoveredTopics) {
      const normalized = topic.topic.toLowerCase().slice(0, 50);
      if (!seenTopics.has(normalized)) {
        seenTopics.add(normalized);
        uniqueTopics.push(topic);
      }
    }

    // Check against existing queue
    const finalTopics: DiscoveredTopic[] = [];
    for (const topic of uniqueTopics) {
      const { data: existing } = await supabase
        .from("atlas_research_queue")
        .select("id")
        .ilike("topic", `%${topic.topic.slice(0, 30)}%`)
        .limit(1);

      if (!existing || existing.length === 0) {
        finalTopics.push(topic);
      }
    }

    console.log(`[topic-discovery] Discovered ${finalTopics.length} new unique topics`);

    // Insert into research queue
    if (finalTopics.length > 0) {
      const queueEntries = finalTopics.map((t) => ({
        topic: t.topic,
        description: t.description,
        priority_score: t.priority,
        source: "topic_discovery",
        category: t.category,
        status: "queued",
        metadata: {
          reasoning: t.reasoning,
          discovered_at: new Date().toISOString(),
        },
      }));

      const { error: insertError } = await supabase
        .from("atlas_research_queue")
        .insert(queueEntries);

      if (insertError) {
        console.error("[topic-discovery] Error inserting topics:", insertError);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        topicsGenerated: finalTopics.length,
        topics: finalTopics.map((t) => ({
          topic: t.topic,
          category: t.category,
          priority: t.priority,
        })),
        context: {
          existingTopicsCount: existingTopics.length,
          userInterestsCount: userInterests.length,
          categoryCoverage: existingCategories,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[topic-discovery] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

async function discoverWithGemini(
  existingTopics: string[],
  categoryDistribution: Record<string, number>,
  userInterests: string[],
  recentNews: string[],
  maxTopics: number
): Promise<DiscoveredTopic[]> {
  try {
    const response = await aiChatCompletion({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `You are Atlas, an AI research system discovering knowledge gaps and generating research topics.

Your goal is to identify important topics that would expand the knowledge base strategically.

Consider:
1. Balance across categories (technology, science, history, culture, etc.)
2. Current events and trending topics
3. Deep topics worth understanding
4. User interests if provided

Always return valid JSON array only.`,
          },
          {
            role: "user",
            content: `Analyze this knowledge context and suggest ${maxTopics} new research topics:

EXISTING TOPICS (last 50):
${existingTopics.slice(0, 30).join("\n")}

CATEGORY DISTRIBUTION:
${Object.entries(categoryDistribution)
  .map(([cat, count]) => `${cat}: ${count}`)
  .join(", ")}

USER INTERESTS:
${userInterests.length > 0 ? userInterests.join(", ") : "None specified"}

RECENT NEWS TOPICS:
${recentNews.join("\n")}

Return a JSON array:
[
  {
    "topic": "specific research topic",
    "description": "why this is valuable to research",
    "priority": 0.5-1.0,
    "category": "technology|science|history|culture|economics|health|environment|politics",
    "reasoning": "how this fills a knowledge gap"
  }
]

Focus on:
- Topics NOT already covered
- Balance underrepresented categories
- Timely and important subjects
- Deep understanding over shallow breadth`,
          },
        ],
    });

    if (!response.ok) {
      console.error("[topic-discovery] Gemini error:", response.status);
      return [];
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "[]";

    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      console.error("[topic-discovery] Failed to parse Gemini response:", parseError);
    }

    return [];
  } catch (error) {
    console.error("[topic-discovery] Gemini discovery error:", error);
    return [];
  }
}

async function discoverTrendingWithPerplexity(
  apiKey: string,
  existingTopics: string[],
  maxTopics: number
): Promise<DiscoveredTopic[]> {
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
            content: "You are a research topic analyst. Return ONLY a JSON array.",
          },
          {
            role: "user",
            content: `What are ${maxTopics} important emerging topics in science, technology, and world affairs that are worth deep research right now?

Avoid these already-covered topics:
${existingTopics.slice(0, 20).join(", ")}

Return JSON array:
[
  {
    "topic": "specific topic title",
    "description": "brief explanation",
    "priority": 0.7,
    "category": "technology|science|world|business",
    "reasoning": "why this matters now"
  }
]`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error("[topic-discovery] Perplexity error:", response.status);
      return [];
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "[]";

    try {
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (parseError) {
      console.error("[topic-discovery] Failed to parse Perplexity response:", parseError);
    }

    return [];
  } catch (error) {
    console.error("[topic-discovery] Perplexity discovery error:", error);
    return [];
  }
}
