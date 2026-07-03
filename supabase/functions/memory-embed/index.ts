import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

import { aiChatCompletion, generateEmbedding } from "../_shared/aiGateway.ts";

// Use AI to extract semantic chunks from text
async function extractChunks(text: string): Promise<string[]> {
  const response = await aiChatCompletion({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content: "Extract key facts and concepts from the text. Return a JSON array of strings, each string being a standalone fact or concept that could be useful to remember.",
        },
        { role: "user", content: text },
      ],
  });

  if (!response.ok) {
    throw new Error("Failed to extract chunks");
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "[]";
  
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : [text];
  } catch {
    return [text];
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing authorization" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const action = url.pathname.split("/").pop();

    // POST /memory-embed/embed - Embed new content
    if (req.method === "POST" && action !== "search" && action !== "prune") {
      const body = await req.json();
      const { content, source_type, source_id, memory_item_id, knowledge_entry_id } = body;

      if (!content) {
        return new Response(JSON.stringify({ error: "Missing content" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`[memory-embed] Embedding content for user ${user.id}`);

      // Extract semantic chunks
      const chunks = await extractChunks(content);
      const embeddings = [];

      for (const chunk of chunks) {
        const embedding = await generateEmbedding(chunk);
        
        const { data, error } = await supabase
          .from("memory_vectors")
          .insert({
            user_id: user.id,
            memory_item_id,
            knowledge_entry_id,
            chunk_text: chunk,
            embedding: `[${embedding.join(",")}]`,
            source_ref_json: { source_type, source_id },
          })
          .select("id")
          .single();

        if (error) {
          console.error("[memory-embed] Failed to insert vector:", error);
        } else {
          embeddings.push(data.id);
        }
      }

      return new Response(JSON.stringify({ 
        embedded: embeddings.length,
        vector_ids: embeddings,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /memory-embed/search - Semantic search
    if (req.method === "POST" && action === "search") {
      const body = await req.json();
      const { query, limit = 10 } = body;

      if (!query) {
        return new Response(JSON.stringify({ error: "Missing query" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`[memory-embed] Searching for: ${query.slice(0, 50)}`);

      const queryEmbedding = await generateEmbedding(query);

      // Use pgvector similarity search
      const { data: results, error } = await supabase.rpc("match_memory_vectors", {
        query_embedding: `[${queryEmbedding.join(",")}]`,
        match_threshold: 0.5,
        match_count: limit,
        p_user_id: user.id,
      });

      if (error) {
        // If RPC doesn't exist, fall back to basic query
        console.log("[memory-embed] RPC not found, using basic query");
        
        const { data: fallback } = await supabase
          .from("memory_vectors")
          .select("*")
          .eq("user_id", user.id)
          .limit(limit);

        return new Response(JSON.stringify({ results: fallback || [] }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ results: results || [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /memory-embed/prune - Apply retention policies
    if (req.method === "POST" && action === "prune") {
      console.log(`[memory-embed] Pruning old memories for user ${user.id}`);

      // Get active memory policies
      const { data: policies } = await supabase
        .from("memory_policies")
        .select("*")
        .eq("user_id", user.id)
        .eq("is_active", true)
        .eq("auto_prune", true);

      let prunedCount = 0;

      for (const policy of policies || []) {
        if (policy.retention_days) {
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - policy.retention_days);

          // Delete old memory items in this category
          const { count } = await supabase
            .from("ai_memory")
            .delete()
            .eq("user_id", user.id)
            .eq("category", policy.category)
            .lt("importance", policy.importance_threshold)
            .lt("created_at", cutoffDate.toISOString());

          prunedCount += count || 0;
        }
      }

      return new Response(JSON.stringify({ pruned: prunedCount }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[memory-embed] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
