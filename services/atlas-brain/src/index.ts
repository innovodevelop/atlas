/**
 * Atlas brain sidecar — Bun HTTP server.
 *
 * Serves the chat/AI orchestrator over local HTTP, replacing the Supabase
 * `chat` and `chat-with-memory` edge functions with an on-device process. It
 * re-imports the SAME runtime-neutral `_shared/orchestrator.ts` the voice
 * gateway already runs, so there is one brain, not two implementations.
 *
 * Runs as a Tauri sidecar in the packaged app (spawned by src-tauri, bound to
 * 127.0.0.1, optional SIDECAR_TOKEN) or standalone in dev: `bun run dev`.
 *
 * Env (sidecar: injected by Tauri; dev: shell env):
 *   ANTHROPIC_API_KEY                             (required: completions + native web search; from Keychain)
 *   ATLAS_BRAIN_PORT (default 4830)
 *   SIDECAR_TOKEN (optional — checked when set)
 *
 * Fully local: identity comes from the Cloudflare account JWT (decode-only —
 * signature verification lives at Cloudflare), all data lives in the on-device
 * atlas.db via bun:sqlite. No Supabase.
 */

import "./denoShim.ts";
import {
  assistantTextFromSse,
  captureChatTurn,
  createLocalDb,
  eraseUserData,
  forgetMemories,
} from "./localDb.ts";
import { createLearningHandlers } from "./learningRoutes.ts";
import { embedText } from "./localEmbed.ts";
import { AUTO_EMBED_BATCH, embedPending, scheduleAutoEmbed } from "./autoEmbed.ts";

import { runChat } from "../../../supabase/functions/_shared/orchestrator.ts";
import { aiChatCompletion, hasAIKey } from "../../../supabase/functions/_shared/aiGateway.ts";
import { selectModel } from "../../../supabase/functions/_shared/providerRouting.ts";

const PORT = Number(process.env.ATLAS_BRAIN_PORT ?? 4830);
const SIDECAR_TOKEN = process.env.SIDECAR_TOKEN;

// CORS: the Tauri webview (tauri://localhost / http://localhost:8080) fetches
// this over http://127.0.0.1. No cookies are used — auth is a bearer JWT — so a
// wildcard origin is safe here.
const cors: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-sidecar-token, x-session-id, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

/** Decode a JWT payload (no signature check — see requireUser). */
function decodeJwt(token: string): { sub?: string; email?: string; exp?: number } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Identity from the Cloudflare account JWT. Single local trust boundary
 * (local-first): the brain runs on the user's own machine, so it decodes the
 * token for the userId rather than cryptographically verifying it — signature
 * verification lives at Cloudflare (the account endpoints, the mail worker),
 * where the secret stays. Still enforces SIDECAR_TOKEN when configured.
 */
function requireUser(req: Request): { userId: string; email: string; token: string } {
  if (SIDECAR_TOKEN) {
    const presented = req.headers.get("x-sidecar-token");
    if (presented !== SIDECAR_TOKEN) throw new AuthError("bad sidecar token", 403);
  }
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new AuthError("missing bearer token");
  const claims = decodeJwt(token);
  if (!claims?.sub) throw new AuthError("invalid token");
  if (claims.exp && Date.now() / 1000 >= claims.exp) throw new AuthError("token expired");
  return { userId: claims.sub, email: claims.email ?? "", token };
}

// One local DB (bun:sqlite over atlas.db) serves as both the user client and the
// service-role client for the orchestrator — there's no RLS locally.
const localDb = createLocalDb();

// Learning / research / maintenance routes (see learningRoutes.ts).
const learning = createLearningHandlers({ db: localDb, requireUser, json });

