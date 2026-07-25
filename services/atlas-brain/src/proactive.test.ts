// Containment tests for the proactive digest (proactive.ts): cooldown, the
// per-run insight cap, the learning master switch, the generic-output filter,
// and the scheduler's no-JWT fallback. Runs against a real copy of the app
// schema — same harness as localDb.test.ts.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalDb, type LocalDb } from "./localDb.ts";
import { createProactiveHandlers, filterInsights } from "./proactive.ts";

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/db_schema.sql"),
  "utf8",
);

function freshDb(): LocalDb {
  const dbPath = join(mkdtempSync(join(tmpdir(), "atlas-proactive-")), "atlas.db");
  const seed = new Database(dbPath, { create: true });
  seed.exec(SCHEMA);
  seed.close();
  return createLocalDb(dbPath);
}

const USER = "u-test";
const req = () => new Request("http://127.0.0.1/proactive/cycle", { method: "POST", body: "{}" });
const authed = () => ({ userId: USER, email: "t@t", token: "jwt" });
const jsonHelper = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function seedSignal(db: LocalDb, userId = USER) {
  db._db
    .query(`INSERT INTO ai_memory (id, user_id, memory_type, category, key, value, importance) VALUES (?, ?, 'fact', 'health', 'dentist', '"asked to be reminded about the dentist"', 7)`)
    .run(crypto.randomUUID(), userId);
  db._db
    .query(`INSERT INTO user_events (id, user_id, title, start_time) VALUES (?, ?, 'Dentist appointment', ?)`)
    .run(crypto.randomUUID(), userId, new Date(Date.now() + 24 * 3600 * 1000).toISOString());
}

function enableLearning(db: LocalDb) {
  db._db.query(`INSERT OR IGNORE INTO atlas_system_settings (id, learning_enabled) VALUES ('settings', 1)`).run();
  db._db.query(`UPDATE atlas_system_settings SET learning_enabled = 1`).run();
}

const GOOD = JSON.stringify([
  { title: "Dentist tomorrow", content: "Your dentist appointment is tomorrow at 10:00 — you asked me to remind you." },
]);

test("cooldown: second run within the interval is refused, backdated stamp re-enables", async () => {
  const db = freshDb();
  enableLearning(db);
  seedSignal(db);
  let calls = 0;
  const p = createProactiveHandlers({
    db,
    requireUser: authed,
    json: jsonHelper,
    hasKey: () => true,
    complete: async () => (calls++, GOOD),
  });

  const first = await (await p.cycle(req())).json();
  expect(first).toEqual({ ok: true, insightsCreated: 1 });

  const second = await (await p.cycle(req())).json();
  expect(second).toEqual({ ok: true, insightsCreated: 0, skipped: "cooldown" });
  expect(calls).toBe(1); // the cooldown gates the AI call itself, not just inserts

  // 13h later (default interval 12h) the cycle runs again.
  db._db
    .query(`UPDATE proactive_state SET last_run_at = ? WHERE user_id = ?`)
    .run(new Date(Date.now() - 13 * 3600 * 1000).toISOString(), USER);
  const third = await (await p.cycle(req())).json();
  expect(third.insightsCreated).toBe(1);
  expect(calls).toBe(2);
});

test("cap: model returning more than 3 insights inserts exactly 3", async () => {
  const db = freshDb();
  enableLearning(db);
  seedSignal(db);
  const five = JSON.stringify(
    Array.from({ length: 5 }, (_, i) => ({
      title: `Follow up on task ${i}`,
      content: `Task ${i} from your list is due this week and still open — worth finishing.`,
    })),
  );
  const p = createProactiveHandlers({
    db,
    requireUser: authed,
    json: jsonHelper,
    hasKey: () => true,
    complete: async () => five,
  });

  const res = await (await p.cycle(req())).json();
  expect(res.insightsCreated).toBe(3);
  const rows = db._db.query(`SELECT COUNT(*) AS c FROM ai_insights WHERE user_id = ?`).get(USER) as { c: number };
  expect(rows.c).toBe(3);
});

test("disabled learning short-circuits before any AI call", async () => {
  const db = freshDb();
  seedSignal(db);
  // The Phase-4 settings seed gives every install a learning_enabled=1 row, so
  // "no row at all" no longer occurs — disable explicitly to hit the guard.
  db._db.query(`UPDATE atlas_system_settings SET learning_enabled = 0`).run();
  let calls = 0;
  const p = createProactiveHandlers({
    db,
    requireUser: authed,
    json: jsonHelper,
    hasKey: () => true,
    complete: async () => (calls++, GOOD),
  });

  expect(await (await p.cycle(req())).json()).toEqual({ ok: true, insightsCreated: 0, skipped: "disabled" });
  expect(calls).toBe(0);
});

test("missing AI key skips without stamping the cooldown", async () => {
  const db = freshDb();
  enableLearning(db);
  seedSignal(db);
  const p = createProactiveHandlers({
    db,
    requireUser: authed,
    json: jsonHelper,
    hasKey: () => false,
    complete: async () => GOOD,
  });
  expect(await (await p.cycle(req())).json()).toEqual({ ok: true, insightsCreated: 0, skipped: "no-key" });
  const state = db._db.query(`SELECT COUNT(*) AS c FROM proactive_state`).get() as { c: number };
  expect(state.c).toBe(0); // a keyless skip must not consume the interval
});

