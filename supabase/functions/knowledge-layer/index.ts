import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient, getSupabaseUrl } from "../_shared/supabase.ts";
import { requireUserOrInternal, AuthError, authErrorResponse } from "../_shared/auth.ts";

interface RetrieveRequest {
  query: string;
  userId?: string;
  types?: ("knowledge" | "memory" | "research" | "context")[];
  limit?: number;
  includeUnvalidated?: boolean;
  excludeFake?: boolean;
}

interface StoreRequest {
  type: "knowledge" | "memory" | "research" | "context";
  topic: string;
  content: unknown;
  userId?: string;
  source?: string;
  category?: string;
  confidence?: number;
  triggerValidation?: boolean;
}

interface UnifiedEntry {
  id: string;
  type: "knowledge" | "memory" | "research" | "context";
  topic: string;
  content: unknown;
  category?: string;
  relevanceScore: number;
  isValidated: boolean;
  isFake: boolean;
  validationScore: number;
  source: string;
  createdAt: string;
}

// Calculate text similarity for basic relevance ranking
function calculateSimilarity(query: string, text: string): number {
  const queryTerms = query.toLowerCase().split(/\s+/);
  const textLower = text.toLowerCase();
  
  let matches = 0;
  for (const term of queryTerms) {
    if (textLower.includes(term)) {
      matches++;
    }
  }
  
  return queryTerms.length > 0 ? matches / queryTerms.length : 0;
}

// Retrieve unified context from all sources
async function retrieveContext(
  supabase: ReturnType<typeof getSupabaseClient>,
  request: RetrieveRequest
): Promise<UnifiedEntry[]> {
  const {
    query,
    userId,
    types = ["knowledge", "memory", "research", "context"],
    limit = 20,
    includeUnvalidated = true,
    excludeFake = true,
  } = request;

  const results: UnifiedEntry[] = [];
  const queries: Promise<void>[] = [];

  if (types.includes("knowledge")) {
    queries.push((async () => {
      let q = supabase
        .from("atlas_knowledge_entries")
        .select("id, topic, content, category, relevance_score, is_validated, is_fake, validation_score, source, created_at")
        .order("relevance_score", { ascending: false })
        .limit(limit);

      if (userId) {
        q = q.or(`user_id.eq.${userId},user_id.is.null`);
      }
      if (excludeFake) {
        q = q.eq("is_fake", false);
      }
      if (!includeUnvalidated) {
        q = q.eq("is_validated", true);
      }

      const { data } = await q;
      if (data) {
        for (const item of data) {
          const textContent = typeof item.content === "string" 
            ? item.content 
            : JSON.stringify(item.content);
          const similarity = calculateSimilarity(query, `${item.topic} ${textContent}`);
          
          results.push({
            id: item.id,
            type: "knowledge",
            topic: item.topic,
            content: item.content,
            category: item.category,
            relevanceScore: (item.relevance_score || 0.5) * (0.5 + similarity * 0.5),
            isValidated: item.is_validated || false,
            isFake: item.is_fake || false,
            validationScore: item.validation_score || 0,
            source: item.source || "unknown",
            createdAt: item.created_at,
          });
        }
      }
    })());
  }

  if (types.includes("memory")) {
    queries.push((async () => {
      let q = supabase
        .from("ai_memory")
        .select("id, key, value, category, importance, is_validated, is_fake, validation_score, created_at")
        .order("importance", { ascending: false })
        .limit(limit);

      if (userId) {
        q = q.eq("user_id", userId);
      }
      if (excludeFake) {
        q = q.or("is_fake.eq.false,is_fake.is.null");
      }

      const { data } = await q;
      if (data) {
        for (const item of data) {
          const textContent = typeof item.value === "string" 
            ? item.value 
            : JSON.stringify(item.value);
          const similarity = calculateSimilarity(query, `${item.key} ${textContent}`);
          
          results.push({
            id: item.id,
            type: "memory",
            topic: item.key,
            content: item.value,
            category: item.category,
            relevanceScore: ((item.importance || 5) / 10) * (0.5 + similarity * 0.5),
            isValidated: item.is_validated || false,
            isFake: item.is_fake || false,
            validationScore: item.validation_score || 0,
            source: "user_memory",
            createdAt: item.created_at,
          });
        }
      }
    })());
  }

  if (types.includes("research")) {
    queries.push((async () => {
      let q = supabase
        .from("atlas_research_topics")
        .select("id, topic, description, findings, sources, status, is_validated, is_fake, validation_score, created_at")
        .eq("status", "completed")
        .order("priority", { ascending: false })
        .limit(limit);

      if (userId) {
        q = q.or(`user_id.eq.${userId},user_id.is.null`);
      }
      if (excludeFake) {
        q = q.or("is_fake.eq.false,is_fake.is.null");
      }

      const { data } = await q;
      if (data) {
        for (const item of data) {
          const textContent = `${item.topic} ${item.description || ""} ${JSON.stringify(item.findings || {})}`;
          const similarity = calculateSimilarity(query, textContent);
          
          results.push({
            id: item.id,
            type: "research",
            topic: item.topic,
            content: {
              description: item.description,
              findings: item.findings,
              sources: item.sources,
            },
            category: "research",
            relevanceScore: 0.7 * (0.5 + similarity * 0.5),
            isValidated: item.is_validated || false,
            isFake: item.is_fake || false,
            validationScore: item.validation_score || 0,
            source: "research",
            createdAt: item.created_at,
          });
        }
      }
    })());
  }

  if (types.includes("context")) {
    queries.push((async () => {
      if (!userId) return;

      const { data } = await supabase
        .from("session_context")
        .select("id, context_type, content, confidence, created_at")
        .eq("user_id", userId)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(limit);

      if (data) {
        for (const item of data) {
          const textContent = JSON.stringify(item.content);
          const similarity = calculateSimilarity(query, textContent);
          
          results.push({
            id: item.id,
            type: "context",
            topic: item.context_type,
            content: item.content,
            category: item.context_type,
            relevanceScore: (item.confidence || 0.8) * (0.5 + similarity * 0.5),
            isValidated: true,
            isFake: false,
            validationScore: 1,
            source: "session",
            createdAt: item.created_at,
          });
        }
      }
    })());
  }

  await Promise.all(queries);

  results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  return results.slice(0, limit);
}

