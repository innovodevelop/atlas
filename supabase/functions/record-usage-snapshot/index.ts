import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireCronSecret, authErrorResponse } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Cost estimates per 1K tokens by provider
const COST_PER_1K_TOKENS: Record<string, { input: number; output: number }> = {
  lovable_ai: { input: 0.00025, output: 0.00125 },
  perplexity: { input: 0.001, output: 0.001 },
  openai: { input: 0.01, output: 0.03 },
  anthropic: { input: 0.008, output: 0.024 },
  firecrawl: { input: 0.0001, output: 0.0001 },
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // WS-A: cron target — only pg_cron/internal callers with the secret.
    try { requireCronSecret(req); } catch (e) { return authErrorResponse(e); }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Get current date
    const today = new Date().toISOString().split("T")[0];

    // Fetch all provider status
    const { data: providers, error: providersError } = await supabase
      .from("atlas_provider_status")
      .select("*");

    if (providersError) {
      throw providersError;
    }

    // Record snapshot for each provider
    const snapshots = providers.map((provider) => {
      const costs = COST_PER_1K_TOKENS[provider.provider] || { input: 0.001, output: 0.001 };
      // Estimate 500 tokens per successful call
      const estimatedCost = (provider.successful_calls || 0) * 500 * (costs.input + costs.output) / 1000;

      return {
        date: today,
        provider: provider.provider,
        total_calls: provider.total_calls || 0,
        successful_calls: provider.successful_calls || 0,
        failed_calls: provider.failed_calls || 0,
        estimated_cost: estimatedCost,
        tokens_used: (provider.successful_calls || 0) * 500, // Rough estimate
      };
    });

    // Upsert snapshots (update if exists for today, otherwise insert)
    for (const snapshot of snapshots) {
      const { error: upsertError } = await supabase
        .from("atlas_usage_history")
        .upsert(snapshot, { 
          onConflict: "date,provider",
          ignoreDuplicates: false 
        });

      if (upsertError) {
        console.error(`Failed to upsert snapshot for ${snapshot.provider}:`, upsertError);
      }
    }

    // Check budget limits and potentially disable learning
    const { data: budgetSettings } = await supabase
      .from("atlas_budget_settings")
      .select("*")
      .limit(1)
      .single();

    if (budgetSettings?.auto_disable_on_limit) {
      // Calculate total daily spending
      const totalDailySpending = snapshots.reduce((sum, s) => sum + s.estimated_cost, 0);

      if (totalDailySpending >= budgetSettings.daily_budget_usd) {
        // Disable learning
        await supabase
          .from("atlas_system_settings")
          .update({ learning_enabled: false })
          .eq("id", (await supabase.from("atlas_system_settings").select("id").limit(1).single()).data?.id);

        console.log("Learning disabled due to budget limit exceeded");
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        snapshotsRecorded: snapshots.length,
        date: today,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error recording usage snapshot:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(
      JSON.stringify({ error: errorMessage }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
