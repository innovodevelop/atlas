/**
 * Workstream A acceptance tests — auth hardening.
 *
 * Run with: bun test tests/auth.spec.ts
 *
 * Hits the LIVE Supabase project (from .env). Written BEFORE the fix, so on
 * the unhardened deploy the core tests FAIL (chat-with-memory returns 200 to
 * anonymous callers). After hardening they must pass.
 *
 * Cross-user isolation tests need two real accounts; provide them via env:
 *   TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD
 *   TEST_USER_B_EMAIL / TEST_USER_B_PASSWORD
 * Those tests are skipped when the env vars are absent.
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";

import { readFileSync } from "node:fs";

function readEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const txt = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*)"?$/);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* .env optional; fall back to process env */ }
  return out;
}

const fileEnv = readEnvFile();
const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? fileEnv.VITE_SUPABASE_URL;
const PUBLISHABLE_KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? fileEnv.VITE_SUPABASE_PUBLISHABLE_KEY;

// Live tests hit the deployed project and need the URL/key (.env is
// untracked, so CI doesn't have them). The static config-discipline tests
// always run; the live ones skip cleanly when unconfigured.
const haveLiveTarget = Boolean(SUPABASE_URL && PUBLISHABLE_KEY);

const FN = (name: string) => `${SUPABASE_URL}/functions/v1/${name}`;

/** Functions that must reject anonymous callers once hardened. */
const USER_SCOPED_SAMPLE = [
  "chat-with-memory",
  "elevenlabs-tts",
  "elevenlabs-stt",
  "tool-gateway",
  "semantic-search",
  "mail-oauth-start",
];

const A_EMAIL = process.env.TEST_USER_A_EMAIL;
const A_PASSWORD = process.env.TEST_USER_A_PASSWORD;
const B_EMAIL = process.env.TEST_USER_B_EMAIL;
const B_PASSWORD = process.env.TEST_USER_B_PASSWORD;
const haveTwoUsers = Boolean(A_EMAIL && A_PASSWORD && B_EMAIL && B_PASSWORD);

async function signIn(email: string, password: string) {
  const client = createClient(SUPABASE_URL!, PUBLISHABLE_KEY!);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign-in failed for ${email}: ${error?.message}`);
  return { client, session: data.session, userId: data.user!.id };
}

describe("A1 — anonymous callers are rejected", () => {
  test.skipIf(!haveLiveTarget)("chat-with-memory with NO Authorization header → 401", async () => {
    const res = await fetch(FN("chat-with-memory"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "ping" }] }),
    });
    expect(res.status).toBe(401);
  });

  test.skipIf(!haveLiveTarget)("chat-with-memory with only the publishable key as bearer → 401", async () => {
    // The publishable key is NOT a user identity. Pre-fix the app called this way.
    const res = await fetch(FN("chat-with-memory"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PUBLISHABLE_KEY}`,
        apikey: PUBLISHABLE_KEY!,
      },
      body: JSON.stringify({ messages: [{ role: "user", content: "ping" }] }),
    });
    expect(res.status).toBe(401);
  });

  for (const fn of USER_SCOPED_SAMPLE) {
    test.skipIf(!haveLiveTarget)(`${fn} anonymous POST → 401`, async () => {
      const res = await fetch(FN(fn), {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: PUBLISHABLE_KEY! },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });
  }
});

describe("A2 — body userId is ignored; identity comes from the JWT", () => {
  test.skipIf(!haveTwoUsers || !haveLiveTarget)(
    "user A sending B's userId in the body still gets A-scoped behavior",
    async () => {
      const a = await signIn(A_EMAIL!, A_PASSWORD!);
      const b = await signIn(B_EMAIL!, B_PASSWORD!);

      // Plant a distinctive memory as B so leakage would be observable.
      const marker = `b-secret-${Date.now()}`;
      await b.client.from("ai_memory").insert({
        user_id: b.userId,
        key: `test_marker`,
        value: marker,
        category: "test",
        importance: 1,
      });

      // A calls chat-with-memory while claiming to be B in the body.
      const res = await fetch(FN("chat-with-memory"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${a.session.access_token}`,
          apikey: PUBLISHABLE_KEY!,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "What do you remember about me?" }],
          userId: b.userId, // must be ignored post-fix
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain(marker);

      // Cleanup B's marker.
      await b.client.from("ai_memory").delete().eq("user_id", b.userId).eq("key", "test_marker");
    },
  );

  test.skipIf(!haveTwoUsers || !haveLiveTarget)("A's JWT cannot read B's ai_memory rows via REST", async () => {
    const a = await signIn(A_EMAIL!, A_PASSWORD!);
    const b = await signIn(B_EMAIL!, B_PASSWORD!);
    const { data, error } = await a.client
      .from("ai_memory")
      .select("key, value")
      .eq("user_id", b.userId);
    // RLS must yield zero rows (empty), never B's data.
    expect(error ?? null).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});

describe("A3 — config.toml discipline (static)", () => {
  test("at most 4 functions remain verify_jwt = false, each with a justification comment", async () => {
    const toml = await Bun.file(new URL("../supabase/config.toml", import.meta.url)).text();
    const offenders: string[] = [];
    const undocumented: string[] = [];
    // A justification comment precedes the [functions.X] header, so check the
    // line above each offender's header rather than naive block-splitting.
    const re = /\[functions\.([^\]]+)\]\nverify_jwt\s*=\s*false/g;
    for (const m of toml.matchAll(re)) {
      const name = m[1];
      offenders.push(name);
      const before = toml.slice(0, m.index);
      const prevLine = before.split("\n").at(-2) ?? "";
      if (!prevLine.trimStart().startsWith("#")) undocumented.push(name);
    }
    expect(offenders.length).toBeLessThanOrEqual(4);
    expect(undocumented).toHaveLength(0);
  });

  test.skipIf(!haveLiveTarget)("cron-target functions require the CRON_SECRET header", async () => {
    // Anonymous call to a cron target must be rejected even though verify_jwt=false.
    for (const fn of ["record-usage-snapshot", "atlas-daily-digest", "mail-sync"]) {
      const res = await fetch(FN(fn), {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: PUBLISHABLE_KEY! },
        body: JSON.stringify({}),
      });
      expect([401, 403]).toContain(res.status);
    }
  });
});
