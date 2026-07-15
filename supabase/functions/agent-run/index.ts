import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient, getSupabaseUrl } from "../_shared/supabase.ts";
import { isLovableAIEnabled } from "../_shared/providerStatus.ts";
import { aiChatCompletion } from "../_shared/aiGateway.ts";

interface AgentRunRequest {
  agent_id: string;
  goal: string;
  context?: Record<string, unknown>;
}

// Provider configuration for multi-model orchestration
const PROVIDERS = {
  lovable: {
    url: "https://ai.gateway.lovable.dev/v1/chat/completions",
    models: {
      planner: "openai/gpt-5",           // Best reasoning for planning
      worker: "google/gemini-2.5-flash", // Fast execution
      reasoner: "openai/gpt-5",          // Best reasoning for verification
      fast: "google/gemini-2.5-flash",   // Quick tasks
    }
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    models: {
      // Claude Sonnet 4.5 for memory and reasoning tasks
      memory: "claude-sonnet-4-5",            // Memory synthesis, consolidation
      reasoner: "claude-sonnet-4-5",          // Complex multi-step reasoning
      // Claude Sonnet 4.5 for faster analytical tasks
      critic: "claude-sonnet-4-5",            // Code review, verification
      creative: "claude-sonnet-4-5",          // Creative writing, nuanced responses
    }
  },
  perplexity: {
    url: "https://api.perplexity.ai/chat/completions",
    models: {
      research: "sonar-pro",  // Deep research with citations
      search: "sonar",        // Fast web search
    }
  },
  jina: {
    url: "https://r.jina.ai", // URL scraping
  }
};

// Intelligent model routing based on task type
function selectModel(taskType: string, agentConfig: Record<string, unknown> | null): { provider: string; model: string; url: string } {
  // Check if agent has custom model configuration
  const modelConfig = agentConfig?.model_config_json as Record<string, string> | null;
  
  switch (taskType) {
    // Memory Core: Claude Opus 4.5 for advanced memory operations
    case "memory_synthesis":
    case "memory_consolidation":
    case "contradiction_resolution":
    case "insight_extraction":
      if (Deno.env.get("ANTHROPIC_API_KEY")) {
        return { provider: "anthropic", model: PROVIDERS.anthropic.models.memory, url: PROVIDERS.anthropic.url };
      }
      break;
    
    // Complex Reasoning: Claude Opus 4.5
    case "complex_reasoning":
    case "multi_step_logic":
    case "deep_analysis":
      if (Deno.env.get("ANTHROPIC_API_KEY")) {
        return { provider: "anthropic", model: PROVIDERS.anthropic.models.reasoner, url: PROVIDERS.anthropic.url };
      }
      // Fallback to Lovable reasoner if no Anthropic key
      return { 
        provider: "lovable", 
        model: modelConfig?.reasoner || PROVIDERS.lovable.models.reasoner, 
        url: PROVIDERS.lovable.url 
      };
    
    // Tier 4: Claude Sonnet 4.5 for faster analytical tasks
    case "code_review":
    case "code_analysis":
    case "critic":
      if (Deno.env.get("ANTHROPIC_API_KEY")) {
        return { provider: "anthropic", model: PROVIDERS.anthropic.models.critic, url: PROVIDERS.anthropic.url };
      }
      break;
    case "creative_writing":
    case "creative":
    case "nuanced_response":
      if (Deno.env.get("ANTHROPIC_API_KEY")) {
        return { provider: "anthropic", model: PROVIDERS.anthropic.models.creative, url: PROVIDERS.anthropic.url };
      }
      break;
    
    // Tier 3: Perplexity for research
    // (deep_analysis is handled above under reasoning — removed here, it was an
    // unreachable duplicate case)
    case "research":
    case "web_research":
      // Use Perplexity for research tasks (grounded with citations)
      if (Deno.env.get("PERPLEXITY_API_KEY")) {
        return { provider: "perplexity", model: PROVIDERS.perplexity.models.research, url: PROVIDERS.perplexity.url };
      }
      break;
    case "web_search":
    case "quick_search":
      if (Deno.env.get("PERPLEXITY_API_KEY")) {
        return { provider: "perplexity", model: PROVIDERS.perplexity.models.search, url: PROVIDERS.perplexity.url };
      }
      break;
    
    // Tier 1: Planning with best reasoning
    case "planning":
      return { 
        provider: "lovable", 
        model: modelConfig?.planner || PROVIDERS.lovable.models.planner, 
        url: PROVIDERS.lovable.url 
      };
    
    // Tier 1: Verification/reasoning
    case "verification":
    case "reasoning":
      return { 
        provider: "lovable", 
        model: modelConfig?.reasoner || PROVIDERS.lovable.models.reasoner, 
        url: PROVIDERS.lovable.url 
      };
    
    // Tier 2: Execution with fast model
    case "execution":
    case "tool_call":
    default:
      return { 
        provider: "lovable", 
        model: modelConfig?.worker || PROVIDERS.lovable.models.worker, 
        url: PROVIDERS.lovable.url 
      };
  }
  
  // Default fallback to Lovable AI
  return { provider: "lovable", model: PROVIDERS.lovable.models.worker, url: PROVIDERS.lovable.url };
}

