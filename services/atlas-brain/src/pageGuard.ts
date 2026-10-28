/**
 * The Browser's address guard — which addresses this Mac may fetch a page from.
 *
 * The Beta Browser (src/pages/atlas/BetaBrowser.tsx) fetches pages through the
 * brain, and the brain runs on the user's Mac, inside their network. An
 * address bar that fetches whatever it is given is a way to reach the router's
 * admin page, a NAS, the brain's own port or the cloud metadata service from a
 * link on a web page. So only the public internet is reachable from here:
 *
 *   - http: and https: only. file:, data:, javascript:, ftp: and every other
 *     scheme are refused before anything is resolved.
 *   - No user:password@ in the address (it hides the real host from a reader
 *     and is never needed to read a public page), and none of the ports
 *     browsers refuse (mail, SSH, IRC, …).
 *   - Hostnames that are local by name are refused without a lookup:
 *     localhost and *.localhost, *.local (Bonjour), *.internal, *.home.arpa,
 *     *.lan, and single-label names (resolved through the LAN's search domain).
 *   - Every address a hostname resolves to is checked, and one private,
 *     loopback, link-local, unspecified, multicast or reserved address refuses
 *     the whole host — a name with one public and one private record is how
 *     DNS rebinding gets in. IPv4-mapped, NAT64 and 6to4 IPv6 addresses are
 *     checked by the IPv4 address they carry.
 *
 * The check runs again on every redirect (pageFetch.ts follows them by hand),
 * and pageFetch connects to the very addresses checked here rather than
 * resolving the name a second time, so a record that changes between the check
 * and the connection is never used.
 *
 * Pure: no DNS, no network. The lookup lives in pageFetch.ts.
 */

export type GuardRefusal =
  | { ok: false; reason: "bad-address"; message: string }
  | { ok: false; reason: "scheme"; message: string }
  | { ok: false; reason: "private"; message: string };

/**
 * An address as typed into Go, turned into a URL the fetcher may try, or the
 * reason it may not. A bare host ("example.com/a") gets https://.
 */
export function parseTarget(input: string): { ok: true; url: URL } | GuardRefusal {
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) {
    return { ok: false, reason: "bad-address", message: "That isn’t a web address." };
  }
  let candidate = raw;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw) || /^[^:/]+:\d+(\/|$)/.test(raw)) {
    // No scheme ("example.com", "example.com:8080/x"): the web's default.
    candidate = `https://${raw}`;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "bad-address", message: "That isn’t a web address." };
  }
  return checkUrl(url);
}

/** The scheme, credential and hostname checks for a URL (a typed one, or a redirect's Location). */
export function checkUrl(url: URL): { ok: true; url: URL } | GuardRefusal {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: "scheme",
      message: `Atlas only opens http and https pages, not ${url.protocol.replace(/:$/, "")}: addresses.`,
    };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "bad-address", message: "Addresses with a user name or password in them aren’t opened." };
  }
  if (url.port && BAD_PORTS.has(Number(url.port))) {
    return { ok: false, reason: "bad-address", message: `Port ${url.port} belongs to mail, file sharing or another service, not web pages, so Atlas doesn’t open it.` };
  }
  const host = bareHost(url.hostname);
  if (!host) return { ok: false, reason: "bad-address", message: "That address has no host." };
  if (isLocalName(host)) {
    return { ok: false, reason: "private", message: `${host} is on this Mac or your local network, which the Browser never reaches.` };
  }
  if (isIpLiteral(host) && isPrivateAddress(host)) {
    return { ok: false, reason: "private", message: `${host} is a private or local address, which the Browser never reaches.` };
  }
  return { ok: true, url };
}

/**
 * The Fetch standard's "bad ports": SMTP, SSH, IRC and the rest, which every
 * browser refuses to send an HTTP request to. A page link is not a way to talk
 * to a mail server, here either.
 */
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** `[::1]` → `::1`; lower case; no trailing dot. */
export function bareHost(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"];

/** A hostname that names this Mac or the LAN without any lookup. */
export function isLocalName(host: string): boolean {
  const h = bareHost(host);
  if (isIpLiteral(h)) return false;
  if (h === "localhost" || h === "localhost.localdomain") return true;
  if (LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  // A single label ("router", "nas") resolves through the LAN's search domain.
  return !h.includes(".");
}

export function isIpLiteral(host: string): boolean {
  return parseIPv4(host) !== null || parseIPv6(host) !== null;
}

/**
 * True for every address that is not plainly on the public internet.
 * Unparseable input counts as private: the guard fails closed.
 */
export function isPrivateAddress(address: string): boolean {
  const a = bareHost(address);
  const v4 = parseIPv4(a);
  if (v4) return isPrivateV4(v4);
  const v6 = parseIPv6(a);
  if (v6) return isPrivateV6(v6);
  return true;
}

/**
 * The verdict on a lookup: every address must be public. An empty answer is a
 * refusal too (nothing to connect to that has been checked).
 */
export function checkResolved(host: string, addresses: readonly string[]): { ok: true } | GuardRefusal {
  if (addresses.length === 0) {
    return { ok: false, reason: "bad-address", message: `${host} doesn’t resolve to any address.` };
  }
  const bad = addresses.find((a) => isPrivateAddress(a));
  if (bad !== undefined) {
    return {
      ok: false,
      reason: "private",
      message: `${host} points at ${bad}, a private or local address, which the Browser never reaches.`,
    };
  }
  return { ok: true };
}

/* ── IPv4 ─────────────────────────────────────────────────────────────────── */

/** Strict dotted quad only. (The URL parser has already turned 0x7f.1 and 2130706433 into one.) */
export function parseIPv4(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return parts as [number, number, number, number];
}

function isPrivateV4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 carrier-grade NAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (and cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/* ── IPv6 ─────────────────────────────────────────────────────────────────── */

/** Eight 16-bit groups, or null. Handles `::` and a trailing dotted quad; drops a %zone. */
export function parseIPv6(input: string): number[] | null {
  let s = input;
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(":");
  const last = s.slice(lastColon + 1);
  if (last.includes(".")) {
    const v4 = parseIPv4(last);
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    s = s.slice(0, lastColon + 1) + "0"; // placeholder group, replaced below
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !rest) return null;
  // A dotted tail stands in as one placeholder group for two real ones.
  const target = tail.length ? 7 : 8;
  let groups: number[];
  if (halves.length === 2) {
    const fill = target - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== target) return null;
  if (tail.length) groups = [...groups.slice(0, -1), ...tail];
  return groups;
}

function embeddedV4(hi: number, lo: number): [number, number, number, number] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

function isPrivateV6(g: number[]): boolean {
  const allZeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  if (allZeroUpTo(8)) return true; // :: unspecified
  if (allZeroUpTo(7) && g[7] === 1) return true; // ::1 loopback
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compatible): the IPv4 decides.
  if (allZeroUpTo(5) && g[5] === 0xffff) return isPrivateV4(embeddedV4(g[6], g[7]));
  if (allZeroUpTo(6)) return isPrivateV4(embeddedV4(g[6], g[7]));
  // 64:ff9b::/96 NAT64: the IPv4 decides.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPrivateV4(embeddedV4(g[6], g[7]));
  // 2002::/16 6to4: the IPv4 sits in groups 1–2.
  if (g[0] === 0x2002) return isPrivateV4(embeddedV4(g[1], g[2]));
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 old site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard-only
  return false;
}
