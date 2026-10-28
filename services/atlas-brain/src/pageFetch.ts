/**
 * Fetches one web page for the Beta Browser, on this Mac, safely.
 *
 * The rules (the Browser's brief, row 69), and where each is enforced:
 *   - http/https only, no local or private address: pageGuard.ts, on the typed
 *     address AND on every redirect target.
 *   - Every address the host resolves to is checked, and the connection goes
 *     to exactly those checked addresses: the socket's `lookup` is ours
 *     (`guardedLookup`), so the name is resolved once, judged, and connected
 *     to — never resolved again behind the check's back (DNS rebinding).
 *   - At most MAX_REDIRECTS redirects, followed by hand, each one re-checked.
 *   - A 2 MB cap counted while the body streams (after decompression, so a
 *     small gzip cannot expand past it); reading stops at the cap.
 *   - One deadline for the whole fetch, redirects included.
 *   - A plain user agent that says what this is. No cookies are sent or kept,
 *     no referrer, no credentials.
 *
 * Only HTML (and plain text) is read; the body is returned as a string for
 * pageReader.ts to turn into text blocks. Nothing here runs a script or loads
 * a sub-resource: one GET per hop, and that is all.
 *
 * node:http is used rather than fetch() because it lets the caller own the
 * DNS lookup for the socket (Bun honours the `lookup` option), which is what
 * makes the address check and the connection one step.
 */
import http from "node:http";
import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import zlib from "node:zlib";
import type { Readable } from "node:stream";
import { checkResolved, checkUrl, isIpLiteral, bareHost, isPrivateAddress, parseTarget } from "./pageGuard.ts";

export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const TIMEOUT_MS = 15_000;
export const USER_AGENT = "Atlas/1.0 (reader; +https://helloatlas.app)";

export type FetchFailure =
  | "bad-address"
  | "scheme"
  | "private"
  | "dns"
  | "timeout"
  | "too-many-redirects"
  | "http-status"
  | "not-a-page"
  | "network";

export type FetchOutcome =
  | {
      ok: true;
      /** The address after redirects. */
      url: string;
      status: number;
      contentType: string;
      body: string;
      /** Bytes read (decompressed). */
      bytes: number;
      /** True when reading stopped at MAX_BYTES. */
      truncated: boolean;
      redirects: number;
    }
  | { ok: false; reason: FetchFailure; message: string; url?: string };

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface FetchDeps {
  /** Resolve a hostname to every address it has. Default: the system resolver. */
  resolve?: (host: string) => Promise<ResolvedAddress[]>;
  /**
   * Test seam, applied AFTER the guard has passed the resolved addresses:
   * where the socket really connects. Tests use it to reach a local server
   * while the resolver claims a public address. Never set in production.
   */
  dialOverride?: (host: string, checked: ResolvedAddress[]) => ResolvedAddress[];
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

class GuardError extends Error {
  constructor(public reason: FetchFailure, message: string) {
    super(message);
  }
}

function systemResolve(host: string): Promise<ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    dnsLookup(host, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })));
    });
  });
}

/**
 * The socket's lookup: resolve, refuse the host if ANY address is private,
 * hand back exactly the checked addresses. Exported for its test.
 */
export async function guardedResolve(host: string, deps: FetchDeps): Promise<ResolvedAddress[]> {
  const name = bareHost(host);
  let addresses: ResolvedAddress[];
  if (isIpLiteral(name)) {
    addresses = [{ address: name, family: name.includes(":") ? 6 : 4 }];
  } else {
    try {
      addresses = await (deps.resolve ?? systemResolve)(name);
    } catch {
      throw new GuardError("dns", `Atlas couldn’t find ${name}.`);
    }
  }
  const verdict = checkResolved(name, addresses.map((a) => a.address));
  if (!verdict.ok) throw new GuardError(verdict.reason, verdict.message);
  return deps.dialOverride ? deps.dialOverride(name, addresses) : addresses;
}

interface Hop {
  status: number;
  location: string | null;
  contentType: string;
  body: string;
  bytes: number;
  truncated: boolean;
}

