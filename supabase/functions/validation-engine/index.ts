// Validation engine v2 — GROUNDED fact checking (docs/architecture-memory-v2.md).
//
// v1 asked an LLM "does this sound accurate?" with no source text — that
// validates fluency, not truth (and it still called the dead Lovable gateway
// directly). v2 checks each claim AGAINST ITS STORED SOURCE: fetch the
// source_url the claim came from (atlas-research persists one per finding),
// and ask whether the source text actually supports the claim. Entries with
// no reachable source fall back to plausibility checking but are explicitly
// marked grounding:"none" and their confidence is capped — the UI and prompts
// must not present them as verified (invariant #3).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { aiChatCompletion, hasAIKey } from "../_shared/aiGateway.ts";
import { requireUserOrInternal, AuthError, authErrorResponse } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// deno-lint-ignore no-explicit-any
type SupabaseClient = any;

interface ValidationRequest {
  entryId: string;
  entryType: "knowledge" | "research" | "memory";
  topic: string;
  content: string;
  source?: string;
  source_url?: string;
}

type Grounding = "source" | "web" | "none";

interface ValidationResult {
  model: string;
  grounding: Grounding;
  verdict: "valid" | "suspicious" | "fake";
  confidence: number;
  reasoning: string;
  sourcesChecked: string[];
  processingTimeMs: number;
}

function getSupabaseClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 500) {
  return jsonResponse({ error: message }, status);
}

function extractSourceUrl(entry: ValidationRequest): string | null {
  const candidate = entry.source_url || entry.source || "";
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// Fetch the source text a claim was derived from (Firecrawl → markdown).
async function fetchSourceText(url: string): Promise<string | null> {
  const key = Deno.env.get("FIRECRAWL_API_KEY");
  if (!key) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const markdown: string | undefined = data?.data?.markdown;
    if (!markdown || markdown.length < 100) return null;
    // Cap the excerpt: enough to judge a claim, small enough to stay cheap.
    return markdown.slice(0, 8000);
  } catch {
    return null;
  }
}

async function runJudge(prompt: string, model: string): Promise<{ verdict: string; confidence: number; reasoning: string }> {
  const response = await aiChatCompletion({
    model,
    messages: [
      {
        role: "system",
        content: "You are a rigorous fact-checker. Respond ONLY with valid JSON matching the requested schema.",
      },
      { role: "user", content: prompt },
    ],
  });
  if (!response.ok) throw new Error(`AI gateway error: ${response.status}`);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  return jsonMatch
    ? JSON.parse(jsonMatch[0])
    : { verdict: "suspicious", confidence: 0.5, reasoning: "Parse error" };
}

// Grounded: does the stored source actually support the claim?
async function validateAgainstSource(
  entry: ValidationRequest,
  sourceUrl: string,
  sourceText: string,
): Promise<ValidationResult> {
  const startTime = Date.now();
  try {
    const parsed = await runJudge(
      `SOURCE TEXT (from ${sourceUrl}):\n"""\n${sourceText}\n"""\n\n` +
        `CLAIM (topic: ${entry.topic}):\n"""\n${entry.content}\n"""\n\n` +
        `Does the source text support the claim? Judge ONLY from the source text above — ` +
        `not from your own knowledge.\n` +
        `Respond with JSON: {"verdict": "supported" | "partial" | "unsupported", ` +
        `"confidence": 0.0-1.0, "reasoning": "one or two sentences citing the source"}`,
      "google/gemini-2.5-flash",
    );
    const verdictMap: Record<string, ValidationResult["verdict"]> = {
      supported: "valid",
      partial: "suspicious",
      unsupported: "fake",
    };
    return {
      model: "gemini-2.5-flash",
      grounding: "source",
      verdict: verdictMap[parsed.verdict] || "suspicious",
      confidence: Math.min(Math.max(parsed.confidence ?? 0.5, 0), 1),
      reasoning: parsed.reasoning || "No reasoning provided",
      sourcesChecked: [sourceUrl],
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      model: "gemini-2.5-flash",
      grounding: "source",
      verdict: "suspicious",
      confidence: 0.3,
      reasoning: `Grounded validation error: ${error instanceof Error ? error.message : "unknown"}`,
      sourcesChecked: [sourceUrl],
      processingTimeMs: Date.now() - startTime,
    };
  }
}