// POST /chat-with-memory — full orchestrator: memory recall, tools, streaming.
async function handleChatWithMemory(req: Request): Promise<Response> {
  const { userId, token } = requireUser(req);
  const {
    messages,
    source = "text_chat",
    enableTools = true,
    teachingMode = false,
    systemPromptOverride,
    conversationId = null,
  } = await req.json();

  const result = await runChat(
    {
      // Local DB stands in for both the user + service-role Supabase clients.
      supabase: localDb as any,
      systemDb: localDb as any,
      userId,
      userToken: token,
      supabaseUrl: "local",
      sessionId: req.headers.get("x-session-id") || undefined,
      // Same local e5 embedder that writes memory_vectors — querying with any
      // other model would compare vectors across embedding spaces. The "query"
      // prefix is e5's asymmetric-retrieval convention (stored text uses
      // "passage"); it widens the hit/miss margin measurably.
      embed: (text: string) => embedText(text, "query"),
    },
    { messages, source, enableTools, teachingMode, systemPromptOverride, conversationId },
  );

  // The turn's memory_store writes have landed by now — embed them so they are
  // recallable on the next turn, not whenever someone runs a backfill. Bounded
  // and off the response path (see autoEmbed.ts).
  scheduleAutoEmbed(localDb, userId);

  const lastUserMessage: string | null =
    [...(messages ?? [])].reverse().find((m: { role: string; content: unknown }) => m.role === "user" && typeof m.content === "string")?.content ?? null;

  switch (result.kind) {
    case "stream": {
      // SFT capture: tee the SSE stream — the client branch is returned
      // unchanged (tee forwards each chunk as it arrives, so the first byte is
      // never delayed), while the capture branch accumulates only the final
      // assistant text and persists the turn off the response path.
      const [clientStream, captureStream] = result.stream.tee();
      const capture = result.capture;
      void (async () => {
        try {
          const assistantText = await assistantTextFromSse(captureStream);
          captureChatTurn(localDb._db, {
            userId,
            conversationId,
            source,
            model: capture?.model ?? null,
            systemPrompt: capture?.systemPrompt ?? null,
            userMessage: lastUserMessage,
            toolMessages: capture?.toolMessages ?? [],
            assistantText,
          });
        } catch (e) {
          console.error("[brain] turn capture failed:", e);
        }
      })();
      return new Response(clientStream, {
        headers: { ...cors, "Content-Type": "text/event-stream" },
      });
    }
    case "json": {
      // Teaching mode: the full text is already in the body — capture inline.
      try {
        captureChatTurn(localDb._db, {
          userId,
          conversationId,
          source,
          model: result.capture?.model ?? null,
          systemPrompt: result.capture?.systemPrompt ?? null,
          userMessage: lastUserMessage,
          toolMessages: result.capture?.toolMessages ?? [],
          assistantText: String((result.body as { response?: unknown })?.response ?? ""),
        });
      } catch (e) {
        console.error("[brain] turn capture failed:", e);
      }
      return json(result.body);
    }
    case "error":
      return json(
        { error: result.message, ...(result.reason ? { reason: result.reason } : {}) },
        result.status,
      );
  }
}

// POST /memory/list — the caller's stored memories for the management panel.
async function handleMemoryList(req: Request): Promise<Response> {
  const { userId } = requireUser(req);
  const { data, error } = await localDb
    .from("ai_memory")
    .select()
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return json({ error: error.message }, 500);
  const memories = ((data as Array<Record<string, unknown>>) ?? []).map((m) => ({
    id: m.id,
    key: m.key,
    category: m.category,
    memory_type: m.memory_type,
    importance: m.importance,
    mention_count: m.mention_count,
    preview: (typeof m.value === "object" ? JSON.stringify(m.value) : String(m.value ?? "")).slice(0, 160),
    created_at: m.created_at,
    updated_at: m.updated_at,
  }));
  return json({ memories });
}

// POST /memory/forget {id?, key?} — delete the caller's memory row(s) + vectors.
async function handleMemoryForget(req: Request): Promise<Response> {
  const { userId } = requireUser(req);
  const { id, key } = await req.json();
  if (typeof id !== "string" && typeof key !== "string") {
    return json({ error: "id or key required" }, 400);
  }
  const counts = forgetMemories(localDb._db, userId, {
    id: typeof id === "string" ? id : undefined,
    key: typeof key === "string" ? key : undefined,
  });
  return json(counts);
}

// POST /memory/erase-all {confirm: true} — delete everything Atlas stores about
// the caller (memories, vectors, knowledge, session context, transcripts).
async function handleMemoryEraseAll(req: Request): Promise<Response> {
  const { userId } = requireUser(req);
  const { confirm } = await req.json();
  if (confirm !== true) return json({ error: "confirm: true required" }, 400);
  const deleted = eraseUserData(localDb._db, userId);
  return json({ deleted });
}

// POST /chat — memory-less fallback: a single streamed completion.
async function handleChat(req: Request): Promise<Response> {
  requireUser(req);
  const { messages } = await req.json();
  if (!hasAIKey()) return json({ error: "No AI key configured (ANTHROPIC_API_KEY)" }, 500);

  const response = await aiChatCompletion({
    // Logical id — mapModel() resolves it per provider (Claude: Sonnet 5).
    model: selectModel("chat"),
    messages: [
      {
        role: "system",
        content:
          "You are Atlas, an advanced AI Research Assistant. You are helpful, knowledgeable, and conversational. Keep responses clear, concise, and friendly.",
      },
      ...messages,
    ],
    stream: true,
  });

  if (!response.ok) {
    if (response.status === 429) return json({ error: "Rate limits exceeded, please try again later." }, 429);
    if (response.status === 402) return json({ error: "Payment required, please add funds to your workspace." }, 402);
    return json({ error: "AI gateway error" }, 500);
  }
  return new Response(response.body, { headers: { ...cors, "Content-Type": "text/event-stream" } });
}

