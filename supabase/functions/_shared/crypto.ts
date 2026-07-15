// Generic AES-GCM token encryption for edge functions, parameterized over the
// Supabase secret that holds the key material. Used to store third-party
// tokens at rest (mail refresh tokens, brokerage user-secrets, …) so a DB read
// alone never exposes a usable credential.

async function getKey(secretName: string): Promise<CryptoKey> {
  const raw = Deno.env.get(secretName);
  if (!raw) throw new Error(`${secretName} secret is not set`);
  // Key material: SHA-256 of the secret → always a valid 256-bit AES key.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Encrypt `plaintext` with the key in `secretName`; returns base64(iv|ciphertext). */
export async function encrypt(plaintext: string, secretName: string): Promise<string> {
  const key = await getKey(secretName);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv);
  combined.set(ciphertext, iv.length);
  return btoa(String.fromCharCode(...combined));
}

/** Reverse of `encrypt`. */
export async function decrypt(encoded: string, secretName: string): Promise<string> {
  const key = await getKey(secretName);
  const combined = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}

/** URL-safe base64 (no padding) — for PKCE challenges, state tokens, etc. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}
