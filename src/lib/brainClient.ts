// Resolves the local Atlas brain sidecar's endpoint (Supabase-removal). The
// brain runs on 127.0.0.1:<port> guarded by a per-launch SIDECAR_TOKEN; the
// Rust `atlas_brain_info` command hands the webview {port, token}. Chat now
// streams from the brain instead of the Supabase chat edge functions.
//
// Desktop-only: outside Tauri there's no sidecar, so callers get null and
// should surface "desktop app required".
import { isTauri } from "@/integrations/local/localClient";

let cached: { baseUrl: string; token: string } | null = null;

export async function getBrainEndpoint(): Promise<{ baseUrl: string; token: string } | null> {
  if (cached) return cached;
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = (await invoke("atlas_brain_info")) as { port: number; token: string; running: boolean };
    cached = { baseUrl: `http://127.0.0.1:${info.port}`, token: info.token };
    return cached;
  } catch {
    return null;
  }
}
