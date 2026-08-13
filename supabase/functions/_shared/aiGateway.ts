// Unified AI gateway abstraction.
//
// Routes chat completions to the configured provider:
//   1. ATLAS_AI_PROVIDER=bedrock + AWS creds -> Bedrock, via bedrockAdapter.ts (primary)
//      Web-search turns bridge to first-party Anthropic (ANTHROPIC_API_KEY) if present.
//   2. ANTHROPIC_API_KEY -> Claude first-party, via claudeAdapter.ts
//   3. LOVABLE_API_KEY / GEMINI_API_KEY -> legacy (dev-only, behind ATLAS_ALLOW_LEGACY_PROVIDERS)
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

// ---------------------------------------------------------------------------
// Rate-limit resilience: exponential backoff + jitter + sliding-window TPM
//
// Bedrock quotas refresh on 60-second windows (RPM and TPM). A 429 means the
// current window is exhausted — retrying within the SAME window is futile, so
// the backoff delays are designed to span into the next window boundary.
//
// The sliding-window limiter is a PROACTIVE measure: it estimates token usage
// per request and delays the caller BEFORE the quota is hit, avoiding the 429
// entirely for sustained workloads. It cannot be perfect (it does not know the
// server's true remaining budget), so the retry layer is always the backstop.
// ---------------------------------------------------------------------------

const MAX_RETRIES = 4;
const BASE_DELAY_MS = 1_500;
const MAX_DELAY_MS = 45_000;

/** Retryable status codes: 429 (rate limit), 529 (overloaded), 5xx (transient). */
function isRetryable(status: number): boolean {
  return status === 429 || status === 529 || (status >= 500 && status < 600);
}

/**
 * Parse `retry-after` header (seconds or HTTP-date) into milliseconds to wait.
 * Returns undefined if the header is absent or unparseable — the exponential
 * formula takes over in that case.
 */
function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : undefined;
  }
  return undefined;
}

/**
 * Exponential backoff with full jitter, capped at MAX_DELAY_MS.
 * Jitter range is [0, delay) — "full jitter" per AWS architecture blog.
 */
function backoffDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs + Math.random() * 1000, MAX_DELAY_MS);
  }
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const capped = Math.min(exponential, MAX_DELAY_MS);
  return Math.random() * capped;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a provider call with retry-on-429/5xx. Streaming responses that already
 * returned 200 are NOT retried (the failure is inside the stream and is surfaced
 * to the user inline — retrying would lose partial output).
 */
async function withRetry(
  fn: () => Promise<Response>,
  label: string,
): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fn();
    if (response.ok || !isRetryable(response.status)) return response;
    if (attempt === MAX_RETRIES) {
      console.warn(`[aiGateway] ${label}: giving up after ${MAX_RETRIES + 1} attempts (last status=${response.status})`);
      return response;
    }
    const retryAfterMs = parseRetryAfter(response);
    const delay = backoffDelay(attempt, retryAfterMs);
    console.log(
      `[aiGateway] ${label}: ${response.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay)}ms` +
        (retryAfterMs ? ` (retry-after: ${Math.round(retryAfterMs)}ms)` : ""),
    );
    // Consume the body so the connection is freed for the retry.
    await response.text().catch(() => {});
    await sleep(delay);
  }
  // Unreachable, but TypeScript needs it.
  return new Response(null, { status: 500 });
}

// ---------------------------------------------------------------------------
// Sliding-window token budget (proactive 429 avoidance)
//
// Bedrock's per-minute TPM quota counts `input_tokens + max_tokens` at
// reservation time (the initial reservation — see the AWS blog post). By
// tracking our own rolling usage we can delay a request that would push us over
// the limit, converting a server-side 429 into a client-side wait.
//
// This is BEST-EFFORT: the server's budget may differ (other consumers on the
// same account, cache settlements, burndown), so it errs on the side of letting
// through and relying on the retry layer as backstop.
// ---------------------------------------------------------------------------

interface TokenRecord {
  ts: number;
  tokens: number;
}

const TOKEN_WINDOW_MS = 60_000;
const tokenLog: TokenRecord[] = [];

/** TPM budget — env-configurable, defaults to a conservative estimate. */
function tpmBudget(): number {
  const env = Deno.env.get("ATLAS_TPM_BUDGET");
  return env ? Number(env) : 200_000;
}

