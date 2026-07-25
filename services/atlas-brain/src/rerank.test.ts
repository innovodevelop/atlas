import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rerankPairs } from "./rerank.ts";
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

test("relevant doc outranks irrelevant doc", async () => {
  const scores = await rerankPairs("danish pastry recipe", [
    "quantum chromodynamics lecture notes from tuesday",
    "a simple danish pastry recipe with butter",
  ]);
  expect(scores).toHaveLength(2);
  expect(scores[1]).toBeGreaterThan(scores[0]);
  expect(scores[1]).toBe(1); // best candidate is max-normalized to 1
});

test("exact phrase outranks the same terms scattered (Danish, æ/ø/å intact)", async () => {
  // Both docs contain all query terms once and have equal token counts, so
  // plain BM25 ties them — only the phrase bonus separates the two.
  const scores = await rerankPairs("koffein om aftenen", [
    "om morgenen koffein men aftenen giver ro",
    "undgå koffein om aftenen for bedre søvn",
  ]);
  expect(scores[1]).toBeGreaterThan(scores[0]);
  expect(scores[0]).toBeGreaterThan(0); // Danish letters survive tokenization
});

test("empty inputs are handled deterministically", async () => {
  expect(await rerankPairs("anything", [])).toEqual([]);
  expect(await rerankPairs("", ["some doc", "other doc"])).toEqual([0, 0]);
});

test("recall blends rerank into ordering (lexical hit beats bare vector hit)", async () => {
  const db = freshDb();
  // P: perfect vector similarity but zero lexical overlap with the query.
  upsertVector(db, { id: "p", userId: "u", chunkText: "unrelated words entirely", embedding: basis(0) });
  // Q: zero similarity but an exact lexical match — survives on the kw gate.
  upsertVector(db, { id: "q", userId: "u", chunkText: "quarterly budget report for the finance team", embedding: basis(1) });

  const hits = await recall(db, {
    userId: "u",
    queryEmbedding: basis(0),
    queryText: "quarterly budget report",
    matchCount: 5,
  });
  // Base scoring alone puts P first (0.65*sim beats 0.35*kw); the 0.7-weighted
  // rerank flips the order toward the lexically relevant chunk.
  expect(hits.map((h) => h.id)).toEqual(["q", "p"]);
});

test("recall fails open when the reranker throws", async () => {
  const db = freshDb();
  upsertVector(db, { id: "a", userId: "u", chunkText: "apple pie recipe", embedding: basis(0) });
  upsertVector(db, { id: "c", userId: "u", chunkText: "apple orchard tour", embedding: basis(2) });

  const hits = await recall(db, {
    userId: "u",
    queryEmbedding: basis(0),
    queryText: "apple",
    matchCount: 5,
    rerankFn: async () => {
      throw new Error("forced rerank failure");
    },
  });
  // No throw, and the base ordering (a: sim ~1 first) is preserved.
  expect(hits.map((h) => h.id)).toEqual(["a", "c"]);
});