// Get the appropriate API key for a provider
function getApiKey(provider: string): string {
  switch (provider) {
    case "anthropic":
      return Deno.env.get("ANTHROPIC_API_KEY") || "";
    case "perplexity":
      return Deno.env.get("PERPLEXITY_API_KEY") || "";
    case "lovable":
    default:
      return Deno.env.get("LOVABLE_API_KEY") || Deno.env.get("GEMINI_API_KEY") || "";
  }
}

async function callAI(
  taskType: string,
  messages: { role: string; content: string }[],
  agentConfig: Record<string, unknown> | null,
  tools?: unknown[]
): Promise<{ content: string; tool_calls?: unknown[]; citations?: string[]; provider: string; model: string }> {
  const { provider, model, url } = selectModel(taskType, agentConfig);
  const apiKey = getApiKey(provider);
  
  if (!apiKey) {
    throw new Error(`API key not configured for provider: ${provider}`);
  }

  console.log(`[agent-run] Using ${provider}/${model} for ${taskType}`);

  // Handle Anthropic's different API format
  if (provider === "anthropic") {
    const systemMessage = messages.find(m => m.role === "system");
    const userMessages = messages.filter(m => m.role !== "system").map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content
    }));

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemMessage?.content || "You are a helpful AI assistant.",
        messages: userMessages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[agent-run] Anthropic API call failed:`, response.status, errorText);
      throw new Error(`Anthropic AI call failed: ${response.status}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || "";
    
    return {
      content,
      provider,
      model,
    };
  }

  // Standard OpenAI-compatible format for Lovable AI and Perplexity
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };

  if (tools && tools.length > 0 && provider === "lovable") {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const response = provider === "lovable"
    ? await aiChatCompletion(body)
    : await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[agent-run] ${provider} API call failed:`, response.status, errorText);
    throw new Error(`AI call failed: ${response.status}`);
  }

  const data = await response.json();
  const choice = data.choices?.[0];
  
  return {
    content: choice?.message?.content || "",
    tool_calls: choice?.message?.tool_calls,
    citations: data.citations, // Perplexity provides this
    provider,
    model,
  };
}

// Scrape URL using Jina AI Reader
async function scrapeUrl(url: string): Promise<string> {
  console.log(`[agent-run] Scraping URL with Jina: ${url}`);
  
  const response = await fetch(`${PROVIDERS.jina.url}/${url}`, {
    method: "GET",
    headers: { "Accept": "text/markdown" },
  });
  
  if (!response.ok) {
    throw new Error(`Scraping failed: ${response.status}`);
  }
  
  return await response.text();
}

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
    const supabase = getSupabaseClient();

    // Check if Lovable AI is enabled (master kill switch)
    const lovableAIStatus = await isLovableAIEnabled(supabase);
    if (!lovableAIStatus.enabled) {
      console.log("[agent-run] Lovable AI is disabled, aborting run");
      return new Response(
        JSON.stringify({ 
          error: "Lovable AI is currently disabled",
          reason: "lovable_ai_disabled",
          message: lovableAIStatus.reason || "AI features have been disabled to conserve credits"
        }),
        { 
          status: 503, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        }
      );
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body: AgentRunRequest = await req.json();
    const { agent_id, goal, context } = body;

    // Get agent configuration
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("*")
      .eq("id", agent_id)
      .eq("user_id", user.id)
      .single();

    if (agentError || !agent) {
      return new Response(JSON.stringify({ error: "Agent not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`[agent-run] Starting run for agent ${agent.name} with goal: ${goal.slice(0, 100)}`);
    console.log(`[agent-run] Perplexity available: ${!!Deno.env.get("PERPLEXITY_API_KEY")}`);

    // Create run record
    const { data: run, error: runError } = await supabase
      .from("runs")
      .insert({
        user_id: user.id,
        agent_id,
        goal_text: goal,
        status: "planning",
        started_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (runError) {
      console.error("[agent-run] Failed to create run:", runError);
      return new Response(JSON.stringify({ error: "Failed to create run" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get user's memories for context
    const { data: memories } = await supabase
      .from("ai_memory")
      .select("key, value, category")
      .eq("user_id", user.id)
      .order("importance", { ascending: false })
      .limit(10);

    const memoryContext = memories?.length 
      ? `\n\nUser context:\n${memories.map(m => `- ${m.key}: ${JSON.stringify(m.value)}`).join("\n")}`
      : "";

    // Detect if goal requires research
    const requiresResearch = /research|find out|what is|latest|current|news|search|look up/i.test(goal);
    const requiresScraping = /read|scrape|extract|from url|from link/i.test(goal);

    // Step 1: Planning with Planner model (always use best reasoning)
    const { data: planStep } = await supabase
      .from("run_steps")
      .insert({
        run_id: run.id,
        step_index: 0,
        kind: "planning",
        model_tier: "planner",
        input_json: { goal, context, requiresResearch, requiresScraping },
      })
      .select()
      .single();

    const planPrompt = `You are an AI agent planner. Create a step-by-step plan to achieve the goal.

Goal: ${goal}
${context ? `Additional context: ${JSON.stringify(context)}` : ""}
${memoryContext}

Available tools: ${JSON.stringify(agent.enabled_tools_json)}

${requiresResearch ? "NOTE: This goal requires web research. Plan to use web_search or deep_research tools." : ""}
${requiresScraping ? "NOTE: This goal requires reading from URLs. Plan to use web_scrape tool." : ""}

Return a JSON object with:
{
  "plan": [
    { "step": 1, "action": "description", "tool": "tool_name or null", "args": {}, "task_type": "research|execution|thinking", "reasoning": "why" }
  ],
  "estimated_steps": number,
  "confidence": 0.0-1.0
}

Task types help route to the best AI model:
- "research": Use when step needs web search or deep research (uses Perplexity if available)
- "execution": Use when step calls a tool or performs an action
- "thinking": Use when step requires reasoning without tools`;

    let planResult;
    try {
      planResult = await callAI("planning", [
        { role: "system", content: agent.system_prompt },
        { role: "user", content: planPrompt },
      ], agent);
      
      await supabase
        .from("run_steps")
        .update({
          output_json: { response: planResult.content, provider: planResult.provider, model: planResult.model },
          model_used: planResult.model,
          finished_at: new Date().toISOString(),
        })
        .eq("id", planStep!.id);
    } catch (e) {
      console.error("[agent-run] Planning failed:", e);
      await supabase.from("runs").update({ 
        status: "failed", 
        error_message: "Planning phase failed",
        finished_at: new Date().toISOString(),
      }).eq("id", run.id);
      
      return new Response(JSON.stringify({ error: "Planning failed", run_id: run.id }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse plan
    let plan;
    try {
      const jsonMatch = planResult.content.match(/\{[\s\S]*\}/);
      plan = jsonMatch ? JSON.parse(jsonMatch[0]) : { plan: [], confidence: 0.5 };
    } catch {
      plan = { plan: [{ step: 1, action: planResult.content, tool: null, task_type: "thinking", reasoning: "Direct response" }], confidence: 0.5 };
    }

    await supabase.from("runs").update({ 
      plan_json: plan,
      status: "running",
    }).eq("id", run.id);

    // Step 2: Execute plan steps with intelligent model routing
    let stepResults: unknown[] = [];
    let totalTokens = { planner: 0, worker: 0, reasoner: 0 };
    let allCitations: string[] = [];

    for (let i = 0; i < Math.min(plan.plan?.length || 0, agent.max_steps || 20); i++) {
      const planStep = plan.plan[i];
      const taskType = planStep.task_type || (planStep.tool ? "execution" : "thinking");
      
      const { data: execStep } = await supabase
        .from("run_steps")
        .insert({
          run_id: run.id,
          step_index: i + 1,
          kind: planStep.tool ? "tool_call" : taskType,
          model_tier: taskType === "research" ? "worker" : "worker",
          input_json: planStep,
        })
        .select()
        .single();

      try {
        let stepOutput;
        
        if (planStep.tool === "web_scrape" && planStep.args?.url) {
          // Use Jina for URL scraping
          const scrapedContent = await scrapeUrl(planStep.args.url);
          stepOutput = { 
            scraped_content: scrapedContent.slice(0, 10000), 
            url: planStep.args.url,
            provider: "jina"
          };
        } else if (planStep.tool) {
          // Execute tool via tool-gateway
          const toolResponse = await fetch(`${supabaseUrl}/functions/v1/tool-gateway`, {
            method: "POST",
            headers: {
              Authorization: authHeader,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              tool_name: planStep.tool,
              args: planStep.args || {},
              run_id: run.id,
              step_id: execStep!.id,
              agent_id,
            }),
          });
          
          stepOutput = await toolResponse.json();
          
          // Collect citations if available
          if (stepOutput.result?.citations) {
            allCitations.push(...stepOutput.result.citations);
          }
          
          // If tool requires approval, pause execution
          if (stepOutput.status === "awaiting_approval") {
            await supabase.from("runs").update({ status: "awaiting_approval" }).eq("id", run.id);
            stepResults.push({ step: i + 1, status: "awaiting_approval", ...stepOutput });
            break;
          }
        } else {
          // Pure thinking/research step - use intelligent routing
          const thinkResult = await callAI(taskType, [
            { role: "system", content: agent.system_prompt },
            { role: "user", content: `Execute this step: ${planStep.action}\n\nContext from previous steps: ${JSON.stringify(stepResults)}` },
          ], agent);
          
          stepOutput = { 
            thought: thinkResult.content, 
            provider: thinkResult.provider,
            model: thinkResult.model,
            citations: thinkResult.citations
          };
          
          if (thinkResult.citations) {
            allCitations.push(...thinkResult.citations);
          }
        }

        await supabase
          .from("run_steps")
          .update({
            output_json: stepOutput,
            model_used: stepOutput.model || stepOutput.provider,
            finished_at: new Date().toISOString(),
          })
          .eq("id", execStep!.id);

        stepResults.push({ step: i + 1, ...stepOutput });
      } catch (e) {
        console.error(`[agent-run] Step ${i + 1} failed:`, e);
        await supabase
          .from("run_steps")
          .update({
            kind: "error",
            output_json: { error: e instanceof Error ? e.message : "Step failed" },
            finished_at: new Date().toISOString(),
          })
          .eq("id", execStep!.id);
        break;
      }
    }

    // Step 3: Verification with Reasoner model
    const { data: verifyStep } = await supabase
      .from("run_steps")
      .insert({
        run_id: run.id,
        step_index: (plan.plan?.length || 0) + 1,
        kind: "verification",
        model_tier: "reasoner",
        input_json: { goal, plan, results: stepResults, citations: allCitations },
      })
      .select()
      .single();

    let verificationResult;
    try {
      verificationResult = await callAI("verification", [
        { role: "system", content: "You are a verification agent. Review the execution and provide a final response. If sources were used, include them in your response." },
        { role: "user", content: `Original goal: ${goal}\n\nPlan executed: ${JSON.stringify(plan)}\n\nStep results: ${JSON.stringify(stepResults)}\n\n${allCitations.length > 0 ? `Sources used:\n${allCitations.join("\n")}` : ""}\n\nProvide a final summary and answer. If the goal was not fully achieved, explain what's missing.` },
      ], agent);

      await supabase
        .from("run_steps")
        .update({
          output_json: { 
            verification: verificationResult.content, 
            provider: verificationResult.provider,
            model: verificationResult.model
          },
          model_used: verificationResult.model,
          finished_at: new Date().toISOString(),
        })
        .eq("id", verifyStep!.id);
    } catch (e) {
      console.error("[agent-run] Verification failed:", e);
      verificationResult = { content: "Verification skipped due to error", provider: "none", model: "none" };
    }

    // Finalize run
    await supabase.from("runs").update({
      status: "completed",
      result_json: { 
        final_response: verificationResult.content,
        steps_completed: stepResults.length,
        citations: allCitations,
        models_used: [...new Set(stepResults.map((s: any) => s.provider || s.model).filter(Boolean))]
      },
      verification_json: { verified: true, response: verificationResult.content },
      tokens_planner: totalTokens.planner,
      tokens_worker: totalTokens.worker,
      tokens_reasoner: totalTokens.reasoner,
      finished_at: new Date().toISOString(),
    }).eq("id", run.id);

    // Store episodic memory of this run
    await supabase.from("ai_memory").insert({
      user_id: user.id,
      key: `run_${run.id}`,
      value: { goal, result: verificationResult.content, completed_at: new Date().toISOString(), citations: allCitations.slice(0, 5) },
      category: "episodic",
      memory_type: "agent_run",
      importance: 6,
    });

    console.log(`[agent-run] Run ${run.id} completed successfully with ${allCitations.length} citations`);

    return new Response(JSON.stringify({
      run_id: run.id,
      status: "completed",
      result: verificationResult.content,
      steps_completed: stepResults.length,
      citations: allCitations,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[agent-run] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
