// Starts the one-time mail connect flow (plan Part 4a). Returns the Google
// consent URL; the app opens it in the system browser, where the user's
// existing Google session (or Safari/iCloud Keychain autofill) means the
// whole flow is typically a single "Allow" click — no typing.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleOAuthConfig, pkceChallenge, base64UrlEncode, GMAIL_SCOPE } from "../_shared/mailShared.ts";
import { requireUser, AuthError, authErrorResponse } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Identity from the verified JWT — never from the body.
    const { userId } = await requireUser(req);
    const { provider = "gmail" } = await req.json().catch(() => ({}));
    if (provider !== "gmail") throw new Error(`Provider not yet supported: ${provider}`);

    const { clientId, redirectUri } = getGoogleOAuthConfig();
    // service-role: mail_oauth_states intentionally has no user policies —
    // the PKCE verifier must be writable/readable only server-side.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // PKCE + state, verifier kept server-side only
    const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
    const codeVerifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = await pkceChallenge(codeVerifier);

    // Clean expired states in passing (10 min lifetime)
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await supabase.from("mail_oauth_states").delete().lt("created_at", tenMinAgo);

    const { error } = await supabase.from("mail_oauth_states").insert({
      state,
      user_id: userId,
      provider,
      code_verifier: codeVerifier,
    });
    if (error) throw error;

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", GMAIL_SCOPE);           // READ-ONLY by design
    authUrl.searchParams.set("access_type", "offline");        // refresh token
    authUrl.searchParams.set("prompt", "consent");             // always issue refresh token
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    return new Response(JSON.stringify({ authUrl: authUrl.href }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("[mail-oauth-start]", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
