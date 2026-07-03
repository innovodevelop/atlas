import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateEmbedding } from "../_shared/aiGateway.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { query, threshold = 0.3, limit = 20, userId } = await req.json();

    if (!query || typeof query !== "string") {
      return new Response(
        JSON.stringify({ error: "Query is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    console.log(`Semantic search for: "${query.slice(0, 100)}..."`);

    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query);

    // Create Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Search for similar vectors using RPC
    const { data: vectorResults, error: vectorError } = await supabase.rpc(
      "match_brain_vectors",
      {
        query_embedding: `[${queryEmbedding.join(",")}]`,
        match_threshold: threshold,
        match_count: limit,
        p_user_id: userId || null,
      }
    );

    if (vectorError) {
      console.error("Vector search error:", vectorError);
      // Return empty results if RPC fails (e.g., no embeddings yet)
      return new Response(
        JSON.stringify({ 
          results: [], 
          message: "No embeddings indexed yet. Run generate-embeddings first.",
          query 
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!vectorResults || vectorResults.length === 0) {
      return new Response(
        JSON.stringify({ results: [], query }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch full details for matched vectors
    const knowledgeIds = vectorResults
      .filter((v: any) => v.knowledge_entry_id)
      .map((v: any) => v.knowledge_entry_id);

    const memoryIds = vectorResults
      .filter((v: any) => v.memory_item_id)
      .map((v: any) => v.memory_item_id);

    // Fetch knowledge entries and memory items in parallel
    const [knowledgeResult, memoryResult] = await Promise.all([
      knowledgeIds.length > 0
        ? supabase
            .from("atlas_knowledge_entries")
            .select("*")
            .in("id", knowledgeIds)
        : { data: [], error: null },
      memoryIds.length > 0
        ? supabase
            .from("ai_memory")
            .select("*")
            .in("id", memoryIds)
        : { data: [], error: null },
    ]);

    // Build lookup maps
    const knowledgeMap = new Map(
      (knowledgeResult.data || []).map((k: any) => [k.id, k])
    );
    const memoryMap = new Map(
      (memoryResult.data || []).map((m: any) => [m.id, m])
    );

    // Combine results with similarity scores
    const enrichedResults = vectorResults.map((v: any) => {
      if (v.knowledge_entry_id && knowledgeMap.has(v.knowledge_entry_id)) {
        const knowledge = knowledgeMap.get(v.knowledge_entry_id);
        return {
          id: knowledge.id,
          type: "knowledge" as const,
          title: knowledge.topic,
          preview: typeof knowledge.content === "object" 
            ? JSON.stringify(knowledge.content).slice(0, 200)
            : String(knowledge.content).slice(0, 200),
          category: knowledge.category,
          confidence: knowledge.confidence,
          similarity: v.similarity,
          createdAt: knowledge.created_at,
          source: "semantic",
          metadata: {
            source: knowledge.source,
            accessCount: knowledge.access_count,
            relevanceScore: knowledge.relevance_score,
          },
        };
      }
      
      if (v.memory_item_id && memoryMap.has(v.memory_item_id)) {
        const memory = memoryMap.get(v.memory_item_id);
        return {
          id: memory.id,
          type: "memory" as const,
          title: memory.key,
          preview: typeof memory.value === "object"
            ? JSON.stringify(memory.value).slice(0, 200)
            : String(memory.value).slice(0, 200),
          category: memory.category,
          confidence: (memory.validation_score || 0.5),
          similarity: v.similarity,
          createdAt: memory.created_at,
          source: "semantic",
          metadata: {
            memoryType: memory.memory_type,
            importance: memory.importance,
          },
        };
      }

      // Fallback for vectors without linked entries
      return {
        id: v.id,
        type: "vector" as const,
        title: "Indexed Content",
        preview: v.chunk_text?.slice(0, 200) || "",
        similarity: v.similarity,
        createdAt: new Date().toISOString(),
        source: "semantic",
        metadata: {},
      };
    }).filter((r: any) => r.preview); // Filter out empty results

    console.log(`Found ${enrichedResults.length} semantic matches`);

    return new Response(
      JSON.stringify({ results: enrichedResults, query }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Semantic search error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
