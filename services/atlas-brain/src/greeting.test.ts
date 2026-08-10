// Grounding tests for the launch greeting (greeting.ts).
//
// The thing under test is not "does it produce a nice sentence" — it is "can it
// ever say something that is not true". Every test below is a refusal path:
// no signal, dead gateway, invented citation, invented number. Runs against a
// real copy of the app schema — same harness as proactive.test.ts.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalDb, type LocalDb } from "./localDb.ts";
import { createGreetingHandlers, gatherSalience, numbersAreGrounded } from "./greeting.ts";
import { filterInsights } from "./proactive.ts";

const SRC = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(SRC, "../../../src-tauri/src/db_schema.sql"), "utf8");

function freshDb(): LocalDb {
  const dbPath = join(mkdtempSync(join(tmpdir(), "atlas-greeting-")), "atlas.db");
  const seed = new Database(dbPath, { create: true });
  seed.exec(SCHEMA);
  seed.close();
  return createLocalDb(dbPath);
}

const USER = "u-greet";
const req = () => new Request("http://127.0.0.1/greeting", { method: "POST", body: "{}" });
const authed = () => ({ userId: USER, email: "t@t", token: "jwt" });
const jsonHelper = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function seedProfile(db: LocalDb, timezone = "UTC") {
  db._db
    .query(`INSERT INTO profiles (id, user_id, first_name, timezone) VALUES (?, ?, 'Magnus', ?)`)
    .run(crypto.randomUUID(), USER, timezone);
}

/** One real event two hours out — the only fact the model may draw on. */
function seedEvent(db: LocalDb, title = "Dentist", hoursOut = 2) {
  db._db
    .query(`INSERT INTO user_events (id, user_id, title, start_time) VALUES (?, ?, ?, ?)`)
    .run(crypto.randomUUID(), USER, title, new Date(Date.now() + hoursOut * 3600 * 1000).toISOString());
}

test("happy path: a grounded greeting comes back with the salience it used", async () => {
  const db = freshDb();
  seedProfile(db);
  seedEvent(db);

  let seenUserPrompt = "";
  const g = createGreetingHandlers({
    db,
    requireUser: authed,
    json: jsonHelper,
    hasKey: () => true,
    complete: async (_system, user) => {
      seenUserPrompt = user;
      return {
        text: JSON.stringify({ greeting: "Morning, Magnus — the dentist is the one thing on today.", used: [0] }),
        model: "claude-haiku-4-5",
      };
    },
  });

  const body = await (await g.greeting(req())).json();
  expect(body.greeting).toBe("Morning, Magnus — the dentist is the one thing on today.");
  expect(body.salience).toHaveLength(1);
  expect(body.salience[0].kind).toBe("event");
  expect(body.salience[0].text).toContain("Dentist");
  expect(body.model).toBe("claude-haiku-4-5");
  expect(body.promptVersion).toBe("greeting-v1");
  // The model is shown the fact, not the database.
  expect(seenUserPrompt).toContain("Dentist");
});

test("a user with zero signals gets an honest empty answer and NO model call", async () => {
  const db = freshDb();
  seedProfile(db); // a profile, and nothing else going on

  let calls = 0;
  const g = createGreetingHandlers({
    db,
    requireUser: authed,
    json: jsonHelper,
    hasKey: () => true,
    complete: async () => {
      calls++;
      return { text: JSON.stringify({ greeting: "You've got a call with Sarah at 10.", used: [] }), model: "m" };
    },
  });

  const res = await g.greeting(req());
  const body = await res.json();
  // 200, not an error: the frontend keeps its deterministic greeting.
  expect(res.status).toBe(200);
  expect(body.greeting).toBeNull();
  expect(body.salience).toEqual([]);
  expect(body.skipped).toBe("no-salience");
  // The point of the whole design: with nothing to say, nothing can be invented,
  // because no model was ever asked.
  expect(calls).toBe(0);
});

test("upstream model failure degrades to no greeting, never to an error", async () => {
  const db = freshDb();
  seedProfile(db);
  seedEvent(db);

  const g = createGreetingHandlers({
    db,
    requireUser: authed,
    json: jsonHelper,
    hasKey: () => true,
    complete: async () => null, // dead gateway / non-2xx / thrown
  });

  const res = await g.greeting(req());
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.greeting).toBeNull();
  expect(body.skipped).toBe("model-failed");
});

