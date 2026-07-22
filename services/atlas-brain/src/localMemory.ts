/**
 * Local semantic memory for the brain sidecar (Supabase migration, Phase 3).
 *
 * Reads/writes the same on-device atlas.db the Tauri app uses, and runs the
 * recall_memories() hybrid retrieval in plain JS. It deliberately does NOT use
 * sqlite-vec: Bun's bun:sqlite links the system SQLite on macOS, which refuses
 * to load native extensions. For an internal-tool-sized memory set, a
 * brute-force cosine over the user's vectors is sub-millisecond and needs no
 * extension — so this works in the compiled sidecar binary with no external
 * dependency. (The Rust side keeps a sqlite-vec index for frontend use; both
 * read the same table and apply the identical scoring formula.)
 *
 * Scoring (identical to the Postgres RPC + the Rust port):
 *   score = (0.65*sim + 0.35*min(kw,1)) * (0.5 + 0.5*recency) * (0.5 + importance/20)
 *   sim = cosine(query, embedding); recency = exp(-age_seconds / (86400*65));
 *   importance = ai_memory.importance | knowledge.relevance_score*10 | 5;
 *   keep rows with sim>0.25 OR kw>0.05; drop is_fake; ORDER score DESC.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_DB_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "com.magnuspilegaard.atlas",
  "atlas.db",
);

export function openMemoryDb(path: string = DEFAULT_DB_PATH): Database {
  const db = new Database(path, { create: true, readwrite: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  return db;
}

// Embeddings are stored as little-endian float32 bytes (matches the Rust side).
export function floatToBlob(v: Float32Array | number[]): Uint8Array {
  const f = v instanceof Float32Array ? Float32Array.from(v) : Float32Array.from(v);
  return new Uint8Array(f.buffer.slice(0));
}

function blobToFloat(b: Uint8Array): Float32Array {
  const copy = b.slice(); // contiguous, aligned
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function keywordScore(queryText: string, chunk: string): number {
  const toks = queryText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  if (toks.length === 0) return 0;
  const hay = chunk.toLowerCase();
  const hits = toks.filter((t) => hay.includes(t)).length;
  return hits / toks.length;
}

export interface UpsertArgs {
  id: string;
  userId: string;
  chunkText: string;
  embedding: Float32Array | number[];
  memoryItemId?: string | null;
  knowledgeEntryId?: string | null;
}

/** Insert/replace a memory chunk + its embedding in the base table. */
export function upsertVector(db: Database, a: UpsertArgs): void {
  db.query(
    `INSERT OR REPLACE INTO memory_vectors
       (id, user_id, memory_item_id, knowledge_entry_id, embedding, chunk_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(a.id, a.userId, a.memoryItemId ?? null, a.knowledgeEntryId ?? null, floatToBlob(a.embedding), a.chunkText);
}

export interface RecallHit {
  id: string;
  chunk_text: string;
  memory_item_id: string | null;
  knowledge_entry_id: string | null;
  score: number;
  similarity: number;
}

interface Row {
  id: string;
  chunk_text: string;
  embedding: Uint8Array | null;
  memory_item_id: string | null;
  knowledge_entry_id: string | null;
  age: number | null;
  am_imp: number | null;
  am_fake: number | null;
  ake_rel: number | null;
  ake_fake: number | null;
}

/** Hybrid semantic+lexical recall over the user's memory vectors. */
export function recall(
  db: Database,
  opts: { userId: string; queryEmbedding: Float32Array | number[]; queryText: string; matchCount?: number },
): RecallHit[] {
  const q = opts.queryEmbedding instanceof Float32Array ? opts.queryEmbedding : Float32Array.from(opts.queryEmbedding);
  const matchCount = opts.matchCount ?? 12;

  const rows = db
    .query<Row, [string]>(
      `SELECT mv.id, mv.chunk_text, mv.embedding, mv.memory_item_id, mv.knowledge_entry_id,
              (strftime('%s','now') - strftime('%s', mv.created_at)) AS age,
              am.importance AS am_imp, am.is_fake AS am_fake,
              ake.relevance_score AS ake_rel, ake.is_fake AS ake_fake
       FROM memory_vectors mv
       LEFT JOIN ai_memory am ON am.id = mv.memory_item_id
       LEFT JOIN atlas_knowledge_entries ake ON ake.id = mv.knowledge_entry_id
       WHERE mv.user_id = ? AND mv.embedding IS NOT NULL`,
    )
    .all(opts.userId);

  const scored: RecallHit[] = [];
  for (const r of rows) {
    if (r.am_fake === 1 || r.ake_fake === 1) continue;
    if (!r.embedding) continue;
    const sim = cosine(q, blobToFloat(r.embedding));
    const kw = keywordScore(opts.queryText, r.chunk_text);
    if (!(sim > 0.25 || kw > 0.05)) continue;

    const ageS = Math.max(0, r.age ?? 0);
    const recency = Math.exp(-ageS / (86400 * 65));
    const importance =
      r.am_imp != null ? r.am_imp : r.ake_rel != null ? Math.min(10, Math.max(1, r.ake_rel * 10)) : 5;
    const score = (0.65 * sim + 0.35 * Math.min(kw, 1)) * (0.5 + 0.5 * recency) * (0.5 + importance / 20);

    scored.push({
      id: r.id,
      chunk_text: r.chunk_text,
      memory_item_id: r.memory_item_id,
      knowledge_entry_id: r.knowledge_entry_id,
      score,
      similarity: sim,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, matchCount));
}
