// Phase 4 — personality as bounded state: humour gating, drift bounds, trait
// round-trip through atlas_personality, and the atlas_system_settings seed.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TRAITS,
  DRIFT_STEP,
  applyDrift,
  composePersonality,
  detectSeriousTopic,
  observeUserStyle,
  type Traits,
} from "../../../supabase/functions/_shared/personality.ts";
import {
  createLocalDb,
  getPersonality,
  refreshLexicon,
  resetPersonality,
  savePersonality,
} from "./localDb.ts";

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/db_schema.sql"),
  "utf8",
);

function freshDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "atlas-personality-")), "atlas.db");
}

function seedSchema(path: string): void {
  const seed = new Database(path, { create: true });
  seed.exec(SCHEMA);
  seed.close();
}

const PLAYFUL = { traits: { ...DEFAULT_TRAITS, playfulness: 0.9 }, lexicon: {} };

// ---------------------------------------------------------------------------
// composePersonality — humour gating

test("humour permitted by default (no gates)", () => {
  const block = composePersonality(PLAYFUL, {});
  expect(block).toContain("## Your Personality");
  expect(block).toContain("## Communication Style");
  expect(block).toContain("playful teasing");
  expect(block).not.toContain("NOT the moment for humor");
});

for (const emotion of ["stressed", "sad"]) {
  test(`humour suppressed when emotion is ${emotion}`, () => {
    const block = composePersonality(PLAYFUL, { emotion });
    expect(block).toContain("NOT the moment for humor");
    expect(block).not.toContain("good sense of humor");
    expect(block).toContain("steady and plain");
  });
}

test("humour NOT suppressed for non-gating emotions", () => {
  expect(composePersonality(PLAYFUL, { emotion: "happy" })).toContain("playful teasing");
  expect(composePersonality(PLAYFUL, { emotion: "curious" })).toContain("playful teasing");
});

test("humour suppressed when user is terse", () => {
  const block = composePersonality(PLAYFUL, { terse: true });
  expect(block).toContain("NOT the moment for humor");
  expect(block).not.toContain("good sense of humor");
});

test("humour suppressed on serious topics", () => {
  const block = composePersonality(PLAYFUL, { seriousTopic: true });
  expect(block).toContain("NOT the moment for humor");
  expect(block).not.toContain("good sense of humor");
});

test("composed block is deterministic (prompt-cache prefix)", () => {
  const ctx = { emotion: "happy" as const };
  expect(composePersonality(PLAYFUL, ctx)).toBe(composePersonality(PLAYFUL, ctx));
});

test("traits shape the block: low verbosity ⇒ explicit brevity", () => {
  const brief = composePersonality({ traits: { ...DEFAULT_TRAITS, verbosity: 0.1 }, lexicon: {} }, {});
  expect(brief).toContain("Keep replies brief");
  const formal = composePersonality({ traits: { ...DEFAULT_TRAITS, formality: 0.9 }, lexicon: {} }, {});
  expect(formal).toContain("measured and polished");
});

test("lexicon renders as a things-you-call-each-other note", () => {
  const block = composePersonality(
    { traits: { ...DEFAULT_TRAITS }, lexicon: { "what you call them": "Boss" } },
    {},
  );
  expect(block).toContain("Things you call each other");
  expect(block).toContain("Boss");
  // Empty lexicon ⇒ no note at all.
  expect(composePersonality(PLAYFUL, {})).not.toContain("Things you call each other");
});

// ---------------------------------------------------------------------------
// detectSeriousTopic / observeUserStyle

test("serious-topic detection is narrow", () => {
  expect(detectSeriousTopic("my grandmother passed away yesterday")).toBe(true);
  expect(detectSeriousTopic("I got laid off this morning")).toBe(true);
  expect(detectSeriousTopic("we're getting a divorce")).toBe(true);
  expect(detectSeriousTopic("this bug is really annoying")).toBe(false);
  expect(detectSeriousTopic("what's the weather like?")).toBe(false);
});

