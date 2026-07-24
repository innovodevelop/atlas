// Thin HTTP wrapper around the shared chat orchestrator (WS-B B1).
// All prompt building, memory retrieval, tool looping, and streaming live in
// _shared/orchestrator.ts so the local voice gateway runs the same brain.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders } from "../_shared/cors.ts";
import { getSupabaseClient, getSupabaseUrl, getUserClient } from "../_shared/supabase.ts";
import { requireUser, AuthError, authErrorResponse } from "../_shared/auth.ts";
import { runChat } from "../_shared/orchestrator.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Identity comes from the verified JWT — never from the request body.
    const { userId, token } = await requireUser(req);

    const { messages, source = "text_chat", enableTools = true, teachingMode = false, systemPromptOverride, conversationId = null } = await req.json();

    const result = await runChat(
      {
        // User-scoped client: caller's data goes through RLS.
        supabase: getUserClient(token),
        // service-role: provider-status/learning tables have no per-user RLS.
        systemDb: getSupabaseClient(),
        userId,
        userToken: token,
        supabaseUrl: getSupabaseUrl(),
          sessionId: req.headers.get("x-session-id") || undefined,
      },
      { messages, source, enableTools, teachingMode, systemPromptOverride, conversationId },
    );

    switch (result.kind) {
      case "stream":
        return new Response(result.stream, {
          headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
        });
      case "json":
        return new Response(JSON.stringify(result.body), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      case "error":
        return new Response(
          JSON.stringify({ error: result.message, ...(result.reason ? { reason: result.reason } : {}) }),
          { status: result.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
    }
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("[chat-with-memory] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