test("a fabricated number is refused even when the sentence looks plausible", async () => {
  const db = freshDb();
  seedProfile(db);
  seedEvent(db, "Standup", 3);

  const g = createGreetingHandlers({
    db,
    requireUser: authed,
    json: jsonHelper,
    hasKey: () => true,
    // The event is real; "and 3 unread messages" is not, and no fact contains it.
    complete: async () => ({
      text: JSON.stringify({ greeting: "Standup soon, and 3 unread messages waiting.", used: [0] }),
      model: "m",
    }),
  });

  const body = await (await g.greeting(req())).json();
  expect(body.greeting).toBeNull();
  expect(body.skipped).toBe("ungrounded-number");
});

test("a greeting citing no real fact is discarded", async () => {
  const db = freshDb();
  seedProfile(db);
  seedEvent(db);

  const g = createGreetingHandlers({
    db,
    requireUser: authed,
    json: jsonHelper,
    hasKey: () => true,
    // Index 7 does not exist; nothing real survives the filter.
    complete: async () => ({ text: JSON.stringify({ greeting: "Big day ahead!", used: [7] }), model: "m" }),
  });

  const body = await (await g.greeting(req())).json();
  expect(body.greeting).toBeNull();
  expect(body.skipped).toBe("ungrounded");
});

test("no AI key: honest skip, not a 500", async () => {
  const db = freshDb();
  seedProfile(db);
  seedEvent(db);
  const g = createGreetingHandlers({ db, requireUser: authed, json: jsonHelper, hasKey: () => false });
  const res = await g.greeting(req());
  expect(res.status).toBe(200);
  expect((await res.json()).skipped).toBe("no-key");
});

test("numbersAreGrounded: allows quoted figures, refuses invented ones", () => {
  const facts = '0. [event] "Dentist" at 10:00';
  expect(numbersAreGrounded("The dentist is at 10:00.", facts)).toBe(true);
  expect(numbersAreGrounded("Your morning looks light.", facts)).toBe(true);
  expect(numbersAreGrounded("The dentist is at 11:00.", facts)).toBe(false);
  expect(numbersAreGrounded("You have 4 things today.", facts)).toBe(false);
});

test("gatherSalience reads only rows, and caps what reaches the model", () => {
  const db = freshDb();
  seedProfile(db);
  for (let i = 0; i < 6; i++) seedEvent(db, `Event ${i}`, i + 1);
  const s = gatherSalience(db, USER, new Date());
  expect(s.userName).toBe("Magnus");
  // Two events is the query's own limit; the MAX_FACTS cap sits above it.
  expect(s.facts.length).toBeGreaterThan(0);
  expect(s.facts.length).toBeLessThanOrEqual(4);
  expect(s.facts.every((f) => f.kind === "event")).toBe(true);
});

// ---------------------------------------------------------------------------
// The verified trap.

test("greeting output would be destroyed by the insight filter — and never meets it", () => {
  // filterInsights (proactive.ts) exists to refuse pleasantries in the DIGEST,
  // where a greeting IS filler. Run a real greeting through it to show what
  // would happen if this route were ever wired through the digest's quality
  // gate: the good output is dropped on the floor.
  const asInsight = [{ title: "Good morning", content: "Morning, Magnus — hope you're set for the dentist at 10:00." }];
  expect(filterInsights(asInsight)).toEqual([]);

  // So the greeting path must not import it. Read the module as text rather
  // than trusting the import graph: a future refactor that reaches into
  // proactive.ts for "the quality gate we already have" fails here.
  // (Matching the import and the call site, not the word: the module header
  // names filterInsights in prose precisely to explain why it stays away.)
  const source = readFileSync(join(SRC, "greeting.ts"), "utf8");
  expect(source).not.toContain('from "./proactive.ts"');
  expect(source).not.toContain("filterInsights(");
});

// ---------------------------------------------------------------------------
// Reachability. Same reason as adminRoutes.test.ts: a handler that is written,
// documented and never routed is indistinguishable from one nobody wrote, and
// its button 404s.

test("every exported greeting handler is dispatched from index.ts", () => {
  const indexSource = readFileSync(join(SRC, "index.ts"), "utf8");
  expect(indexSource).toContain("createGreetingHandlers");
  expect(indexSource).toContain('url.pathname === "/greeting"');
  expect(indexSource).toContain("greeting.greeting(req)");
  // POST only — the route runs a model call and must not be reachable by GET.
  const line = indexSource.split("\n").find((l) => l.includes('url.pathname === "/greeting"'));
  expect(line).toContain('req.method === "POST"');
});