/** One GET, no redirects followed, through the guarded lookup. */
function getOnce(url: URL, deps: FetchDeps, signal: AbortSignal, maxBytes: number): Promise<Hop> {
  return new Promise<Hop>((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    let settled = false;
    const fail = (e: unknown) => { if (!settled) { settled = true; reject(e); } };
    const lookup = (hostname: string, options: unknown, cb: (...args: unknown[]) => void) => {
      const all = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
      guardedResolve(hostname, deps).then(
        (addrs) => {
          if (all) cb(null, addrs);
          else cb(null, addrs[0].address, addrs[0].family);
        },
        (e) => cb(e),
      );
    };
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: bareHost(url.hostname),
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        agent: false,
        lookup: lookup as never,
        // An IP literal has no name to present; a hostname is the TLS server name.
        servername: isIpLiteral(bareHost(url.hostname)) ? undefined : bareHost(url.hostname),
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1",
          "Accept-Language": "en,da;q=0.8,*;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          Host: url.host,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        const contentType = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400 && location) {
          res.resume();
          settled = true;
          resolve({ status, location, contentType, body: "", bytes: 0, truncated: false });
          return;
        }
        if (status < 200 || status >= 300 || !isReadableType(contentType)) {
          res.resume();
          settled = true;
          resolve({ status, location: null, contentType, body: "", bytes: 0, truncated: false });
          return;
        }
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
        let stream: Readable = res;
        if (encoding === "gzip" || encoding === "x-gzip") stream = res.pipe(zlib.createGunzip());
        else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
        else if (encoding === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const buf = Buffer.concat(chunks, bytes);
          resolve({ status, location: null, contentType, body: decodeBody(buf, contentType), bytes, truncated });
        };
        stream.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const room = maxBytes - bytes;
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, room));
            bytes += room;
            truncated = true;
            // Stop reading: the cap is the cap, not a hint.
            res.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
          bytes += chunk.length;
        });
        stream.on("end", finish);
        stream.on("error", (e) => (truncated ? finish() : fail(e)));
        res.on("error", (e) => (truncated ? finish() : fail(e)));
      },
    );
    req.on("error", fail);
    // The deadline covers a slow body too, not only a slow connect.
    const onAbort = () => { req.destroy(new Error("timeout")); fail(new Error("timeout")); };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    req.end();
  });
}

/** HTML and plain text are pages; a PDF, an image or a zip is not something the reader can show. */
export function isReadableType(contentType: string): boolean {
  const t = contentType.split(";")[0].trim().toLowerCase();
  return t === "" || t === "text/html" || t === "application/xhtml+xml" || t === "text/plain";
}

/** The body as text: the header's charset, else a <meta charset> in the first 2 KB, else UTF-8. */
export function decodeBody(buf: Buffer | Uint8Array, contentType: string): string {
  let charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1];
  if (!charset) {
    const head = new TextDecoder("latin1").decode(buf.subarray(0, 2048));
    charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/**
 * Fetch a page the Browser may read. Never throws: every way it can fail is an
 * outcome with a sentence the screen can show.
 */
export async function fetchPage(input: string, deps: FetchDeps = {}): Promise<FetchOutcome> {
  const parsed = parseTarget(input);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, message: parsed.message };
  const maxBytes = deps.maxBytes ?? MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? TIMEOUT_MS);
  let url = parsed.url;
  try {
    for (let redirects = 0; ; redirects++) {
      let hop: Hop;
      try {
        hop = await getOnce(url, deps, controller.signal, maxBytes);
      } catch (e) {
        if (e instanceof GuardError) return { ok: false, reason: e.reason, message: e.message, url: url.href };
        if (controller.signal.aborted) {
          return { ok: false, reason: "timeout", message: `${url.host} took too long to answer.`, url: url.href };
        }
        return { ok: false, reason: "network", message: `Atlas couldn’t reach ${url.host}.`, url: url.href };
      }
      if (hop.location !== null) {
        if (redirects >= maxRedirects) {
          return { ok: false, reason: "too-many-redirects", message: `${url.host} redirected more than ${maxRedirects} times.`, url: url.href };
        }
        let next: URL;
        try {
          next = new URL(hop.location, url);
        } catch {
          return { ok: false, reason: "bad-address", message: `${url.host} redirected to an address that isn’t one.`, url: url.href };
        }
        const verdict = checkUrl(next);
        if (!verdict.ok) {
          return { ok: false, reason: verdict.reason, message: `${url.host} redirected somewhere the Browser never goes: ${verdict.message}`, url: next.href };
        }
        url = next;
        continue;
      }
      if (hop.status < 200 || hop.status >= 300) {
        return { ok: false, reason: "http-status", message: `${url.host} answered ${hop.status}.`, url: url.href };
      }
      if (!isReadableType(hop.contentType)) {
        const type = hop.contentType.split(";")[0].trim();
        return { ok: false, reason: "not-a-page", message: `That address is a ${type} file, not a page Atlas can read.`, url: url.href };
      }
      return {
        ok: true,
        url: url.href,
        status: hop.status,
        contentType: hop.contentType.split(";")[0].trim().toLowerCase() || "text/html",
        body: hop.body,
        bytes: hop.bytes,
        truncated: hop.truncated,
        redirects,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

// Re-exported so the route and its tests reach the guard through one module.
export { isPrivateAddress, parseTarget };
