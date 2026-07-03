import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, corsHeaders, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { 
  isLearningEnabled, 
  isProviderHealthy,
  recordSuccess, 
  recordError
} from "../_shared/providerStatus.ts";
import { isLovableAIEnabled } from "../_shared/providerStatus.ts";
import { aiChatCompletion, hasAIKey } from "../_shared/aiGateway.ts";

interface KnowledgeExtraction {
  topic: string;
  content: Record<string, unknown>;
  category: string;
  confidence: number;
}

// Extract knowledge using AI
async function extractKnowledge(
  conversation: Array<{ role: string; content: string }>,
  supabase: ReturnType<typeof getSupabaseClient>
): Promise<KnowledgeExtraction[]> {
  const conversationText = conversation
    .map(m => `${m.role}: ${m.content}`)
    .join("\n");

  const startTime = Date.now();

  const response = await aiChatCompletion({
      model: "google/gemini-2.5-flash",
      messages: [
        {
          role: "system",
          content: `You are a knowledge extraction AI. Analyze conversations and extract valuable information to remember.

Extract these types of knowledge:
1. **user_preference** - User's likes, dislikes, preferences, habits
2. **personal_info** - Names of people, relationships, important dates
3. **learned_fact** - Facts, information, or insights shared
4. **task_context** - Ongoing tasks, projects, goals
5. **emotional_state** - User's feelings, concerns, celebrations

For each piece of knowledge, provide:
- topic: A short descriptive title (2-5 words)
- content: Structured data about the knowledge
- category: One of the types above
- confidence: 0.0-1.0 how confident you are this is worth remembering

Only extract genuinely useful information. Skip generic greetings or trivial exchanges.
Return a JSON array of extractions. If nothing worth extracting, return an empty array.`
        },
        {
          role: "user",
          content: `Extract knowledge from this conversation:\n\n${conversationText}`
        }
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "store_knowledge",
            description: "Store extracted knowledge from the conversation",
            parameters: {
              type: "object",
              properties: {
                extractions: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      topic: { type: "string", description: "Short descriptive title" },
                      content: { type: "object", description: "Structured knowledge data" },
                      category: { 
                        type: "string", 
                        enum: ["user_preference", "personal_info", "learned_fact", "task_context", "emotional_state"]
                      },
                      confidence: { type: "number", minimum: 0, maximum: 1 }
                    },
                    required: ["topic", "content", "category", "confidence"]
                  }
                }
              },
              required: ["extractions"]
            }
          }
        }
      ],
      tool_choice: { type: "function", function: { name: "store_knowledge" } }
  });

  const responseTime = Date.now() - startTime;

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[atlas-knowledge] Extraction failed:", errorText);
    await recordError(supabase, 'lovable_ai', response.status, errorText);
    return [];
  }

  // Record successful call
  await recordSuccess(supabase, 'lovable_ai', responseTime);

  const result = await response.json();
  
  try {
    const toolCall = result.choices?.[0]?.message?.tool_calls?.[0];
    if (toolCall?.function?.arguments) {
      const parsed = JSON.parse(toolCall.function.arguments);
      return parsed.extractions || [];
    }
  } catch (e) {
    console.error("[atlas-knowledge] Failed to parse extraction:", e);
  }

  return [];
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { conversation, userId, source = "conversation", learningTopic, maxTopics } = await req.json();

    const supabase = getSupabaseClient();

    // Check if Lovable AI is enabled (master kill switch)
    const lovableAIStatus = await isLovableAIEnabled(supabase);
    if (!lovableAIStatus.enabled) {
      console.log("[atlas-knowledge] Lovable AI is disabled, skipping extraction");
      return jsonResponse({ 
        success: false, 
        extracted: 0, 
        reason: "lovable_ai_disabled",
        message: "Lovable AI is currently disabled"
      });
    }

    if (!hasAIKey()) {
      return errorResponse("No AI key configured (GEMINI_API_KEY)", 500);
    }

    if (!conversation || !Array.isArray(conversation)) {
      return errorResponse("Invalid conversation data", 400);
    }

    // Check if learning is enabled
    const learningSettings = await isLearningEnabled(supabase);
    if (!learningSettings.enabled) {
      console.log("[atlas-knowledge] Learning is disabled, skipping extraction");
      return jsonResponse({ success: true, extracted: 0, reason: "learning_disabled" });
    }

    // Check if AI provider is healthy
    const isHealthy = await isProviderHealthy(supabase, 'lovable_ai');
    if (!isHealthy) {
      console.log("[atlas-knowledge] AI provider unhealthy, skipping extraction");
      return jsonResponse({ success: true, extracted: 0, reason: "provider_unhealthy" });
    }

    console.log("[atlas-knowledge] Extracting knowledge from conversation, user:", userId);
    console.log("[atlas-knowledge] Learning topic:", learningTopic || "general");

    // Extract knowledge using AI
    const extractions = await extractKnowledge(conversation, supabase);
    console.log("[atlas-knowledge] Extracted", extractions.length, "knowledge entries");

    if (extractions.length === 0) {
      return jsonResponse({ success: true, extracted: 0 });
    }

    // Limit extractions based on settings
    const limitedExtractions = maxTopics 
      ? extractions.slice(0, maxTopics) 
      : extractions;

    const entries = limitedExtractions
      .filter((e: KnowledgeExtraction) => e.confidence >= 0.5) // Only store confident extractions
      .map((e: KnowledgeExtraction) => ({
        user_id: userId || null,
        topic: e.topic,
        content: e.content,
        category: e.category,
        source: source,
        confidence: e.confidence,
        relevance_score: e.confidence,
      }));

    if (entries.length > 0) {
      const { error } = await supabase
        .from("atlas_knowledge_entries")
        .insert(entries);

      if (error) {
        console.error("[atlas-knowledge] Failed to store knowledge:", error);
        return errorResponse("Failed to store knowledge", 500);
      }

      console.log("[atlas-knowledge] Stored", entries.length, "knowledge entries");
    }

    return jsonResponse({ 
      success: true, 
      extracted: extractions.length,
      stored: entries.length 
    });
  } catch (error) {
    console.error("[atlas-knowledge] Error:", error);
    return errorResponse(error instanceof Error ? error.message : "Unknown error");
  }
});