// POST /search — semantic search over local memory + knowledge (replaces the
// semantic-search edge fn): embed the query on-device, recall locally, enrich.
// recall_memories includes the second-stage rerank (localMemory + rerank.ts),
// so /search results arrive already rerank-ordered — same as the chat path.
async function handleSearch(req: Request): Promise<Response> {
  const { userId } = requireUser(req);
  // multilingual-e5 cosines sit on a compressed scale — measured on Danish
  // memory-style text: true hits 0.78-0.85, unrelated 0.65-0.79. The old 0.3
  // default was calibrated for Gemini vectors and now admits everything.
  // Callers omit `threshold` and inherit this model-appropriate default.
  const { query, threshold = 0.78, limit = 20 } = await req.json();
  if (!query || typeof query !== "string") return json({ error: "Query is required" }, 400);

  const queryEmbedding = await embedText(query, "query");
  const { data: hits } = await localDb.rpc("recall_memories", {
    p_user_id: userId,
    query_embedding: queryEmbedding,
    query_text: query,
    match_count: limit,
  });

  const results: Array<Record<string, unknown>> = [];
  for (const h of (hits as any[]) ?? []) {
    if (h.knowledge_entry_id) {
      const { data: k } = await localDb.from("atlas_knowledge_entries").select().eq("id", h.knowledge_entry_id).single();
      if (k) results.push({
        id: k.id, type: "knowledge", title: k.topic,
        preview: (typeof k.content === "object" ? JSON.stringify(k.content) : String(k.content)).slice(0, 200),
        category: k.category, confidence: k.confidence, similarity: h.similarity, createdAt: k.created_at,
        source: "semantic", metadata: { source: k.source, accessCount: k.access_count, relevanceScore: k.relevance_score },
      });
    } else if (h.memory_item_id) {
      const { data: m } = await localDb.from("ai_memory").select().eq("id", h.memory_item_id).single();
      if (m) results.push({
        id: m.id, type: "memory", title: m.key,
        preview: (typeof m.value === "object" ? JSON.stringify(m.value) : String(m.value)).slice(0, 200),
        category: m.category, confidence: m.validation_score || 0.5, similarity: h.similarity, createdAt: m.created_at,
        source: "semantic", metadata: { memoryType: m.memory_type, importance: m.importance },
      });
    }
  }
  return json({ results: results.filter((r) => (r.similarity as number) >= threshold), query });
}

// POST /embed-backfill — embed + store vectors for the user's memories/knowledge
// that don't have one yet (replaces the generate-embeddings edge fn). Mostly a
// catch-up lever now: chat turns embed their own writes (see autoEmbed.ts).
async function handleEmbedBackfill(req: Request): Promise<Response> {
  const { userId } = requireUser(req);
  const { batchSize = AUTO_EMBED_BATCH } = await req.json();
  const processed = await embedPending(localDb, userId, batchSize);
  return json({ processed });
}

const server = Bun.serve({
  hostname: "127.0.0.1", // localhost only — never exposed to the network
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (url.pathname === "/health") {
      return json({ ok: true, service: "atlas-brain", aiKey: hasAIKey(), db: "local" });
    }
    try {
      if (req.method === "POST" && url.pathname === "/chat-with-memory") return await handleChatWithMemory(req);
      if (req.method === "POST" && url.pathname === "/chat") return await handleChat(req);
      if (req.method === "POST" && url.pathname === "/search") return await handleSearch(req);
      if (req.method === "POST" && url.pathname === "/embed-backfill") return await handleEmbedBackfill(req);
      if (req.method === "POST" && url.pathname === "/learning/control") return await learning.control(req);
      if (req.method === "POST" && url.pathname === "/learning/cycle") return await learning.cycle(req);
      if (req.method === "POST" && url.pathname === "/learning/intent") return await learning.intent(req);
      if (req.method === "POST" && url.pathname === "/research") return await learning.research(req);
      if (req.method === "POST" && url.pathname === "/memory/maintenance") return await learning.memoryMaintenance(req);
      if (req.method === "POST" && url.pathname === "/memory/list") return await handleMemoryList(req);
      if (req.method === "POST" && url.pathname === "/memory/forget") return await handleMemoryForget(req);
      if (req.method === "POST" && url.pathname === "/memory/erase-all") return await handleMemoryEraseAll(req);
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message }, e.status);
      console.error("[brain] error:", e);
      return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
    }
    return json({ error: "not found" }, 404);
  },
});

if (!hasAIKey()) console.log("[brain] no AI key (ANTHROPIC_API_KEY) — completions will 500 until a key is set");
console.log(`[brain] Atlas brain on http://127.0.0.1:${server.port} (/chat, /chat-with-memory) — local DB`);
