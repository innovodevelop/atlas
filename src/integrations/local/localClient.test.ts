/* eslint-disable @typescript-eslint/no-explicit-any -- test code deliberately builds
   partial fixtures and reaches into internals to assert on them. Precise types
   here would mean mirroring production shapes in the tests, which adds churn
   without adding safety: the assertions, not the annotations, are the contract. */
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
// Stops the import chain of useMailIntelligence (whose pickAccount projection
// is under test) from dragging in the real auth stack.
mock.module("@/hooks/useAuth", () => ({ useAuth: () => ({ user: null }) }));
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

test("update/delete with non-eq filters is refused loudly, not applied to every row", async () => {
  await supabase.from("user_tasks").insert({ user_id: "u4", title: "keep-a", completed: false });
  await supabase.from("user_tasks").insert({ user_id: "u4", title: "keep-b", completed: false });

  // .neq() on update: db_update only takes an eq-map, so silently dropping the
  // filter would rewrite EVERY row — the shim must return an error instead.
  const { error: updErr } = await supabase
    .from("user_tasks")
    .update({ completed: true })
    .neq("id", "00000000-0000-0000-0000-000000000000");
  expect(updErr).not.toBeNull();
  expect(updErr!.message).toContain("only supports .eq() filters");
  expect(updErr!.message).toContain("neq");

  // .in() on delete: same refusal.
  const { error: delErr } = await supabase.from("user_tasks").delete().in("id", ["x", "y"]);
  expect(delErr).not.toBeNull();
  expect(delErr!.message).toContain("only supports .eq() filters");

  // Nothing was touched.
  const { data: rows } = await supabase.from("user_tasks").select("*").eq("user_id", "u4");
  expect(rows.length).toBe(2);
  expect(rows.every((r: any) => r.completed === false)).toBe(true);

  // Mixed filters still refused (an eq alongside a neq must not slip through).
  const { error: mixedErr } = await supabase
    .from("user_tasks")
    .update({ completed: true })
    .eq("user_id", "u4")
    .neq("title", "keep-a");
  expect(mixedErr).not.toBeNull();

  // Pure .eq() writes keep working.
  const { error: okErr } = await supabase
    .from("user_tasks")
    .update({ completed: true })
    .eq("user_id", "u4");
  expect(okErr).toBeNull();

  // Selects still support the full filter set client-side.
  const { data: sel } = await supabase.from("user_tasks").select("*").eq("user_id", "u4").neq("title", "keep-a");
  expect(sel.map((r: any) => r.title)).toEqual(["keep-b"]);
});

test("agent-name join pattern (runs/schedules → agents map) resolves names without embeds", async () => {
  // The shim ignores relational embed strings like `agent:agents(name)`; the
  // hooks resolve names via a second query + Map. Exercise that exact path.
  const { data: agent } = await supabase
    .from("agents")
    .insert({ user_id: "u5", name: "Research Agent", system_prompt: "x" })
    .select()
    .single();
  await supabase
    .from("runs")
    .insert({ user_id: "u5", agent_id: agent.id, goal_text: "goal", status: "pending" });

  const [{ data: runs }, { data: agentRows }] = await Promise.all([
    supabase.from("runs").select("*").eq("user_id", "u5"),
    supabase.from("agents").select("id, name"),
  ]);
  const agentNames = new Map<string, string>((agentRows || []).map((a: any) => [a.id, a.name]));
  const joined = (runs || []).map((run: any) => {
    const name = agentNames.get(run.agent_id);
    return { ...run, agent: name != null ? { name } : undefined };
  });

  expect(joined.length).toBe(1);
  expect(joined[0].agent).toEqual({ name: "Research Agent" }); // was undefined pre-fix
});

