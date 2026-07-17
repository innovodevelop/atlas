/**
 * Atlas voice gateway — Bun WebSocket server.
 *
 * Runs as a Tauri sidecar in the packaged app (spawned by src-tauri, bound to
 * 127.0.0.1, guarded by a SIDECAR_TOKEN handshake so only the app connects)
 * or standalone in dev: `bun run dev` from services/voice-gateway.
 *
 * Env (sidecar: injected by Tauri; dev: .env fallback from the repo root):
 *   SUPABASE_URL / VITE_SUPABASE_URL
 *   SUPABASE_ANON_KEY / VITE_SUPABASE_PUBLISHABLE_KEY
 *   VOICE_GATEWAY_PORT (default 4820)
 *   SIDECAR_TOKEN (optional — required when set)
 *   VAD_MODEL_PATH (default models/silero_vad.onnx)
 */

import "./denoShim.ts";
import { createClient } from "@supabase/supabase-js";
import { VoiceSession } from "./session.ts";
import type { ClientMsg } from "./protocol.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

function loadRepoDotenv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const txt = readFileSync(join(HERE, "../../../.env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* packaged build: env comes from Tauri */ }
  return out;
}

const dotenv = loadRepoDotenv();
const SUPABASE_URL =
  process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? dotenv.VITE_SUPABASE_URL;
const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? dotenv.VITE_SUPABASE_PUBLISHABLE_KEY;
const PORT = Number(process.env.VOICE_GATEWAY_PORT ?? 4820);
const SIDECAR_TOKEN = process.env.SIDECAR_TOKEN;
const VAD_MODEL_PATH = process.env.VAD_MODEL_PATH ?? join(HERE, "../models/silero_vad.onnx");

if (!SUPABASE_URL || !ANON_KEY) {
  console.error("[gateway] Missing SUPABASE_URL / SUPABASE_ANON_KEY");
  process.exit(1);
}

interface SocketData {
  session: VoiceSession | null;
  authed: boolean;
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
        // Validate the user JWT — same trust model as the edge functions.
        const authClient = createClient(SUPABASE_URL!, ANON_KEY!);
        const { data, error } = await authClient.auth.getUser(msg.jwt);
        if (error || !data.user) {
          ws.send(JSON.stringify({ type: "error", message: "invalid jwt" }));
          ws.close(4003);
          return;
        }

        // User-scoped client: RLS applies to everything the session touches.
        const supabase = createClient(SUPABASE_URL!, ANON_KEY!, {
          global: { headers: { Authorization: `Bearer ${msg.jwt}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const session = await VoiceSession.create({
          supabaseUrl: SUPABASE_URL!,
          anonKey: ANON_KEY!,
          userJwt: msg.jwt,
          userId: data.user.id,
          supabase,
          vadModelPath: VAD_MODEL_PATH,
          voiceId: msg.voiceId,
          ttsModelId: msg.ttsModelId,
          languageCode: undefined, // auto-detect; Danish benchmarked in bench/
          send: (m) => ws.send(JSON.stringify(m)),
          sendBinary: (bytes) => ws.send(bytes),
        });
        ws.data.session = session;
        ws.data.authed = true;
        ws.send(JSON.stringify({ type: "ready", sessionId: crypto.randomUUID() }));
        console.log(`[gateway] session ready (user ${data.user.id.slice(0, 8)}…, vad=${session.vadEngine})`);
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
