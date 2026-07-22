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
 * Env (sidecar: injected by Tauri; dev: .env fallback from the repo root):
 *   SUPABASE_URL / VITE_SUPABASE_URL              (JWT verification + user client)
 *   SUPABASE_ANON_KEY / VITE_SUPABASE_PUBLISHABLE_KEY
 *   SUPABASE_SERVICE_ROLE_KEY                     (optional; provider/learning tables)
 *   GEMINI_API_KEY                                (required for real completions; from Keychain)
 *   PERPLEXITY_API_KEY                            (optional; web-search tools)
 *   ATLAS_BRAIN_PORT (default 4830)
 *   SIDECAR_TOKEN (optional — checked when set)
 *
 * NOTE (migration state): this phase still uses Supabase for JWT auth + memory/
 * data reads (via the injected clients). Phase 3 swaps memory to local SQLite +
 * sqlite-vec, Phase 6 swaps auth to a local profile — at which point the
 * Supabase env here goes away.
 */

import "./denoShim.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { runChat } from "../../../supabase/functions/_shared/orchestrator.ts";
import { aiChatCompletion, hasAIKey } from "../../../supabase/functions/_shared/aiGateway.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadRepoDotenv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const txt = readFileSync(join(HERE, "../../../.env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    /* packaged build: env comes from Tauri */
  }
  return out;
}

const dotenv = loadRepoDotenv();
const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? dotenv.VITE_SUPABASE_URL;
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ??
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  dotenv.VITE_SUPABASE_PUBLISHABLE_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ANON_KEY;
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

/**
 * Identity from the verified JWT only — never from the body (mirrors the edge
 * functions' requireUser). Also enforces SIDECAR_TOKEN when one is configured.
 */
async function requireUser(req: Request): Promise<{ userId: string; token: string }> {
  if (SIDECAR_TOKEN) {
    const presented = req.headers.get("x-sidecar-token");
    if (presented !== SIDECAR_TOKEN) throw new AuthError("bad sidecar token", 403);
  }
  if (!SUPABASE_URL || !ANON_KEY) throw new AuthError("brain not configured (no Supabase env)", 503);
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw new AuthError("missing bearer token");
  const authClient = createClient(SUPABASE_URL, ANON_KEY);
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user) throw new AuthError("invalid jwt");
  return { userId: data.user.id, token };
}

function userClient(token: string): SupabaseClient {
  return createClient(SUPABASE_URL!, ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function systemClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// POST /chat-with-memory — full orchestrator: memory recall, tools, streaming.
async function handleChatWithMemory(req: Request): Promise<Response> {
  const { userId, token } = await requireUser(req);
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
      supabase: userClient(token),
      systemDb: systemClient(),
      userId,
      userToken: token,
      supabaseUrl: SUPABASE_URL!,
      perplexityKey: process.env.PERPLEXITY_API_KEY,
      sessionId: req.headers.get("x-session-id") || undefined,
    },
    { messages, source, enableTools, teachingMode, systemPromptOverride, conversationId },
  );

  switch (result.kind) {
    case "stream":
      return new Response(result.stream, {
        headers: { ...cors, "Content-Type": "text/event-stream" },
      });
    case "json":
      return json(result.body);
    case "error":
      return json(
        { error: result.message, ...(result.reason ? { reason: result.reason } : {}) },
        result.status,
      );
  }
}

// POST /chat — memory-less fallback: a single streamed completion.
async function handleChat(req: Request): Promise<Response> {
  await requireUser(req);
  const { messages } = await req.json();
  if (!hasAIKey()) return json({ error: "No AI key configured (GEMINI_API_KEY)" }, 500);

  const response = await aiChatCompletion({
    model: "google/gemini-2.5-flash",
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

const server = Bun.serve({
  hostname: "127.0.0.1", // localhost only — never exposed to the network
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (url.pathname === "/health") {
      return json({ ok: true, service: "atlas-brain", aiKey: hasAIKey(), supabase: Boolean(SUPABASE_URL && ANON_KEY) });
    }
    try {
      if (req.method === "POST" && url.pathname === "/chat-with-memory") return await handleChatWithMemory(req);
      if (req.method === "POST" && url.pathname === "/chat") return await handleChat(req);
    } catch (e) {
      if (e instanceof AuthError) return json({ error: e.message }, e.status);
      console.error("[brain] error:", e);
      return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
    }
    return json({ error: "not found" }, 404);
  },
});

if (!hasAIKey()) console.log("[brain] no GEMINI_API_KEY — completions will 500 until a key is set");
if (!SUPABASE_URL || !ANON_KEY) console.log("[brain] no Supabase env — auth/memory disabled until injected");
console.log(`[brain] Atlas brain on http://127.0.0.1:${server.port} (/chat, /chat-with-memory)`);
