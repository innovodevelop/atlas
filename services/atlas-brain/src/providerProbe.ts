/**
 * The AI provider as a System Status service (Beta row 75): is the provider
 * this brain runs on reachable, and does it accept this Mac's key — checked
 * without spending a token (probeAIProvider in the gateway lists one model on
 * first-party, the foundation models on Bedrock).
 *
 * The health route is polled every ten seconds while System Status is open,
 * and a provider round trip is not worth making that often, so the answer is
 * kept for a minute. "Check again" asks for a fresh one. Two polls arriving
 * while a probe is in flight share it rather than starting a second.
 */

import { probeAIProvider, type ProviderProbe } from "../../../supabase/functions/_shared/aiGateway.ts";

export const AI_PROBE_TTL_MS = 60_000;

export interface ProbeResult {
  probe: ProviderProbe;
  /** `Date.now()` when the probe finished. */
  at: number;
  /** True when this answer was taken from the cache rather than measured now. */
  cached: boolean;
}

export function createProviderProbeCache(
  probe: () => Promise<ProviderProbe> = () => probeAIProvider(),
  ttlMs = AI_PROBE_TTL_MS,
  now: () => number = Date.now,
) {
  let last: { probe: ProviderProbe; at: number } | null = null;
  let inflight: Promise<{ probe: ProviderProbe; at: number }> | null = null;

  return {
    async get(fresh = false): Promise<ProbeResult> {
      if (!fresh && last && now() - last.at < ttlMs) return { ...last, cached: true };
      inflight ??= probe()
        .then((p) => (last = { probe: p, at: now() }))
        .finally(() => { inflight = null; });
      const r = await inflight;
      return { ...r, cached: false };
    },
  };
}

/** The service row the System Status screen draws, in the health route's shape. */
export interface AiProviderService {
  name: "ai-provider";
  status: "healthy" | "degraded" | "down";
  latency_ms: number | null;
  last_check: string;
  error?: string;
  detail: string;
  /** Measured before this request (the minute-long cache), so not part of its round trip. */
  cached: boolean;
}

export function aiProviderService(r: ProbeResult): AiProviderService {
  const p = r.probe;
  // A developer-only provider is configured on purpose and simply not probed:
  // that is not an outage, but it is not a verified answer either.
  const status = p.ok ? "healthy" : p.error === null ? "degraded" : "down";
  return {
    name: "ai-provider",
    status,
    latency_ms: p.latencyMs,
    last_check: new Date(r.at).toISOString(),
    ...(p.error ? { error: p.error } : {}),
    detail: p.detail,
    cached: r.cached,
  };
}
