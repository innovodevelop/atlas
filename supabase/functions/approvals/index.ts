import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient, getSupabaseUrl } from "../_shared/supabase.ts";

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

    const supabaseUrl = getSupabaseUrl();
    // service-role: JWT verified below; queries scoped by verified user.id.
    // Approval state transitions are system-level writes.
    const supabase = getSupabaseClient();

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const approvalId = pathParts[pathParts.length - 2];
    const action = pathParts[pathParts.length - 1];

    // GET /approvals - List pending approvals
    if (req.method === "GET") {
      const status = url.searchParams.get("status") || "pending";
      
      const { data: approvals, error } = await supabase
        .from("approvals")
        .select(`
          *,
          tool_calls (
            tool_name,
            args_json
          ),
          runs (
            goal_text,
            agents (name)
          )
        `)
        .eq("user_id", user.id)
        .eq("status", status)
        .order("created_at", { ascending: false })
        .limit(50);

      if (error) {
        console.error("[approvals] Failed to fetch:", error);
        return new Response(JSON.stringify({ error: "Failed to fetch approvals" }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify({ approvals }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // POST /approvals/:id/approve or /approvals/:id/reject
    if (req.method === "POST" && approvalId) {
      const body = await req.json().catch(() => ({}));
      
      // Get the approval
      const { data: approval, error: fetchError } = await supabase
        .from("approvals")
        .select("*, tool_calls(*)")
        .eq("id", approvalId)
        .eq("user_id", user.id)
        .single();

      if (fetchError || !approval) {
        return new Response(JSON.stringify({ error: "Approval not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (approval.status !== "pending") {
        return new Response(JSON.stringify({ error: "Approval already processed" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const isApprove = action === "approve";
      const now = new Date().toISOString();

      // Update approval
      await supabase
        .from("approvals")
        .update({
          status: isApprove ? "approved" : "rejected",
          approved_by: user.id,
          approved_at: now,
          reason: body.reason || null,
        })
        .eq("id", approvalId);

      // Update tool_call status
      await supabase
        .from("tool_calls")
        .update({
          status: isApprove ? "approved" : "rejected",
        })
        .eq("id", approval.tool_call_id);

      console.log(`[approvals] Approval ${approvalId} ${isApprove ? "approved" : "rejected"} by ${user.id}`);

      // If approved, execute the tool
      if (isApprove && approval.tool_calls) {
        const toolCall = approval.tool_calls;
        
        try {
          // Re-invoke tool-gateway to execute
          const response = await fetch(`${supabaseUrl}/functions/v1/tool-gateway`, {
            method: "POST",
            headers: {
              Authorization: authHeader,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              tool_name: toolCall.tool_name,
              args: toolCall.args_json,
              run_id: approval.run_id,
              tool_call_id: toolCall.id,
            }),
          });

          const result = await response.json();

          // Update the run if it was waiting for approval
          if (approval.run_id) {
            await supabase
              .from("runs")
              .update({ status: "running" })
              .eq("id", approval.run_id)
              .eq("status", "awaiting_approval");
          }

          return new Response(JSON.stringify({
            status: "approved",
            approval_id: approvalId,
            execution_result: result,
          }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } catch (e) {
          console.error("[approvals] Tool execution failed after approval:", e);
          return new Response(JSON.stringify({
            status: "approved",
            approval_id: approvalId,
            execution_error: e instanceof Error ? e.message : "Execution failed",
          }), {
            status: 500,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }

      return new Response(JSON.stringify({
        status: isApprove ? "approved" : "rejected",
        approval_id: approvalId,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[approvals] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