test("generic and empty model output is filtered to zero inserts", async () => {
  const db = freshDb();
  enableLearning(db);
  seedSignal(db);
  const filler = JSON.stringify([
    { title: "Good morning!", content: "Hope you're having a great day so far!" },
    { title: "Checking in", content: "Just checking in on you — nothing new to report." },
    { title: "Empty", content: "" },
    { title: "", content: "A content string without a title should also be dropped here." },
    { content: "missing title entirely" },
  ]);
  const p = createProactiveHandlers({
    db,
    requireUser: authed,
    json: jsonHelper,
    hasKey: () => true,
    complete: async () => filler,
  });

  const res = await (await p.cycle(req())).json();
  expect(res).toEqual({ ok: true, insightsCreated: 0 });
  const rows = db._db.query(`SELECT COUNT(*) AS c FROM ai_insights WHERE user_id = ?`).get(USER) as { c: number };
  expect(rows.c).toBe(0);
});

test("non-JSON model output creates nothing", () => {
  expect(filterInsights(null)).toEqual([]);
  expect(filterInsights("prose, not an array")).toEqual([]);
  expect(filterInsights({ title: "obj", content: "not wrapped in an array" })).toEqual([]);
});

test("scheduler fallback: 401 (no JWT) resolves the most recent local user; bad sidecar token (403) does not", async () => {
  process.env.SIDECAR_TOKEN = "test-token"; // fallback only engages when configured
  const db = freshDb();
  enableLearning(db);
  db._db
    .query(`INSERT INTO chat_turns (id, user_id, turn_id, seq, role, content) VALUES (?, 'u-recent', ?, 0, 'user', 'remind me about the dentist')`)
    .run(crypto.randomUUID(), crypto.randomUUID());
  seedSignal(db, "u-recent");

  const unauth401 = () => {
    throw Object.assign(new Error("missing bearer token"), { status: 401 });
  };
  const p = createProactiveHandlers({
    db,
    requireUser: unauth401,
    json: jsonHelper,
    hasKey: () => true,
    complete: async () => GOOD,
  });
  const res = await (await p.cycle(req())).json();
  expect(res.insightsCreated).toBe(1);
  const row = db._db.query(`SELECT user_id FROM ai_insights LIMIT 1`).get() as { user_id: string };
  expect(row.user_id).toBe("u-recent");

  const forbidden403 = () => {
    throw Object.assign(new Error("bad sidecar token"), { status: 403 });
  };
  const p403 = createProactiveHandlers({
    db,
    requireUser: forbidden403,
    json: jsonHelper,
    hasKey: () => true,
    complete: async () => GOOD,
  });
  await expect(p403.cycle(req())).rejects.toThrow("bad sidecar token");
});

test("no local user ever signed in → no-op, no AI call", async () => {
  process.env.SIDECAR_TOKEN = "test-token";
  const db = freshDb();
  enableLearning(db);
  let calls = 0;
  const p = createProactiveHandlers({
    db,
    requireUser: () => {
      throw Object.assign(new Error("missing bearer token"), { status: 401 });
    },
    json: jsonHelper,
    hasKey: () => true,
    complete: async () => (calls++, GOOD),
  });
  expect(await (await p.cycle(req())).json()).toEqual({ ok: true, insightsCreated: 0, skipped: "no-user" });
  expect(calls).toBe(0);
});

// ---------------------------------------------------------------------------
// Regression: the scheduler fallback must not become an unauthenticated route.
// Without these conditions the brain (CORS `*` on loopback) would let any web
// page trigger an AI completion as the local user in dev, and an expired or
// garbage bearer would silently execute as a different account.

test("fallback is OFF when no sidecar token is configured (dev)", async () => {
  delete process.env.SIDECAR_TOKEN;
  const db = freshDb();
  enableLearning(db);
  seedSignal(db, "u-recent");
  const p = createProactiveHandlers({
    db,
    requireUser: () => { throw Object.assign(new Error("missing bearer token"), { status: 401 }); },
    json: jsonHelper,
    hasKey: () => true,
    complete: async () => GOOD,
  });
  await expect(p.cycle(req())).rejects.toThrow("missing bearer token");
});

test("fallback is OFF when a bearer was supplied but rejected (expired/garbage)", async () => {
  process.env.SIDECAR_TOKEN = "test-token";
  const db = freshDb();
  enableLearning(db);
  seedSignal(db, "u-recent");
  const p = createProactiveHandlers({
    db,
    requireUser: () => { throw Object.assign(new Error("token expired"), { status: 401 }); },
    json: jsonHelper,
    hasKey: () => true,
    complete: async () => GOOD,
  });
  const withAuth = new Request("http://127.0.0.1/proactive/cycle", {
    method: "POST",
    headers: { authorization: "Bearer expired.token.here" },
    body: "{}",
  });
  await expect(p.cycle(withAuth)).rejects.toThrow("token expired");
});
