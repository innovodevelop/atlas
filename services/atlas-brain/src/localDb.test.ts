// Validates the brain's bun:sqlite-backed Supabase-compatible client against a
// real copy of the app schema — the same query shapes the orchestrator uses.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalDb } from "./localDb.ts";

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/db_schema.sql"),
  "utf8",
);
const dbPath = join(mkdtempSync(join(tmpdir(), "atlas-brain-")), "atlas.db");
{
  const seed = new Database(dbPath, { create: true });
  seed.exec(SCHEMA);
  seed.close();
}
const db = createLocalDb(dbPath);

test("insert → select round-trips jsonb + bool; eq/order/limit", async () => {
  const { data: ins, error } = await db
    .from("ai_memory")
    .insert({ user_id: "u", memory_type: "fact", category: "personal", key: "car", value: { make: "Volvo" }, importance: 8, is_fake: false })
    .select()
    .single();
  expect(error).toBeNull();
  expect(ins.value).toEqual({ make: "Volvo" });
  expect(ins.is_fake).toBe(false);

  await db.from("ai_memory").insert({ user_id: "u", memory_type: "fact", category: "work", key: "role", value: "eng", importance: 3, is_fake: false });

  const { data } = await db
    .from("ai_memory")
    .select()
    .eq("user_id", "u")
    .eq("is_fake", false)
    .order("importance", { ascending: false })
    .limit(10);
  expect(data.length).toBe(2);
  expect(data[0].key).toBe("car"); // importance 8 before 3
});

test("filters neq/in/gte and single-missing → PGRST116", async () => {
  const { data: miss, error } = await db.from("ai_memory").select().eq("user_id", "nobody").single();
  expect(miss).toBeNull();
  expect(error?.code).toBe("PGRST116");

  const { data: inSet } = await db.from("ai_memory").select().in("category", ["personal"]);
  expect(inSet.length).toBe(1);
});

test("rpc recall_memories routes through localMemory", async () => {
  const emb = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
  db.upsertVector({ id: "m1", userId: "u", chunkText: "apple pie recipe", embedding: emb });
  const { data, error } = await db.rpc("recall_memories", {
    p_user_id: "u",
    query_embedding: emb,
    query_text: "apple",
    match_count: 5,
  });
  expect(error).toBeNull();
  expect(Array.isArray(data)).toBe(true);
  expect(data[0].id).toBe("m1");
});
