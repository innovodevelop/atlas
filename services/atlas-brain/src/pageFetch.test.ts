// The Browser's page fetcher (pageFetch.ts), against real local servers.
//
// The resolver is injected so a test can say "this name resolves to a public
// address" or "to a private one"; `dialOverride` then points the socket at the
// local test server AFTER the guard has judged the resolved addresses. So every
// test below exercises the real guard on the real request path: a refusal here
// is a request that never reached the server, and the tests count the hits.
import { afterAll, describe, expect, test } from "bun:test";
import net from "node:net";
import zlib from "node:zlib";
import { fetchPage, guardedResolve, decodeBody, isCertificateError, isReadableType, USER_AGENT, type FetchDeps, type ResolvedAddress } from "./pageFetch.ts";

const PUBLIC: ResolvedAddress[] = [{ address: "93.184.215.14", family: 4 }];
const LOOPBACK: ResolvedAddress[] = [{ address: "127.0.0.1", family: 4 }];

let hits = 0;
const seen: Headers[] = [];
// The handler's redirects name the server's own port; reading it through this
// variable rather than `server` keeps the server's type from depending on itself.
let ownPort = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req: Request): Promise<Response> {
    hits++;
    seen.push(req.headers);
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === "/page") return new Response("<html><head><title>Hello</title></head><body><p>Hi there.</p></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
    if (p === "/latin1") return new Response(Buffer.from("<p>K\xf8benhavn</p>", "latin1"), { headers: { "content-type": "text/html; charset=iso-8859-1" } });
    if (p === "/text") return new Response("plain words", { headers: { "content-type": "text/plain" } });
    if (p === "/pdf") return new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } });
    if (p === "/missing") return new Response("gone", { status: 404, headers: { "content-type": "text/html" } });
    if (p === "/big") return new Response("x".repeat(300_000), { headers: { "content-type": "text/html" } });
    if (p === "/gzbomb") {
      return new Response(zlib.gzipSync(Buffer.from("y".repeat(500_000))), { headers: { "content-type": "text/html", "content-encoding": "gzip" } });
    }
    if (p === "/gz") return new Response(zlib.gzipSync(Buffer.from("<p>zipped</p>")), { headers: { "content-type": "text/html", "content-encoding": "gzip" } });
    if (p === "/slow") { await Bun.sleep(1500); return new Response("<p>late</p>", { headers: { "content-type": "text/html" } }); }
    if (p === "/to-private") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
    if (p === "/to-file") return new Response(null, { status: 301, headers: { location: "file:///etc/passwd" } });
    if (p === "/to-rebind") return new Response(null, { status: 302, headers: { location: `http://rebind.test:${ownPort}/page` } });
    const hop = /^\/hop\/(\d+)$/.exec(p);
    if (hop) {
      const n = Number(hop[1]);
      if (n === 0) return new Response("<p>landed</p>", { headers: { "content-type": "text/html" } });
      return new Response(null, { status: 302, headers: { location: `/hop/${n - 1}` } });
    }
    return new Response("not found", { status: 404 });
  },
});
ownPort = Number(server.port);
afterAll(() => server.stop(true));

const base = () => `http://public.test:${server.port}`;

/** public.test resolves to a public address; the socket really goes to the test server. */
function deps(extra: Partial<FetchDeps> = {}): FetchDeps {
  return {
    resolve: async (host) => (host === "rebind.test" ? [{ address: "10.0.0.5", family: 4 }] : host === "private.test" ? [{ address: "192.168.1.20", family: 4 }] : PUBLIC),
    dialOverride: () => LOOPBACK,
    timeoutMs: 3000,
    ...extra,
  };
}

