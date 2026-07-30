/**
 * Atlas voice gateway — Bun WebSocket server.
 *
 * Runs as a Tauri sidecar in the packaged app (spawned by src-tauri, bound to
 * 127.0.0.1, guarded by a SIDECAR_TOKEN handshake so only the app connects)
 * or standalone in dev: `bun run dev` from services/voice-gateway.
 *
 * Env (injected by Tauri; dev: shell env):
 *   VOICE_GATEWAY_PORT (default 4820)
 *   ATLAS_BRAIN_PORT (default 4830 — the brain sidecar; voice delegates chat there)
 *   ELEVENLABS_API_KEY (from Keychain — direct TTS/STT, no Supabase hop)
 *   SIDECAR_TOKEN (optional — required when set; shared with the brain)
 *   VAD_MODEL_PATH (default models/silero_vad.onnx)
 */

import "./denoShim.ts";
import { VoiceSession } from "./session.ts";
import { DirectTtsProvider } from "./tts.ts";
import type { ClientMsg } from "./protocol.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.VOICE_GATEWAY_PORT ?? 4820);
const SIDECAR_TOKEN = process.env.SIDECAR_TOKEN;
const VAD_MODEL_PATH = process.env.VAD_MODEL_PATH ?? join(HERE, "../models/silero_vad.onnx");

/**
 * Identity from the Cloudflare account JWT (decode only — the signature is
 * verified at Cloudflare; the brain sidecar re-checks the token on every chat
 * call). Same single-local-trust-boundary model as the brain: the gateway runs
 * on 127.0.0.1 behind the SIDECAR_TOKEN handshake, so decoding is sufficient.
 */
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
 * VAD assets. Dev: files on disk. Compiled binary: embedded via
 * embeddedAssets.ts (Bun inlines `with { type: "file" }` imports and hands
 * back extracted paths at runtime).
 */
import { sileroModelPath, prepareOrtWasmDir } from "./embeddedAssets.ts";
import type { VadAssets } from "./vad.ts";

const { existsSync } = await import("node:fs");
const VAD_ASSETS: VadAssets = {
  model: existsSync(VAD_MODEL_PATH) ? VAD_MODEL_PATH : (sileroModelPath as string),
  ortWasmDir: await prepareOrtWasmDir(),
};

// Startup self-test: report which VAD engine this build actually runs
// (silero/silero-wasm = ONNX loaded; energy = fallback). Sessions create
// their own instance.
{
  const { createVad } = await import("./vad.ts");
  const probe = await createVad({ onSpeechStart: () => {}, onSpeechEnd: () => {} }, VAD_ASSETS);
  console.log(`[gateway] VAD engine: ${probe.name}`);
}

interface SocketData {
  session: VoiceSession | null;
  authed: boolean;
}

// The webview calls the HTTP routes cross-origin from tauri://localhost.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type,x-sidecar-token",
};

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function handleTts(req: Request): Promise<Response> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return jsonRes({ error: "ELEVENLABS_API_KEY not configured" }, 500);

  let body: { text?: string; voiceId?: string; modelId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: "bad json" }, 400);
  }
  if (!body.text || typeof body.text !== "string") {
    return jsonRes({ error: "text required" }, 400);
  }

  const provider = new DirectTtsProvider(apiKey);
  const controller = new AbortController();
  // Abort the upstream ElevenLabs fetch if the webview disconnects mid-stream.
  req.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(sink) {
      provider
        .synthesize(
          { text: body.text!, voiceId: body.voiceId, modelId: body.modelId, signal: controller.signal },
          (bytes) => sink.enqueue(bytes),
        )
        .then(() => sink.close())
        .catch((e) => {
          if (!controller.signal.aborted) console.error("[gateway] /tts failed:", e);
          try {
            sink.error(e);
          } catch { /* sink already closed by the client disconnecting — nothing to report to */ }
        });
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, { headers: { "Content-Type": "audio/mpeg", ...CORS } });
}