// Web-grounded second opinion when a Perplexity key exists (real-time search).
async function validateWithPerplexity(
  entry: ValidationRequest,
  perplexityKey: string,
): Promise<ValidationResult> {
  const startTime = Date.now();
  try {
    const response = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${perplexityKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [
          {
            role: "system",
            content:
              "You are a fact-checker with access to real-time web information. Verify the claim and respond with JSON only: { \"verdict\": \"valid\"|\"suspicious\"|\"fake\", \"confidence\": 0-1, \"reasoning\": string }",
          },
          { role: "user", content: `Verify: Topic: ${entry.topic}\nClaim: ${entry.content}` },
        ],
      }),
    });
    if (!response.ok) throw new Error(`Perplexity API error: ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const citations: string[] = data.citations || [];
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch
      ? JSON.parse(jsonMatch[0])
      : { verdict: "suspicious", confidence: 0.5, reasoning: "Parse error" };
    const verdict: ValidationResult["verdict"] = ["valid", "suspicious", "fake"].includes(parsed.verdict)
      ? parsed.verdict
      : "suspicious";
    return {
      model: "perplexity-sonar-pro",
      grounding: "web",
      verdict,
      confidence: parsed.confidence ?? 0.5,
      reasoning: parsed.reasoning || "No reasoning provided",
      sourcesChecked: citations,
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      model: "perplexity-sonar-pro",
      grounding: "web",
      verdict: "suspicious",
      confidence: 0.3,
      reasoning: `Validation error: ${error instanceof Error ? error.message : "unknown"}`,
      sourcesChecked: [],
      processingTimeMs: Date.now() - startTime,
    };
  }
}

// Ungrounded fallback — plausibility only. Confidence is CAPPED because
// nothing was checked against a source (invariant #3).
async function validatePlausibility(entry: ValidationRequest): Promise<ValidationResult> {
  const startTime = Date.now();
  try {
    const parsed = await runJudge(
      `No source is available for this claim, so judge plausibility only.\n` +
        `Topic: ${entry.topic}\nClaim: ${entry.content}\n\n` +
        `Respond with JSON: {"verdict": "valid" | "suspicious" | "fake", ` +
        `"confidence": 0.0-1.0, "reasoning": "brief"}`,
      "google/gemini-2.5-flash",
    );
    const verdict: ValidationResult["verdict"] = ["valid", "suspicious", "fake"].includes(parsed.verdict)
      ? (parsed.verdict as ValidationResult["verdict"])
      : "suspicious";
    return {
      model: "gemini-2.5-flash",
      grounding: "none",
      verdict,
      confidence: Math.min(parsed.confidence ?? 0.5, 0.6),
      reasoning: `[ungrounded] ${parsed.reasoning || "No reasoning provided"}`,
      sourcesChecked: [],
      processingTimeMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      model: "gemini-2.5-flash",
      grounding: "none",
      verdict: "suspicious",
      confidence: 0.3,
      reasoning: `Validation error: ${error instanceof Error ? error.message : "unknown"}`,
      sourcesChecked: [],
      processingTimeMs: Date.now() - startTime,
    };
  }
}

interface ConsensusResult {
  finalVerdict: "valid" | "suspicious" | "fake";
  consensusScore: number;
  grounding: Grounding;
  validatorResults: ValidationResult[];
}

// The grounded (source-text) verdict dominates; web/plausibility results are
// logged and only override when the grounded check errored out (conf <= 0.3).
function calculateConsensus(results: ValidationResult[]): ConsensusResult {
  const grounded = results.find((r) => r.grounding === "source");
  const primary =
    grounded && grounded.confidence > 0.3
      ? grounded
      : results.slice().sort((a, b) => b.confidence - a.confidence)[0];
  return {
    finalVerdict: primary.verdict,
    consensusScore: primary.confidence,
    grounding: primary.grounding,
    validatorResults: results,
  };
}

async function storeValidationLogs(
  supabase: SupabaseClient,
  entryId: string,
  entryType: string,
  results: ValidationResult[],
) {
  const logs = results.map((r) => ({
    entry_id: entryId,
    entry_type: entryType,
    validator_model: `${r.model} (${r.grounding})`,
    verdict: r.verdict,
    confidence: r.confidence,
    reasoning: r.reasoning,
    sources_checked: r.sourcesChecked,
    processing_time_ms: r.processingTimeMs,
  }));
  await supabase.from("validation_logs").insert(logs);
}

async function updateEntryValidation(
  supabase: SupabaseClient,
  entryId: string,
  entryType: string,
  consensus: ConsensusResult,
) {
  const updates = {
    is_validated: true,
    is_fake: consensus.finalVerdict === "fake",
    validation_score: consensus.consensusScore,
    validation_consensus: {
      verdict: consensus.finalVerdict,
      grounding: consensus.grounding,
      validators: consensus.validatorResults.map((r) => ({
        model: r.model,
        grounding: r.grounding,
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
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // WS-A: user JWT (identity from token) or internal cron-secret caller.
  let auth: { userId: string | null; token: string | null; internal: boolean };
  try { auth = await requireUserOrInternal(req); } catch (e) { return authErrorResponse(e); }

  try {
    const { entries, immediate = false } = await req.json();
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");

    if (!hasAIKey()) {
      return errorResponse("No AI key configured (GEMINI_API_KEY)", 500);
    }

    const supabase = getSupabaseClient();
    const validationEntries: ValidationRequest[] = Array.isArray(entries) ? entries : [entries];

    console.log(`[validation-engine] Validating ${validationEntries.length} entries (grounded v2)`);

    const processEntry = async (entry: ValidationRequest) => {
      const results: ValidationResult[] = [];

      // Primary: check the claim against its own stored source.
      const sourceUrl = extractSourceUrl(entry);
      const sourceText = sourceUrl ? await fetchSourceText(sourceUrl) : null;
      if (sourceUrl && sourceText) {
        results.push(await validateAgainstSource(entry, sourceUrl, sourceText));
      }

      // Secondary: real-time web check when available.
      if (PERPLEXITY_API_KEY) {
        results.push(await validateWithPerplexity(entry, PERPLEXITY_API_KEY));
      }

      // Fallback so there is always at least one verdict.
      if (results.length === 0) {
        results.push(await validatePlausibility(entry));
      }

      const consensus = calculateConsensus(results);
      console.log(
        `[validation-engine] ${entry.entryId}: ${consensus.finalVerdict} ` +
          `(${consensus.grounding}, ${consensus.consensusScore.toFixed(2)})`,
      );

      await Promise.all([
        storeValidationLogs(supabase, entry.entryId, entry.entryType, results),
        updateEntryValidation(supabase, entry.entryId, entry.entryType, consensus),
      ]);

      return { entryId: entry.entryId, consensus };
    };

    if (!immediate) {
      Promise.all(validationEntries.map(processEntry))
        .then((r) => console.log(`[validation-engine] Background validation complete: ${r.length}`))
        .catch((e) => console.error("[validation-engine] Background validation error:", e));
      return jsonResponse({
        message: `Validation queued for ${validationEntries.length} entries`,
        queued: true,
      });
    }

    const allResults = await Promise.all(validationEntries.map(processEntry));
    return jsonResponse({
      success: true,
      validated: allResults.length,
      results: allResults.map((r) => ({
        entryId: r.entryId,
        verdict: r.consensus.finalVerdict,
        grounding: r.consensus.grounding,
        score: r.consensus.consensusScore,
      })),
    });
  } catch (error) {
    console.error("[validation-engine] Error:", error);
    return errorResponse(error instanceof Error ? error.message : "Unknown error");
  }
});