test("observeUserStyle: playful vs formal evidence", () => {
  const playful = observeUserStyle(["haha yeah that's great 😂", "lol ok"]);
  expect(playful.playfulRegister).toBe(true);
  expect(playful.formalRegister).toBe(false);

  const formal = observeUserStyle([
    "Could you prepare a summary of the quarterly figures before our meeting?",
    "Please include the year-over-year comparison as well.",
  ]);
  expect(formal.formalRegister).toBe(true);
  expect(formal.playfulRegister).toBeUndefined();

  // No messages ⇒ no evidence, nothing to drift on.
  expect(observeUserStyle([])).toEqual({});
});

// ---------------------------------------------------------------------------
// applyDrift — bounded, slow, clamped

test("drift moves each trait at most DRIFT_STEP per invocation", () => {
  const start: Traits = { ...DEFAULT_TRAITS };
  const next = applyDrift(start, {
    avgUserMessageChars: 1000,
    formalRegister: true,
    playfulRegister: true,
    followUpRate: 0,
  });
  for (const k of Object.keys(DEFAULT_TRAITS) as Array<keyof Traits>) {
    expect(Math.abs(next[k] - start[k])).toBeLessThanOrEqual(DRIFT_STEP + 1e-9);
  }
});

test("drift clamps to [0,1] at the edges", () => {
  const maxed: Traits = { warmth: 1, playfulness: 1, formality: 1, verbosity: 1, directness: 1 };
  const up = applyDrift(maxed, { avgUserMessageChars: 1000, formalRegister: true, playfulRegister: true });
  for (const v of Object.values(up)) expect(v).toBeLessThanOrEqual(1);

  const floored: Traits = { warmth: 0, playfulness: 0, formality: 0, verbosity: 0, directness: 0 };
  const down = applyDrift(floored, { avgUserMessageChars: 10, formalRegister: false, followUpRate: 0 });
  for (const v of Object.values(down)) expect(v).toBeGreaterThanOrEqual(0);
});

test("warmth never drifts; no observations ⇒ no movement", () => {
  const start: Traits = { ...DEFAULT_TRAITS, warmth: 0.5 };
  expect(applyDrift(start, {}).warmth).toBe(0.5);
  expect(applyDrift(start, { avgUserMessageChars: 1000, formalRegister: true, followUpRate: 0 }).warmth).toBe(0.5);
  expect(applyDrift(start, {})).toEqual(start);
});

test("low follow-up rate backs off verbosity and sharpens directness", () => {
  const next = applyDrift({ ...DEFAULT_TRAITS }, { followUpRate: 0.1 });
  expect(next.verbosity).toBeCloseTo(0.5 - DRIFT_STEP, 10);
  expect(next.directness).toBeCloseTo(0.5 + DRIFT_STEP, 10);
});

// ---------------------------------------------------------------------------
// atlas_personality round-trip + settings seed (real schema)

test("trait round-trip through localDb, clamped, and reset", () => {
  const path = freshDbPath();
  seedSchema(path);
  const db = createLocalDb(path);

  // Missing row ⇒ defaults.
  expect(getPersonality(db._db, "u1").traits).toEqual(DEFAULT_TRAITS);

  // Partial update merges + clamps out-of-range input.
  const saved = savePersonality(db._db, "u1", {
    traits: { playfulness: 1.7, formality: -2 },
    lexicon: { "what you call them": "Boss" },
  });
  expect(saved.traits.playfulness).toBe(1);
  expect(saved.traits.formality).toBe(0);
  expect(saved.traits.warmth).toBe(0.5);

  const loaded = getPersonality(db._db, "u1");
  expect(loaded).toEqual(saved);

  // Reset restores defaults.
  expect(resetPersonality(db._db, "u1").traits).toEqual(DEFAULT_TRAITS);
  expect(getPersonality(db._db, "u1").lexicon).toEqual({});
});

