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
  "root_topic_context", "source_ref_json", "raw_json", "settings_json",
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

  constructor(private db: Database, private table: string) {}

  select(): this { this.wantSelect = true; return this; }
  insert(values: unknown): this { this.op = "insert"; this.values = values; return this; }
  update(patch: Row): this { this.op = "update"; this.patch = patch; return this; }
  upsert(values: unknown): this { this.op = "insert"; this.values = values; return this; }
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
    for (const raw of rows as Row[]) {
      const r = { ...raw };
      if (!("id" in r) && this.hasIdCol()) r.id = crypto.randomUUID();
      const cols = Object.keys(r);
      const res = this.db
        .query(`INSERT OR REPLACE INTO "${this.table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")}) RETURNING *`)
        .all(...cols.map((c) => toSql(r[c]))) as Row[];
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

export function createLocalDb(dbPath?: string) {
  const db = openMemoryDb(dbPath);
  return {
    from(table: string) {
      return new QueryBuilder(db, table);
    },
    async rpc(name: string, args: Record<string, unknown>): Promise<Result<any>> {
      try {
        if (name === "recall_memories") {
          const hits = localRecall(db, {
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
