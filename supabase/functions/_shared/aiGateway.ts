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
import {
  awsCredentialsFromEnv,
  bedrockChatCompletion,
  bedrockRegion,
  mapModelToBedrock,
} from "./bedrockAdapter.ts";

const LOVABLE_CHAT_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const GEMINI_CHAT_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const GEMINI_EMBEDDINGS_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/embeddings";

export const EMBEDDING_DIMENSIONS = 768;

export interface AIGatewayConfig {
  chatUrl: string;
  apiKey: string;
  provider: "anthropic" | "bedrock" | "lovable_ai" | "gemini";
}

export function getAIConfig(): AIGatewayConfig | null {
  // ATLAS_AI_PROVIDER is the migration switch. "bedrock" runs background
  // inference on AWS (Activate credits, EU residency); the default keeps the
  // first-party Anthropic path. The later Path-B value ("aws" — Claude Platform
  // on AWS) will reuse the very same SigV4 auth + AWS creds, so adding it is a
  // one-branch change here, not a rewrite.
  const provider = (Deno.env.get("ATLAS_AI_PROVIDER") ?? "").toLowerCase();
  if (provider === "bedrock") {
    const creds = awsCredentialsFromEnv();
    if (creds) {
      return {
        chatUrl: `https://bedrock-runtime.${bedrockRegion()}.amazonaws.com`,
        apiKey: creds.accessKeyId, // only used for the fail-closed presence check
        provider: "bedrock",
      };
    }
    // Fail closed exactly like the Anthropic branch: if the operator asked for
    // Bedrock but the AWS creds are absent, do NOT silently fall through to a
    // different processor — surface "no AI key configured" instead.
    return null;
  }

  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    return { chatUrl: ANTHROPIC_MESSAGES_URL, apiKey: anthropicKey, provider: "anthropic" };
  }
  // Anthropic is the ONLY chat provider on the app path. Falling back to
  // Google/Lovable when the key is missing would silently ship the user's
  // prompts — which embed their stored memories — to an undisclosed processor,
  // contradicting the privacy policy. Fail closed instead: callers surface
  // "no AI key configured" and nothing leaves the device.
  //
  // ATLAS_ALLOW_LEGACY_PROVIDERS is an explicit developer opt-in for comparing
  // providers locally; it is never set in the packaged app.
  if (Deno.env.get("ATLAS_ALLOW_LEGACY_PROVIDERS") === "1") {
    const lovableKey = Deno.env.get("LOVABLE_API_KEY");
    if (lovableKey) {
      return { chatUrl: LOVABLE_CHAT_URL, apiKey: lovableKey, provider: "lovable_ai" };
    }
    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (geminiKey) {
      return { chatUrl: GEMINI_CHAT_URL, apiKey: geminiKey, provider: "gemini" };
    }
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
  if (config.provider === "bedrock") return mapModelToBedrock(model);
  return (
    GEMINI_MODEL_MAP[model] ??
    (model.startsWith("google/") ? model.slice("google/".length) : model)
  );
}

/**
 * True when the request carries a native Anthropic server tool
 * (web_search_/web_fetch_) that only api.anthropic.com can execute — Bedrock's
 * Messages API has no server-tool runtime. This is the single capability the
 * Bedrock path cannot serve.
 */
function requestNeedsNativeServerTool(body: Record<string, unknown>): boolean {
  const tools = body.anthropicTools as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(tools)) return false;
  return tools.some((t) => {
    const type = String(t.type ?? "");
    return type.startsWith("web_search") || type.startsWith("web_fetch");
  });
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

  // Bedrock is the credit-funded background tier. The ONE thing it cannot serve
  // is native web search, so web-search-dependent turns bridge to first-party
  // Anthropic (small real $ while on credits). This is the only provider branch
  // that keys on capability, and it evaporates on the flip to Path B (Claude
  // Platform on AWS serves the native web_search tool itself).
  if (config.provider === "bedrock") {
    if (requestNeedsNativeServerTool(body)) {
      const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (anthropicKey) return claudeChatCompletion(body, anthropicKey);
      // No first-party bridge key: serve on Bedrock WITHOUT the server tools
      // (degraded — no live search) rather than 400 the whole request.
      const { anthropicTools: _drop, ...rest } = body;
      return bedrockChatCompletion(rest);
    }
    return bedrockChatCompletion(body);
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
