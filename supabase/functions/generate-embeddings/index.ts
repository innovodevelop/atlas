import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

import { generateEmbedding } from "../_shared/aiGateway.ts";
import { requireUserOrInternal, AuthError, authErrorResponse } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // WS-A: user JWT (identity from token) or internal cron-secret caller.
  let auth: { userId: string | null; token: string | null; internal: boolean };
  try { auth = await requireUserOrInternal(req); } catch (e) { return authErrorResponse(e); }

  try {
    const { batchSize = 10, source = "all" } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let totalProcessed = 0;
    let totalCreated = 0;
    const errors: string[] = [];

    // Get existing embedded knowledge entry IDs
    const { data: existingKnowledge } = await supabase
      .from("memory_vectors")
      .select("knowledge_entry_id")
      .not("knowledge_entry_id", "is", null);
    
    const embeddedKnowledgeIds = new Set(
      (existingKnowledge || []).map((v: any) => v.knowledge_entry_id)
    );

    // Process knowledge entries
    if (source === "all" || source === "knowledge") {
      const { data: knowledgeEntries, error: kError } = await supabase
        .from("atlas_knowledge_entries")
        .select("id, topic, content, category, user_id")
        .order("created_at", { ascending: false })
        .limit(batchSize * 2);

      if (kError) {
        errors.push(`Knowledge fetch error: ${kError.message}`);
      } else if (knowledgeEntries) {
        // Filter out already embedded entries
        const toEmbed = knowledgeEntries
          .filter((k: any) => !embeddedKnowledgeIds.has(k.id))
          .slice(0, batchSize);

        for (const entry of toEmbed) {
          try {
            const contentStr = typeof entry.content === "object"
              ? JSON.stringify(entry.content)
              : String(entry.content);
            
            const textToEmbed = `${entry.topic}. Category: ${entry.category}. ${contentStr}`;
            
            console.log(`Embedding knowledge: ${entry.topic.slice(0, 50)}...`);
            const embedding = await generateEmbedding(textToEmbed);

            const { error: insertError } = await supabase
              .from("memory_vectors")
              .insert({
                user_id: entry.user_id || "00000000-0000-0000-0000-000000000000",
                knowledge_entry_id: entry.id,
                chunk_text: textToEmbed.slice(0, 1000),
                embedding: `[${embedding.join(",")}]`,
                source_ref_json: { type: "knowledge", topic: entry.topic },
              });

            if (insertError) {
              errors.push(`Insert error for ${entry.id}: ${insertError.message}`);
            } else {
              totalCreated++;
            }
            totalProcessed++;
          } catch (e) {
            errors.push(`Embedding error for ${entry.id}: ${e}`);
          }
          
          // Rate limiting - wait between embeddings
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    // Process research topics
    if (source === "all" || source === "research") {
      const { data: existingResearch } = await supabase
        .from("memory_vectors")
        .select("source_ref_json")
        .not("source_ref_json", "is", null);
      
      const embeddedResearchIds = new Set(
        (existingResearch || [])
          .filter((v: any) => v.source_ref_json?.type === "research")
          .map((v: any) => v.source_ref_json?.id)
      );

      const { data: researchTopics, error: rError } = await supabase
        .from("atlas_research_topics")
        .select("id, topic, description, findings, user_id, status")
        .eq("status", "completed")
        .order("created_at", { ascending: false })
        .limit(batchSize * 2);

      if (rError) {
        errors.push(`Research fetch error: ${rError.message}`);
      } else if (researchTopics) {
        const toEmbed = researchTopics
          .filter((r: any) => !embeddedResearchIds.has(r.id))
          .slice(0, batchSize);

        for (const topic of toEmbed) {
          try {
            const findingsStr = Array.isArray(topic.findings)
              ? topic.findings.slice(0, 5).map((f: any) => 
                  typeof f === "string" ? f : JSON.stringify(f)
                ).join(". ")
              : "";
            
            const textToEmbed = `${topic.topic}. ${topic.description || ""}. Key findings: ${findingsStr}`;
            
            console.log(`Embedding research: ${topic.topic.slice(0, 50)}...`);
            const embedding = await generateEmbedding(textToEmbed);

            const { error: insertError } = await supabase
              .from("memory_vectors")
              .insert({
                user_id: topic.user_id || "00000000-0000-0000-0000-000000000000",
                chunk_text: textToEmbed.slice(0, 1000),
                embedding: `[${embedding.join(",")}]`,
                source_ref_json: { type: "research", id: topic.id, topic: topic.topic },
              });

            if (insertError) {
              errors.push(`Insert error for research ${topic.id}: ${insertError.message}`);
            } else {
              totalCreated++;
            }
            totalProcessed++;
          } catch (e) {
            errors.push(`Embedding error for research ${topic.id}: ${e}`);
          }
          
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    }

    console.log(`Embedding complete: ${totalCreated} created, ${totalProcessed} processed`);

    return new Response(
      JSON.stringify({
        success: true,
        processed: totalProcessed,
        created: totalCreated,
        errors: errors.slice(0, 10),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (error) {
    console.error("Generate embeddings error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
