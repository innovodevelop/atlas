// Local Supabase-compatible client for the brain sidecar (Supabase-removal,
// Phase 6 / Phase-3 tail). Same surface the shared orchestrator uses
// (`.from(table)…`, `.rpc(name)`), but backed by bun:sqlite over the on-device
// atlas.db instead of Supabase. This lets the brain run the orchestrator fully
// locally — profile, memories, knowledge, provider-status, session context — and
// routes recall through localMemory (brute-force cosine + keyword).
//
// Mirrors src/integrations/local/localClient.ts (the webview shim); the only
// difference is the execution backend (bun:sqlite here vs Tauri invoke there).

import { Database } from "bun:sqlite";
import { openMemoryDb, recall as localRecall, upsertVector } from "./localMemory.ts";

type Row = Record<string, unknown>;
type Result<T> = { data: T; error: { message: string; code?: string } | null };

// jsonb text ↔ object, 0/1 ↔ boolean (mirrors db_schema.sql / the webview shim).
const JSON_COLUMNS = new Set([
  "value", "content", "config", "attendees", "findings", "sources", "discoveries",
  "people_involved", "metadata", "extracted", "payload", "context", "details",
  "metrics", "provider_errors", "sources_checked", "validation_consensus",
  "root_topic_context", "source_ref_json", "raw_json", "settings_json", "tool_calls",
]);
const BOOL_COLUMNS = new Set([
  "completed", "resolved", "acknowledged", "enabled", "sandboxed", "requires_approval",
  "auto_generated", "auto_validation", "auto_knowledge_extraction", "auto_switch_enabled",
  "auto_disable_on_limit", "auto_prune", "lovable_ai_enabled", "global_discovery_enabled",
  "should_follow_up", "should_remember", "learning_enabled", "require_approval_for_risky",
  "auto_approve_low_risk", "alerts_enabled",
]);
const isJsonCol = (k: string) => k.endsWith("_json") || JSON_COLUMNS.has(k);
const isBoolCol = (k: string) => BOOL_COLUMNS.has(k) || k.startsWith("is_") || k.startsWith("has_");

function reconstruct(row: Row): Row {
  const out: Row = {};
  for (const k in row) {
    const v = row[k];
    if (isJsonCol(k) && typeof v === "string") {
      try { out[k] = JSON.parse(v); } catch { out[k] = v; }
    } else if (isBoolCol(k) && (v === 0 || v === 1)) {
      out[k] = v === 1;
    } else {
      out[k] = v;
    }
  }
  return out;
}
type Bind = string | number | bigint | boolean | null | Uint8Array;
const toSql = (v: unknown): Bind =>
  v == null ? null : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "object" ? JSON.stringify(v) : (v as Bind);

interface Filter { op: "eq" | "neq" | "in" | "gt" | "gte" | "lt" | "lte"; col: string; val: unknown }

// Tables where upsert(…, { onConflict }) runs a real ON CONFLICT DO UPDATE.
// Scoped to tables that actually carry the matching unique index (see
// idx_ai_memory_user_key in db_schema.sql / ensureMemoryIntegrity) — every
// other table keeps the legacy INSERT OR REPLACE-by-id behaviour, because a
// conflict target without an index is a hard SQL error.
const UPSERT_TARGETS: Record<string, string[]> = {
  ai_memory: ["user_id", "key"],
};