function pruneBefore(cutoff: number) {
  while (tokenLog.length > 0 && tokenLog[0].ts < cutoff) tokenLog.shift();
}

function currentWindowUsage(): number {
  pruneBefore(Date.now() - TOKEN_WINDOW_MS);
  let sum = 0;
  for (const r of tokenLog) sum += r.tokens;
  return sum;
}

/**
 * Estimate the token reservation for a request. Bedrock reserves
 * `input_tokens + max_tokens` initially; we approximate input_tokens from the
 * JSON byte length (÷4 is the standard heuristic for English text).
 */
function estimateReservation(body: Record<string, unknown>): number {
  const maxTokens = Number(body.max_tokens ?? 4096);
  const messagesStr = JSON.stringify(body.messages ?? []);
  const estimatedInput = Math.ceil(messagesStr.length / 4);
  return estimatedInput + maxTokens;
}

/**
 * If the estimated reservation would exceed the TPM budget, sleep until enough
 * of the window has rolled off. Returns immediately if there's headroom.
 */
async function throttleIfNeeded(body: Record<string, unknown>, label: string): Promise<void> {
  const budget = tpmBudget();
  if (budget <= 0) return; // disabled
  const reservation = estimateReservation(body);
  const used = currentWindowUsage();
  const headroom = budget - used;
  if (reservation <= headroom) {
    tokenLog.push({ ts: Date.now(), tokens: reservation });
    return;
  }
  // How long until enough rolls off? Find the oldest record whose removal
  // would free enough space, then sleep until its window expires.
  pruneBefore(Date.now() - TOKEN_WINDOW_MS);
  let freed = 0;
  let waitUntil = Date.now();
  for (const r of tokenLog) {
    freed += r.tokens;
    waitUntil = r.ts + TOKEN_WINDOW_MS;
    if (used - freed + reservation <= budget) break;
  }
  const waitMs = Math.max(0, waitUntil - Date.now());
  if (waitMs > 0 && waitMs < MAX_DELAY_MS) {
    console.log(`[aiGateway] ${label}: proactive throttle ${Math.round(waitMs)}ms (used=${used}, reservation=${reservation}, budget=${budget})`);
    await sleep(waitMs);
  }
  tokenLog.push({ ts: Date.now(), tokens: reservation });
}

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
 *
 * Rate-limit resilience (added per AWS Bedrock best-practices blog):
 *  - Proactive sliding-window throttle delays requests that would exceed TPM.
 *  - Exponential backoff with jitter retries 429 / 5xx up to MAX_RETRIES times.
 *  - Streaming requests (body.stream=true) are retried on the initial fetch only
 *    (a 200 that later errors mid-stream is surfaced inline, not retried).
 */
export async function aiChatCompletion(body: Record<string, unknown>): Promise<Response> {
  const config = getAIConfig();
  if (!config) {
    return Promise.reject(
      new Error("No AI key configured: set ATLAS_AI_PROVIDER=bedrock with AWS credentials, or ANTHROPIC_API_KEY"),
    );
  }

  const label = `${config.provider}/${String(body.model ?? "default")}`;
  await throttleIfNeeded(body, label);

  // Bedrock is the credit-funded background tier. The ONE thing it cannot serve
  // is native web search, so web-search-dependent turns bridge to first-party
  // Anthropic (small real $ while on credits). This is the only provider branch
  // that keys on capability, and it evaporates on the flip to Path B (Claude
  // Platform on AWS serves the native web_search tool itself).
  if (config.provider === "bedrock") {
    if (requestNeedsNativeServerTool(body)) {
      const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (anthropicKey) {
        return withRetry(() => claudeChatCompletion(body, anthropicKey), `${label}/bridge`);
      }
      const { anthropicTools: _drop, ...rest } = body;
      return withRetry(() => bedrockChatCompletion(rest), `${label}/degraded`);
    }
    return withRetry(() => bedrockChatCompletion(body), label);
  }

  if (config.provider === "anthropic") {
    return withRetry(() => claudeChatCompletion(body, config.apiKey), label);
  }

  const payload = {
    ...body,
    model: mapModel(String(body.model ?? "google/gemini-2.5-flash")),
  };
  return withRetry(
    () => fetch(config.chatUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }),
    label,
  );
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
