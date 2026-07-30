/* eslint-disable @typescript-eslint/no-explicit-any -- test code deliberately builds
   partial fixtures and reaches into internals to assert on them. Precise types
   here would mean mirroring production shapes in the tests, which adds churn
   without adding safety: the assertions, not the annotations, are the contract. */
// Phase 3 memory integrity + SFT capture: dedup upserts, the idempotent
// (user_id, key) migration, forget/erase scoping, and chat-turn round-trips.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assistantTextFromSse,
  captureChatTurn,
  createLocalDb,
  ensureMemoryIntegrity,
  eraseUserData,
  forgetMemories,
} from "./localDb.ts";

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/db_schema.sql"),
  "utf8",
);

function freshDb(): ReturnType<typeof createLocalDb> {
  const path = join(mkdtempSync(join(tmpdir(), "atlas-integrity-")), "atlas.db");
  const seed = new Database(path, { create: true });
  seed.exec(SCHEMA);
  seed.close();
  return createLocalDb(path);
}

test("upsert with onConflict updates in place and bumps mention_count", async () => {
  const db = freshDb();
  const base = { user_id: "u", key: "car", category: "preferences", memory_type: "fact" };

  await db.from("ai_memory").upsert(
    { ...base, value: "Volvo", importance: 5, updated_at: new Date().toISOString() },
    { onConflict: "user_id,key" },
  );
  const { data: updated, error } = await db
    .from("ai_memory")
    .upsert({ ...base, value: "Tesla", importance: 8, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" })
    .select()
    .single();
  expect(error).toBeNull();

  const { data: rows } = await db.from("ai_memory").select().eq("user_id", "u").eq("key", "car");
  expect(rows.length).toBe(1); // no duplicate row
  expect(rows[0].value).toBe("Tesla");
  expect(rows[0].importance).toBe(8);
  expect(rows[0].mention_count).toBe(2); // re-stating = a mention
  expect(updated.id).toBe(rows[0].id);

  // Another user's identical key is a separate fact.
  await db.from("ai_memory").upsert({ ...base, user_id: "v", value: "Bike" }, { onConflict: "user_id,key" });
  const { data: all } = await db.from("ai_memory").select().eq("key", "car");
  expect(all.length).toBe(2);
});

test("migration dedupes a dirty pre-index DB and is idempotent", () => {
  // Legacy DB: ai_memory without the unique index, with duplicate facts.
  const path = join(mkdtempSync(join(tmpdir(), "atlas-dirty-")), "atlas.db");
  const db = new Database(path, { create: true });
  db.exec(`
    CREATE TABLE ai_memory (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, memory_type TEXT NOT NULL,
      category TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      importance INTEGER DEFAULT 5, last_mentioned TEXT, mention_count INTEGER DEFAULT 1,
      is_validated INTEGER DEFAULT 0, is_fake INTEGER DEFAULT 0, validation_score REAL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    INSERT INTO ai_memory (id,user_id,memory_type,category,key,value,mention_count,updated_at) VALUES
      ('a','u','fact','personal','car','old',   2, '2026-01-01T00:00:00.000Z'),
      ('b','u','fact','personal','car','new',   3, '2026-02-01T00:00:00.000Z'),
      ('c','v','fact','personal','car','other', 1, '2026-01-15T00:00:00.000Z');`);

  ensureMemoryIntegrity(db);
  ensureMemoryIntegrity(db); // idempotent re-run

  const rows = db.query(`SELECT id, value, mention_count FROM ai_memory WHERE user_id='u'`).all() as any[];
  expect(rows.length).toBe(1);
  expect(rows[0].id).toBe("b"); // newest survives
  expect(rows[0].value).toBe("new");
  expect(rows[0].mention_count).toBe(5); // 2 + 3 summed into the survivor
  expect((db.query(`SELECT COUNT(*) AS n FROM ai_memory`).get() as any).n).toBe(2); // other user intact

  // The unique index now rejects raw duplicate inserts.
  expect(() =>
    db.query(`INSERT INTO ai_memory (id,user_id,memory_type,category,key,value) VALUES ('d','u','fact','personal','car','dupe')`).run(),
  ).toThrow();
  // And chat_turns was created for capture.
  expect(db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_turns'`).get()).toBeTruthy();
  db.close();
});

test("forget deletes only the caller's rows (and their vectors)", async () => {
  const db = freshDb();
  const emb = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
  for (const user of ["u1", "u2"]) {
    const { data: mem } = await db
      .from("ai_memory")
      .insert({ user_id: user, memory_type: "fact", category: "personal", key: "secret", value: "x" })
      .select()
      .single();
    db.upsertVector({ id: `vec-${user}`, userId: user, chunkText: "secret: x", embedding: emb, memoryItemId: mem.id });
  }

  const counts = forgetMemories(db._db, "u1", { key: "secret" });
  expect(counts).toEqual({ memories: 1, vectors: 1 });

  const { data: u1 } = await db.from("ai_memory").select().eq("user_id", "u1");
  const { data: u2 } = await db.from("ai_memory").select().eq("user_id", "u2");
  expect(u1.length).toBe(0);
  expect(u2.length).toBe(1);
  expect((db._db.query(`SELECT COUNT(*) AS n FROM memory_vectors WHERE user_id='u1'`).get() as any).n).toBe(0);
  expect((db._db.query(`SELECT COUNT(*) AS n FROM memory_vectors WHERE user_id='u2'`).get() as any).n).toBe(1);

  // Unknown selector is a no-op, missing selector is an error.
  expect(forgetMemories(db._db, "u1", { id: "nope" })).toEqual({ memories: 0, vectors: 0 });
  expect(() => forgetMemories(db._db, "u1", {})).toThrow();
});

test("erase-all wipes every user-scoped table for the caller only", async () => {
  const db = freshDb();
  for (const user of ["u1", "u2"]) {
    await db.from("ai_memory").insert({ user_id: user, memory_type: "fact", category: "personal", key: "k", value: "v" });
    await db.from("atlas_knowledge_entries").insert({ user_id: user, topic: "t", content: {} });
    await db.from("conversations").insert({ id: `conv-${user}`, user_id: user, title: "hello" });
    await db.from("messages").insert({ conversation_id: `conv-${user}`, role: "user", content: "hi" });
    captureChatTurn(db._db, {
      userId: user, conversationId: `conv-${user}`, source: "text_chat", model: "m",
      systemPrompt: "sp", userMessage: "hi", toolMessages: [], assistantText: "hello",
    });
  }

  const deleted = eraseUserData(db._db, "u1");
  expect(deleted.ai_memory).toBe(1);
  expect(deleted.atlas_knowledge_entries).toBe(1);
  expect(deleted.conversations).toBe(1);
  expect(deleted.messages).toBe(1);
  expect(deleted.chat_turns).toBeGreaterThanOrEqual(2);

  expect((db._db.query(`SELECT COUNT(*) AS n FROM chat_turns WHERE user_id='u1'`).get() as any).n).toBe(0);
  expect((db._db.query(`SELECT COUNT(*) AS n FROM chat_turns WHERE user_id='u2'`).get() as any).n).toBeGreaterThan(0);
  expect((db._db.query(`SELECT COUNT(*) AS n FROM ai_memory WHERE user_id='u2'`).get() as any).n).toBe(1);
});

test("captured turn round-trips with its system-prompt snapshot", async () => {
  const db = freshDb();
  const turnId = captureChatTurn(db._db, {
    userId: "u",
    conversationId: "conv1",
    source: "text_chat",
    model: "google/gemini-2.5-flash",
    systemPrompt: "You are Atlas. ## What You Remember\n- car: Tesla",
    userMessage: "what car do I drive?",
    toolMessages: [
      { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "memory_store", arguments: "{}" } }] },
      { role: "tool", content: '{"success":true}' },
    ],
    assistantText: "You drive a Tesla.",
  });

  const rows = db._db
    .query(`SELECT role, content, tool_calls, model, system_prompt, followed_up_at FROM chat_turns WHERE turn_id = ? ORDER BY seq`)
    .all(turnId) as any[];
  expect(rows.map((r) => r.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  const final = rows[3];
  expect(final.content).toBe("You drive a Tesla.");
  expect(final.model).toBe("google/gemini-2.5-flash");
  expect(final.system_prompt).toContain("- car: Tesla"); // the SFT-critical snapshot
  expect(JSON.parse(rows[1].tool_calls)[0].function.name).toBe("memory_store");
  expect(final.followed_up_at).toBeNull();

  // Success signal: the user returning to the conversation stamps the previous
  // assistant turn (engagement, not approval).
  captureChatTurn(db._db, {
    userId: "u", conversationId: "conv1", source: "text_chat", model: "m",
    systemPrompt: "sp", userMessage: "and what color?", toolMessages: [], assistantText: "Red.",
  });
  const stamped = db._db
    .query(`SELECT followed_up_at FROM chat_turns WHERE turn_id = ? AND seq = 3`)
    .get(turnId) as any;
  expect(stamped.followed_up_at).not.toBeNull();
});

test("assistantTextFromSse accumulates deltas and skips foreign events", async () => {
  const chunks = [
    `data: {"citations":["https://example.com"]}\n\n`,
    `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"lo "}}]}\ndata: {"choices":[{"delta":{"content":"there"}}]}\n\n`,
    `data: [DONE]\n\n`,
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  expect(await assistantTextFromSse(stream)).toBe("Hello there");
});
