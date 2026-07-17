import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { requireUserOrInternal, AuthError, authErrorResponse } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface SchedulerConfig {
  operation: "consolidate" | "prune" | "insight" | "validate" | "full";
  userId?: string;
  dryRun?: boolean;
}

interface SchedulerResult {
  operation: string;
  entriesProcessed: number;
  duplicatesRemoved: number;
  lowPriorityPruned: number;
  insightsExtracted: number;
  validationTriggered: number;
  durationMs: number;
}

// Consolidate duplicate or similar memories
async function consolidateDuplicates(
  supabase: any,
  userId?: string
): Promise<{ processed: number; removed: number }> {
  let query = supabase
    .from("ai_memory")
    .select("id, user_id, key, value, category, importance, created_at")
    .order("created_at", { ascending: false });

  if (userId) {
    query = query.eq("user_id", userId);
  }

  const { data: memories } = await query.limit(500);
  if (!memories || memories.length === 0) {
    return { processed: 0, removed: 0 };
  }

  // Group by user and category to find duplicates
  const groupedMemories = new Map<string, typeof memories>();
  for (const memory of memories) {
    const key = `${memory.user_id}_${memory.category}`;
    if (!groupedMemories.has(key)) {
      groupedMemories.set(key, []);
    }
    groupedMemories.get(key)!.push(memory);
  }

  const toDelete: string[] = [];

  for (const [_, group] of groupedMemories) {
    if (group.length < 2) continue;

    // Find memories with similar keys (potential duplicates)
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const m1 = group[i];
        const m2 = group[j];

        // Check if keys are similar (fuzzy match)
        const key1 = m1.key.toLowerCase().replace(/[^a-z0-9]/g, "");
        const key2 = m2.key.toLowerCase().replace(/[^a-z0-9]/g, "");

        if (key1 === key2 || key1.includes(key2) || key2.includes(key1)) {
          // Keep the one with higher importance or newer
          const keepNewer = m1.importance === m2.importance;
          const toRemove = keepNewer
            ? (new Date(m1.created_at) > new Date(m2.created_at) ? m2.id : m1.id)
            : (m1.importance > m2.importance ? m2.id : m1.id);
          
          if (!toDelete.includes(toRemove)) {
            toDelete.push(toRemove);
          }
        }
      }
    }
  }

  if (toDelete.length > 0) {
    await supabase.from("ai_memory").delete().in("id", toDelete);
    console.log(`[memory-scheduler] Consolidated ${toDelete.length} duplicate memories`);
  }

  return { processed: memories.length, removed: toDelete.length };
}

// Prune low-priority old memories
async function pruneLowPriority(
  supabase: any,
  userId?: string
): Promise<{ pruned: number }> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  let query = supabase
    .from("ai_memory")
    .select("id")
    .lt("importance", 4)
    .lt("updated_at", thirtyDaysAgo)
    .eq("is_validated", false);

  if (userId) {
    query = query.eq("user_id", userId);
  }

  const { data: toPrune } = await query.limit(100);
  
  if (toPrune && toPrune.length > 0) {
    const ids = toPrune.map((m: any) => m.id);
    await supabase.from("ai_memory").delete().in("id", ids);
    console.log(`[memory-scheduler] Pruned ${ids.length} low-priority memories`);
    return { pruned: ids.length };
  }

  return { pruned: 0 };
}

// Extract insights from memories and knowledge
async function extractInsights(
  supabase: any,
  supabaseUrl: string,
  userId?: string
): Promise<{ extracted: number }> {
  // Get recent memories that haven't been synthesized
  let memoryQuery = supabase
    .from("ai_memory")
    .select("id, key, value, category")
    .order("created_at", { ascending: false })
    .limit(50);

  if (userId) {
    memoryQuery = memoryQuery.eq("user_id", userId);
  }

  const { data: memories } = await memoryQuery;
  if (!memories || memories.length < 5) {
    return { extracted: 0 };
  }

  // Call memory-synthesize for insight extraction
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/memory-synthesize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "x-cron-secret": Deno.env.get("CRON_SECRET") ?? "",
      },
      body: JSON.stringify({
        operation: "insight",
        memories: memories.slice(0, 20),
        userId,
      }),
    });

    if (response.ok) {
      const result = await response.json();
      console.log(`[memory-scheduler] Extracted ${result.insightsCreated || 0} insights`);
      return { extracted: result.insightsCreated || 0 };
    }
  } catch (e) {
    console.error("[memory-scheduler] Insight extraction error:", e);
  }

  return { extracted: 0 };
}