// Columns the conflict branch owns instead of taking from the incoming row:
// re-stating a fact is a *mention* — bump the counter, refresh recency.
// (Unqualified names refer to the existing row; excluded.* is the new data.)
const UPSERT_EXTRA_SET: Record<string, { skip: string[]; sql: string }> = {
  ai_memory: {
    skip: ["mention_count", "last_mentioned", "updated_at"],
    sql:
      `"mention_count" = COALESCE("mention_count", 1) + 1, ` +
      `"last_mentioned" = strftime('%Y-%m-%dT%H:%M:%fZ','now'), ` +
      `"updated_at" = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  },
};

class QueryBuilder implements PromiseLike<Result<any>> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "delete" = "select";
  private values: unknown = null;
  private patch: Row | null = null;
  private wantSelect = false;
  private wantSingle = false;
  private orderCol: string | null = null;
  private asc = true;
  private lim: number | null = null;
  private onConflict: string | null = null;

  constructor(private db: Database, private table: string) {}

  select(): this { this.wantSelect = true; return this; }
  insert(values: unknown): this { this.op = "insert"; this.values = values; return this; }
  update(patch: Row): this { this.op = "update"; this.patch = patch; return this; }
  upsert(values: unknown, opts?: { onConflict?: string }): this {
    this.op = "insert";
    this.values = values;
    this.onConflict = opts?.onConflict ?? null;
    return this;
  }
  delete(): this { this.op = "delete"; return this; }
  eq(col: string, val: unknown): this { this.filters.push({ op: "eq", col, val }); return this; }
  neq(col: string, val: unknown): this { this.filters.push({ op: "neq", col, val }); return this; }
  in(col: string, val: unknown[]): this { this.filters.push({ op: "in", col, val }); return this; }
  gt(col: string, val: unknown): this { this.filters.push({ op: "gt", col, val }); return this; }
  gte(col: string, val: unknown): this { this.filters.push({ op: "gte", col, val }); return this; }
  lt(col: string, val: unknown): this { this.filters.push({ op: "lt", col, val }); return this; }
  lte(col: string, val: unknown): this { this.filters.push({ op: "lte", col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }): this { this.orderCol = col; this.asc = opts?.ascending ?? true; return this; }
  limit(n: number): this { this.lim = n; return this; }
  single(): this { this.wantSingle = true; return this; }
  maybeSingle(): this { this.wantSingle = true; return this; }

  private whereSql(): { sql: string; binds: Bind[] } {
    if (!this.filters.length) return { sql: "", binds: [] };
    const parts: string[] = [];
    const binds: Bind[] = [];
    for (const f of this.filters) {
      if (f.op === "in") {
        const arr = f.val as unknown[];
        parts.push(`"${f.col}" IN (${arr.map(() => "?").join(",")})`);
        binds.push(...arr.map(toSql));
      } else {
        const opMap = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
        parts.push(`"${f.col}" ${opMap[f.op]} ?`);
        binds.push(toSql(f.val));
      }
    }
    return { sql: ` WHERE ${parts.join(" AND ")}`, binds };
  }

  private run(): Result<any> {
    try {
      if (this.op === "insert") return this.doInsert();
      if (this.op === "update") return this.doUpdate();
      if (this.op === "delete") return this.doDelete();
      // select
      const { sql, binds } = this.whereSql();
      let q = `SELECT * FROM "${this.table}"${sql}`;
      if (this.orderCol) q += ` ORDER BY "${this.orderCol}" ${this.asc ? "ASC" : "DESC"}`;
      if (this.lim != null) q += ` LIMIT ${this.lim}`;
      const rows = (this.db.query(q).all(...binds) as Row[]).map(reconstruct);
      if (this.wantSingle) {
        return { data: rows[0] ?? null, error: rows.length ? null : { code: "PGRST116", message: "No rows found" } };
      }
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  }

  private doInsert(): Result<any> {
    const rows = Array.isArray(this.values) ? this.values : [this.values];
    const out: Row[] = [];
    // Honor the requested conflict target only where the unique index exists.
    const conflictCols =
      this.onConflict &&
      UPSERT_TARGETS[this.table]?.slice().sort().join(",") ===
        this.onConflict.split(",").map((s) => s.trim()).sort().join(",")
        ? UPSERT_TARGETS[this.table]
        : null;
    for (const raw of rows as Row[]) {
      const r = { ...raw };
      if (!("id" in r) && this.hasIdCol()) r.id = crypto.randomUUID();
      const cols = Object.keys(r);
      const colList = cols.map((c) => `"${c}"`).join(",");
      const placeholders = cols.map(() => "?").join(",");
      let sql: string;
      if (conflictCols) {
        const extra = UPSERT_EXTRA_SET[this.table];
        const sets = cols
          .filter((c) => !conflictCols.includes(c) && c !== "id" && c !== "created_at" && !extra?.skip.includes(c))
          .map((c) => `"${c}" = excluded."${c}"`);
        if (extra) sets.push(extra.sql);
        const target = conflictCols.map((c) => `"${c}"`).join(",");
        sql = sets.length
          ? `INSERT INTO "${this.table}" (${colList}) VALUES (${placeholders}) ON CONFLICT(${target}) DO UPDATE SET ${sets.join(", ")} RETURNING *`
          : `INSERT INTO "${this.table}" (${colList}) VALUES (${placeholders}) ON CONFLICT(${target}) DO NOTHING RETURNING *`;
      } else {
        sql = `INSERT OR REPLACE INTO "${this.table}" (${colList}) VALUES (${placeholders}) RETURNING *`;
      }
      const res = this.db.query(sql).all(...cols.map((c) => toSql(r[c]))) as Row[];
      out.push(...res.map(reconstruct));
    }
    return this.finalizeWrite(out);
  }

  private doUpdate(): Result<any> {
    const patch = this.patch ?? {};
    const set = Object.keys(patch);
    const { sql, binds } = this.whereSql();
    const res = this.db
      .query(`UPDATE "${this.table}" SET ${set.map((c) => `"${c}"=?`).join(",")}${sql} RETURNING *`)
      .all(...set.map((c) => toSql(patch[c])), ...binds) as Row[];
    return this.finalizeWrite(res.map(reconstruct));
  }

  private doDelete(): Result<any> {
    const { sql, binds } = this.whereSql();
    const res = this.db.query(`DELETE FROM "${this.table}"${sql} RETURNING *`).all(...binds) as Row[];
    return this.finalizeWrite(res.map(reconstruct));
  }

  private finalizeWrite(rows: Row[]): Result<any> {
    if (!this.wantSelect) return { data: null, error: null };
    if (this.wantSingle) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  private hasIdCol(): boolean {
    try {
      return (this.db.query(`PRAGMA table_info("${this.table}")`).all() as { name: string }[]).some((c) => c.name === "id");
    } catch { return false; }
  }

  then<R1 = Result<any>, R2 = never>(
    onfulfilled?: ((value: Result<any>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

// ---------------------------------------------------------------------------
// Memory integrity + SFT capture (Phase 3)

// Mirror of the chat_turns DDL in db_schema.sql — inlined so a standalone brain
// (dev, tests) can capture turns against a DB the Rust core hasn't migrated yet.
// Keep the two in lockstep.
const CHAT_TURNS_DDL = `
CREATE TABLE IF NOT EXISTS chat_turns (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  conversation_id TEXT,
  turn_id         TEXT NOT NULL,
  seq             INTEGER NOT NULL DEFAULT 0,
  role            TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  content         TEXT NOT NULL,
  tool_calls      TEXT,
  model           TEXT,
  system_prompt   TEXT,
  source          TEXT,
  followed_up_at  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_turns_user ON chat_turns(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_chat_turns_conv ON chat_turns(conversation_id, created_at);`;

function hasTable(db: Database, name: string): boolean {
  return !!db.query(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

/**
 * Idempotent startup migration (JS twin of db.rs::migrate_ai_memory — keep in
 * lockstep): dedupe ai_memory to one row per (user_id, key) — keep the newest,
 * sum mention_count into the survivor — then enforce it with a unique index.
 * The index (not a table constraint) is the migratable form, and it is what the
 * upserts' ON CONFLICT(user_id, key) resolves against. Also ensures chat_turns
 * exists. Safe on a fresh/empty DB and safe to re-run.
 */
export function ensureMemoryIntegrity(db: Database): void {
  if (hasTable(db, "ai_memory")) {
    // Mirrors src-tauri/src/db.rs::migrate_ai_memory — keep the two in step.
    // The scan index goes first (the correlated subquery is O(n^2) without it,
    // and this blocks sidecar startup); the whole dedupe runs in one
    // transaction so a crash can't leave summed counts AND their duplicates;
    // `updated_at = updated_at` suppresses trg_ai_memory_updated so survivors
    // keep their real age for recency scoring.
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE INDEX IF NOT EXISTS idx_ai_memory_user_key_scan ON ai_memory(user_id, key);
      WITH survivors AS (
        SELECT (SELECT a2.id FROM ai_memory a2
                 WHERE a2.user_id = a1.user_id AND a2.key = a1.key
                 ORDER BY a2.updated_at DESC, a2.rowid DESC LIMIT 1) AS keep_id,
               SUM(COALESCE(a1.mention_count, 1)) AS total_mentions
        FROM ai_memory a1 GROUP BY a1.user_id, a1.key HAVING COUNT(*) > 1
      )
      UPDATE ai_memory
         SET mention_count = (SELECT s.total_mentions FROM survivors s WHERE s.keep_id = ai_memory.id),
             updated_at = updated_at
       WHERE id IN (SELECT keep_id FROM survivors);
      DELETE FROM ai_memory WHERE EXISTS (
        SELECT 1 FROM ai_memory a2
         WHERE a2.user_id = ai_memory.user_id AND a2.key = ai_memory.key
           AND (a2.updated_at > ai_memory.updated_at
                OR (a2.updated_at = ai_memory.updated_at AND a2.rowid > ai_memory.rowid))
      );
      COMMIT;`);
    // Non-fatal: a surviving duplicate must not kill the sidecar — upserts
    // degrade to inserts instead.
    try {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memory_user_key ON ai_memory(user_id, key);`);
    } catch (e) {
      console.error("[brain] ai_memory unique index not created (duplicates remain?):", e);
    }
  }
  db.exec(CHAT_TURNS_DDL);
}

/**
 * Best-effort purge of the Rust-side index mirrors for deleted vector ids.
 * FTS5 is available to bun:sqlite; the vec0 table is not (no extension loading)
 * — its residue is cleaned by db.rs::reconcile_vector_indexes on next app
 * start, and recall always joins memory_vectors, so a deleted row can never be
 * returned in the meantime.
 */
function purgeIndexMirrors(db: Database, vectorIds: string[]): void {
  if (!vectorIds.length) return;
  const ph = vectorIds.map(() => "?").join(",");
  for (const table of ["memory_fts", "memory_vec"]) {
    try {
      if (hasTable(db, table)) db.query(`DELETE FROM "${table}" WHERE id IN (${ph})`).run(...vectorIds);
    } catch { /* vec0 needs the extension — Rust reconciles on startup */ }
  }
}

/** Delete one user's memory row(s) by id and/or key, plus their vectors. */
export function forgetMemories(
  db: Database,
  userId: string,
  sel: { id?: string; key?: string },
): { memories: number; vectors: number } {
  const clauses: string[] = [];
  const binds: string[] = [userId];
  if (sel.id) { clauses.push(`"id" = ?`); binds.push(sel.id); }
  if (sel.key) { clauses.push(`"key" = ?`); binds.push(sel.key); }
  if (!clauses.length) throw new Error("forget requires an id or key");

  const ids = (db
    .query(`SELECT id FROM ai_memory WHERE user_id = ? AND (${clauses.join(" OR ")})`)
    .all(...binds) as { id: string }[]).map((r) => r.id);
  if (!ids.length) return { memories: 0, vectors: 0 };

  const ph = ids.map(() => "?").join(",");
  const vectorIds = (db
    .query(`SELECT id FROM memory_vectors WHERE user_id = ? AND memory_item_id IN (${ph})`)
    .all(userId, ...ids) as { id: string }[]).map((r) => r.id);
  // Explicit vector delete (not just FK cascade) so the count is honest even on
  // a connection where foreign_keys is off.
  db.query(`DELETE FROM memory_vectors WHERE user_id = ? AND memory_item_id IN (${ph})`).run(userId, ...ids);
  db.query(`DELETE FROM ai_memory WHERE user_id = ? AND id IN (${ph})`).run(userId, ...ids);
  purgeIndexMirrors(db, vectorIds);
  return { memories: ids.length, vectors: vectorIds.length };
}

/** Erase everything Atlas stores about one user. Returns per-table counts. */
export function eraseUserData(db: Database, userId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const vectorIds = hasTable(db, "memory_vectors")
    ? (db.query(`SELECT id FROM memory_vectors WHERE user_id = ?`).all(userId) as { id: string }[]).map((r) => r.id)
    : [];

  const run = (table: string, sql: string, ...binds: string[]) => {
    counts[table] = hasTable(db, table) ? Number(db.query(sql).run(...binds).changes) : 0;
  };

  // GDPR Art. 17 means EVERYTHING, so this is discovered from the live schema
  // rather than a hand-kept list: any table carrying a user_id is wiped. A
  // hardcoded list silently goes stale the moment a table is added — the first
  // version of this function covered 7 of 36 user-scoped tables, leaving the
  // user's profile, life events, mail and notes on disk after "delete all".
  const userScoped = (
    db
      .query(
        `SELECT m.name AS t FROM sqlite_master m
          WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
            AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) p WHERE p.name = 'user_id')
          ORDER BY m.name`,
      )
      .all() as { t: string }[]
  ).map((r) => r.t);

  // Child tables that carry no user_id and are owned through a parent — delete
  // them FIRST, while the parent rows still exist to scope the subquery.
  run(
    "messages",
    `DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)`,
    userId,
  );
  run("run_steps", `DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE user_id = ?)`, userId);

  // memory_vectors first: its ids drive the FTS/vec mirror purge below.
  for (const table of ["memory_vectors", ...userScoped.filter((t) => t !== "memory_vectors")]) {
    run(table, `DELETE FROM "${table}" WHERE user_id = ?`, userId);
  }
  purgeIndexMirrors(db, vectorIds);
  return counts;
}

export interface CapturedMessage { role: string; content: string; tool_calls?: unknown }

export interface TurnRecord {
  userId: string;
  conversationId: string | null;
  source: string;
  model: string | null;
  /** The composed system prompt at generation time — the SFT-critical snapshot. */
  systemPrompt: string | null;
  userMessage: string | null;
  /** Intermediate tool-loop messages (assistant tool_calls + tool results). */
  toolMessages: CapturedMessage[];
  assistantText: string;
}

const TURN_ROLES = new Set(["system", "user", "assistant", "tool"]);

/**
 * Persist one generation as chat_turns rows (user msg, tool-loop messages,
 * final assistant text with model + system-prompt snapshot), grouped by
 * turn_id and ordered by seq.
 *
 * Success signal: `followed_up_at`. When the user sends ANOTHER message in the
 * same conversation, the previous assistant turn gets stamped. Chosen as the
 * cheapest honest non-approval signal: continued engagement measures whether
 * the reply kept the conversation useful, not whether it was flattering (an
 * approval-shaped signal like thumbs-up trains sycophancy), and it costs one
 * UPDATE at capture time — no extra model calls, no UI.
 */
export function captureChatTurn(db: Database, t: TurnRecord): string {
  const turnId = crypto.randomUUID();
  const insert = db.query(
    `INSERT INTO chat_turns (id, user_id, conversation_id, turn_id, seq, role, content, tool_calls, model, system_prompt, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let seq = 0;
  const add = (role: string, content: string, toolCalls: unknown, model: string | null, systemPrompt: string | null) =>
    insert.run(
      crypto.randomUUID(), t.userId, t.conversationId, turnId, seq++,
      TURN_ROLES.has(role) ? role : "tool",
      content,
      toolCalls == null ? null : JSON.stringify(toolCalls),
      model, systemPrompt, t.source,
    );

  db.transaction(() => {
    if (t.conversationId && t.userMessage != null) {
      db.query(
        `UPDATE chat_turns SET followed_up_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = (SELECT id FROM chat_turns
                       WHERE user_id = ? AND conversation_id = ? AND role = 'assistant' AND followed_up_at IS NULL
                       ORDER BY created_at DESC, seq DESC LIMIT 1)`,
      ).run(t.userId, t.conversationId);
    }
    if (t.userMessage != null) add("user", t.userMessage, null, null, null);
    for (const m of t.toolMessages) add(m.role, m.content ?? "", m.tool_calls ?? null, null, null);
    add("assistant", t.assistantText, null, t.model, t.systemPrompt);
  })();
  return turnId;
}

