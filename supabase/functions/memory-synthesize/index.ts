import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, corsHeaders, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { aiChatCompletion } from "../_shared/aiGateway.ts";

interface MemoryItem {
  id: string;
  key: string;
  value: unknown;
  category: string;
  importance: number;
  created_at: string;
  updated_at: string;
}

interface SynthesisRequest {
  user_id?: string;
  operation: "consolidate" | "resolve_conflicts" | "extract_insights" | "prune";
  options?: {
    category_filter?: string[];
    time_range_days?: number;
    min_importance?: number;
  };
}

// Claude Opus 4.5 for advanced memory reasoning
const ANTHROPIC_CONFIG = {
  url: "https://api.anthropic.com/v1/messages",
  model: "claude-opus-4-5-20251124",
};

// Memory synthesis tools for Claude Opus 4.5
const MEMORY_TOOLS = [
  {
    name: "identify_themes",
    description: "Identify recurring themes and patterns across memories",
    input_schema: {
      type: "object",
      properties: {
        memories: {
          type: "array",
          items: { type: "object" },
          description: "Array of memory objects to analyze"
        }
      },
      required: ["memories"]
    }
  },
  {
    name: "detect_contradictions",
    description: "Find contradicting or conflicting memories that need resolution",
    input_schema: {
      type: "object",
      properties: {
        memories: {
          type: "array",
          items: { type: "object" },
          description: "Array of memory objects to check for contradictions"
        }
      },
      required: ["memories"]
    }
  },
  {
    name: "create_synthesis",
    description: "Create a synthesized memory entry from multiple related memories",
    input_schema: {
      type: "object",
      properties: {
        source_memories: {
          type: "array",
          items: { type: "string" },
          description: "IDs of memories being synthesized"
        },
        synthesized_key: { type: "string", description: "Key for the new synthesized memory" },
        synthesized_value: { type: "string", description: "Consolidated value" },
        category: { type: "string", description: "Category for the synthesis" },
        importance: { type: "number", description: "Importance score 1-10" },
        reasoning: { type: "string", description: "Why these memories were consolidated" }
      },
      required: ["source_memories", "synthesized_key", "synthesized_value", "category", "importance"]
    }
  },
  {
    name: "resolve_conflict",
    description: "Resolve a contradiction between memories by keeping the most accurate one",
    input_schema: {
      type: "object",
      properties: {
        conflicting_memories: {
          type: "array",
          items: { type: "string" },
          description: "IDs of conflicting memories"
        },
        resolution: {
          type: "string",
          enum: ["keep_newer", "keep_older", "merge", "keep_both", "discard_both"],
          description: "How to resolve the conflict"
        },
        merged_value: { type: "string", description: "If merging, the new merged value" },
        reasoning: { type: "string", description: "Why this resolution was chosen" }
      },
      required: ["conflicting_memories", "resolution", "reasoning"]
    }
  },
  {
    name: "extract_insight",
    description: "Extract a meta-insight from patterns across multiple memories",
    input_schema: {
      type: "object",
      properties: {
        insight_key: { type: "string", description: "Key for the insight" },
        insight_value: { type: "string", description: "The extracted insight" },
        supporting_memories: {
          type: "array",
          items: { type: "string" },
          description: "Memory IDs that support this insight"
        },
        confidence: { type: "number", description: "Confidence score 0-1" }
      },
      required: ["insight_key", "insight_value", "supporting_memories", "confidence"]
    }
  }
];