// Trigger validation for unvalidated entries
async function triggerValidation(
  supabase: any,
  supabaseUrl: string,
  userId?: string
): Promise<{ triggered: number }> {
  // Find unvalidated knowledge entries
  let query = supabase
    .from("atlas_knowledge_entries")
    .select("id, topic, content, source")
    .eq("is_validated", false)
    .limit(20);

  if (userId) {
    query = query.eq("user_id", userId);
  }

  const { data: entries } = await query;
  if (!entries || entries.length === 0) {
    return { triggered: 0 };
  }

  // Prepare validation requests
  const validationEntries = entries.map((e: any) => ({
    entryId: e.id,
    entryType: "knowledge",
    topic: e.topic,
    content: typeof e.content === "string" ? e.content : JSON.stringify(e.content),
    source: e.source,
  }));

  // Trigger validation in background
  try {
    fetch(`${supabaseUrl}/functions/v1/validation-engine`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "x-cron-secret": Deno.env.get("CRON_SECRET") ?? "",
      },
      body: JSON.stringify({
        entries: validationEntries,
        immediate: false,
      }),
    }).catch(e => console.log("[memory-scheduler] Validation trigger error:", e));

    console.log(`[memory-scheduler] Triggered validation for ${validationEntries.length} entries`);
    return { triggered: validationEntries.length };
  } catch (e) {
    console.error("[memory-scheduler] Validation trigger error:", e);
    return { triggered: 0 };
  }
}

// Log synthesis operation
async function logOperation(
  supabase: any,
  operation: string,
  result: SchedulerResult,
  userId?: string
) {
  await supabase.from("memory_synthesis_logs").insert({
    user_id: userId,
    operation_type: operation,
    input_count: result.entriesProcessed,
    output_count: result.entriesProcessed - result.duplicatesRemoved - result.lowPriorityPruned,
    conflicts_resolved: result.duplicatesRemoved,
    insights_extracted: result.insightsExtracted,
    duration_ms: result.durationMs,
    details: {
      duplicatesRemoved: result.duplicatesRemoved,
      lowPriorityPruned: result.lowPriorityPruned,
      validationTriggered: result.validationTriggered,
    },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // WS-A: user JWT (identity from token) or internal cron-secret caller.
  let auth: { userId: string | null; token: string | null; internal: boolean };
  try { auth = await requireUserOrInternal(req); } catch (e) { return authErrorResponse(e); }

  try {
    const config: SchedulerConfig = req.method === "GET" 
      ? { operation: "full" }
      : await req.json();

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const startTime = Date.now();
    const result: SchedulerResult = {
      operation: config.operation,
      entriesProcessed: 0,
      duplicatesRemoved: 0,
      lowPriorityPruned: 0,
      insightsExtracted: 0,
      validationTriggered: 0,
      durationMs: 0,
    };

    console.log(`[memory-scheduler] Starting ${config.operation} operation`);

    if (config.dryRun) {
      console.log("[memory-scheduler] Dry run mode - no changes will be made");
      return new Response(
        JSON.stringify({ message: "Dry run complete", operation: config.operation }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Execute operations based on config
    switch (config.operation) {
      case "consolidate": {
        const consolidateResult = await consolidateDuplicates(supabase, config.userId);
        result.entriesProcessed = consolidateResult.processed;
        result.duplicatesRemoved = consolidateResult.removed;
        break;
      }

      case "prune": {
        const pruneResult = await pruneLowPriority(supabase, config.userId);
        result.lowPriorityPruned = pruneResult.pruned;
        break;
      }

      case "insight": {
        const insightResult = await extractInsights(supabase, SUPABASE_URL, config.userId);
        result.insightsExtracted = insightResult.extracted;
        break;
      }

      case "validate": {
        const validateResult = await triggerValidation(supabase, SUPABASE_URL, config.userId);
        result.validationTriggered = validateResult.triggered;
        break;
      }

      case "full":
      default: {
        // Run all operations in sequence for full maintenance
        const [consolidateResult, pruneResult, insightResult, validateResult] = await Promise.all([
          consolidateDuplicates(supabase, config.userId),
          pruneLowPriority(supabase, config.userId),
          extractInsights(supabase, SUPABASE_URL, config.userId),
          triggerValidation(supabase, SUPABASE_URL, config.userId),
        ]);

        result.entriesProcessed = consolidateResult.processed;
        result.duplicatesRemoved = consolidateResult.removed;
        result.lowPriorityPruned = pruneResult.pruned;
        result.insightsExtracted = insightResult.extracted;
        result.validationTriggered = validateResult.triggered;
        break;
      }
    }

    result.durationMs = Date.now() - startTime;

    // Log the operation
    await logOperation(supabase, config.operation, result, config.userId);

    console.log(`[memory-scheduler] ${config.operation} complete in ${result.durationMs}ms:`, result);

    return new Response(
      JSON.stringify({
        success: true,
        ...result,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[memory-scheduler] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
