/**
 * Auth API tests — production auth on Cloudflare Pages Functions + D1.
 *
 * Run with: bun test tests/auth.spec.ts
 *
 * Targets the live endpoints at https://helloatlas.dk (override with
 * ATLAS_AUTH_BASE):
 *   POST /api/auth/signup    { email, password } -> { userId, email, token, entitlement }
 *   POST /api/auth/login     { email, password } -> { userId, email, token, entitlement }
 *   POST /api/auth/verify    Bearer or { token } -> { valid, userId, email }
 *   GET  /api/me             Bearer              -> entitlement snapshot
 *   POST /api/account/delete Bearer              -> account erased
 *
 * Static tests (request-shape / config discipline) always run and need no
 * network. The LIVE tests hit production and are OPT-IN:
 *   RUN_LIVE_AUTH_TESTS=1 bun test tests/auth.spec.ts
 * They are safe against production: the lifecycle test uses a throwaway
 * e2e-test-<epoch>@example.com account that is always deleted (try/finally),
 * and the suite stays far below the login throttle (10 fails / 15 min per
 * email+IP) by spending at most ONE failed login per email.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const AUTH_BASE = (process.env.ATLAS_AUTH_BASE ?? "https://helloatlas.dk").replace(/\/$/, "");

const ENDPOINTS = {
  signup: "/api/auth/signup",
  login: "/api/auth/login",
  verify: "/api/auth/verify",
  me: "/api/me",
  accountDelete: "/api/account/delete",
} as const;

const api = (path: string) => `${AUTH_BASE}${path}`;

// Mirrors the server-side signup validation (atlas-site functions/api/auth/signup.ts).
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MIN_PASSWORD_LENGTH = 8;

// Throwaway-account email: unique per call even within the same millisecond.
let emailSeq = 0;
const testEmail = () => `e2e-test-${Date.now()}-${emailSeq++}@example.com`;

async function postJson(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(api(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const readRepoFile = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// Static tests — request shape + config discipline; no live server needed.
// ---------------------------------------------------------------------------

describe("static — endpoint + payload shape", () => {
  test("endpoint builder produces absolute https URLs on the auth origin", () => {
    for (const path of Object.values(ENDPOINTS)) {
      const url = new URL(api(path));
      expect(url.protocol).toBe("https:");
      expect(url.origin + url.pathname).toBe(api(path)); // no query/fragment sneaking in
      expect(url.pathname).toBe(path);
    }
  });

  test("throwaway test emails pass the server's email validation and are unique", () => {
    const a = testEmail();
    const b = testEmail();
    expect(a).toMatch(/^e2e-test-\d+-\d+@example\.com$/);
    expect(EMAIL_RE.test(a)).toBe(true);
    expect(a.length).toBeLessThanOrEqual(254); // server rejects >254
    expect(a).not.toBe(b);
  });

  test("credential payload serializes to the exact shape the API expects", () => {
    const body = JSON.parse(JSON.stringify({ email: "user@example.com", password: "hunter22" }));
    expect(Object.keys(body).sort()).toEqual(["email", "password"]);
    expect(typeof body.email).toBe("string");
    expect(typeof body.password).toBe("string");
    expect(body.password.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });

  test("app auth client targets the same endpoints and default base", () => {
    const src = readRepoFile("src/lib/authClient.ts");
    for (const path of [ENDPOINTS.signup, ENDPOINTS.login, ENDPOINTS.me, ENDPOINTS.accountDelete]) {
      expect(src).toContain(path);
    }
    expect(src).toContain("https://helloatlas.dk");
    expect(src).not.toContain("supabase-js"); // auth must never regress to the dead stack
  });

  test("package.json carries no Supabase dependencies", () => {
    const pkg = JSON.parse(readRepoFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).filter((d) => d === "supabase" || d.startsWith("@supabase/"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Live tests — hit production; opt-in via RUN_LIVE_AUTH_TESTS=1.
// ---------------------------------------------------------------------------

const live = process.env.RUN_LIVE_AUTH_TESTS === "1";
const liveTest = test.skipIf(!live);
const LIVE_TIMEOUT_MS = 30_000;

describe("live — rejection paths (no account created)", () => {
  liveTest(
    "login with bogus credentials → 401 with a JSON error",
    async () => {
      // Unique email => its own throttle bucket; this is the ONLY failed login
      // this suite ever burns on that bucket (limit is 10 per 15 min).
      const res = await postJson(ENDPOINTS.login, {
        email: testEmail(),
        password: "definitely-not-the-password",
      });
      expect(res.status).toBe(401);
      const data = (await res.json()) as { error?: string };
      expect(typeof data.error).toBe("string");
      expect(data.error!.length).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );

  liveTest(
    "login with missing fields → 400",
    async () => {
      const res = await postJson(ENDPOINTS.login, { email: "", password: "" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBeTruthy();
    },
    LIVE_TIMEOUT_MS,
  );

  liveTest(
    "signup with an invalid email → 400",
    async () => {
      const res = await postJson(ENDPOINTS.signup, {
        email: "not-an-email",
        password: "long-enough-password",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBeTruthy();
    },
    LIVE_TIMEOUT_MS,
  );

  liveTest(
    "signup with a 7-char password → 400 (8-char minimum)",
    async () => {
      const res = await postJson(ENDPOINTS.signup, { email: testEmail(), password: "seven77" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBeTruthy();
    },
    LIVE_TIMEOUT_MS,
  );

  liveTest(
    "verify with a garbage token → 401; with no token → 400",
    async () => {
      const bad = await postJson(ENDPOINTS.verify, { token: "garbage.token.value" });
      expect(bad.status).toBe(401);
      const missing = await postJson(ENDPOINTS.verify, {});
      expect(missing.status).toBe(400);
    },
    LIVE_TIMEOUT_MS,
  );

  liveTest(
    "/api/me without a bearer token is rejected",
    async () => {
      const res = await fetch(api(ENDPOINTS.me));
      expect([400, 401]).toContain(res.status);
    },
    LIVE_TIMEOUT_MS,
  );
});

describe("live — signup → login → verify → me → delete lifecycle", () => {
  liveTest(
    "full lifecycle with a throwaway account (always deleted)",
    async () => {
      const email = testEmail();
      const password = `e2e-Pass-${Date.now()}`;
      // The freshest token for the account; the finally block uses it to
      // guarantee deletion even when an assertion above it fails.
      let token: string | null = null;
      let deleted = false;
      try {
        // 1. Signup
        const signupRes = await postJson(ENDPOINTS.signup, { email, password });
        expect(signupRes.status).toBe(200);
        const signup = (await signupRes.json()) as {
          userId?: string;
          email?: string;
          token?: string;
        };
        expect(signup.userId).toBeTruthy();
        expect(signup.email).toBe(email);
        expect(signup.token).toBeTruthy();
        token = signup.token!;

        // 2. Login with the same credentials
        const loginRes = await postJson(ENDPOINTS.login, { email, password });
        expect(loginRes.status).toBe(200);
        const login = (await loginRes.json()) as { userId?: string; token?: string };
        expect(login.userId).toBe(signup.userId);
        expect(login.token).toBeTruthy();
        token = login.token!;

        // 3. Verify the JWT server-side
        const verifyRes = await postJson(ENDPOINTS.verify, {}, token);
        expect(verifyRes.status).toBe(200);
        const verify = (await verifyRes.json()) as { valid?: boolean; userId?: string };
        expect(verify.valid).toBe(true);
        expect(verify.userId).toBe(signup.userId);

        // 4. /api/me returns an entitlement snapshot for the bearer
        const meRes = await fetch(api(ENDPOINTS.me), {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(meRes.status).toBe(200);
        const me = (await meRes.json()) as { plan?: string; status?: string };
        expect(typeof me.plan).toBe("string"); // brand-new accounts land on the free tier

        // 5. Delete the account (part of the assertion path, not just cleanup)
        const delRes = await postJson(ENDPOINTS.accountDelete, {}, token);
        expect(delRes.status).toBe(200);
        deleted = true;

        // 6. The account is really gone: same credentials now fail (single
        //    throttle fail on this email — far below the 10-fail limit).
        const relogin = await postJson(ENDPOINTS.login, { email, password });
        expect(relogin.status).toBe(401);
      } finally {
        // Safety net: never leave the throwaway account behind. A 404 means it
        // is already gone, which is the state we want.
        if (token && !deleted) {
          const res = await postJson(ENDPOINTS.accountDelete, {}, token);
          if (!res.ok && res.status !== 404) {
            console.error(
              `CLEANUP FAILED: throwaway account ${email} may still exist (delete → ${res.status})`,
            );
          }
        }
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
