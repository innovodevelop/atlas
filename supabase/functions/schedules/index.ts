import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient, getSupabaseUrl } from "../_shared/supabase.ts";

// Simple cron parser for next run calculation
function getNextRunTime(cronExpression: string): Date {
  // For now, simple implementation - add 1 hour for hourly, 1 day for daily
  const now = new Date();
  const parts = cronExpression.split(" ");
  
  if (parts[0] === "*") {
    // Every minute - next minute
    now.setMinutes(now.getMinutes() + 1, 0, 0);
  } else if (parts[1] === "*") {
    // Hourly - next hour
    now.setHours(now.getHours() + 1, 0, 0, 0);
  } else {
    // Daily - next day at specified hour
    now.setDate(now.getDate() + 1);
    now.setHours(parseInt(parts[1]) || 0, parseInt(parts[0]) || 0, 0, 0);
  }
  
  return now;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    const supabaseUrl = getSupabaseUrl();
    // service-role: JWT verified below; queries scoped by verified user.id.
    // Cron trigger path calls agent-run with the service key.
    const supabase = getSupabaseClient();

    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const action = pathParts[pathParts.length - 1];

    // Handle cron tick (no auth required - called by cron job)
    if (req.method === "POST" && action === "tick") {
      console.log("[schedules] Processing tick");
      
      const now = new Date();
      
      // Find schedules due to run
      const { data: dueSchedules, error } = await supabase
        .from("schedules")
        .select(`
          *,
          agents (*)
        `)
        .eq("enabled", true)
        .lte("next_run_at", now.toISOString());

      if (error) {
        console.error("[schedules] Failed to fetch due schedules:", error);
        return new Response(JSON.stringify({ error: "Failed to process tick" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const results = [];
      
      for (const schedule of dueSchedules || []) {
        try {
          // Trigger agent run
          const response = await fetch(`${supabaseUrl}/functions/v1/agent-run`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              agent_id: schedule.agent_id,
              goal: schedule.payload_json?.goal || `Scheduled run: ${schedule.name}`,
              context: schedule.payload_json,
            }),
          });

          const runResult = await response.json();
          
          // Update schedule
          const nextRunAt = getNextRunTime(schedule.cron_expression);
          await supabase
            .from("schedules")
            .update({
              last_run_at: now.toISOString(),
              next_run_at: nextRunAt.toISOString(),
              last_run_status: response.ok ? "success" : "failed",
              last_run_id: runResult.run_id || null,
            })
            .eq("id", schedule.id);

          results.push({ schedule_id: schedule.id, status: "triggered", run_id: runResult.run_id });
        } catch (e) {
          console.error(`[schedules] Failed to run schedule ${schedule.id}:`, e);
          results.push({ schedule_id: schedule.id, status: "failed", error: e instanceof Error ? e.message : "Unknown" });
        }
      }

      return new Response(JSON.stringify({ processed: results.length, results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // All other endpoints require auth
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

    // GET /schedules - List schedules
    if (req.method === "GET") {
      const { data: schedules, error } = await supabase
        .from("schedules")
        .select(`
          *,
          agents (name, description)
        `)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false });

      if (error) {
        return new Response(JSON.stringify({ error: "Failed to fetch schedules" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ schedules }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /schedules - Create schedule
    if (req.method === "POST" && !pathParts.includes("toggle") && !pathParts.includes("run-now")) {
      const body = await req.json();
      const { agent_id, name, description, cron_expression, payload_json, enabled } = body;

      if (!agent_id || !name || !cron_expression) {
        return new Response(JSON.stringify({ error: "Missing required fields" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Verify agent ownership
      const { data: agent } = await supabase
        .from("agents")
        .select("id")
        .eq("id", agent_id)
        .eq("user_id", user.id)
        .single();

      if (!agent) {
        return new Response(JSON.stringify({ error: "Agent not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const nextRunAt = getNextRunTime(cron_expression);

      const { data: schedule, error } = await supabase
        .from("schedules")
        .insert({
          user_id: user.id,
          agent_id,
          name,
          description,
          cron_expression,
          payload_json: payload_json || {},
          enabled: enabled !== false,
          next_run_at: nextRunAt.toISOString(),
        })
        .select()
        .single();

      if (error) {
        return new Response(JSON.stringify({ error: "Failed to create schedule" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ schedule }), {
        status: 201,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /schedules/:id/toggle
    const scheduleId = pathParts[pathParts.length - 2];
    
    if (req.method === "POST" && action === "toggle") {
      const { data: schedule, error: fetchError } = await supabase
        .from("schedules")
        .select("enabled, cron_expression")
        .eq("id", scheduleId)
        .eq("user_id", user.id)
        .single();

      if (fetchError || !schedule) {
        return new Response(JSON.stringify({ error: "Schedule not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const newEnabled = !schedule.enabled;
      const nextRunAt = newEnabled ? getNextRunTime(schedule.cron_expression) : null;

      const { error: updateError } = await supabase
        .from("schedules")
        .update({ 
          enabled: newEnabled,
          next_run_at: nextRunAt?.toISOString() || null,
        })
        .eq("id", scheduleId);

      if (updateError) {
        return new Response(JSON.stringify({ error: "Failed to toggle schedule" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ enabled: newEnabled }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /schedules/:id/run-now
    if (req.method === "POST" && action === "run-now") {
      const { data: schedule, error: fetchError } = await supabase
        .from("schedules")
        .select("*, agents(*)")
        .eq("id", scheduleId)
        .eq("user_id", user.id)
        .single();

      if (fetchError || !schedule) {
        return new Response(JSON.stringify({ error: "Schedule not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Trigger agent run
      const response = await fetch(`${supabaseUrl}/functions/v1/agent-run`, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agent_id: schedule.agent_id,
          goal: schedule.payload_json?.goal || `Manual run: ${schedule.name}`,
          context: schedule.payload_json,
        }),
      });

      const runResult = await response.json();

      // Update last run
      await supabase
        .from("schedules")
        .update({
          last_run_at: new Date().toISOString(),
          last_run_status: response.ok ? "success" : "failed",
          last_run_id: runResult.run_id || null,
        })
        .eq("id", scheduleId);

      return new Response(JSON.stringify(runResult), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // DELETE /schedules/:id
    if (req.method === "DELETE" && scheduleId) {
      const { error } = await supabase
        .from("schedules")
        .delete()
        .eq("id", scheduleId)
        .eq("user_id", user.id);

      if (error) {
        return new Response(JSON.stringify({ error: "Failed to delete schedule" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ deleted: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[schedules] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
