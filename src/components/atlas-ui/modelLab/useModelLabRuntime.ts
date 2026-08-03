import { useEffect, useState } from 'react';
import { isTauri } from '@/integrations/local/localClient';

/**
 * The only genuinely LIVE thing the Model Lab can read: which lane the brain
 * sidecar was spawned on, and which keys exist to serve it.
 *
 * Two Tauri commands, both already shipping (`src-tauri/src/lib.rs`):
 *
 *   brain_ai_status   -> { anthropic, bedrock, ai_provider, gemini, … }
 *                        Key PRESENCE only; it never returns a value.
 *   atlas_brain_info  -> { port, token, running, integrity_error }
 *                        `running` is what says routing is live at all.
 *
 * OUTSIDE TAURI there is no sidecar and no Keychain, so this reports
 * `available: false` and the surface renders a "desktop app required" empty
 * state instead of a plausible-looking default. That distinction is the whole
 * point: "no key configured" and "we cannot see whether a key is configured"
 * are different facts and must not render the same.
 *
 * ONE-SHOT, not polled. Both values change at app launch — `brain_set_ai_key`
 * says so in its own doc comment ("takes effect on the next app launch") — so a
 * refetch interval would be network churn for a value that cannot move. The
 * caller gets `reload()` for the case where the user changed a key in Settings
 * and came back.
 */
export interface BrainAiStatus {
  anthropic: boolean;
  bedrock: boolean;
  ai_provider: string;
  gemini: boolean;
  perplexity: boolean;
  openweather: boolean;
  finnhub: boolean;
  news: boolean;
  elevenlabs: boolean;
}

export interface BrainInfo {
  port: number;
  running: boolean;
  integrity_error: string | null;
}

export interface ModelLabRuntime {
  /** False in a browser: nothing here is knowable outside the desktop app. */
  available: boolean;
  loading: boolean;
  /** Set when the commands exist but threw — a real failure, not absence. */
  error: string | null;
  status: BrainAiStatus | null;
  brain: BrainInfo | null;
  reload: () => void;
}

export function useModelLabRuntime(): ModelLabRuntime {
  const available = isTauri();
  const [loading, setLoading] = useState(available);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<BrainAiStatus | null>(null);
  const [brain, setBrain] = useState<BrainInfo | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        // Settled, not all-or-nothing: the brain can be down while the Keychain
        // still answers, and that combination is exactly what the surface has
        // to be able to show.
        const [s, b] = await Promise.allSettled([
          invoke<BrainAiStatus>('brain_ai_status'),
          invoke<BrainInfo>('atlas_brain_info'),
        ]);
        if (cancelled) return;
        if (s.status === 'fulfilled') setStatus(s.value);
        if (b.status === 'fulfilled') setBrain(b.value);
        if (s.status === 'rejected' && b.status === 'rejected') {
          setError(String(s.reason ?? 'brain_ai_status failed'));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [available, nonce]);

  return { available, loading, error, status, brain, reload: () => setNonce((n) => n + 1) };
}

/**
 * Which lane the runtime says is active, expressed in the lab's vocabulary.
 * `brain_ai_status.ai_provider` defaults to "anthropic" in Rust when the
 * Keychain has no `atlas_ai_provider` entry, which matches getAIConfig()'s own
 * fallback order — so this is the same answer the gateway would give.
 */
export function activeLane(status: BrainAiStatus | null): 'anthropic' | 'bedrock' | null {
  if (!status) return null;
  return status.ai_provider.toLowerCase() === 'bedrock' ? 'bedrock' : 'anthropic';
}