/**
 * Accumulate the assistant text out of an OpenAI-shaped SSE stream. Runs on the
 * capture branch of a tee'd response stream — it consumes chunks as they
 * arrive, so the client branch is never delayed, and only the final text (not
 * the SSE framing) is held in memory.
 */
export async function assistantTextFromSse(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = "";
  let text = "";
  const drainLine = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") return;
    try {
      const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
      if (typeof delta === "string") text += delta;
    } catch { /* partial or non-completion event (citations) — skip */ }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      drainLine(buf.slice(0, idx).trimEnd());
      buf = buf.slice(idx + 1);
    }
  }
  drainLine(buf.trimEnd());
  return text;
}

export function createLocalDb(dbPath?: string) {
  const db = openMemoryDb(dbPath);
  ensureMemoryIntegrity(db);
  return {
    from(table: string) {
      return new QueryBuilder(db, table);
    },
    async rpc(name: string, args: Record<string, unknown>): Promise<Result<any>> {
      try {
        if (name === "recall_memories") {
          const hits = await localRecall(db, {
            userId: String(args.p_user_id),
            queryEmbedding: args.query_embedding as number[],
            queryText: String(args.query_text ?? ""),
            matchCount: (args.match_count as number) ?? 12,
          });
          return { data: hits, error: null };
        }
        if (name === "touch_memory_vectors") {
          const ids = (args.p_ids as string[]) ?? [];
          if (ids.length) {
            db.query(`UPDATE memory_vectors SET last_accessed = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${ids.map(() => "?").join(",")})`).run(...ids);
          }
          return { data: null, error: null };
        }
        return { data: null, error: { message: `Unknown RPC: ${name}` } };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
      }
    },
    _db: db,
    upsertVector: (a: Parameters<typeof upsertVector>[1]) => upsertVector(db, a),
  };
}

export type LocalDb = ReturnType<typeof createLocalDb>;