test("mail_accounts projection: encrypted_refresh_token cannot survive pickAccount", async () => {
  const { pickAccount } = await import("@/hooks/useMailIntelligence.ts");

  await supabase.from("mail_accounts").insert({
    user_id: "u6",
    provider: "gmail",
    email_address: "u6@example.com",
    status: "active",
    encrypted_refresh_token: "SECRET-TOKEN",
  });

  // The shim ignores select() column lists — the full row (token included)
  // comes back from the DB layer...
  const { data } = await supabase
    .from("mail_accounts")
    .select("id, provider, email_address, status, last_synced_at")
    .eq("user_id", "u6");
  expect(data.length).toBe(1);
  expect(data[0].encrypted_refresh_token).toBe("SECRET-TOKEN");

  // ...so pickAccount is the enforcement point: exactly the 5 public keys.
  const account = pickAccount(data[0]);
  expect(Object.keys(account).sort()).toEqual([
    "email_address",
    "id",
    "last_synced_at",
    "provider",
    "status",
  ]);
  expect("encrypted_refresh_token" in account).toBe(false);
  expect(JSON.stringify(account)).not.toContain("SECRET-TOKEN");
});

// ---------------------------------------------------------------------------
// Boolean filters. SQLite stores flags as INTEGER 0/1, and this shim's job is
// to let callers keep the old client's API — so `.eq('col', false)` must work.
//
// It did not. `0 === false` is false and `String(0) === String(false)` is
// `"0" === "false"`, so a boolean filter matched NO ROW EVER, silently. Three
// live call sites were dead because of it: useAtlasHealth.ts:39 (`resolved`)
// and useMailIntelligence.ts:77,150 (`acknowledged`). Nothing threw and nothing
// logged — an always-empty result is indistinguishable from "nothing to report",
// which is why it survived a green suite.
// ---------------------------------------------------------------------------

test("eq matches a stored 0/1 flag against a JS boolean, in both directions", async () => {
  await supabase.from("atlas_error_logs").insert([
    { id: "e-open-1", user_id: "u-bool", error_type: "x", error_message: "still broken", resolved: false },
    { id: "e-open-2", user_id: "u-bool", error_type: "x", error_message: "also broken", resolved: false },
    { id: "e-done-1", user_id: "u-bool", error_type: "x", error_message: "fixed", resolved: true },
  ]);

  // This is the exact query useAtlasHealth.ts:39 makes.
  const open = await supabase.from("atlas_error_logs").select().eq("user_id", "u-bool").eq("resolved", false);
  expect(open.data?.length).toBe(2);

  const closed = await supabase.from("atlas_error_logs").select().eq("user_id", "u-bool").eq("resolved", true);
  expect(closed.data?.length).toBe(1);

  // The integer spelling must keep working — callers use both.
  const openAsInt = await supabase.from("atlas_error_logs").select().eq("user_id", "u-bool").eq("resolved", 0);
  expect(openAsInt.data?.length).toBe(2);
});

test("neq and in agree with eq about booleans", async () => {
  const notOpen = await supabase.from("atlas_error_logs").select().eq("user_id", "u-bool").neq("resolved", false);
  expect(notOpen.data?.length).toBe(1);

  // `in` compared with .includes(), which has the same identity problem.
  const either = await supabase
    .from("atlas_error_logs").select().eq("user_id", "u-bool").in("resolved", [true, false]);
  expect(either.data?.length).toBe(3);
});

test("a boolean eq filter reaches Rust as 0/1, so update targets the right rows", async () => {
  // eqFilterObj() is handed to db_update/db_delete, where the column is
  // INTEGER. An un-normalised `false` there updates nothing at all — the
  // dangerous half of this bug, because it fails silently and looks like a
  // no-op rather than an error.
  const { data } = await supabase
    .from("atlas_error_logs")
    .update({ error_message: "swept" })
    .eq("user_id", "u-bool")
    .eq("resolved", false)
    .select();

  expect(data?.length).toBe(2);
  expect(data?.every((r: any) => r.error_message === "swept")).toBe(true);

  // And the resolved row was left alone.
  const untouched = await supabase.from("atlas_error_logs").select().eq("id", "e-done-1").single();
  expect(untouched.data?.error_message).toBe("fixed");
});
