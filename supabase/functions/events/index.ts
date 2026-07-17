import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    // service-role: JWT verified per-route below with user.id scoping; the
    // inbox processor iterates events across users (system-level).
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const action = pathParts[pathParts.length - 1];

    // POST /events/ingest - Ingest external events
    if (req.method === "POST" && action === "ingest") {
      const authHeader = req.headers.get("Authorization");

      // Webhook auth: X-API-Key must MATCH the EVENTS_WEBHOOK_KEY secret.
      // (Previously any non-empty header was accepted — that was a hole.)
      const apiKey = req.headers.get("X-API-Key");
      const webhookKey = Deno.env.get("EVENTS_WEBHOOK_KEY");
      const validWebhook = Boolean(apiKey && webhookKey && apiKey === webhookKey);
      let userId: string | null = null;

      if (authHeader) {
        const token = authHeader.replace("Bearer ", "");
        const { data: { user } } = await supabase.auth.getUser(token);
        userId = user?.id || null;
      }

      if (!userId && !validWebhook) {
        return new Response(JSON.stringify({ error: "Missing authorization" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const body = await req.json();
      const { event_type, payload, source } = body;

      if (!event_type || !payload) {
        return new Response(JSON.stringify({ error: "Missing event_type or payload" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: event, error } = await supabase
        .from("events_inbox")
        .insert({
          user_id: userId,
          event_type,
          source: source || "webhook",
          payload_json: payload,
          status: "pending",
        })
        .select()
        .single();

      if (error) {
        console.error("[events] Failed to insert event:", error);
        return new Response(JSON.stringify({ error: "Failed to ingest event" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      console.log(`[events] Ingested event ${event.id} of type ${event_type}`);

      return new Response(JSON.stringify({ event_id: event.id, status: "pending" }), {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /events/process - Process pending events (worker)
    if (req.method === "POST" && action === "process") {
      // System-level processor (iterates all users' pending events): only an
      // internal caller with the cron secret, or a logged-in user, may trigger.
      const cronSecret = Deno.env.get("CRON_SECRET");
      const gotSecret = req.headers.get("x-cron-secret");
      let processorAuthed = Boolean(cronSecret && gotSecret === cronSecret);
      if (!processorAuthed) {
        const hdr = req.headers.get("Authorization");
        if (hdr) {
          const { data: { user } } = await supabase.auth.getUser(hdr.replace("Bearer ", ""));
          processorAuthed = Boolean(user);
        }
      }
      if (!processorAuthed) {
        return new Response(JSON.stringify({ error: "Missing authorization" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      console.log("[events] Processing pending events");

      // Get pending events
      const { data: pendingEvents, error } = await supabase
        .from("events_inbox")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(10);

      if (error) {
        console.error("[events] Failed to fetch pending events:", error);
        return new Response(JSON.stringify({ error: "Failed to fetch events" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const results = [];

      for (const event of pendingEvents || []) {
        // Mark as processing
        await supabase
          .from("events_inbox")
          .update({ status: "processing", updated_at: new Date().toISOString() })
          .eq("id", event.id);

        try {
          // Find matching agent triggers
          // For now, look for agents that have this event type in their enabled_tools
          const { data: agents } = await supabase
            .from("agents")
            .select("*")
            .eq("user_id", event.user_id)
            .eq("is_active", true)
            .contains("enabled_tools_json", [event.event_type]);

          if (agents && agents.length > 0) {
            const agent = agents[0]; // Use first matching agent

            // Trigger agent run
            const response = await fetch(`${supabaseUrl}/functions/v1/agent-run`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${supabaseKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                agent_id: agent.id,
                goal: `Handle ${event.event_type} event`,
                context: { event: event.payload_json },
              }),
            });

            const runResult = await response.json();

            await supabase
              .from("events_inbox")
              .update({
                status: "done",
                run_id: runResult.run_id,
                processed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("id", event.id);

            results.push({ event_id: event.id, status: "done", run_id: runResult.run_id });
          } else {
            // No matching agent - mark as done without action
            await supabase
              .from("events_inbox")
              .update({
                status: "done",
                processed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              })
              .eq("id", event.id);

            results.push({ event_id: event.id, status: "done", reason: "no_matching_agent" });
          }
        } catch (e) {
          console.error(`[events] Failed to process event ${event.id}:`, e);
          
          await supabase
            .from("events_inbox")
            .update({
              status: "failed",
              error_message: e instanceof Error ? e.message : "Processing failed",
              updated_at: new Date().toISOString(),
            })
            .eq("id", event.id);

          results.push({ event_id: event.id, status: "failed", error: e instanceof Error ? e.message : "Unknown" });
        }
      }

      return new Response(JSON.stringify({ processed: results.length, results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // GET /events - List events for user
    if (req.method === "GET") {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return new Response(JSON.stringify({ error: "Missing authorization" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const token = authHeader.replace("Bearer ", "");
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      
      if (authError || !user) {
        return new Response(JSON.stringify({ error: "Invalid token" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const status = url.searchParams.get("status");
      
      let query = supabase
        .from("events_inbox")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);

      if (status) {
        query = query.eq("status", status);
      }

      const { data: events, error } = await query;

      if (error) {
        return new Response(JSON.stringify({ error: "Failed to fetch events" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ events }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[events] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