async function handleScribeToken(): Promise<Response> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return jsonRes({ error: "ELEVENLABS_API_KEY not configured" }, 500);
  // Same single-use-token mint RealtimeStt performs for the in-gateway WS path.
  const r = await fetch("https://api.elevenlabs.io/v1/single-use-token/realtime_scribe", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
  });
  if (!r.ok) return jsonRes({ error: `scribe token failed: ${r.status}` }, 500);
  const { token } = (await r.json()) as { token: string };
  return jsonRes({ token });
}

const server = Bun.serve<SocketData>({
  hostname: "127.0.0.1", // localhost only — never exposed to the network
  port: PORT,
  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "atlas-voice-gateway" });
    }
    if (url.pathname === "/ws") {
      if (srv.upgrade(req, { data: { session: null, authed: false } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    if (url.pathname === "/tts" || url.pathname === "/scribe-token") {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (req.method !== "POST") return jsonRes({ error: "method not allowed" }, 405);
      if (SIDECAR_TOKEN && req.headers.get("x-sidecar-token") !== SIDECAR_TOKEN) {
        return jsonRes({ error: "unauthorized" }, 401);
      }
      // Bun.serve's default 500 carries no CORS headers, so an uncaught
      // upstream failure would surface as an opaque "Failed to fetch" in the
      // webview — keep errors as readable JSON.
      const handler = url.pathname === "/tts" ? handleTts(req) : handleScribeToken();
      return handler.catch((e) =>
        jsonRes({ error: e instanceof Error ? e.message : String(e) }, 500),
      );
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    // 20 ms of 16 kHz Int16 = 640 bytes; allow generous batching.
    maxPayloadLength: 1 << 20,

    async message(ws, raw) {
      // Binary = PCM audio for the active session.
      if (typeof raw !== "string") {
        const session = ws.data.session;
        if (session) {
          await session.handleAudio(new Uint8Array(raw as ArrayBuffer | Uint8Array as any));
        }
        return;
      }

      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw);
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "bad json" }));
        return;
      }

      if (msg.type === "hello") {
        if (SIDECAR_TOKEN && msg.sessionToken !== SIDECAR_TOKEN) {
          ws.send(JSON.stringify({ type: "error", message: "bad session token" }));
          ws.close(4001);
          return;
        }
        // Identity from the Cloudflare JWT (decode only — see decodeJwt). The
        // brain re-checks the token cryptographically on each /chat call.
        const claims = decodeJwt(msg.jwt);
        if (!claims?.sub || (claims.exp && Date.now() / 1000 >= claims.exp)) {
          ws.send(JSON.stringify({ type: "error", message: "invalid jwt" }));
          ws.close(4003);
          return;
        }

        const session = await VoiceSession.create({
          userJwt: msg.jwt,
          userId: claims.sub,
          vadAssets: VAD_ASSETS,
          voiceId: msg.voiceId,
          ttsModelId: msg.ttsModelId,
          languageCode: undefined, // auto-detect; Danish benchmarked in bench/
          send: (m) => ws.send(JSON.stringify(m)),
          sendBinary: (bytes) => ws.send(bytes),
        });
        ws.data.session = session;
        ws.data.authed = true;
        ws.send(JSON.stringify({ type: "ready", sessionId: crypto.randomUUID() }));
        console.log(`[gateway] session ready (user ${claims.sub.slice(0, 8)}…, vad=${session.vadEngine})`);
        return;
      }

      if (!ws.data.authed || !ws.data.session) {
        ws.send(JSON.stringify({ type: "error", message: "hello first" }));
        return;
      }
      ws.data.session.handleMessage(msg);
    },

    close(ws) {
      ws.data.session?.destroy();
      ws.data.session = null;
    },
  },
});

console.log(`[gateway] Atlas voice gateway on ws://127.0.0.1:${server.port}/ws`);
