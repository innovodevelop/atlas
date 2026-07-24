// Local Supabase-compatible client (Supabase-removal, Phase 4).
//
// A drop-in for the parts of the supabase-js client the app uses, backed by the
// local SQLite DB via Tauri `invoke` (db_select/insert/update/delete) and Tauri
// events for realtime. Replacing the `supabase` export with this means every
// `supabase.from(...)` / `.channel(...)` / `.rpc(...)` call site keeps working
// unchanged.
//
// Runtime gate: outside Tauri (browser dev) there's no local DB, so reads return
// empty and writes return an error — the app renders without data instead of
// crashing. In the packaged desktop app everything is local.
//
// Type reconstruction: the Rust layer is schema-agnostic, so jsonb columns come
// back as JSON *text* and booleans as 0/1. We restore them here (JSON_COLUMNS /
// BOOL_COLUMNS) so consumers see the same shapes Supabase returned.

import * as authClient from "@/lib/authClient";

type Row = Record<string, unknown>;
type Result<T> = { data: T; error: { message: string; code?: string; status?: number } | null; count?: number };

// ---------------------------------------------------------------------------
// Tauri bridge
// ---------------------------------------------------------------------------
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let _invoke: (<T>(cmd: string, args?: Record<string, unknown>) => Promise<T>) | null = null;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!_invoke) {
    const core = await import("@tauri-apps/api/core");
    _invoke = core.invoke as typeof _invoke;
  }
  return _invoke!<T>(cmd, args);
}

let _listen: ((event: string, cb: (e: { payload: unknown }) => void) => Promise<() => void>) | null = null;
async function tauriListen(event: string, cb: (e: { payload: unknown }) => void): Promise<() => void> {
  if (!_listen) {
    const ev = await import("@tauri-apps/api/event");
    _listen = ev.listen as typeof _listen;
  }
  return _listen!(event, cb);
}

