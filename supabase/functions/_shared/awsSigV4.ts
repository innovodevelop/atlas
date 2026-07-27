// AWS Signature Version 4 signer — the shared auth primitive for every AWS call
// Atlas makes: Bedrock Claude (now, on Activate credits), Claude Platform on AWS
// (the later "Path B" migration target), SES (mail sending) and S3 (attachment
// blobs + the updater release home).
//
// WHY HAND-ROLLED, NO DEPENDENCY: this file is imported *verbatim* by both the
// Deno edge functions and the Bun brain sidecar (see supabase/functions/_shared/
// in CLAUDE.md). A dependency would need one specifier that resolves in both
// runtimes, and there isn't one — `npm:aws4fetch` fails under Bun, bare
// `aws4fetch` fails under Deno without an import map. Pure WebCrypto (SubtleCrypto
// + TextEncoder) exists identically in both, so a from-scratch signer is the only
// thing that stays runtime-neutral. It is ~120 lines and fully testable.
//
// WHY IT MATTERS FOR THE A→B MIGRATION: Bedrock and Claude Platform on AWS use
// the SAME SigV4 auth with the SAME AWS credentials — they differ only in the
// `service` name and host. So "migrate to B" is: change the service + endpoint
// and drop the model-id prefix. The auth path built here does not change at all.

const encoder = new TextEncoder();

/** SigV4 signing inputs. Credentials come from the environment, never hardcoded. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present only for temporary/STS credentials (assumed roles). */
  sessionToken?: string;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

// --- primitives -----------------------------------------------------------

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
}

/**
 * The SigV4 signing key: a four-step HMAC chain over the credential scope
 * (`AWS4<secret>` → date → region → service → "aws4_request"). Derived per
 * request rather than cached — the date component changes daily and the cost is
 * four HMACs, which is negligible next to the model call that follows.
 */
async function signingKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

// --- the signer -----------------------------------------------------------

export interface SignOptions {
  method: string;
  /** Full request URL, e.g. https://bedrock-runtime.eu-central-1.amazonaws.com/model/…/invoke */
  url: string;
  /** Non-authorization headers to include in the signature (e.g. content-type). */
  headers?: Record<string, string>;
  body?: string;
  region: string;
  /** SigV4 service name: "bedrock", "aws-external-anthropic", "ses", "s3", … */
  service: string;
  credentials: AwsCredentials;
  /**
   * The wall-clock instant for the signature, as (amzDate, dateStamp). Injected
   * rather than read from `new Date()` because `new Date()` with no args is
   * banned in some of Atlas's execution contexts and, more importantly, injecting
   * it keeps the signer a pure function the tests can pin against AWS's own
   * published test vectors.
   */
  now: { amzDate: string; dateStamp: string };
  /**
   * Add `x-amz-content-sha256` as a *signed* header. S3 requires it; SES and the
   * modern AWS SDKs send it everywhere. Off by default so the canonical
   * aws4_testsuite vectors (which sign only host;x-amz-date) can pin the
   * algorithm. The payload hash is part of the canonical request regardless of
   * this flag — this only controls whether the header itself is signed.
   */
  signContentHeader?: boolean;
}

/**
 * Produce the headers (including `Authorization`) for a SigV4-signed request.
 * The caller then does a plain `fetch(url, { method, headers, body })`.
 *
 * Implements the canonical-request → string-to-sign → signature flow from the
 * AWS SigV4 spec, signing exactly the headers in `signedHeaders` (host +
 * x-amz-date + x-amz-content-sha256, plus any caller headers and the session
 * token when present).
 */
export async function signRequest(opts: SignOptions): Promise<Record<string, string>> {
  const url = new URL(opts.url);
  const body = opts.body ?? "";
  const payloadHash = await sha256Hex(body);

  // Headers that participate in the signature. Names are lowercased and the set
  // is sorted; any change here must be mirrored in `signedHeaders` below.
  const signed: Record<string, string> = {
    host: url.host,
    "x-amz-date": opts.now.amzDate,
  };
  if (opts.signContentHeader) {
    signed["x-amz-content-sha256"] = payloadHash;
  }
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    // Skip anything that would collide with the computed signing headers.
    const lower = k.toLowerCase();
    if (lower === "authorization" || lower === "host") continue;
    signed[lower] = v.trim();
  }
  if (opts.credentials.sessionToken) {
    signed["x-amz-security-token"] = opts.credentials.sessionToken;
  }

  const sortedNames = Object.keys(signed).sort();
  const signedHeaders = sortedNames.join(";");
  const canonicalHeaders = sortedNames.map((n) => `${n}:${signed[n]}\n`).join("");

  // Canonical URI must be the path, URI-encoded per RFC 3986 but with "/" kept.
  // The AWS bedrock/messages paths contain no characters that require encoding
  // beyond what URL already normalises, so url.pathname is used directly.
  const canonicalRequest = [
    opts.method.toUpperCase(),
    url.pathname || "/",
    url.search.slice(1), // canonical query string (already sorted by URL for our callers; no query params today)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${opts.now.dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    opts.now.amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const key = await signingKey(opts.credentials.secretAccessKey, opts.now.dateStamp, opts.region, opts.service);
  const signature = toHex(await hmac(key, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { ...signed, Authorization: authorization };
}

/**
 * Format an instant as SigV4 requires: amzDate `YYYYMMDDTHHMMSSZ`, dateStamp
 * `YYYYMMDD`. Pass a Date (the caller supplies it, so this stays testable and
 * avoids the argless-`new Date()` restriction).
 */
export function amzDateParts(d: Date): { amzDate: string; dateStamp: string } {
  const iso = d.toISOString(); // 2026-07-28T12:34:56.789Z
  const amzDate = iso.replace(/[:-]/g, "").replace(/\.\d{3}/, ""); // 20260728T123456Z
  const dateStamp = amzDate.slice(0, 8); // 20260728
  return { amzDate, dateStamp };
}
