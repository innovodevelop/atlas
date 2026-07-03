import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, corsHeaders, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { aiChatCompletion } from "../_shared/aiGateway.ts";

interface ToolCallRequest {
  tool_name: string;
  args: Record<string, unknown>;
  run_id?: string;
  step_id?: string;
  agent_id?: string;
}

// Define which tools are considered risky and require approval
const RISKY_TOOLS = ["file_write", "shell_exec", "api_call", "database_write", "send_email"];

// Model configuration for different providers
const PROVIDERS = {
  perplexity: {
    url: "https://api.perplexity.ai/chat/completions",
    models: {
      fast: "sonar",
      deep: "sonar-pro",
    }
  },
  lovable: {
    url: "https://ai.gateway.lovable.dev/v1/chat/completions",
    models: {
      fast: "google/gemini-2.5-flash",
      standard: "google/gemini-2.5-pro",
    }
  },
  jina: {
    url: "https://r.jina.ai",
  }
};

// Tool implementations
const AVAILABLE_TOOLS: Record<string, (args: Record<string, unknown>, supabase: ReturnType<typeof getSupabaseClient>) => Promise<unknown>> = {
  web_search: async (args) => {
    const query = args.query as string;
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    
    if (!PERPLEXITY_API_KEY) {
      console.log("[web_search] Perplexity API key not configured, falling back to AI gateway");
      const response = await aiChatCompletion({
          model: PROVIDERS.lovable.models.fast,
          messages: [
            { role: "system", content: "You are a web search assistant. Provide accurate information." },
            { role: "user", content: `Search and summarize information about: ${query}` },
          ],
      });
      const data = await response.json();
      return { 
        result: data.choices?.[0]?.message?.content || "No results found",
        citations: [],
        provider: "lovable_fallback"
      };
    }

    console.log(`[web_search] Searching with Perplexity sonar: ${query}`);
    
    const response = await fetch(PROVIDERS.perplexity.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PROVIDERS.perplexity.models.fast,
        messages: [
          { role: "system", content: "Be precise and concise." },
          { role: "user", content: query },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("[web_search] Perplexity API error:", errorText);
      throw new Error(`Search failed: ${response.status}`);
    }

    const data = await response.json();
    return { 
      result: data.choices?.[0]?.message?.content || "No results found",
      citations: data.citations || [],
      provider: "perplexity_sonar"
    };
  },

  deep_research: async (args) => {
    const topic = args.topic as string;
    const depth = (args.depth as string) || "comprehensive";
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    
    if (!PERPLEXITY_API_KEY) {
      const response = await aiChatCompletion({
          model: PROVIDERS.lovable.models.standard,
          messages: [
            { role: "system", content: "You are an expert researcher. Provide comprehensive research findings." },
            { role: "user", content: `Research thoroughly: ${topic}\n\nProvide a ${depth} analysis.` },
          ],
      });
      const data = await response.json();
      return { 
        result: data.choices?.[0]?.message?.content || "Research failed",
        citations: [],
        provider: "lovable_fallback"
      };
    }

    console.log(`[deep_research] Deep research with Perplexity sonar-pro: ${topic}`);
    
    const response = await fetch(PROVIDERS.perplexity.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PROVIDERS.perplexity.models.deep,
        messages: [
          { role: "system", content: "You are an expert research assistant." },
          { role: "user", content: `Research this topic thoroughly: ${topic}\n\nDepth level: ${depth}` },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(`Research failed: ${response.status}`);
    }

    const data = await response.json();
    return { 
      result: data.choices?.[0]?.message?.content || "Research failed",
      citations: data.citations || [],
      provider: "perplexity_sonar_pro"
    };
  },

  web_scrape: async (args) => {
    const url = args.url as string;
    
    if (!url || !url.startsWith("http")) {
      throw new Error("Invalid URL provided");
    }

    console.log(`[web_scrape] Scraping with Jina Reader: ${url}`);
    
    const jinaUrl = `${PROVIDERS.jina.url}/${url}`;
    
    const response = await fetch(jinaUrl, {
      method: "GET",
      headers: { "Accept": "text/markdown" },
    });

    if (!response.ok) {
      throw new Error(`Scraping failed: ${response.status}`);
    }

    const markdown = await response.text();
    
    return { 
      content: markdown,
      url: url,
      content_type: "markdown",
      provider: "jina_reader",
      length: markdown.length
    };
  },

  deep_search: async (args, supabase) => {
    const query = args.query as string;
    const scrapeFirst = args.scrape_results as boolean || false;
    
    console.log(`[deep_search] Combined search + scrape for: ${query}`);
    
    const searchResult = await AVAILABLE_TOOLS.web_search({ query }, supabase) as { result: string; citations: string[] };
    
    let scrapedContent: { url: string; content: string }[] = [];
    if (scrapeFirst && searchResult.citations?.length > 0) {
      const urlsToScrape = searchResult.citations.slice(0, 3);
      
      for (const url of urlsToScrape) {
        try {
          const scraped = await AVAILABLE_TOOLS.web_scrape({ url }, supabase) as { content: string };
          scrapedContent.push({ url, content: scraped.content.slice(0, 5000) });
        } catch (e) {
          console.log(`[deep_search] Failed to scrape ${url}:`, e);
        }
      }
    }
    
    return {
      search_result: searchResult.result,
      citations: searchResult.citations,
      scraped_sources: scrapedContent,
      provider: "combined"
    };
  },
  
  calculate: async (args) => {
    const expression = args.expression as string;
    try {
      const result = Function(`"use strict"; return (${expression})`)();
      return { result };
    } catch {
      return { error: "Invalid expression" };
    }
  },
  
  get_time: async () => {
    return { 
      utc: new Date().toISOString(),
      timestamp: Date.now() 
    };
  },
  
  memory_recall: async (args, supabase) => {
    const query = args.query as string;
    const userId = args.user_id as string;
    
    const { data } = await supabase
      .from("ai_memory")
      .select("*")
      .eq("user_id", userId)
      .textSearch("value", query)
      .limit(5);
    
    return { memories: data || [] };
  },
  
  memory_store: async (args, supabase) => {
    const { user_id, key, value, category, memory_type, importance } = args;
    
    const { data, error } = await supabase
      .from("ai_memory")
      .upsert({
        user_id,
        key,
        value,
        category: category || "general",
        memory_type: memory_type || "fact",
        importance: importance || 5,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,key" });
    
    if (error) return { error: error.message };
    return { success: true, data };
  },
};

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return errorResponse("Missing authorization", 401);
    }

    const supabase = getSupabaseClient();

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return errorResponse("Invalid token", 401);
    }

    const body: ToolCallRequest = await req.json();
    const { tool_name, args, run_id, step_id, agent_id } = body;

    console.log(`[tool-gateway] User ${user.id} calling tool: ${tool_name}`);

    if (!AVAILABLE_TOOLS[tool_name]) {
      return errorResponse(`Unknown tool: ${tool_name}`, 400);
    }

    // Check agent's tool allowlist
    if (agent_id) {
      const { data: agent } = await supabase
        .from("agents")
        .select("enabled_tools_json")
        .eq("id", agent_id)
        .eq("user_id", user.id)
        .single();

      if (agent) {
        const enabledTools = agent.enabled_tools_json || [];
        if (enabledTools.length > 0 && !enabledTools.includes(tool_name)) {
          return errorResponse(`Tool ${tool_name} not allowed for this agent`, 403);
        }
      }
    }

    // Check workspace limits
    const { data: settings } = await supabase
      .from("workspace_settings")
      .select("*")
      .eq("user_id", user.id)
      .single();

    if (settings) {
      const today = new Date().toISOString().split("T")[0];
      const { count: todayCalls } = await supabase
        .from("tool_calls")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", `${today}T00:00:00Z`);

      if (todayCalls && todayCalls >= settings.daily_tool_call_limit) {
        return errorResponse("Daily tool call limit exceeded", 429);
      }
    }

    const requiresApproval = RISKY_TOOLS.includes(tool_name) && settings?.require_approval_for_risky;

    let costEstimate = 0.001;
    if (tool_name === "deep_research") costEstimate = 0.01;
    else if (tool_name === "web_search") costEstimate = 0.005;
    else if (tool_name === "deep_search") costEstimate = 0.015;

    const { data: toolCall, error: insertError } = await supabase
      .from("tool_calls")
      .insert({
        user_id: user.id,
        run_id,
        step_id,
        tool_name,
        args_json: args,
        status: requiresApproval ? "awaiting_approval" : "running",
        requires_approval: requiresApproval,
        cost_estimate: costEstimate,
      })
      .select()
      .single();

    if (insertError) {
      console.error("[tool-gateway] Failed to create tool_call:", insertError);
      return errorResponse("Failed to log tool call", 500);
    }

    if (requiresApproval) {
      await supabase.from("approvals").insert({
        user_id: user.id,
        run_id,
        tool_call_id: toolCall.id,
        action_summary: `Execute ${tool_name} with args: ${JSON.stringify(args).slice(0, 200)}`,
        risk_level: RISKY_TOOLS.includes(tool_name) ? "high" : "medium",
        status: "pending",
      });

      return new Response(JSON.stringify({
        status: "awaiting_approval",
        tool_call_id: toolCall.id,
        message: "This tool requires approval before execution",
      }), {
        status: 202,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const result = await AVAILABLE_TOOLS[tool_name]({ ...args, user_id: user.id }, supabase);
      
      await supabase
        .from("tool_calls")
        .update({
          result_json: result,
          status: "completed",
          completed_at: new Date().toISOString(),
        })
        .eq("id", toolCall.id);

      console.log(`[tool-gateway] Tool ${tool_name} completed successfully`);

      return jsonResponse({
        status: "completed",
        tool_call_id: toolCall.id,
        result,
      });
    } catch (execError) {
      console.error(`[tool-gateway] Tool ${tool_name} failed:`, execError);
      
      await supabase
        .from("tool_calls")
        .update({
          status: "failed",
          error_message: execError instanceof Error ? execError.message : "Unknown error",
          completed_at: new Date().toISOString(),
        })
        .eq("id", toolCall.id);

      return errorResponse(execError instanceof Error ? execError.message : "Tool execution failed", 500);
    }
  } catch (error) {
    console.error("[tool-gateway] Error:", error);
    return errorResponse(error instanceof Error ? error.message : "Unknown error");
  }
});
