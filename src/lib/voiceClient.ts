// Resolves the local voice gateway sidecar's endpoint (Supabase-removal). The
// gateway runs on 127.0.0.1:<port> guarded by a per-launch SIDECAR_TOKEN; the
// Rust `voice_gateway_info` command hands the webview {port, token}. TTS/STT
// now hit the gateway instead of the Supabase ElevenLabs edge functions.
//
// Desktop-only: outside Tauri there's no sidecar, so callers get null and
// should surface "desktop app required".
import { isTauri } from "@/integrations/local/localClient";

let cached: { baseUrl: string; token: string } | null = null;

export async function getVoiceEndpoint(): Promise<{ baseUrl: string; token: string } | null> {
  if (cached) return cached;
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = (await invoke("voice_gateway_info")) as { port: number; token: string; running: boolean };
    cached = { baseUrl: `http://127.0.0.1:${info.port}`, token: info.token };
    return cached;
  } catch {
    return null;
  }
}
