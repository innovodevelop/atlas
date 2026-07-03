import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { aiChatCompletion, hasAIKey } from "../_shared/aiGateway.ts";

interface ValidationRequest {
  entryId: string;
  entryType: "knowledge" | "research" | "memory" | "context";
  topic: string;
  content: string;
  source?: string;
  userId?: string;
}

interface ValidationResult {
  model: string;
  verdict: "valid" | "suspicious" | "fake";
  confidence: number;
  reasoning: string;
  sourcesChecked: string[];
  processingTimeMs: number;
}

interface ConsensusResult {
  finalVerdict: "valid" | "suspicious" | "fake";
  consensusScore: number;
  agreementCount: number;
  validatorResults: ValidationResult[];
}

// Provider configuration for multi-model validation
const PROVIDERS = {
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-4-20250514",
  },
  lovable: {
    url: "https://ai.gateway.lovable.dev/v1/chat/completions",
    model: "google/gemini-2.5-pro",
  },
  perplexity: {
    url: "https://api.perplexity.ai/chat/completions",
    model: "sonar-pro",
  },
};

const VALIDATION_PROMPT = `You are a rigorous fact-checker and validator. Analyze the following information for accuracy and reliability.

Topic: {topic}
Content: {content}
Source: {source}

Evaluate based on:
1. **Factual Accuracy**: Can this be verified with known facts?
2. **Logical Coherence**: Does it make logical sense?
3. **Source Credibility**: Is the source reliable?
4. **Consistency**: Does it contradict well-established knowledge?
5. **Bias Detection**: Are there signs of misinformation or bias?

Respond ONLY with valid JSON:
{
  "verdict": "valid" | "suspicious" | "fake",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of your assessment",
  "red_flags": ["list of any concerns"],
  "sources_to_verify": ["suggested sources to cross-reference"]
}`;

// Validate with Claude
async function validateWithClaude(
  entry: ValidationRequest,
  anthropicKey: string
): Promise<ValidationResult> {
  const startTime = Date.now();
  
  try {
    const prompt = VALIDATION_PROMPT
      .replace("{topic}", entry.topic)
      .replace("{content}", entry.content)
      .replace("{source}", entry.source || "unknown");

    const response = await fetch(PROVIDERS.anthropic.url, {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PROVIDERS.anthropic.model,
        max_tokens: 1024,
        messages: [
          { role: "user", content: prompt }
        ],
      }),
    });

    if (!response.ok) {
      console.error("[validation-engine] Claude error:", response.status);
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || "{}";
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { verdict: "suspicious", confidence: 0.5, reasoning: "Parse error" };

    return {
      model: "claude-sonnet-4",
      verdict: parsed.verdict || "suspicious",
      confidence: parsed.confidence || 0.5,
      reasoning: parsed.reasoning || "No reasoning provided",
      sourcesChecked: parsed.sources_to_verify || [],
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    console.error("[validation-engine] Claude validation error:", error);
    return {
      model: "claude-sonnet-4",
      verdict: "suspicious",
      confidence: 0.3,
      reasoning: `Validation error: ${error instanceof Error ? error.message : "unknown"}`,
      sourcesChecked: [],
      processingTimeMs: Date.now() - startTime,
    };
  }
}

