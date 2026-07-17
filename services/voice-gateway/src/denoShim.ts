/**
 * Deno shim for Bun. The shared `_shared/*` modules (orchestrator, aiGateway,
 * providerStatus, learningGuards) read secrets via `Deno.env.get(...)`.
 * Import this module FIRST so those imports resolve under Bun.
 */
const g = globalThis as unknown as { Deno?: { env: { get(k: string): string | undefined } } };

if (!g.Deno) {
  g.Deno = {
    env: {
      get: (k: string) => process.env[k],
    },
  };
}

export {};
