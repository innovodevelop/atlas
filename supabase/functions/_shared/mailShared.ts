// Shared helpers for the mail-intelligence functions (plan Part 4a).
// Google OAuth plumbing + mail-scoped token encryption (delegates to the
// generic _shared/crypto module, bound to the MAIL_TOKEN_KEY secret).
// The mailbox is READ-ONLY by design: gmail.readonly scope, never modify.
import { encrypt, decrypt, base64UrlEncode, pkceChallenge } from "./crypto.ts";

// deno-lint-ignore no-explicit-any
export type SupabaseClient = any;

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

const MAIL_KEY = "MAIL_TOKEN_KEY";

// --- Token encryption (mail-scoped) -------------------------------------
export const encryptToken = (plaintext: string) => encrypt(plaintext, MAIL_KEY);
export const decryptToken = (encoded: string) => decrypt(encoded, MAIL_KEY);

// Re-export the generic PKCE/base64url helpers so existing mail imports keep working.
export { base64UrlEncode, pkceChallenge };

// --- Google OAuth --------------------------------------------------------

export function getGoogleOAuthConfig() {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET secrets are not set (see docs/mail-setup.md)");
  }
  // Prefer the branded callback (atlas.innovo-studio.com/oauth/google/callback,
  // an atlas-site Pages Function that proxies to mail-oauth-callback) when
  // OAUTH_REDIRECT_BASE is set; otherwise fall back to the direct Supabase URL
  // so the flow keeps working until the domain cutover. This exact string must
  // also be registered as an Authorized redirect URI on the Atlas Mail client.
  const base = Deno.env.get("OAUTH_REDIRECT_BASE");
  const redirectUri = base
    ? `${base.replace(/\/$/, "")}/oauth/google/callback`
    : `${Deno.env.get("SUPABASE_URL")}/functions/v1/mail-oauth-callback`;
  return { clientId, clientSecret, redirectUri };
}

/** Exchange a refresh token for a short-lived Gmail access token. */
export async function googleAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = getGoogleOAuthConfig();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) {
    throw new Error(`Google token refresh failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const data = await res.json();
  return data.access_token;
}
