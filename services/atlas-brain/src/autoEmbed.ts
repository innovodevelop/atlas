/**
 * Keeps memory_vectors in step with what the orchestrator writes.
 *
 * The memory_store tool upserts ai_memory rows mid-turn (orchestrator.ts,
 * executeTool "memory_store"), and the learning routes write
 * atlas_knowledge_entries — but neither produces an embedding, so until now a
 * fact Atlas just learned was invisible to semantic recall until somebody
 * pressed a backfill button. Embedding is now local (localEmbed.ts), so the
 * brain can simply close the gap itself: after every chat turn it sweeps the
 * user's un-embedded rows.
 *
 * Two constraints shape this:
 *  - It must never delay a response. The sweep is scheduled *after* the
 *    Response is handed back, is bounded per turn, and yields between items —
 *    ORT's WASM backend computes on this process's threads, so a long
 *    unyielding batch would add jitter to an in-flight SSE stream.
 *  - It must not stack up. One sweep per user at a time; whatever is left over
 *    is picked up by the next turn (or by POST /embed-backfill).
 */

import { EMBEDDING_MODEL_ID, embedText } from "./localEmbed.ts";
import type { LocalDb } from "./localDb.ts";

/** Rows embedded per chat turn — ~40 ms each, spread out, off the response path. */
export const AUTO_EMBED_BATCH = 20;

/** Delay before an auto sweep starts, so the turn's stream gets a clean head start. */
const AUTO_EMBED_DELAY_MS = 500;

interface PendingRow {
  id: string;
  text: string;
  kind: "memory" | "knowledge";
}

/** Memories, then knowledge entries, that have no memory_vectors row yet. */
function selectPending(db: LocalDb, userId: string, limit: number): PendingRow[] {
  const raw = db._db;
  const out: PendingRow[] = [];

  const mems = raw
    .query(
      `SELECT id, key, value FROM ai_memory
        WHERE user_id = ?
          AND id NOT IN (SELECT memory_item_id FROM memory_vectors WHERE memory_item_id IS NOT NULL)
        LIMIT ?`,
    )
    .all(userId, limit) as Array<{ id: string; key: string; value: unknown }>;
  for (const m of mems) out.push({ id: m.id, kind: "memory", text: `${m.key}: ${m.value}`.slice(0, 2000) });

  const remaining = limit - out.length;
  if (remaining > 0) {
    const ks = raw
      .query(
        `SELECT id, topic, content FROM atlas_knowledge_entries
          WHERE user_id = ?
            AND id NOT IN (SELECT knowledge_entry_id FROM memory_vectors WHERE knowledge_entry_id IS NOT NULL)
          LIMIT ?`,
      )
      .all(userId, remaining) as Array<{ id: string; topic: string; content: unknown }>;
    for (const k of ks) out.push({ id: k.id, kind: "knowledge", text: `${k.topic}: ${k.content}`.slice(0, 2000) });
  }
  return out;
}

/**
 * Drop vectors produced by a different embedding model. Cosine between two
 * models' output is noise, so a mixed table silently corrupts recall; this DB
 * can still hold Gemini-era vectors, which carry no model stamp. The rows are
 * pure derived data — selectPending() regenerates them on the next sweep.
 */
const pruned = new Set<string>();
function pruneForeignVectors(db: LocalDb, userId: string): void {
  if (pruned.has(userId)) return;
  pruned.add(userId);
  try {
    const res = db._db
      .query(
        `DELETE FROM memory_vectors
          WHERE user_id = ?
            AND COALESCE(json_extract(source_ref_json, '$.model'), '') != ?`,
      )
      .run(userId, EMBEDDING_MODEL_ID);
    if (res.changes > 0) {
      console.log(`[brain] dropped ${res.changes} vector(s) from a previous embedding model — will re-embed`);
    }
  } catch (e) {
    console.error("[brain] vector prune failed:", e);
  }
}

/**
 * Embed up to `limit` pending rows for a user. Returns how many were written.
 * Shared by POST /embed-backfill and the post-turn sweep.
 */
export async function embedPending(db: LocalDb, userId: string, limit = AUTO_EMBED_BATCH): Promise<number> {
  pruneForeignVectors(db, userId);
  const pending = selectPending(db, userId, limit);
  let processed = 0;
  for (const row of pending) {
    try {
      const embedding = await embedText(row.text);
      db.upsertVector({
        id: crypto.randomUUID(),
        userId,
        chunkText: row.text,
        embedding,
        memoryItemId: row.kind === "memory" ? row.id : null,
        knowledgeEntryId: row.kind === "knowledge" ? row.id : null,
        sourceRef: { model: EMBEDDING_MODEL_ID },
      });
      processed++;
    } catch (e) {
      console.error(`[brain] embed failed for ${row.kind} ${row.id}:`, e);
      break; // model is unhappy — stop rather than log the same failure 20 times
    }
    await Bun.sleep(0); // yield: keep an in-flight SSE stream smooth
  }
  return processed;
}

const inFlight = new Set<string>();

/**
 * Fire-and-forget: sweep this user's un-embedded rows after a chat turn.
 * Returns immediately; failures are logged, never surfaced to the caller.
 */
export function scheduleAutoEmbed(db: LocalDb, userId: string): void {
  if (inFlight.has(userId)) return;
  inFlight.add(userId);
  setTimeout(() => {
    embedPending(db, userId)
      .then((n) => {
        if (n > 0) console.log(`[brain] auto-embedded ${n} new memory row(s)`);
      })
      .catch((e) => console.error("[brain] auto-embed sweep failed:", e))
      .finally(() => inFlight.delete(userId));
  }, AUTO_EMBED_DELAY_MS);
}
