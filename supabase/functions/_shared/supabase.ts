/**
 * Shared Supabase client factory for Edge Functions
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

/**
 * Get a Supabase client with service role key (full admin access)
 */
export function getSupabaseClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables");
  }
  
  return createClient(url, key);
}

/**
 * Get a Supabase client acting AS the calling user (anon key + their JWT),
 * so RLS applies. THIS IS THE DEFAULT for user-scoped functions — pair it
 * with `requireUser(req)` from ./auth.ts. Service role (`getSupabaseClient`)
 * is reserved for genuinely cross-user/system work and each call site must
 * carry a one-line comment saying why RLS can't be used.
 */
export function getUserClient(token: string) {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY");

  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables");
  }

  return createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Get a Supabase client with anon key (respects RLS)
 */
export function getSupabaseAnon() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY");
  
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables");
  }
  
  return createClient(url, key);
}

/**
 * Get Supabase URL for internal function calls
 */
export function getSupabaseUrl(): string {
  const url = Deno.env.get("SUPABASE_URL");
  if (!url) {
    throw new Error("Missing SUPABASE_URL environment variable");
  }
  return url;
}
