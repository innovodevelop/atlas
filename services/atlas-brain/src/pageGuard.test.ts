// The Browser's address guard (pageGuard.ts). Each row is an address the
// brain must never fetch on the user's behalf, or one it must: the guard fails
// closed, so a missed refusal here is a way into the user's own network.
import { describe, expect, test } from "bun:test";
import {
  bareHost,
  checkResolved,
  checkUrl,
  isLocalName,
  isPrivateAddress,
  parseIPv6,
  parseTarget,
} from "./pageGuard.ts";

function refused(input: string): string | null {
  const r = parseTarget(input);
  return r.ok ? null : r.reason;
}

describe("parseTarget", () => {
  test("a bare host gets https and keeps its path and query", () => {
    const r = parseTarget(" example.com/a/b?c=1 ");
    if (!r.ok) throw new Error(r.message);
    expect(r.url.href).toBe("https://example.com/a/b?c=1");
  });

  test("a bare host with a port is still a host, not a scheme", () => {
    const r = parseTarget("example.com:8443/x");
    if (!r.ok) throw new Error(r.message);
    expect(r.url.href).toBe("https://example.com:8443/x");
  });

  test("http and https pass", () => {
    expect(refused("http://example.com")).toBeNull();
    expect(refused("HTTPS://Example.COM/Path")).toBeNull();
  });

  test("every other scheme is refused before any lookup", () => {
    for (const s of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://example.com", "mailto:a@b.co", "chrome://settings", "about:blank", "tauri://localhost"]) {
      expect(refused(s)).toBe("scheme");
    }
  });

  test("words, sentences and empty input are not addresses", () => {
    expect(refused("")).toBe("bad-address");
    expect(refused("   ")).toBe("bad-address");
    expect(refused("heat pump prices")).toBe("bad-address");
    expect(refused("https://")).toBe("bad-address");
  });

  test("ports that belong to other services are refused, as browsers refuse them", () => {
    for (const s of ["http://example.com:25/", "example.com:22", "https://example.com:6667/x"]) {
      expect([s, refused(s)]).toEqual([s, "bad-address"]);
    }
    expect(refused("https://example.com:8443/")).toBeNull();
    expect(refused("http://example.com:80/")).toBeNull();
  });

  test("credentials in the address are refused", () => {
    expect(refused("https://user:pass@example.com/")).toBe("bad-address");
    expect(refused("https://user@example.com/")).toBe("bad-address");
  });

  test("local names are refused without a lookup", () => {
    for (const s of [
      "localhost", "http://localhost:4830/health", "LOCALHOST.", "app.localhost", "printer.local", "nas.lan",
      "metadata.google.internal", "router.home.arpa", "router", "http://intranet/", "wiki.corp",
    ]) {
      expect(refused(s)).toBe("private");
    }
  });

  test("private, loopback and link-local literals are refused", () => {
    for (const s of [
      "http://127.0.0.1/", "127.1", "http://0.0.0.0:8080", "10.0.0.1", "http://172.16.5.4", "172.31.255.255",
      "192.168.1.1", "169.254.169.254/latest/meta-data", "100.64.0.1", "http://[::1]/", "http://[::]/",
      "http://[fe80::1]/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/",
      "http://[64:ff9b::a00:1]/", "http://[2002:c0a8:101::1]/", "224.0.0.1", "255.255.255.255",
      // The URL parser turns these into dotted quads; the guard sees 127.0.0.1.
      "http://2130706433/", "http://0x7f.1/", "http://0177.0.0.1/",
    ]) {
      expect([s, refused(s)]).toEqual([s, "private"]);
    }
  });

  test("public literals pass", () => {
    expect(refused("http://93.184.215.14/")).toBeNull();
    expect(refused("http://[2606:2800:21f:cb07:6820:80da:af6b:8b2c]/")).toBeNull();
    expect(refused("172.32.0.1")).toBeNull();
    expect(refused("100.128.0.1")).toBeNull();
  });
});

describe("checkUrl (redirect targets)", () => {
  test("judges a redirect's Location the same way", () => {
    expect(checkUrl(new URL("http://192.168.0.10/admin")).ok).toBe(false);
    expect(checkUrl(new URL("file:///etc/hosts")).ok).toBe(false);
    expect(checkUrl(new URL("https://example.org/next")).ok).toBe(true);
  });
});

describe("addresses", () => {
  test("bareHost strips brackets, case and trailing dots", () => {
    expect(bareHost("[::1]")).toBe("::1");
    expect(bareHost("Example.COM..")).toBe("example.com");
  });

  test("isLocalName", () => {
    expect(isLocalName("localhost")).toBe(true);
    expect(isLocalName("nas")).toBe(true);
    expect(isLocalName("example.com")).toBe(false);
    expect(isLocalName("127.0.0.1")).toBe(false); // a literal is judged as an address, not a name
  });

  test("unparseable input counts as private: the guard fails closed", () => {
    expect(isPrivateAddress("not an address")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });

  test("documentation, benchmarking and TEST-NET ranges are not the internet", () => {
    for (const a of ["192.0.2.1", "198.51.100.7", "203.0.113.9", "198.18.0.1", "2001:db8::1", "192.0.0.8"]) {
      expect([a, isPrivateAddress(a)]).toEqual([a, true]);
    }
  });

  test("parseIPv6 expands :: and a dotted tail", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(parseIPv6("fe80::1%en0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("1:2:3:4:5:6:7:8:9")).toBeNull();
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(parseIPv6("example.com")).toBeNull();
  });
});

describe("checkResolved", () => {
  test("one private record refuses the whole host (DNS rebinding)", () => {
    const r = checkResolved("evil.example", ["93.184.215.14", "127.0.0.1"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("private");
      expect(r.message).toContain("127.0.0.1");
    }
  });

  test("an empty answer is a refusal, not a pass", () => {
    expect(checkResolved("nothing.example", []).ok).toBe(false);
  });

  test("all-public answers pass", () => {
    expect(checkResolved("example.com", ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"]).ok).toBe(true);
  });
});
