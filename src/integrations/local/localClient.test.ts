// Integration test for the local Supabase-shim: a mocked Tauri `invoke` runs the
// shim's generated operations against a REAL bun:sqlite copy of the app schema,
// so the whole round-trip (query building → db_* → SQLite → type reconstruction)
// is exercised without needing the desktop app.
import { test, expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/db_schema.sql"),
  "utf8",
);
const db = new Database(":memory:");
db.exec(SCHEMA);

const toSql = (v: unknown): unknown =>
  v == null ? null : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "object" ? JSON.stringify(v) : v;

// Faithful stand-in for the Rust db_* commands (generic, eq filters, RETURNING).
function fakeInvoke(cmd: string, args: any): any {
  const t = args.table;
  if (cmd === "db_insert") {
    const rows = Array.isArray(args.values) ? args.values : [args.values];
    const out: any[] = [];
    for (const row of rows) {
      const r = { ...row };
      if (!("id" in r)) r.id = crypto.randomUUID();
      const cols = Object.keys(r);
      const res = db
        .query(
          `INSERT OR REPLACE INTO "${t}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols
            .map(() => "?")
            .join(",")}) RETURNING *`,
        )
        .all(...cols.map((c) => toSql(r[c])));
      out.push(...res);
    }
    return out;
  }
  if (cmd === "db_update") {
    const set = Object.keys(args.patch);
    const wh = Object.keys(args.filters);
    return db
      .query(
        `UPDATE "${t}" SET ${set.map((c) => `"${c}"=?`).join(",")} WHERE ${wh
          .map((c) => `"${c}"=?`)
          .join(" AND ")} RETURNING *`,
      )
      .all(...set.map((c) => toSql(args.patch[c])), ...wh.map((c) => toSql(args.filters[c])));
  }
  if (cmd === "db_delete") {
    const wh = Object.keys(args.filters);
    return db
      .query(`DELETE FROM "${t}" WHERE ${wh.map((c) => `"${c}"=?`).join(" AND ")} RETURNING *`)
      .all(...wh.map((c) => toSql(args.filters[c])));
  }
  // db_select
  const wh = Object.keys(args.filters ?? {});
  let sql = `SELECT * FROM "${t}"`;
  const binds: unknown[] = [];
  if (wh.length) {
    sql += ` WHERE ${wh.map((c) => `"${c}"=?`).join(" AND ")}`;
    binds.push(...wh.map((c) => toSql(args.filters[c])));
  }
  return db.query(sql).all(...binds);
}

mock.module("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: any) => Promise.resolve(fakeInvoke(cmd, args)) }));
mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
mock.module("@/lib/authClient", () => ({
  getSession: () => null,
  getToken: () => null,
  subscribe: () => () => {},
  hasFeature: () => false,
}));
(globalThis as any).window = { __TAURI_INTERNALS__: {} };

const { localClient: supabase } = await import("./localClient.ts");

test("insert → select round-trips jsonb + booleans", async () => {
  const { data: ins, error } = await supabase
    .from("ai_memory")
    .insert({ user_id: "u1", memory_type: "fact", category: "personal", key: "car", value: { make: "Volvo", year: 2020 }, is_fake: false })
    .select()
    .single();
  expect(error).toBeNull();
  expect(ins.value).toEqual({ make: "Volvo", year: 2020 }); // jsonb text -> object
  expect(ins.is_fake).toBe(false); // 0 -> boolean

  const { data } = await supabase.from("ai_memory").select("*").eq("user_id", "u1").single();
  expect(data.value.make).toBe("Volvo");
  expect(data.is_fake).toBe(false);
  expect(typeof data.importance).toBe("number"); // non-bool integer stays a number
});

test("filters (eq/neq/in/gte), order, limit", async () => {
  for (const [title, pri] of [["a", 1], ["b", 5], ["c", 3]] as const) {
    await supabase.from("user_tasks").insert({ user_id: "u2", title, priority: String(pri), completed: title === "b" });
  }
  const { data: all } = await supabase.from("user_tasks").select("*").eq("user_id", "u2").order("title", { ascending: true });
  expect(all.map((r: any) => r.title)).toEqual(["a", "b", "c"]);
  expect(all.find((r: any) => r.title === "b").completed).toBe(true); // bool reconstructed

  const { data: notB } = await supabase.from("user_tasks").select("*").eq("user_id", "u2").neq("title", "b");
  expect(notB.map((r: any) => r.title).sort()).toEqual(["a", "c"]);

  const { data: inSet } = await supabase.from("user_tasks").select("*").eq("user_id", "u2").in("title", ["a", "c"]);
  expect(inSet.length).toBe(2);

  const { data: lim } = await supabase.from("user_tasks").select("*").eq("user_id", "u2").order("title").limit(2);
  expect(lim.map((r: any) => r.title)).toEqual(["a", "b"]);
});

test("update .eq().select().single() and delete", async () => {
  const { data: t } = await supabase.from("user_tasks").insert({ user_id: "u3", title: "x", completed: false }).select().single();
  const { data: upd } = await supabase.from("user_tasks").update({ completed: true }).eq("id", t.id).select().single();
  expect(upd.completed).toBe(true);

  await supabase.from("user_tasks").delete().eq("id", t.id);
  const { data: gone } = await supabase.from("user_tasks").select("*").eq("id", t.id);
  expect(gone.length).toBe(0);
});

test("single() on no rows returns PGRST116 error, not throw", async () => {
  const { data, error } = await supabase.from("user_tasks").select("*").eq("id", "nope").single();
  expect(data).toBeNull();
  expect(error?.code).toBe("PGRST116");
});
