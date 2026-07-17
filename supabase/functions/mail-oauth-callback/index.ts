// Google redirects here after consent. Exchanges the code, encrypts and
// stores the refresh token, kicks off the first sync, and shows a tiny
// "connected" page — the app notices via the mail_accounts table (no deep
// link needed). The refresh token never reaches the browser or the client.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getGoogleOAuthConfig, encryptToken } from "../_shared/mailShared.ts";

function htmlPage(title: string, message: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#0d0d1f;color:#eceef8;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{text-align:center;padding:48px;border-radius:20px;background:#16162c;max-width:420px}
h1{font-size:22px;margin:0 0 12px}p{color:#9aa0c0;line-height:1.5;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");

    if (oauthError) return htmlPage("Connection cancelled", `Google reported: ${oauthError}. You can close this window and try again in Atlas.`);
    if (!code || !state) return htmlPage("Invalid request", "Missing code or state. Close this window and retry from Atlas.");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Validate state (10 min lifetime), consume it
    const { data: stateRow } = await supabase
      .from("mail_oauth_states").select("user_id, provider, code_verifier, created_at")
      .eq("state", state).single();
    if (!stateRow || Date.now() - new Date(stateRow.created_at).getTime() > 10 * 60 * 1000) {
      return htmlPage("Link expired", "This connect link has expired. Close this window and retry from Atlas.");
    }
    await supabase.from("mail_oauth_states").delete().eq("state", state);

    // Exchange the code
    const { clientId, clientSecret, redirectUri } = getGoogleOAuthConfig();
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        code_verifier: stateRow.code_verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      console.error("[mail-oauth-callback] token exchange failed:", await tokenRes.text().catch(() => ""));
      return htmlPage("Connection failed", "Google rejected the token exchange. Close this window and retry from Atlas.");
    }
    const tokens = await tokenRes.json();
    if (!tokens.refresh_token) {
      return htmlPage("Connection failed", "Google did not issue a refresh token. Remove Atlas from your Google account permissions and try again.");
    }

    // Whose mailbox is this?
    const profileRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = profileRes.ok ? await profileRes.json() : {};
    const emailAddress = profile.emailAddress || "unknown";

    const { error: upsertError } = await supabase.from("mail_accounts").upsert({
      user_id: stateRow.user_id,
      provider: stateRow.provider,
      email_address: emailAddress,
      encrypted_refresh_token: await encryptToken(tokens.refresh_token),
      status: "active",
      last_error: null,
      sync_cursor: null,
    }, { onConflict: "user_id,provider,email_address" });
    if (upsertError) throw upsertError;

    // First scan starts right away (fire and forget)
    fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/mail-sync`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        "x-cron-secret": Deno.env.get("CRON_SECRET") ?? "",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ userId: stateRow.user_id }),
    }).catch(() => {});

    return htmlPage(
      "Mailbox connected ✓",
      `Atlas is now scanning ${emailAddress} (read-only). You can close this window and return to Atlas — the Mail card updates automatically.`,
    );
  } catch (error) {
    console.error("[mail-oauth-callback]", error);
    return htmlPage("Connection failed", "Something went wrong storing the connection. Close this window and retry from Atlas.");
  }
});