describe("fetchPage", () => {
  test("reads an HTML page and says where it ended up", async () => {
    const r = await fetchPage(`${base()}/page`, deps());
    if (!r.ok) throw new Error(r.message);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("text/html");
    expect(r.body).toContain("<title>Hello</title>");
    expect(r.truncated).toBe(false);
    expect(r.redirects).toBe(0);
    expect(r.url).toBe(`${base()}/page`);
  });

  test("sends a plain user agent and no cookie or referrer", async () => {
    seen.length = 0;
    await fetchPage(`${base()}/page`, deps());
    const h = seen[0];
    expect(h.get("user-agent")).toBe(USER_AGENT);
    expect(h.get("cookie")).toBeNull();
    expect(h.get("referer")).toBeNull();
    expect(h.get("authorization")).toBeNull();
  });

  test("a name that resolves to a private address is refused before any request", async () => {
    const before = hits;
    const r = await fetchPage(`http://private.test:${server.port}/page`, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private");
    expect(hits).toBe(before);
  });

  test("a redirect to a private address is refused, and never followed", async () => {
    const before = hits;
    const r = await fetchPage(`${base()}/to-private`, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("private");
      expect(r.message).toContain("redirected");
    }
    expect(hits).toBe(before + 1);
  });

  test("a redirect to a name that resolves privately is refused at the lookup", async () => {
    const before = hits;
    const r = await fetchPage(`${base()}/to-rebind`, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private");
    expect(hits).toBe(before + 1);
  });

  test("a redirect to another scheme is refused", async () => {
    const r = await fetchPage(`${base()}/to-file`, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("scheme");
  });

  test("follows up to five redirects, and no more", async () => {
    const five = await fetchPage(`${base()}/hop/5`, deps());
    if (!five.ok) throw new Error(five.message);
    expect(five.redirects).toBe(5);
    expect(five.body).toContain("landed");
    const six = await fetchPage(`${base()}/hop/6`, deps());
    expect(six.ok).toBe(false);
    if (!six.ok) expect(six.reason).toBe("too-many-redirects");
  });

  test("stops reading at the size cap", async () => {
    const r = await fetchPage(`${base()}/big`, deps({ maxBytes: 64 * 1024 }));
    if (!r.ok) throw new Error(r.message);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(64 * 1024);
    expect(r.body.length).toBe(64 * 1024);
  });

  test("the cap counts decompressed bytes, so a small gzip cannot expand past it", async () => {
    const r = await fetchPage(`${base()}/gzbomb`, deps({ maxBytes: 100_000 }));
    if (!r.ok) throw new Error(r.message);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(100_000);
  });

  test("decompresses gzip", async () => {
    const r = await fetchPage(`${base()}/gz`, deps());
    if (!r.ok) throw new Error(r.message);
    expect(r.body).toBe("<p>zipped</p>");
  });

  test("gives up at the deadline", async () => {
    const t0 = Date.now();
    const r = await fetchPage(`${base()}/slow`, deps({ timeoutMs: 250 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(1400);
  });

  test("a PDF is not a page; a 404 says so", async () => {
    const pdf = await fetchPage(`${base()}/pdf`, deps());
    expect(pdf.ok).toBe(false);
    if (!pdf.ok) {
      expect(pdf.reason).toBe("not-a-page");
      expect(pdf.message).toContain("application/pdf");
    }
    const missing = await fetchPage(`${base()}/missing`, deps());
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.reason).toBe("http-status");
      expect(missing.message).toContain("404");
    }
  });

  test("plain text is read; the header's charset decodes the body", async () => {
    const txt = await fetchPage(`${base()}/text`, deps());
    if (!txt.ok) throw new Error(txt.message);
    expect(txt.contentType).toBe("text/plain");
    const latin = await fetchPage(`${base()}/latin1`, deps());
    if (!latin.ok) throw new Error(latin.message);
    expect(latin.body).toBe("<p>København</p>");
  });

  test("a typed private address never reaches the network", async () => {
    const before = hits;
    const r = await fetchPage(`http://127.0.0.1:${server.port}/page`, deps({ dialOverride: undefined }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("private");
    expect(hits).toBe(before);
  });

  test("a name that does not resolve is a dns failure with a sentence", async () => {
    const r = await fetchPage("https://nowhere.example/", { resolve: async () => { throw new Error("ENOTFOUND"); } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("dns");
      expect(r.message).toContain("nowhere.example");
    }
  });
});

// A raw TCP server that streams a large body as fast as the socket takes it,
// counting what it managed to write on each connection. Bun.serve buffers a
// streamed body on its own side, so only a socket-level count shows whether
// the client really stopped reading.
describe("a body Atlas does not read", () => {
  const CHUNK = 64 * 1024;
  const TOTAL = 64 * 1024 * 1024;
  // What the sockets may still take in while the close goes out: a few chunks,
  // where draining the body would write tens of megabytes.
  const SLACK = 16 * CHUNK;
  interface Conn { path: string; sent: number; closed: boolean }
  const conns: Conn[] = [];
  const block = Buffer.alloc(CHUNK, 65);
  const raw = net.createServer((sock) => {
    const c: Conn = { path: "", sent: 0, closed: false };
    conns.push(c);
    let head = "";
    sock.on("data", (d: Buffer) => {
      if (c.path) return;
      head += d.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      c.path = head.split(" ")[1] ?? "/";
      if (c.path === "/page") {
        sock.end("HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 9\r\nconnection: close\r\n\r\n<p>hi</p>");
        return;
      }
      sock.write(c.path === "/moved"
        ? `HTTP/1.1 302 Found\r\nlocation: /page\r\ncontent-type: text/html\r\ncontent-length: ${TOTAL}\r\n\r\n`
        : `HTTP/1.1 200 OK\r\ncontent-type: application/pdf\r\ncontent-length: ${TOTAL}\r\n\r\n`);
      const pump = () => {
        while (c.sent < TOTAL && !c.closed) {
          c.sent += CHUNK;
          if (!sock.write(block)) { sock.once("drain", pump); return; }
        }
        if (c.sent >= TOTAL) sock.end();
      };
      pump();
    });
    const done = () => { c.closed = true; };
    sock.on("end", done);
    sock.on("close", done);
    sock.on("error", done);
  });
  const listening = new Promise<number>((resolve) => raw.listen(0, "127.0.0.1", () => resolve((raw.address() as net.AddressInfo).port)));
  afterAll(() => { raw.close(); });

  /** Fetch, then watch the connection: how much the server wrote after fetchPage returned. */
  async function after(path: string) {
    const port = await listening;
    const from = conns.length;
    const r = await fetchPage(`http://public.test:${port}${path}`, deps());
    const c = conns[from];
    const atReturn = c.sent;
    for (let i = 0; i < 40 && !c.closed; i++) await Bun.sleep(25);
    await Bun.sleep(100);
    return { r, c, atReturn };
  }

  test("a large PDF is cut off at its headers, not downloaded in the background", async () => {
    const { r, c, atReturn } = await after("/huge.pdf");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not-a-page");
    expect(c.closed).toBe(true);
    expect(c.sent - atReturn).toBeLessThanOrEqual(SLACK);
    expect(c.sent).toBeLessThan(TOTAL / 4);
  });

  test("a redirect's body is cut off too, and the redirect is still followed", async () => {
    const { r, c, atReturn } = await after("/moved");
    if (!r.ok) throw new Error(r.message);
    expect(r.body).toBe("<p>hi</p>");
    expect(r.redirects).toBe(1);
    expect(c.closed).toBe(true);
    expect(c.sent - atReturn).toBeLessThanOrEqual(SLACK);
    expect(c.sent).toBeLessThan(TOTAL / 4);
  });
});

describe("guardedResolve", () => {
  test("hands back exactly the checked addresses", async () => {
    expect(await guardedResolve("example.com", { resolve: async () => PUBLIC })).toEqual(PUBLIC);
  });
  test("refuses a mixed answer", async () => {
    const mixed = [...PUBLIC, { address: "::1", family: 6 as const }];
    await expect(guardedResolve("example.com", { resolve: async () => mixed })).rejects.toThrow("::1");
  });
});

describe("helpers", () => {
  test("isCertificateError knows the TLS failures by their codes", () => {
    for (const code of ["DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]) {
      expect([code, isCertificateError(Object.assign(new Error("x"), { code }))]).toEqual([code, true]);
    }
    expect(isCertificateError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(false);
    expect(isCertificateError("nope")).toBe(false);
  });
  test("isReadableType", () => {
    expect(isReadableType("text/html; charset=utf-8")).toBe(true);
    expect(isReadableType("application/xhtml+xml")).toBe(true);
    expect(isReadableType("text/plain")).toBe(true);
    expect(isReadableType("")).toBe(true);
    expect(isReadableType("application/pdf")).toBe(false);
    expect(isReadableType("image/png")).toBe(false);
  });
  test("decodeBody falls back to a meta charset, then UTF-8", () => {
    const latin = Buffer.from('<meta charset="iso-8859-1"><p>\xe6\xf8\xe5</p>', "latin1");
    expect(decodeBody(latin, "text/html")).toContain("æøå");
    expect(decodeBody(Buffer.from("<p>æøå</p>"), "text/html")).toBe("<p>æøå</p>");
    expect(decodeBody(Buffer.from("x"), "text/html; charset=nonsense-9")).toBe("x");
  });
});
