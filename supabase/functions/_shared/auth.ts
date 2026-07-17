/**
 * Shared auth helpers for Edge Functions (Workstream A).
 *
 * Identity ALWAYS comes from the verified JWT — never from the request body.
 * Every user-scoped function calls `requireUser(req)` first and uses the
 * returned token with `getUserClient(token)` so RLS applies.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";
import { corsHeaders } from "./cors.ts";

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

/** 401/403 Response with CORS headers — return this from a catch block. */
export function authErrorResponse(err: unknown): Response {
  const status = err instanceof AuthError ? err.status : 401;
  const message = err instanceof Error ? err.message : "Unauthorized";
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Verify the caller's JWT and return their identity.
 * Throws AuthError(401) when the header is missing/invalid — including when
 * the bearer is merely the publishable/anon key (a key is not an identity).
 */
export async function requireUser(
  req: Request,
): Promise<{ userId: string; token: string }> {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new AuthError("Missing Authorization bearer token");

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) throw new AuthError("Auth not configured", 500);

  // The anon/publishable key itself is not a user session.
  if (token === anonKey) throw new AuthError("A user session is required");

  const client = createClient(url, anonKey);
  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user) throw new AuthError("Invalid or expired session");
  return { userId: data.user.id, token };
}

/**
 * Guard for cron/internal endpoints that stay `verify_jwt = false`.
 * The caller (pg_cron, internal function-to-function) must send
 * `x-cron-secret: <CRON_SECRET>`. Throws AuthError(403) otherwise.
 */
export function requireCronSecret(req: Request): void {
  const expected = Deno.env.get("CRON_SECRET");
  if (!expected) throw new AuthError("CRON_SECRET not configured", 500);
  const got = req.headers.get("x-cron-secret");
  if (got !== expected) throw new AuthError("Forbidden", 403);
}

/** True when the request carries the internal cron secret. */
export function hasCronSecret(req: Request): boolean {
  const expected = Deno.env.get("CRON_SECRET");
  return Boolean(expected && req.headers.get("x-cron-secret") === expected);
}

/**
 * Dual-mode guard for functions reachable both by users (JWT) and by the
 * internal cron chain (x-cron-secret). Internal callers get
 * `{ internal: true, userId: null }`; user callers get their verified id.
 */
export async function requireUserOrInternal(
  req: Request,
): Promise<{ userId: string | null; token: string | null; internal: boolean }> {
  if (hasCronSecret(req)) return { userId: null, token: null, internal: true };
  const { userId, token } = await requireUser(req);
  return { userId, token, internal: false };
}
