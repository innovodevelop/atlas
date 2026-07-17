import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { requireUserOrInternal, AuthError, authErrorResponse } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface KnowledgeEntry {
  id: string;
  topic: string;
  content: Record<string, unknown>;
  category: string;
  source: string;
  confidence: number;
  relevance_score: number;
  research_topic_id?: string;
  root_topic_context?: RootTopicContext;
  validation_status: string;
}

interface RootTopicContext {
  root_topic: string;
  root_description?: string;
  jurisdiction?: string;
  domain?: string;
  parent_chain: string[];
  focus_keywords: string[];
}

interface ValidationResult {
  entry_id: string;
  original_status: string;
  new_status: string;
  relevance_score: number;
  issues: string[];
}

// Validate a knowledge entry against its root context
function validateEntry(entry: KnowledgeEntry): ValidationResult {
  const issues: string[] = [];
  let relevanceScore = entry.relevance_score || 0.5;
  
  const content = entry.content as { summary?: string; details?: string };
  const combinedText = `${entry.topic} ${content.summary || ''} ${content.details || ''}`.toLowerCase();
  
  const context = entry.root_topic_context;
  
  if (context) {
    // Check jurisdiction match
    if (context.jurisdiction) {
      const hasCorrectJurisdiction = combinedText.includes(context.jurisdiction);
      
      // Check for wrong jurisdictions
      const wrongJurisdictions = ['american', 'usa', 'united states', 'u.s.', 'federal'].filter(
        j => !context.jurisdiction?.includes('american') && combinedText.includes(j)
      );
      
      if (wrongJurisdictions.length > 0 && !hasCorrectJurisdiction) {
        issues.push(`Wrong jurisdiction detected: found ${wrongJurisdictions.join(', ')} but expected ${context.jurisdiction}`);
        relevanceScore *= 0.3;
      } else if (!hasCorrectJurisdiction) {
        issues.push(`Missing expected jurisdiction: ${context.jurisdiction}`);
        relevanceScore *= 0.7;
      }
    }
    
    // Check keyword relevance
    const keywordHits = context.focus_keywords.filter(kw => 
      combinedText.includes(kw.toLowerCase())
    ).length;
    
    if (keywordHits === 0) {
      issues.push(`No focus keywords found from: ${context.focus_keywords.join(', ')}`);
      relevanceScore *= 0.5;
    } else if (keywordHits < context.focus_keywords.length / 2) {
      issues.push(`Low keyword match: ${keywordHits}/${context.focus_keywords.length}`);
      relevanceScore *= 0.8;
    }
    
    // Check root topic mention
    const rootWords = context.root_topic.toLowerCase().split(/\s+/);
    const rootWordHits = rootWords.filter(w => w.length > 3 && combinedText.includes(w)).length;
    
    if (rootWordHits === 0) {
      issues.push(`No mention of root topic keywords from: ${context.root_topic}`);
      relevanceScore *= 0.6;
    }
  }
  
  // Check content quality
  const details = content.details || '';
  if (details.length < 100) {
    issues.push('Content details are too short (< 100 chars)');
    relevanceScore *= 0.9;
  }
  
  // Determine validation status
  let newStatus: string;
  if (relevanceScore >= 0.7) {
    newStatus = 'validated';
  } else if (relevanceScore >= 0.4) {
    newStatus = 'flagged';
  } else {
    newStatus = 'rejected';
  }
  
  return {
    entry_id: entry.id,
    original_status: entry.validation_status,
    new_status: newStatus,
    relevance_score: Math.round(relevanceScore * 100) / 100,
    issues,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // WS-A: user JWT (identity from token) or internal cron-secret caller.
  let auth: { userId: string | null; token: string | null; internal: boolean };
  try { auth = await requireUserOrInternal(req); } catch (e) { return authErrorResponse(e); }

  try {
    const { action, entryId, researchTopicId, userId: bodyUserId, validateAll = false } = await req.json();
    const userId = auth.internal ? (bodyUserId ?? null) : auth.userId;
    
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Missing required environment variables");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Validate single entry
    if (action === "validate" && entryId) {
      const { data: entry, error } = await supabase
        .from("atlas_knowledge_entries")
        .select("*")
        .eq("id", entryId)
        .single();

      if (error || !entry) {
        throw new Error("Entry not found");
      }

      const result = validateEntry(entry as KnowledgeEntry);

      // Update the entry
      await supabase
        .from("atlas_knowledge_entries")
        .update({
          validation_status: result.new_status,
          relevance_to_root: result.relevance_score,
        })
        .eq("id", entryId);

      console.log(`[knowledge-validator] Validated entry ${entryId}: ${result.original_status} -> ${result.new_status}`);

      return new Response(
        JSON.stringify({ success: true, result }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate all entries for a research topic
    if (action === "validate-topic" && researchTopicId) {
      const { data: entries, error } = await supabase
        .from("atlas_knowledge_entries")
        .select("*")
        .eq("research_topic_id", researchTopicId);

      if (error) {
        throw new Error("Failed to fetch entries");
      }

      const results: ValidationResult[] = [];
      
      for (const entry of (entries || [])) {
        const result = validateEntry(entry as KnowledgeEntry);
        results.push(result);

        // Update the entry
        await supabase
          .from("atlas_knowledge_entries")
          .update({
            validation_status: result.new_status,
            relevance_to_root: result.relevance_score,
          })
          .eq("id", entry.id);
      }

      const summary = {
        total: results.length,
        validated: results.filter(r => r.new_status === 'validated').length,
        flagged: results.filter(r => r.new_status === 'flagged').length,
        rejected: results.filter(r => r.new_status === 'rejected').length,
      };

      console.log(`[knowledge-validator] Validated ${results.length} entries for topic ${researchTopicId}:`, summary);

      return new Response(
        JSON.stringify({ success: true, results, summary }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate all pending entries (for a user or all)
    if (action === "validate-pending" || validateAll) {
      let query = supabase
        .from("atlas_knowledge_entries")
        .select("*")
        .eq("validation_status", "pending");

      if (userId) {
        query = query.eq("user_id", userId);
      }

      const { data: entries, error } = await query.limit(100);

      if (error) {
        throw new Error("Failed to fetch pending entries");
      }

      const results: ValidationResult[] = [];
      
      for (const entry of (entries || [])) {
        const result = validateEntry(entry as KnowledgeEntry);
        results.push(result);

        await supabase
          .from("atlas_knowledge_entries")
          .update({
            validation_status: result.new_status,
            relevance_to_root: result.relevance_score,
          })
          .eq("id", entry.id);
      }

      const summary = {
        total: results.length,
        validated: results.filter(r => r.new_status === 'validated').length,
        flagged: results.filter(r => r.new_status === 'flagged').length,
        rejected: results.filter(r => r.new_status === 'rejected').length,
      };

      console.log(`[knowledge-validator] Batch validation complete:`, summary);

      return new Response(
        JSON.stringify({ success: true, results, summary }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Get validation statistics
    if (action === "stats") {
      let query = supabase
        .from("atlas_knowledge_entries")
        .select("validation_status, confidence, relevance_to_root");

      if (userId) {
        query = query.eq("user_id", userId);
      }

      const { data: entries, error } = await query;

      if (error) {
        throw new Error("Failed to fetch entries");
      }

      const stats = {
        total: entries?.length || 0,
        by_status: {
          pending: entries?.filter(e => e.validation_status === 'pending').length || 0,
          validated: entries?.filter(e => e.validation_status === 'validated').length || 0,
          flagged: entries?.filter(e => e.validation_status === 'flagged').length || 0,
          rejected: entries?.filter(e => e.validation_status === 'rejected').length || 0,
        },
        avg_confidence: entries?.length 
          ? (entries.reduce((sum, e) => sum + (e.confidence || 0), 0) / entries.length).toFixed(2)
          : 0,
        avg_relevance: entries?.length && entries.some(e => e.relevance_to_root)
          ? (entries.filter(e => e.relevance_to_root).reduce((sum, e) => sum + (e.relevance_to_root || 0), 0) / 
             entries.filter(e => e.relevance_to_root).length).toFixed(2)
          : 0,
      };

      return new Response(
        JSON.stringify({ success: true, stats }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    throw new Error("Invalid action or missing parameters");
  } catch (error) {
    console.error("[knowledge-validator] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