async function callClaudeOpus(
  systemPrompt: string,
  userPrompt: string,
  tools?: typeof MEMORY_TOOLS
): Promise<{ content: string; tool_use?: Array<{ name: string; input: unknown }> }> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");

  if (!apiKey) {
    // Fallback: run synthesis on the default AI gateway (Gemini) with the
    // same tools translated to OpenAI function-calling format, and map the
    // response back to the Anthropic-style shape callers expect.
    console.log("[memory-synthesize] No ANTHROPIC_API_KEY, using AI gateway fallback");
    const openAiTools = (tools ?? []).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    const response = await aiChatCompletion({
      model: "google/gemini-2.5-pro",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      tools: openAiTools.length > 0 ? openAiTools : undefined,
      stream: false,
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`AI gateway synthesis failed: ${response.status} ${errorText.slice(0, 200)}`);
    }
    const data = await response.json();
    const message = data.choices?.[0]?.message;
    return {
      content: message?.content || "",
      tool_use: (message?.tool_calls || []).map((tc: { function?: { name?: string; arguments?: string } }) => ({
        name: tc.function?.name || "",
        input: (() => { try { return JSON.parse(tc.function?.arguments || "{}"); } catch { return {}; } })(),
      })),
    };
  }

  const body: Record<string, unknown> = {
    model: ANTHROPIC_CONFIG.model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  console.log(`[memory-synthesize] Calling Claude Opus 4.5 for memory synthesis`);

  const response = await fetch(ANTHROPIC_CONFIG.url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[memory-synthesize] Claude API error:`, response.status, errorText);
    throw new Error(`Claude API error: ${response.status}`);
  }

  const data = await response.json();
  
  let textContent = "";
  const toolCalls: Array<{ name: string; input: unknown }> = [];
  
  for (const block of data.content || []) {
    if (block.type === "text") {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({ name: block.name, input: block.input });
    }
  }

  return {
    content: textContent,
    tool_use: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const supabase = getSupabaseClient();

    // Check for auth if user_id not provided
    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    
    if (authHeader) {
      const token = authHeader.replace("Bearer ", "");
      const { data: { user } } = await supabase.auth.getUser(token);
      userId = user?.id || null;
    }

    const body: SynthesisRequest = await req.json();
    userId = body.user_id || userId;

    if (!userId) {
      return errorResponse("User ID required", 400);
    }

    const { operation, options = {} } = body;

    console.log(`[memory-synthesize] Operation: ${operation} for user: ${userId}`);

    // Fetch memories based on options
    let query = supabase
      .from("ai_memory")
      .select("*")
      .eq("user_id", userId)
      .order("importance", { ascending: false });

    if (options.category_filter && options.category_filter.length > 0) {
      query = query.in("category", options.category_filter);
    }

    if (options.time_range_days) {
      const cutoff = new Date(Date.now() - options.time_range_days * 24 * 60 * 60 * 1000).toISOString();
      query = query.gte("created_at", cutoff);
    }

    if (options.min_importance) {
      query = query.gte("importance", options.min_importance);
    }

    const { data: memories, error: memoryError } = await query.limit(100);

    if (memoryError) {
      console.error("[memory-synthesize] Failed to fetch memories:", memoryError);
      return errorResponse("Failed to fetch memories", 500);
    }

    if (!memories || memories.length === 0) {
      return jsonResponse({ 
        status: "no_memories",
        message: "No memories found matching criteria"
      });
    }

    console.log(`[memory-synthesize] Processing ${memories.length} memories`);

    const systemPrompt = `You are Atlas's Memory Core, powered by Claude Opus 4.5. Your role is to analyze, synthesize, and manage the user's personal memories with deep understanding and emotional intelligence.

You have access to memory tools to perform operations. Use them thoughtfully to help maintain a coherent, non-redundant memory bank while preserving important nuances.

Key principles:
1. Preserve emotional context - feelings and personal significance matter
2. Identify patterns across memories that reveal deeper truths about the user
3. Resolve contradictions gracefully - people change, and that's okay
4. Extract insights that the user themselves might not have noticed
5. Never delete something unless absolutely sure it's redundant`;

    let userPrompt = "";
    
    switch (operation) {
      case "consolidate":
        userPrompt = `Analyze these memories and consolidate related ones into synthesized entries. Look for:
- Memories that say the same thing differently
- Related preferences that could be grouped
- Facts that could be combined into richer understanding

Memories to analyze:
${JSON.stringify(memories.map(m => ({ id: m.id, key: m.key, value: m.value, category: m.category, importance: m.importance })), null, 2)}

Use the create_synthesis tool for each consolidation you identify.`;
        break;

      case "resolve_conflicts":
        userPrompt = `Scan these memories for contradictions or conflicts.

Memories to check:
${JSON.stringify(memories.map(m => ({ id: m.id, key: m.key, value: m.value, category: m.category, updated_at: m.updated_at })), null, 2)}

Use detect_contradictions first, then resolve_conflict for each issue found.`;
        break;

      case "extract_insights":
        userPrompt = `Analyze these memories to extract meta-insights about the user.

Memories to analyze:
${JSON.stringify(memories.map(m => ({ id: m.id, key: m.key, value: m.value, category: m.category })), null, 2)}

Use identify_themes first, then extract_insight for each significant pattern you discover.

Additionally, look for COMMUNICATION-STYLE observations — how the user prefers
to be spoken to (e.g. "prefers short direct answers", "likes being called by
nickname", "enjoys humor", "dislikes emoji", "responds well to follow-up
questions"). For each one, call extract_insight with an insight_key prefixed
"style_" (e.g. "style_prefers_short_answers") — these are stored separately
and shape Atlas's tone in future conversations.`;
        break;

      case "prune":
        userPrompt = `Review these memories and identify candidates for removal:
- Truly duplicate information
- Outdated facts that have been superseded
- Very low-importance items that add noise

Memories to review:
${JSON.stringify(memories.map(m => ({ id: m.id, key: m.key, value: m.value, category: m.category, importance: m.importance, updated_at: m.updated_at })), null, 2)}

Be conservative - when in doubt, keep the memory.`;
        break;

      default:
        return errorResponse("Unknown operation", 400);
    }

    const result = await callClaudeOpus(systemPrompt, userPrompt, MEMORY_TOOLS);

    const operations: Array<{ tool: string; input: unknown; status: string }> = [];
    
    if (result.tool_use) {
      for (const toolCall of result.tool_use) {
        console.log(`[memory-synthesize] Executing tool: ${toolCall.name}`);
        
        try {
          switch (toolCall.name) {
            case "create_synthesis": {
              const input = toolCall.input as {
                synthesized_key: string;
                synthesized_value: string;
                category: string;
                importance: number;
                source_memories: string[];
              };
              
              await supabase.from("ai_memory").insert({
                user_id: userId,
                key: input.synthesized_key,
                value: { synthesized: true, content: input.synthesized_value, sources: input.source_memories },
                category: input.category,
                memory_type: "synthesized",
                importance: input.importance,
              });
              
              operations.push({ tool: toolCall.name, input, status: "completed" });
              break;
            }

            case "resolve_conflict": {
              const input = toolCall.input as {
                conflicting_memories: string[];
                resolution: string;
                merged_value?: string;
              };
              
              if (input.resolution === "keep_newer" || input.resolution === "discard_both") {
                const toRemove = input.resolution === "discard_both" 
                  ? input.conflicting_memories 
                  : input.conflicting_memories.slice(1);
                
                for (const memId of toRemove) {
                  await supabase.from("ai_memory").delete().eq("id", memId).eq("user_id", userId);
                }
              } else if (input.resolution === "merge" && input.merged_value) {
                const [keepId, ...removeIds] = input.conflicting_memories;
                await supabase.from("ai_memory")
                  .update({ value: input.merged_value, updated_at: new Date().toISOString() })
                  .eq("id", keepId)
                  .eq("user_id", userId);
                
                for (const memId of removeIds) {
                  await supabase.from("ai_memory").delete().eq("id", memId).eq("user_id", userId);
                }
              }
              
              operations.push({ tool: toolCall.name, input, status: "completed" });
              break;
            }

            case "extract_insight": {
              const input = toolCall.input as {
                insight_key: string;
                insight_value: string;
                supporting_memories: string[];
                confidence: number;
              };
              
              // style_ insights feed the Communication Preferences block of
              // the chat system prompt (category communication_style)
              const isStyle = input.insight_key.startsWith("style_");
              await supabase.from("ai_memory").insert({
                user_id: userId,
                key: isStyle ? input.insight_key : `insight_${input.insight_key}`,
                value: isStyle
                  ? input.insight_value
                  : {
                      insight: input.insight_value,
                      confidence: input.confidence,
                      sources: input.supporting_memories,
                      extracted_at: new Date().toISOString()
                    },
                category: isStyle ? "communication_style" : "insights",
                memory_type: "insight",
                importance: Math.min(10, Math.round(8 * input.confidence)),
              });
              
              operations.push({ tool: toolCall.name, input, status: "completed" });
              break;
            }

            case "identify_themes":
            case "detect_contradictions": {
              operations.push({ tool: toolCall.name, input: toolCall.input, status: "analyzed" });
              break;
            }

            default:
              operations.push({ tool: toolCall.name, input: toolCall.input, status: "unknown_tool" });
          }
        } catch (e) {
          console.error(`[memory-synthesize] Tool ${toolCall.name} failed:`, e);
          operations.push({ tool: toolCall.name, input: toolCall.input, status: "error" });
        }
      }
    }

    await supabase.from("atlas_health_metrics").insert({
      metric_type: "memory_synthesis",
      value: operations.length,
      context: {
        operation,
        memories_processed: memories.length,
        tools_executed: operations.map(o => o.tool),
        model: ANTHROPIC_CONFIG.model,
      },
    });

    console.log(`[memory-synthesize] Completed ${operation} with ${operations.length} tool executions`);

    return jsonResponse({
      status: "completed",
      operation,
      memories_analyzed: memories.length,
      tool_operations: operations,
      analysis: result.content,
      model: ANTHROPIC_CONFIG.model,
    });

  } catch (error) {
    console.error("[memory-synthesize] Error:", error);
    return errorResponse(error instanceof Error ? error.message : "Unknown error");
  }
});