// Validate with Gemini
async function validateWithGemini(
  entry: ValidationRequest
): Promise<ValidationResult> {
  const startTime = Date.now();

  try {
    const prompt = VALIDATION_PROMPT
      .replace("{topic}", entry.topic)
      .replace("{content}", entry.content)
      .replace("{source}", entry.source || "unknown");

    const response = await aiChatCompletion({
        model: PROVIDERS.lovable.model,
        messages: [
          { role: "system", content: "You are a fact-checker. Always respond with valid JSON only." },
          { role: "user", content: prompt }
        ],
    });

    if (!response.ok) {
      console.error("[validation-engine] Gemini error:", response.status);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { verdict: "suspicious", confidence: 0.5, reasoning: "Parse error" };

    return {
      model: "gemini-2.5-pro",
      verdict: parsed.verdict || "suspicious",
      confidence: parsed.confidence || 0.5,
      reasoning: parsed.reasoning || "No reasoning provided",
      sourcesChecked: parsed.sources_to_verify || [],
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    console.error("[validation-engine] Gemini validation error:", error);
    return {
      model: "gemini-2.5-pro",
      verdict: "suspicious",
      confidence: 0.3,
      reasoning: `Validation error: ${error instanceof Error ? error.message : "unknown"}`,
      sourcesChecked: [],
      processingTimeMs: Date.now() - startTime,
    };
  }
}

// Validate with Perplexity
async function validateWithPerplexity(
  entry: ValidationRequest,
  perplexityKey: string
): Promise<ValidationResult> {
  const startTime = Date.now();

  try {
    const response = await fetch(PROVIDERS.perplexity.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${perplexityKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: PROVIDERS.perplexity.model,
        messages: [
          { 
            role: "system", 
            content: "You are a fact-checker with access to real-time web information. Verify the following claim and respond with JSON only: { verdict: 'valid'|'suspicious'|'fake', confidence: 0-1, reasoning: string, sources_checked: string[] }" 
          },
          { 
            role: "user", 
            content: `Verify this information:\nTopic: ${entry.topic}\nClaim: ${entry.content}\nSource: ${entry.source || "unknown"}` 
          }
        ],
      }),
    });

    if (!response.ok) {
      console.error("[validation-engine] Perplexity error:", response.status);
      throw new Error(`Perplexity API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const citations = data.citations || [];
    
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { verdict: "suspicious", confidence: 0.5, reasoning: "Parse error" };

    return {
      model: "perplexity-sonar-pro",
      verdict: parsed.verdict || "suspicious",
      confidence: parsed.confidence || 0.5,
      reasoning: parsed.reasoning || "No reasoning provided",
      sourcesChecked: [...(parsed.sources_checked || []), ...citations],
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    console.error("[validation-engine] Perplexity validation error:", error);
    return {
      model: "perplexity-sonar-pro",
      verdict: "suspicious",
      confidence: 0.3,
      reasoning: `Validation error: ${error instanceof Error ? error.message : "unknown"}`,
      sourcesChecked: [],
      processingTimeMs: Date.now() - startTime,
    };
  }
}

// Calculate consensus from multiple validators
function calculateConsensus(results: ValidationResult[]): ConsensusResult {
  const validVotes = results.filter(r => r.verdict === "valid").length;
  const suspiciousVotes = results.filter(r => r.verdict === "suspicious").length;
  const fakeVotes = results.filter(r => r.verdict === "fake").length;

  const avgConfidence = results.reduce((sum, r) => sum + r.confidence, 0) / results.length;

  let finalVerdict: "valid" | "suspicious" | "fake";
  let agreementCount: number;

  if (fakeVotes >= 2) {
    finalVerdict = "fake";
    agreementCount = fakeVotes;
  } else if (validVotes >= 2) {
    finalVerdict = "valid";
    agreementCount = validVotes;
  } else if (suspiciousVotes >= 2) {
    finalVerdict = "suspicious";
    agreementCount = suspiciousVotes;
  } else {
    finalVerdict = "suspicious";
    agreementCount = Math.max(validVotes, suspiciousVotes, fakeVotes);
  }

  const consensusScore = (agreementCount / results.length) * avgConfidence;

  return {
    finalVerdict,
    consensusScore,
    agreementCount,
    validatorResults: results,
  };
}

// Store validation logs
async function storeValidationLogs(
  supabase: ReturnType<typeof getSupabaseClient>,
  entryId: string,
  entryType: string,
  results: ValidationResult[]
) {
  const logs = results.map(r => ({
    entry_id: entryId,
    entry_type: entryType,
    validator_model: r.model,
    verdict: r.verdict,
    confidence: r.confidence,
    reasoning: r.reasoning,
    sources_checked: r.sourcesChecked,
    processing_time_ms: r.processingTimeMs,
  }));

  await supabase.from("validation_logs").insert(logs);
}

// Update entry with validation results
async function updateEntryValidation(
  supabase: ReturnType<typeof getSupabaseClient>,
  entryId: string,
  entryType: string,
  consensus: ConsensusResult
) {
  const updates = {
    is_validated: true,
    is_fake: consensus.finalVerdict === "fake",
    validation_score: consensus.consensusScore,
    validation_consensus: {
      verdict: consensus.finalVerdict,
      agreement: consensus.agreementCount,
      validators: consensus.validatorResults.map(r => ({
        model: r.model,
        verdict: r.verdict,
        confidence: r.confidence,
      })),
    },
    validated_at: new Date().toISOString(),
  };

  const tableMap: Record<string, string> = {
    knowledge: "atlas_knowledge_entries",
    research: "atlas_research_topics",
    memory: "ai_memory",
  };

  const table = tableMap[entryType];
  if (table) {
    await supabase.from(table).update(updates).eq("id", entryId);
  }
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { entries, immediate = false } = await req.json();
    
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");

    if (!hasAIKey()) {
      return errorResponse("No AI key configured (GEMINI_API_KEY)", 500);
    }

    const supabase = getSupabaseClient();

    const validationEntries: ValidationRequest[] = Array.isArray(entries) ? entries : [entries];
    const results: Array<{ entryId: string; consensus: ConsensusResult }> = [];

    console.log(`[validation-engine] Validating ${validationEntries.length} entries`);

    const processEntry = async (entry: ValidationRequest) => {
      const validationPromises: Promise<ValidationResult>[] = [];

      validationPromises.push(validateWithGemini(entry));

      if (ANTHROPIC_API_KEY) {
        validationPromises.push(validateWithClaude(entry, ANTHROPIC_API_KEY));
      }

      if (PERPLEXITY_API_KEY) {
        validationPromises.push(validateWithPerplexity(entry, PERPLEXITY_API_KEY));
      }

      if (validationPromises.length < 2) {
        validationPromises.push(validateWithGemini(
          { ...entry, content: `STRICT VERIFICATION: ${entry.content}` }
        ));
      }

      const validatorResults = await Promise.all(validationPromises);
      const consensus = calculateConsensus(validatorResults);

      console.log(`[validation-engine] Entry ${entry.entryId}: ${consensus.finalVerdict} (score: ${consensus.consensusScore.toFixed(2)})`);

      await Promise.all([
        storeValidationLogs(supabase, entry.entryId, entry.entryType, validatorResults),
        updateEntryValidation(supabase, entry.entryId, entry.entryType, consensus),
      ]);

      return { entryId: entry.entryId, consensus };
    };

    if (immediate) {
      const allResults = await Promise.all(validationEntries.map(processEntry));
      results.push(...allResults);
    } else {
      Promise.all(validationEntries.map(processEntry))
        .then(r => console.log(`[validation-engine] Background validation complete: ${r.length} entries`))
        .catch(e => console.error("[validation-engine] Background validation error:", e));

      return jsonResponse({ 
        message: `Validation queued for ${validationEntries.length} entries`,
        queued: true,
      });
    }

    return jsonResponse({
      success: true,
      validated: results.length,
      results: results.map(r => ({
        entryId: r.entryId,
        verdict: r.consensus.finalVerdict,
        score: r.consensus.consensusScore,
        agreement: `${r.consensus.agreementCount}/${r.consensus.validatorResults.length}`,
      })),
    });
  } catch (error) {
    console.error("[validation-engine] Error:", error);
    return errorResponse(error instanceof Error ? error.message : "Unknown error");
  }
});
