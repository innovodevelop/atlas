// Unified AI gateway abstraction.
//
// Historically every function called the Lovable AI gateway directly
// (https://ai.gateway.lovable.dev) with LOVABLE_API_KEY. After ejecting from
// Lovable Cloud that gateway is unavailable, so this module routes chat
// completions to whichever provider is configured:
//   1. ANTHROPIC_API_KEY -> Claude, via claudeAdapter.ts (current target)
//   2. LOVABLE_API_KEY   -> Lovable gateway (unchanged behavior, works pre-eject)
//   3. GEMINI_API_KEY    -> Google AI Studio's OpenAI-compatible endpoint
// The Lovable/Gemini branches stay live so the migration can land in pieces.
// Model ids are translated automatically (callers use "google/gemini-2.5-flash"
// style logical ids; Google uses bare "gemini-2.5-flash", Claude uses tiers).
//
// Embeddings: the legacy functions faked embeddings (LLM-hallucinated arrays
// or SHA-256 hashes). generateEmbedding() replaces those with real semantic
// vectors from gemini-embedding-001, truncated + re-normalized to 768 dims to
// match match_brain_vectors(vector(768)). Anthropic has no embeddings endpoint,
// so embeddings stay on GEMINI_API_KEY regardless of the chat provider.

import {
  ANTHROPIC_MESSAGES_URL,
  claudeChatCompletion,
  claudeDocumentExtract,
  mapModelToClaude,
} from "./claudeAdapter.ts";

const LOVABLE_CHAT_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const GEMINI_CHAT_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_EMBEDDINGS_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/embeddings";

export const EMBEDDING_DIMENSIONS = 768;

export interface AIGatewayConfig {
  chatUrl: string;
  apiKey: string;
  provider: "anthropic" | "lovable_ai" | "gemini";
}

export function getAIConfig(): AIGatewayConfig | null {
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    return { chatUrl: ANTHROPIC_MESSAGES_URL, apiKey: anthropicKey, provider: "anthropic" };
  }
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  if (lovableKey) {
    return { chatUrl: LOVABLE_CHAT_URL, apiKey: lovableKey, provider: "lovable_ai" };
  }
  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (geminiKey) {
    return { chatUrl: GEMINI_CHAT_URL, apiKey: geminiKey, provider: "gemini" };
  }
  return null;
}

export function hasAIKey(): boolean {
  return getAIConfig() !== null;
}

// Lovable-gateway model id -> Google AI Studio model id.
// gpt-* ids have no Google equivalent; they map to the strongest Gemini tier.
const GEMINI_MODEL_MAP: Record<string, string> = {
  "google/gemini-2.5-flash": "gemini-2.5-flash",
  "google/gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
  "google/gemini-2.5-pro": "gemini-2.5-pro",
  "openai/gpt-5": "gemini-2.5-pro",
  "openai/gpt-5-mini": "gemini-2.5-flash",
  "openai/gpt-5-nano": "gemini-2.5-flash-lite",
};

export function mapModel(model: string): string {
  const config = getAIConfig();
  if (!config || config.provider === "lovable_ai") return model;
  if (config.provider === "anthropic") return mapModelToClaude(model);
  return (
    GEMINI_MODEL_MAP[model] ??
    (model.startsWith("google/") ? model.slice("google/".length) : model)
  );
}

/**
 * Drop-in replacement for `fetch(LOVABLE_URL, { body: JSON.stringify(body) })`.
 * Accepts an OpenAI-format chat.completions body (streaming supported) and
 * returns the raw Response. The model id is translated for the active provider.
 */
export function aiChatCompletion(body: Record<string, unknown>): Promise<Response> {
  const config = getAIConfig();
  if (!config) {
    return Promise.reject(
      new Error("No AI key configured: set ANTHROPIC_API_KEY (or GEMINI_API_KEY / LOVABLE_API_KEY)"),
    );
  }
  // Claude is not OpenAI-compatible; the adapter translates both directions and
  // still hands back a raw Response, so no call site changes.
  if (config.provider === "anthropic") {
    return claudeChatCompletion(body, config.apiKey);
  }
  const payload = {
    ...body,
    model: mapModel(String(body.model ?? "google/gemini-2.5-flash")),
  };
  return fetch(config.chatUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
}

/**
 * Real semantic embedding (768 dims, L2-normalized — required when truncating
 * gemini-embedding-001 output below its native size). Requires GEMINI_API_KEY;
 * the Lovable gateway never exposed an embeddings endpoint.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiKey) {
    throw new Error("GEMINI_API_KEY is required for embeddings");
  }
  const response = await fetch(GEMINI_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${geminiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gemini-embedding-001",
      input: text.slice(0, 8000),
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Embedding request failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  const embedding: number[] = data.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Embedding response malformed (got ${Array.isArray(embedding) ? embedding.length : typeof embedding} values)`,
    );
  }
  const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0)) || 1;
  return embedding.map((v) => v / norm);
}

/**
 * Document understanding (PDF/image → text answer). Used by mail-sync to
 * extract invoice fields from attachments. Prefers Claude document/image
 * content blocks; falls back to the native Gemini generateContent API (the
 * OpenAI-compatible endpoint does not accept PDFs) when ANTHROPIC_API_KEY is
 * absent, or when Claude cannot handle the media type.
 */
export async function aiDocumentExtract(
  prompt: string,
  mimeType: string,
  base64Data: string,
): Promise<string> {
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    try {
      return await claudeDocumentExtract(prompt, mimeType, base64Data, anthropicKey);
    } catch (e) {
      if (!Deno.env.get("GEMINI_API_KEY")) throw e;
      console.log("[aiGateway] Claude document extraction failed, falling back to Gemini:", e);
    }
  }
  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  if (!geminiKey) throw new Error("GEMINI_API_KEY is required for document extraction");
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: { "x-goog-api-key": geminiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType, data: base64Data } },
            { text: prompt },
          ],
        }],
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Document extraction failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
}