// ---------------------------------------------------------------------------
// Column type reconstruction (mirrors db_schema.sql)
// ---------------------------------------------------------------------------
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
      try {
        out[k] = JSON.parse(v);
      } catch {
        out[k] = v;
      }
    } else if (isBoolCol(k) && (v === 0 || v === 1)) {
      out[k] = v === 1;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Query builder — thenable, mirrors the supabase-js surface the app uses
// ---------------------------------------------------------------------------
type Op = "select" | "insert" | "update" | "delete";
interface Filter {
  op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "like" | "ilike" | "is";
  col: string;
  val: unknown;
}

function likeToRegExp(pattern: string, flags: string): RegExp {
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${esc}$`, flags);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
class QueryBuilder<T = any> implements PromiseLike<Result<T>> {
  private filters: Filter[] = [];
  private _op: Op = "select";
  private _values: unknown = null;
  private _patch: Row | null = null;
  private _select = false;
  private _single = false;
  private _maybeSingle = false;
  private _orderCol: string | null = null;
  private _asc = true;
  private _limit: number | null = null;
  private _range: [number, number] | null = null;

  constructor(private table: string) {}

  select(_cols?: string): this {
    this._select = true;
    return this;
  }
  insert(values: unknown): this {
    this._op = "insert";
    this._values = values;
    this._select = false;
    return this;
  }
  update(patch: Row): this {
    this._op = "update";
    this._patch = patch;
    return this;
  }
  upsert(values: unknown): this {
    // The local layer's insert uses INSERT OR REPLACE, so upsert == insert here.
    this._op = "insert";
    this._values = values;
    return this;
  }
  delete(): this {
    this._op = "delete";
    return this;
  }

  eq(col: string, val: unknown): this { this.filters.push({ op: "eq", col, val }); return this; }
  neq(col: string, val: unknown): this { this.filters.push({ op: "neq", col, val }); return this; }
  gt(col: string, val: unknown): this { this.filters.push({ op: "gt", col, val }); return this; }
  gte(col: string, val: unknown): this { this.filters.push({ op: "gte", col, val }); return this; }
  lt(col: string, val: unknown): this { this.filters.push({ op: "lt", col, val }); return this; }
  lte(col: string, val: unknown): this { this.filters.push({ op: "lte", col, val }); return this; }
  in(col: string, val: unknown[]): this { this.filters.push({ op: "in", col, val }); return this; }
  like(col: string, val: string): this { this.filters.push({ op: "like", col, val }); return this; }
  ilike(col: string, val: string): this { this.filters.push({ op: "ilike", col, val }); return this; }
  is(col: string, val: unknown): this { this.filters.push({ op: "is", col, val }); return this; }

  order(col: string, opts?: { ascending?: boolean }): this {
    this._orderCol = col;
    this._asc = opts?.ascending ?? true;
    return this;
  }
  limit(n: number): this { this._limit = n; return this; }
  range(from: number, to: number): this { this._range = [from, to]; return this; }
  single(): this { this._single = true; return this; }
  maybeSingle(): this { this._maybeSingle = true; return this; }

  private eqFilterObj(): Row {
    const o: Row = {};
    for (const f of this.filters) if (f.op === "eq") o[f.col] = f.val;
    return o;
  }

  private applyFilters(rows: Row[]): Row[] {
    return rows.filter((r) =>
      this.filters.every((f) => {
        const cell = r[f.col];
        switch (f.op) {
          case "eq": return cell === f.val || String(cell) === String(f.val);
          case "neq": return cell !== f.val;
          case "gt": return (cell as number) > (f.val as number);
          case "gte": return (cell as number) >= (f.val as number);
          case "lt": return (cell as number) < (f.val as number);
          case "lte": return (cell as number) <= (f.val as number);
          case "in": return (f.val as unknown[]).includes(cell);
          case "is": return cell === f.val || (f.val === null && cell == null);
          case "like": return likeToRegExp(f.val as string, "").test(String(cell));
          case "ilike": return likeToRegExp(f.val as string, "i").test(String(cell));
          default: return true;
        }
      }),
    );
  }

  private postProcess(rows: Row[]): Row[] {
    let out = this.applyFilters(rows).map(reconstruct);
    if (this._orderCol) {
      const col = this._orderCol;
      out = [...out].sort((a, b) => {
        const av = a[col] as never, bv = b[col] as never;
        if (av === bv) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return (av < bv ? -1 : 1) * (this._asc ? 1 : -1);
      });
    }
    if (this._range) out = out.slice(this._range[0], this._range[1] + 1);
    if (this._limit != null) out = out.slice(0, this._limit);
    return out;
  }

  private finalizeWrite(rows: Row[]): Result<T> {
    const data = rows.map(reconstruct);
    if (!this._select) return { data: null as T, error: null };
    if (this._single) {
      return { data: (data[0] ?? null) as T, error: data.length ? null : { code: "PGRST116", message: "No rows found" } };
    }
    if (this._maybeSingle) return { data: (data[0] ?? null) as T, error: null };
    return { data: data as T, error: null };
  }

  private async execute(): Promise<Result<T>> {
    if (!isTauri()) {
      if (this._op === "select") {
        return { data: (this._single || this._maybeSingle ? null : []) as T, error: null };
      }
      return { data: null as T, error: { message: "Local database is only available in the Atlas desktop app." } };
    }
    try {
      if (this._op === "insert") {
        const rows = await invoke<Row[]>("db_insert", { table: this.table, values: this._values });
        return this.finalizeWrite(rows ?? []);
      }
      if (this._op === "update") {
        const rows = await invoke<Row[]>("db_update", {
          table: this.table,
          filters: this.eqFilterObj(),
          patch: this._patch,
        });
        return this.finalizeWrite(rows ?? []);
      }
      if (this._op === "delete") {
        const rows = await invoke<Row[]>("db_delete", { table: this.table, filters: this.eqFilterObj() });
        return this.finalizeWrite(rows ?? []);
      }
      // select: narrow server-side by eq, then filter/order/limit client-side.
      const raw = await invoke<Row[]>("db_select", { table: this.table, filters: this.eqFilterObj() });
      const rows = this.postProcess(raw ?? []);
      if (this._single) {
        return {
          data: (rows[0] ?? null) as T,
          error: rows.length ? null : { code: "PGRST116", message: "No rows found" },
        };
      }
      if (this._maybeSingle) return { data: (rows[0] ?? null) as T, error: null };
      return { data: rows as T, error: null, count: rows.length };
    } catch (e) {
      return { data: null as T, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  }

  then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((value: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected);
  }
}

// ---------------------------------------------------------------------------
// Realtime — .channel(name).on('postgres_changes', {table,...}, cb).subscribe()
// backed by the Tauri `db:changed` event. Fine-grained filters are ignored; the
// consumer re-queries on any change to the table (which is what the hooks do).
// ---------------------------------------------------------------------------
interface ChangeHandler {
  table: string | null;
  cb: (payload: { eventType: string; new: Row | null; old: Row | null; table: string }) => void;
}

class LocalChannel {
  private handlers: ChangeHandler[] = [];
  private unlisten: (() => void) | null = null;
  constructor(public name: string) {}

  on(_type: string, cfg: { table?: string } | undefined, cb: ChangeHandler["cb"]): this {
    this.handlers.push({ table: cfg?.table ?? null, cb });
    return this;
  }

  subscribe(cb?: (status: string) => void): this {
    if (isTauri()) {
      void tauriListen("db:changed", (e) => {
        const payload = e.payload as { table?: string; op?: string };
        for (const h of this.handlers) {
          if (h.table && payload.table && h.table !== payload.table) continue;
          h.cb({
            eventType: (payload.op ?? "*").toUpperCase(),
            new: null,
            old: null,
            table: payload.table ?? "",
          });
        }
      }).then((un) => (this.unlisten = un));
    }
    cb?.("SUBSCRIBED");
    return this;
  }

  unsubscribe(): void {
    this.unlisten?.();
    this.unlisten = null;
    this.handlers = [];
  }
}

// ---------------------------------------------------------------------------
// RPC — maps the Postgres functions the app calls to local commands.
// ---------------------------------------------------------------------------
async function rpc<T = unknown>(name: string, args?: Record<string, unknown>): Promise<Result<T>> {
  if (!isTauri()) return { data: null as T, error: { message: "RPC only available in the desktop app." } };
  try {
    if (name === "recall_memories") {
      const data = await invoke<T>("memory_recall", {
        userId: args?.p_user_id,
        queryEmbedding: args?.query_embedding,
        queryText: args?.query_text,
        matchCount: args?.match_count,
      });
      return { data, error: null };
    }
    return { data: null as T, error: { message: `Unknown RPC: ${name}` } };
  } catch (e) {
    return { data: null as T, error: { message: e instanceof Error ? e.message : String(e) } };
  }
}

// ---------------------------------------------------------------------------
// The exported client
// ---------------------------------------------------------------------------
// Bridge supabase.auth.* to the Cloudflare account session (authClient). Only
// the three methods the app still calls directly are implemented.
const auth = {
  async getUser() {
    const s = authClient.getSession();
    return { data: { user: s ? { id: s.userId, email: s.email } : null }, error: null };
  },
  async getSession() {
    const s = authClient.getSession();
    return {
      data: { session: s ? { access_token: s.token, user: { id: s.userId, email: s.email } } : null },
      error: null,
    };
  },
  onAuthStateChange(cb: (event: string, session: unknown) => void) {
    const unsub = authClient.subscribe(() => {
      const s = authClient.getSession();
      cb(
        s ? "SIGNED_IN" : "SIGNED_OUT",
        s ? { access_token: s.token, user: { id: s.userId, email: s.email } } : null,
      );
    });
    return { data: { subscription: { unsubscribe: unsub } } };
  },
};

// Local realtime has no socket to manage; the pause-on-inactivity hook's calls
// become no-ops (Tauri events are cheap and don't need pausing).
const realtime = {
  isConnected: () => true,
  connect: () => {},
  disconnect: () => {},
};

// Edge functions now served by local Tauri commands. Anything not in this map
// has no backend anymore — mail waits on the Phase-7 CF mail worker.
const LOCAL_FN: Record<string, string> = {
  "get-weather": "fetch_weather",
  "get-stocks": "fetch_stocks",
  "get-news": "fetch_news",
};

const MAIL_FNS = new Set(["mail-oauth-start", "mail-sync", "mail-disconnect"]);

const functions = {
  async invoke(name: string, opts?: { body?: unknown; headers?: Record<string, string> }): Promise<Result<any>> {
    const localCmd = LOCAL_FN[name];
    if (localCmd && isTauri()) {
      try {
        const data = await invoke(localCmd, (opts?.body ?? {}) as Record<string, unknown>);
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
      }
    }
    if (MAIL_FNS.has(name)) {
      return { data: null, error: new Error("Mail sync is temporarily unavailable — migrating to the new mail service") };
    }
    return { data: null, error: new Error(`${name} is not available locally`) };
  },
};

export const localClient = {
  from<T = any>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(table);
  },
  channel(name: string): LocalChannel {
    return new LocalChannel(name);
  },
  removeChannel(channel: LocalChannel): void {
    channel.unsubscribe();
  },
  rpc,
  auth,
  realtime,
  functions,
};

export type LocalClient = typeof localClient;
