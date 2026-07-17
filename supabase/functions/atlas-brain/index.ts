import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient, getSupabaseUrl } from "../_shared/supabase.ts";
import { checkSessionBudget } from "../_shared/learningGuards.ts";
import { requireUserOrInternal, AuthError, authErrorResponse } from "../_shared/auth.ts";

// atlas-brain used to be the engine of the endless-research loop: every cycle
// it fanned out to atlas-news-pulse and atlas-topic-discovery (which invented
// global topics), then processed the queue those feeders kept refilling.
//
// It is now a session-scoped worker with two modes:
//   - "session":          process queued research topics for ONE learning
//                          session (requires sessionId). Used after chat
//                          creates topics, and by atlas-daily-digest.
//   - "validation_batch": fact-check unvalidated knowledge entries.
// The global feeders are gated behind atlas_system_settings.global_discovery_enabled
// inside their own functions and are no longer invoked from here.

interface BrainRunMetrics {
  researchCompleted: number;
  entriesValidated: number;
  totalDurationMs: number;
  errors: string[];
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  // WS-A: user JWT (identity from token) or internal cron-secret caller.
  let auth: { userId: string | null; token: string | null; internal: boolean };
  try { auth = await requireUserOrInternal(req); } catch (e) { return authErrorResponse(e); }

  const startTime = Date.now();
  const metrics: BrainRunMetrics = {
    researchCompleted: 0,
    entriesValidated: 0,
    totalDurationMs: 0,
    errors: [],
  };

  try {
    const {
      mode = "session",
      sessionId = null,
      maxResearchItems = 3,
      maxValidationItems = 10,
    } = await req.json().catch(() => ({}));

    const supabase = getSupabaseClient();
    const SUPABASE_URL = getSupabaseUrl();
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    console.log(`[atlas-brain] Starting ${mode} cycle...`);

    const { data: runData } = await supabase
      .from("atlas_brain_runs")
      .insert({ run_type: mode, status: "running" })
      .select()
      .single();
    const runId = runData?.id;

    const invokeFunction = async (name: string, body: unknown): Promise<unknown> => {
      try {
        const response = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`${name} failed: ${response.status} - ${text}`);
        }
        return await response.json();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[atlas-brain] Error invoking ${name}:`, msg);
        metrics.errors.push(`${name}: ${msg}`);
        return null;
      }
    };

    if (mode === "session") {
      if (!sessionId) {
        return errorResponse("mode 'session' requires sessionId", 400);
      }

      const gate = await checkSessionBudget(supabase, sessionId);
      if (!gate.ok) {
        return jsonResponse({ success: false, reason: gate.reason, runId });
      }

      const { data: queuedTopics, error: queueError } = await supabase
        .from("atlas_research_topics")
        .select("id, topic, priority")
        .eq("learning_session_id", sessionId)
        .eq("status", "queued")
        .order("priority", { ascending: false })
        .limit(maxResearchItems);

      if (queueError) {
        metrics.errors.push(`queue fetch: ${queueError.message}`);
      } else if (queuedTopics && queuedTopics.length > 0) {
        console.log(`[atlas-brain] Processing ${queuedTopics.length} topics for session ${sessionId}`);
        // Sequential, not parallel: bounded work, no request-storm
        for (const topic of queuedTopics) {
          const result = await invokeFunction("atlas-research", {
            topicId: topic.id,
            action: "start",
            autoDeepen: true,
            learningSessionId: sessionId,
          }) as { success?: boolean } | null;
          if (result?.success) metrics.researchCompleted++;
        }
      } else {
        console.log(`[atlas-brain] No queued topics for session ${sessionId}`);
      }
    }

    if (mode === "validation_batch") {
      const { data: unvalidatedKnowledge } = await supabase
        .from("atlas_knowledge_entries")
        .select("id, topic, content, source")
        .eq("is_validated", false)
        .limit(maxValidationItems);

      const validationEntries = (unvalidatedKnowledge || []).map((e: { id: string; topic: string; content: unknown; source: string }) => ({
        entryId: e.id,
        entryType: "knowledge",
        topic: e.topic,
        content: typeof e.content === "string" ? e.content : JSON.stringify(e.content),
        source: e.source,
      }));

      if (validationEntries.length > 0) {
        console.log(`[atlas-brain] Validating ${validationEntries.length} entries`);
        const validationResult = await invokeFunction("validation-engine", {
          entries: validationEntries,
          immediate: false,
        }) as { queued?: boolean } | null;
        if (validationResult?.queued) {
          metrics.entriesValidated = validationEntries.length;
        }
      }
    }

    metrics.totalDurationMs = Date.now() - startTime;

    if (runId) {
      await supabase
        .from("atlas_brain_runs")
        .update({
          status: metrics.errors.length > 0 ? "completed_with_errors" : "completed",
          completed_at: new Date().toISOString(),
          metrics: metrics,
          research_completed: metrics.researchCompleted,
          entries_validated: metrics.entriesValidated,
        })
        .eq("id", runId);
    }

    console.log(`[atlas-brain] ${mode} cycle complete in ${metrics.totalDurationMs}ms`);

    return jsonResponse({ success: true, runId, mode, metrics });
  } catch (error) {
    console.error("[atlas-brain] Fatal error:", error);
    metrics.totalDurationMs = Date.now() - startTime;
    return errorResponse(error instanceof Error ? error.message : "Unknown error");
  }
});
