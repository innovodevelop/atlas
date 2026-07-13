// Shared helpers for the mail-intelligence functions (plan Part 4a).
// Token encryption (AES-GCM via MAIL_TOKEN_KEY secret) + Google OAuth plumbing.
// The mailbox is READ-ONLY by design: gmail.readonly scope, never modify.

// deno-lint-ignore no-explicit-any
export type SupabaseClient = any;

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// --- AES-GCM token encryption -------------------------------------------

async function getKey(): Promise<CryptoKey> {
  const raw = Deno.env.get("MAIL_TOKEN_KEY");
  if (!raw) throw new Error("MAIL_TOKEN_KEY secret is not set");
  // Key material: SHA-256 of the secret → always a valid 256-bit key.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptToken(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptToken(encoded: string): Promise<string> {
  const key = await getKey();
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

// --- Google OAuth --------------------------------------------------------

export function getGoogleOAuthConfig() {
  const clientId = Deno.env.get("GOOGLE_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET secrets are not set (see docs/mail-setup.md)");
  }
  const redirectUri = `${Deno.env.get("SUPABASE_URL")}/functions/v1/mail-oauth-callback`;
  return { clientId, clientSecret, redirectUri };
}

export function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
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