// Store new entry and optionally trigger validation
async function storeEntry(
  supabase: ReturnType<typeof getSupabaseClient>,
  supabaseUrl: string,
  request: StoreRequest
): Promise<{ id: string; type: string }> {
  const { type, topic, content, userId, source, category, confidence, triggerValidation = true } = request;

  let insertedId: string;

  switch (type) {
    case "knowledge": {
      const { data, error } = await supabase
        .from("atlas_knowledge_entries")
        .insert({
          topic,
          content,
          user_id: userId,
          source: source || "api",
          category: category || "general",
          confidence: confidence || 0.5,
          relevance_score: 0.5,
        })
        .select("id")
        .single();
      
      if (error) throw error;
      insertedId = data.id;
      break;
    }

    case "memory": {
      const { data, error } = await supabase
        .from("ai_memory")
        .insert({
          user_id: userId,
          key: topic,
          value: content,
          category: category || "fact",
          memory_type: "fact",
          importance: Math.round((confidence || 0.5) * 10),
        })
        .select("id")
        .single();
      
      if (error) throw error;
      insertedId = data.id;
      break;
    }

    case "research": {
      const { data, error } = await supabase
        .from("atlas_research_topics")
        .insert({
          topic,
          description: typeof content === "string" ? content : JSON.stringify(content),
          user_id: userId,
          status: "completed",
          findings: typeof content === "object" ? content : { summary: content },
        })
        .select("id")
        .single();
      
      if (error) throw error;
      insertedId = data.id;
      break;
    }

    case "context": {
      const { data, error } = await supabase
        .from("session_context")
        .insert({
          user_id: userId,
          session_id: `api_${Date.now()}`,
          context_type: category || "fact",
          content: typeof content === "object" ? content : { value: content },
          confidence: confidence || 0.8,
          expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        })
        .select("id")
        .single();
      
      if (error) throw error;
      insertedId = data.id;
      break;
    }

    default:
      throw new Error(`Unknown entry type: ${type}`);
  }

  // Trigger validation in background if requested
  if (triggerValidation && type !== "context") {
    try {
      fetch(`${supabaseUrl}/functions/v1/validation-engine`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          "x-cron-secret": Deno.env.get("CRON_SECRET") ?? "",
        },
        body: JSON.stringify({
          entries: [{
            entryId: insertedId,
            entryType: type,
            topic,
            content: typeof content === "string" ? content : JSON.stringify(content),
            source: source || "api",
            userId,
          }],
          immediate: false,
        }),
      }).catch(e => console.log("[knowledge-layer] Validation trigger failed:", e));
    } catch (e) {
      console.log("[knowledge-layer] Could not trigger validation:", e);
    }
  }

  return { id: insertedId, type };
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // WS-A: user JWT (identity from token) or internal cron-secret caller.
  let auth: { userId: string | null; token: string | null; internal: boolean };
  try { auth = await requireUserOrInternal(req); } catch (e) { return authErrorResponse(e); }

  try {
    const url = new URL(req.url);
    const path = url.pathname.split("/").pop();
    
    const supabase = getSupabaseClient();
    const SUPABASE_URL = getSupabaseUrl();

    if (req.method === "GET" || path === "retrieve") {
      let request: RetrieveRequest;
      
      if (req.method === "GET") {
        request = {
          query: url.searchParams.get("query") || "",
          userId: url.searchParams.get("userId") || undefined,
          types: url.searchParams.get("types")?.split(",") as RetrieveRequest["types"] || undefined,
          limit: parseInt(url.searchParams.get("limit") || "20"),
          includeUnvalidated: url.searchParams.get("includeUnvalidated") !== "false",
          excludeFake: url.searchParams.get("excludeFake") !== "false",
        };
      } else {
        request = await req.json();
      }

      console.log(`[knowledge-layer] Retrieving context for query: "${request.query?.slice(0, 50)}..."`);
      
      const results = await retrieveContext(supabase, request);
      
      console.log(`[knowledge-layer] Found ${results.length} entries`);

      return jsonResponse({
        success: true,
        count: results.length,
        entries: results,
      });
    }

    if (req.method === "POST" && path === "store") {
      const request: StoreRequest = await req.json();
      
      console.log(`[knowledge-layer] Storing ${request.type}: "${request.topic}"`);
      
      const result = await storeEntry(supabase, SUPABASE_URL, request);
      
      return jsonResponse({
        success: true,
        ...result,
        message: `Stored ${result.type} entry`,
      });
    }

    if (req.method === "POST") {
      const body = await req.json();
      
      if (body.action === "store") {
        const result = await storeEntry(supabase, SUPABASE_URL, body);
        return jsonResponse({ success: true, ...result });
      }

      const results = await retrieveContext(supabase, body);
      return jsonResponse({ success: true, count: results.length, entries: results });
    }

    return errorResponse("Method not allowed", 405);
  } catch (error) {
    console.error("[knowledge-layer] Error:", error);
    return errorResponse(error instanceof Error ? error.message : "Unknown error");
  }
});