test("atlas_system_settings seed is idempotent and respects user changes", () => {
  const path = freshDbPath();
  seedSchema(path); // schema batch itself runs the seed once
  const db = createLocalDb(path); // ensureMemoryIntegrity re-runs the JS twin

  const count = () =>
    (db._db.query(`SELECT COUNT(*) AS c FROM atlas_system_settings`).get() as { c: number }).c;
  const enabled = () =>
    (db._db.query(`SELECT learning_enabled AS e FROM atlas_system_settings LIMIT 1`).get() as { e: number }).e;

  expect(count()).toBe(1);
  expect(enabled()).toBe(1);

  // Re-open: still exactly one row.
  createLocalDb(path);
  expect(count()).toBe(1);

  // A user turning learning off must survive the seed on the next open.
  db._db.exec(`UPDATE atlas_system_settings SET learning_enabled = 0`);
  createLocalDb(path);
  expect(count()).toBe(1);
  expect(enabled()).toBe(0);
});

test("refreshLexicon only picks up explicit statements (nickname, call-me memories)", () => {
  const path = freshDbPath();
  seedSchema(path);
  const db = createLocalDb(path);

  db._db.query(`INSERT INTO profiles (id, user_id, nickname) VALUES (?, ?, ?)`).run("p1", "u1", "Boss");
  db._db
    .query(`INSERT INTO ai_memory (id, user_id, key, value, category, memory_type) VALUES (?, ?, ?, ?, ?, 'fact')`)
    .run("m1", "u1", "call me nickname", JSON.stringify("Chief"), "identity");
  // A vibes-y memory in another category must NOT enter the lexicon.
  db._db
    .query(`INSERT INTO ai_memory (id, user_id, key, value, category, memory_type) VALUES (?, ?, ?, ?, ?, 'fact')`)
    .run("m2", "u1", "seems to like puns", JSON.stringify("maybe"), "preferences");

  refreshLexicon(db._db, "u1");
  const { lexicon } = getPersonality(db._db, "u1");
  expect(lexicon["what you call them"]).toBe("Boss");
  expect(lexicon["call me nickname"]).toBe("Chief");
  expect(Object.keys(lexicon)).not.toContain("seems to like puns");

  // User-edited entries win over rediscovered ones.
  savePersonality(db._db, "u1", { lexicon: { ...lexicon, "what you call them": "Captain" } });
  refreshLexicon(db._db, "u1");
  expect(getPersonality(db._db, "u1").lexicon["what you call them"]).toBe("Captain");
});

// ---------------------------------------------------------------------------
// Regression: a hand-set trait must survive drift. The settings panel promises
// "your setting always wins"; without pinning, drift walked an explicit choice
// back at 0.02/turn (~17 turns to cross a render bucket) with no trace.

test("drift cannot move a trait the user set by hand", () => {
  const path = freshDbPath();
  seedSchema(path);
  const db = createLocalDb(path);
  const uid = "pin-user";
  savePersonality(db._db, uid, { traits: { verbosity: 0.9 } }, "user");
  expect(getPersonality(db._db, uid).pinned).toContain("verbosity");

  for (let i = 0; i < 40; i++) {
    savePersonality(db._db, uid, { traits: { verbosity: 0.1, directness: 0.9 } }, "drift");
  }
  const after = getPersonality(db._db, uid);
  expect(after.traits.verbosity).toBe(0.9);   // pinned — untouched by drift
  expect(after.traits.directness).toBe(0.9);  // unpinned — drift applies
});

test("reset clears pins so Atlas can learn again", () => {
  const path = freshDbPath();
  seedSchema(path);
  const db = createLocalDb(path);
  const uid = "reset-user";
  savePersonality(db._db, uid, { traits: { warmth: 0.8 } }, "user");
  expect(getPersonality(db._db, uid).pinned).toContain("warmth");
  resetPersonality(db._db, uid);
  expect(getPersonality(db._db, uid).pinned ?? []).toHaveLength(0);
});
