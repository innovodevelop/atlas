import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { recall, upsertVector } from "./localMemory.ts";

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/db_schema.sql"),
  "utf8",
);

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

// Unit basis vector in 768-space (already normalized) for deterministic cosine.
function basis(i: number): Float32Array {
  const v = new Float32Array(768);
  v[i] = 1;
  return v;
}

test("hybrid recall ranks by similarity and filters", () => {
  const db = freshDb();
  upsertVector(db, { id: "a", userId: "u", chunkText: "apple pie recipe", embedding: basis(0) });
  upsertVector(db, { id: "b", userId: "u", chunkText: "quantum physics lecture", embedding: basis(1) });
  upsertVector(db, { id: "c", userId: "u", chunkText: "apple orchard tour", embedding: basis(2) });

  const hits = recall(db, { userId: "u", queryEmbedding: basis(0), queryText: "apple", matchCount: 5 });

  // a is the nearest vector (sim ~1) and matches the term -> ranked first.
  expect(hits[0].id).toBe("a");
  expect(hits[0].similarity).toBeGreaterThan(0.9);
  // b (orthogonal, no "apple") is dropped by the sim>0.25 OR kw>0.05 gate.
  expect(hits.some((h) => h.id === "b")).toBe(false);
  // c survives on the keyword arm ("apple" in text) despite sim 0.
  expect(hits.some((h) => h.id === "c")).toBe(true);
});

test("recall is user-scoped", () => {
  const db = freshDb();
  upsertVector(db, { id: "a", userId: "u", chunkText: "apple", embedding: basis(0) });
  expect(recall(db, { userId: "other", queryEmbedding: basis(0), queryText: "apple" }).length).toBe(0);
});

test("is_fake knowledge is excluded even on a strong vector hit", () => {
  const db = freshDb();
  db.query(
    `INSERT INTO atlas_knowledge_entries (id, user_id, topic, content, is_fake) VALUES (?,?,?,?,1)`,
  ).run("k1", "u", "t", "{}");
  upsertVector(db, { id: "d", userId: "u", chunkText: "apple cider", embedding: basis(0), knowledgeEntryId: "k1" });
  const hits = recall(db, { userId: "u", queryEmbedding: basis(0), queryText: "apple", matchCount: 5 });
  expect(hits.some((h) => h.id === "d")).toBe(false);
});
