// The agent runner (agentRunner.ts) against a real copy of the app schema:
// the plan written before any step, progress kept in it, pause and resume
// between steps, waiting on the run's own approvals, stop with undo, and the
// sweep that closes runs a stopped brain left behind. The model and the
// control port are fakes; everything the runner writes is real SQL.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { atlasToolOpNames, type ToolCall, type ToolDecl, type ChatMessage } from "../../../supabase/functions/_shared/orchestrator.ts";
import type { CallOpts, ControlResult } from "./control.ts";
import {
  MAX_PARALLEL_RUNS, RUN_WITHHELD_OPS, STALE_PENDING_MS, createAgentRunner, ensureAgentRunSchema, parsePlan, readStoredPlan, undoFor,
  type ModelTurn, type RunPlan, type UndoRecord,
} from "./agentRunner.ts";

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/db_schema.sql"),
  "utf8",
);
const USER = "u-test";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  db.query(`INSERT INTO agents (id, user_id, name, system_prompt, max_steps) VALUES ('a1', ?, 'Helper', 'You are Atlas.', 6)`).run(USER);
  return db;
}

function addRun(db: Database, id = "r1", over: { status?: string; created_at?: string; user?: string; agent?: string } = {}): string {
  const agent = over.agent ?? "a1";
  db.query(`INSERT OR IGNORE INTO agents (id, user_id, name, system_prompt, max_steps) VALUES (?, ?, 'Helper', 'You are Atlas.', 6)`).run(agent, USER);
  db.query(`INSERT INTO runs (id, user_id, agent_id, goal_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, over.user ?? USER, agent, "Tidy my week. Add a task for the dentist.", over.status ?? "pending", over.created_at ?? new Date().toISOString());
  return id;
}

const run = (db: Database, id = "r1") =>
  db.query(`SELECT * FROM runs WHERE id = ?`).get(id) as Record<string, unknown> & { status: string; plan_json: string | null; paused_at: string | null };
const planOf = (db: Database, id = "r1") => JSON.parse(run(db, id).plan_json ?? "null") as RunPlan;

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** A model that plans `plan` and then answers each step from `steps` in turn. */
function scriptedModel(plan: string, steps: Array<ModelTurn | ((messages: ChatMessage[]) => ModelTurn | Promise<ModelTurn>)>) {
  let i = 0;
  const seen: Array<{ tools: number }> = [];
  const complete = async (_model: string, messages: ChatMessage[], tools: ToolDecl[]): Promise<ModelTurn | null> => {
    seen.push({ tools: tools.length });
    if (!tools.length && messages[0].content.includes("You plan work")) return { content: plan, toolCalls: [], tokens: 10 };
    const next = steps[i++];
    if (!next) return { content: "Nothing more to do.", toolCalls: [], tokens: 1 };
    return typeof next === "function" ? next(messages) : next;
  };
  return { complete, seen };
}

/** A control port that writes the rows Rust would and remembers every call. */
function fakeControl(db: Database) {
  const calls: Array<{ op: string; args: Record<string, unknown>; opts: CallOpts }> = [];
  return {
    calls,
    available: () => true,
    capabilities: async () => ["tasks.list", "tasks.create", "tasks.update", "music.play", "mail.list_threads", "mail.archive", "mail.mark_read"],
    async call(op: string, args: unknown, opts: CallOpts): Promise<ControlResult> {
      const a = (args ?? {}) as Record<string, unknown>;
      calls.push({ op, args: a, opts });
      if (op === "tasks.create") {
        const id = crypto.randomUUID();
        db.query(`INSERT INTO user_tasks (id, user_id, title) VALUES (?, ?, ?)`).run(id, opts.userId ?? "", String(a.title));
        return { ok: true, data: { action: "created", row: { id, title: a.title } } };
      }
      if (op === "tasks.update") {
        db.query(`UPDATE user_tasks SET title = ? WHERE id = ?`).run(String(a.title), String(a.id));
        return { ok: true, data: { action: "updated", changed: ["title"], row: { id: a.id, title: a.title } } };
      }
      // Rust queues an actuation on the background profile (policy.rs decide).
      if (op === "music.play" || op === "mail.archive" || op === "mail.mark_read") {
        const tc = crypto.randomUUID();
        const ap = crypto.randomUUID();
        db.query(`INSERT INTO tool_calls (id, run_id, user_id, tool_name, status, requires_approval) VALUES (?, ?, ?, ?, 'awaiting_approval', 1)`).run(tc, opts.runId ?? null, opts.userId ?? "", op);
        db.query(`INSERT INTO approvals (id, run_id, user_id, tool_call_id, action_summary) VALUES (?, ?, ?, ?, ?)`).run(ap, opts.runId ?? null, opts.userId ?? "", tc, `Queued ${op}`);
        return { ok: true, data: { status: "awaiting_approval", approval_id: ap, tool_call_id: tc, action_summary: `Queued ${op}` } };
      }
      return { ok: true, data: { rows: [] } };
    },
  };
}

const PLAN_2 = JSON.stringify([{ title: "Add the dentist task", detail: "A task exists" }, { title: "Say what changed", detail: "" }]);
const createTask = (title: string): ModelTurn => ({ content: null, toolCalls: [toolCall("c1", "atlas_lists", { action: "create_task", title })], tokens: 5 });
const say = (text: string): ModelTurn => ({ content: text, toolCalls: [], tokens: 3 });
const noSleep = () => Promise.resolve();

describe("the plan", () => {
  test("the model's steps, capped, each still to do", () => {
    const p = parsePlan(`Here you go:\n[{"title":"Read"},{"step":"Write","detail":"a brief"},"Send it",{"x":1}]`, "Goal", 2, "t");
    expect(p.source).toBe("model");
    expect(p.steps).toEqual([
      { title: "Read", detail: "", status: "todo" },
      { title: "Write", detail: "a brief", status: "todo" },
    ]);
  });
  test("no usable answer makes the goal the one-step plan", () => {
    for (const answer of [null, "", "I cannot plan this", "[]", "[{}]"]) {
      const p = parsePlan(answer, "  Clear   the inbox  ", 5, "t");
      expect(p.source).toBe("goal");
      expect(p.steps).toEqual([{ title: "Clear the inbox", detail: "", status: "todo" }]);
    }
  });
});

describe("what a call leaves to undo", () => {
  const ok = (data: unknown): ControlResult => ({ ok: true, data });
  test("a created row is deleted", () => {
    const u = undoFor("tasks.create", { title: "Dentist" }, ok({ action: "created", row: { id: "t1", title: "Dentist" } }));
    expect(u).toEqual({ label: "Created the task “Dentist”", action: { kind: "delete", table: "user_tasks", id: "t1" } });
    expect(undoFor("events.create", { title: "Standup" }, ok({ action: "created", row: { id: "e1" } }))?.action)
      .toEqual({ kind: "delete", table: "user_events", id: "e1" });
  });
  test("an edit is put back from the row as it stood before", () => {
    const u = undoFor("tasks.update", { id: "t1", title: "New" }, ok({ action: "updated", changed: ["title"] }), { id: "t1", title: "Old", completed: 0 });
    expect(u?.action).toEqual({ kind: "restore", table: "user_tasks", id: "t1", values: { title: "Old" } });
    expect(undoFor("tasks.update", { id: "t1" }, ok({ action: "updated", changed: ["title"] }), null)?.action).toBeNull();
  });
  test("nothing changed means nothing to undo", () => {
    expect(undoFor("tasks.list", {}, ok({ rows: [] }))).toBeNull();
    expect(undoFor("tasks.create", { title: "x" }, { ok: false, error: { code: "invalid_args", message: "no", retryable: false } })).toBeNull();
    expect(undoFor("watchlist.add", { symbol: "AAPL" }, ok({ action: "unchanged", row: { symbol: "AAPL" } }))).toBeNull();
    // The Clock's "nothing is ringing" is a success that changed nothing.
    expect(undoFor("clock.stop_alarm", {}, ok({ done: false, changed_anything: false, message: "Nothing is ringing." }))).toBeNull();
  });
  test("music and the Clock say why they cannot be undone", () => {
    for (const op of ["music.play", "music.volume", "clock.set_alarm", "clock.snooze_alarm"]) {
      const u = undoFor(op, {}, ok({ ok: true })) as UndoRecord;
      expect(u.action).toBeNull();
      expect(u.reason?.length).toBeGreaterThan(10);
      expect(u.label).not.toBe(op);
    }
  });
  test("a queued call names its approval", () => {
    const u = undoFor("music.play", { uri: "x" }, ok({ status: "awaiting_approval", approval_id: "ap1", action_summary: "Play “Blue in Green”" }));
    expect(u).toMatchObject({ label: "Play “Blue in Green”", action: null, approval_id: "ap1" });
  });
});

describe("a run", () => {
  test("is planned before any step, then worked step by step with the run id on every call", async () => {
    const db = freshDb();
    addRun(db);
    const control = fakeControl(db);
    const model = scriptedModel(PLAN_2, [createTask("Dentist"), say("Added the dentist task."), say("One task was added.")]);
    const runner = createAgentRunner({ db, control, complete: model.complete, hasKey: () => true, sleep: noSleep, pollMs: 1 });
    await runner.executeRun("r1");

    expect(run(db).status).toBe("completed");
    const p = planOf(db);
    expect(p.source).toBe("model");
    expect(p.steps.map((s) => s.status)).toEqual(["done", "done"]);
    expect(p.steps[0].summary).toBe("Added the dentist task.");
    expect(p.steps[0].started_at && p.steps[0].finished_at).toBeTruthy();
    // The planner saw no tools; the steps saw the desktop ones.
    expect(model.seen[0].tools).toBe(0);
    expect(model.seen[1].tools).toBeGreaterThan(0);
    // Every call carried the run, as the background profile.
    expect(control.calls).toHaveLength(1);
    expect(control.calls[0].opts).toMatchObject({ runId: "r1", userId: USER, profile: "background" });
    // The call is a step with its inverse recorded.
    const steps = db.query(`SELECT kind, input_json, output_json FROM run_steps WHERE run_id = 'r1' ORDER BY step_index`).all() as Array<{ kind: string; input_json: string; output_json: string }>;
    expect(steps.map((s) => s.kind)).toEqual(["planning", "tool_call", "response", "response"]);
    expect(JSON.parse(steps[1].input_json)).toMatchObject({ plan_step: 0, op: "tasks.create" });
    expect(JSON.parse(steps[1].output_json).undo.action.kind).toBe("delete");
  });

  test("without an AI key it fails at once and says why", async () => {
    const db = freshDb();
    addRun(db);
    const runner = createAgentRunner({ db, complete: async () => null, hasKey: () => false, sleep: noSleep });
    await runner.executeRun("r1");
    expect(run(db)).toMatchObject({ status: "failed", error_message: "No AI key is configured." });
  });

  test("a run is claimed once", async () => {
    const db = freshDb();
    addRun(db, "r1", { status: "running" });
    const runner = createAgentRunner({ db, complete: async () => say("x"), hasKey: () => true, sleep: noSleep });
    await runner.executeRun("r1");
    expect(db.query(`SELECT COUNT(*) AS n FROM run_steps`).get()).toEqual({ n: 0 });
  });

  test("pause holds it between steps; resume carries on from the next step", async () => {
    const db = freshDb();
    addRun(db);
    let sleeps = 0;
    const box = {} as { runner: ReturnType<typeof createAgentRunner> };
    const model = scriptedModel(PLAN_2, [
      () => { expect(box.runner.pause("r1", USER)).toEqual({ ok: true }); return say("First step done."); },
      () => { expect(run(db).paused_at).toBeNull(); return say("Second step done."); },
    ]);
    box.runner = createAgentRunner({
      db, control: fakeControl(db), complete: model.complete, hasKey: () => true, pollMs: 1,
      sleep: async () => {
        sleeps++;
        // While it waits the run is paused and step two has not started.
        expect(run(db).paused_at).toBeTruthy();
        expect(planOf(db).steps.map((s) => s.status)).toEqual(["done", "todo"]);
        if (sleeps === 3) expect(box.runner.resume("r1", USER)).toEqual({ ok: true });
      },
    });
    await box.runner.executeRun("r1");
    expect(sleeps).toBe(3);
    expect(run(db).status).toBe("completed");
  });

  test("an unanswered approval of the run holds it; an expired one does not", async () => {
    const db = freshDb();
    addRun(db);
    let sleeps = 0;
    const model = scriptedModel(PLAN_2, [
      { content: null, toolCalls: [toolCall("m1", "atlas_music", { action: "play", uri: "spotify:track:1" })], tokens: 1 },
      say("Asked to start the music; it waits for you."),
      say("Done."),
    ]);
    const runner = createAgentRunner({
      db, control: fakeControl(db), complete: model.complete, hasKey: () => true, pollMs: 1,
      sleep: async () => {
        sleeps++;
        if (sleeps === 2) db.query(`UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
      },
    });
    await runner.executeRun("r1");
    const ap = db.query(`SELECT run_id, status FROM approvals`).get() as { run_id: string; status: string };
    expect(ap).toEqual({ run_id: "r1", status: "pending" });
    expect(sleeps).toBe(2);
    expect(run(db).status).toBe("completed");
  });

  test("stopped mid-step, it makes no further calls and the rest of the plan never starts", async () => {
    const db = freshDb();
    addRun(db);
    const control = fakeControl(db);
    const box = {} as { runner: ReturnType<typeof createAgentRunner> };
    const model = scriptedModel(PLAN_2, [
      async () => {
        await box.runner.stop("r1", USER, { undo: false });
        return createTask("After the stop");
      },
      say("Should not matter."),
    ]);
    box.runner = createAgentRunner({ db, control, complete: model.complete, hasKey: () => true, sleep: noSleep, pollMs: 1 });
    await box.runner.executeRun("r1");
    expect(run(db).status).toBe("cancelled");
    expect(control.calls).toHaveLength(0);
    expect(planOf(db).steps.map((s) => s.status)).toEqual(["stopped", "todo"]);
  });

  test("its agent deleted mid-step, the run ends without taking the brain down", async () => {
    const db = freshDb();
    addRun(db);
    const warn = console.warn;
    console.warn = () => {};
    try {
      // The cascade takes the run's row with it, so every write about the run
      // fails its foreign key — in the step, and again while closing the run.
      const model = scriptedModel(PLAN_2, [() => { db.query(`DELETE FROM agents WHERE id = 'a1'`).run(); return say("Done."); }]);
      const runner = createAgentRunner({ db, control: fakeControl(db), complete: model.complete, hasKey: () => true, sleep: noSleep, pollMs: 1 });
      await expect(runner.executeRun("r1")).resolves.toBeUndefined();

      // And through the loop, which holds the promise: it settles, and nothing is left rejecting.
      addRun(db, "r2", { agent: "a2" });
      const rejected: unknown[] = [];
      const onRejection = (e: unknown) => { rejected.push(e); };
      process.on("unhandledRejection", onRejection);
      const second = scriptedModel(PLAN_2, [() => { db.query(`DELETE FROM agents WHERE id = 'a2'`).run(); return say("Done."); }]);
      const loop = createAgentRunner({ db, control: fakeControl(db), complete: second.complete, hasKey: () => true, sleep: noSleep, pollMs: 1 });
      loop.tick();
      expect(loop.inFlight).toEqual(["r2"]);
      for (let i = 0; i < 50 && loop.inFlight.length; i++) await new Promise((r) => setTimeout(r, 1));
      process.off("unhandledRejection", onRejection);
      expect(loop.inFlight).toEqual([]);
      expect(rejected).toEqual([]);
      expect(db.query(`SELECT COUNT(*) AS n FROM runs`).get()).toEqual({ n: 0 });
    } finally {
      console.warn = warn;
    }
  });
});

describe("mail", () => {
  test("a run is not offered a mail change, and one it names anyway queues nothing", async () => {
    const db = freshDb();
    addRun(db);
    const control = fakeControl(db);
    const offered: string[] = [];
    let turn = 0;
    const runner = createAgentRunner({
      db, control, hasKey: () => true, sleep: noSleep, pollMs: 1,
      complete: async (_m, messages, tools) => {
        if (!tools.length && messages[0].content.includes("You plan work")) return { content: JSON.stringify([{ title: "Tidy the inbox" }]), toolCalls: [], tokens: 1 };
        for (const t of tools) {
          const action = (t.function.parameters as { properties?: { action?: { enum?: string[] } } }).properties?.action?.enum ?? [];
          for (const a of action) offered.push(`${t.function.name}.${a}`);
        }
        // A model can still guess an action it was never shown.
        if (turn++ === 0) return { content: null, toolCalls: [toolCall("m1", "atlas_mail", { action: "archive", thread_id: "th1" }), toolCall("m2", "atlas_mail", { action: "mark_read", thread_id: "th1" })], tokens: 1 };
        return say("Two threads can be archived; that is yours to do in Mail.");
      },
    });
    await runner.executeRun("r1");

    expect(offered).toContain("atlas_mail.list_threads");
    expect(offered).not.toContain("atlas_mail.archive");
    expect(offered).not.toContain("atlas_mail.mark_read");
    // Nothing reached the port, and no question waits that a yes could not answer.
    expect(control.calls.map((c) => c.op)).toEqual([]);
    expect(db.query(`SELECT COUNT(*) AS n FROM approvals`).get()).toEqual({ n: 0 });
    expect(run(db).status).toBe("completed");
    // The refusals are in the log.
    const refused = (db.query(`SELECT output_json FROM run_steps WHERE kind = 'tool_call'`).all() as Array<{ output_json: string }>).map((r) => JSON.parse(r.output_json));
    expect(refused).toHaveLength(2);
    for (const r of refused) expect(r).toMatchObject({ ok: false, error: expect.stringContaining("cannot archive mail") });
  });

  test("every op a run could be offered that needs the user's own credential is withheld", () => {
    // A run calls the port with no user token, and an approved call runs with
    // the token it was queued with (control/mod.rs approval_resolve), so any op
    // whose Rust side asks for one could only ever fail after a yes. Read off
    // the Rust source, so a new such op cannot reach a run unnoticed.
    const control = join(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/control");
    const registry = readFileSync(join(control, "registry.rs"), "utf8");
    const needsToken = new Set<string>();
    for (const m of registry.matchAll(/name:\s*"([^"]+)"[\s\S]*?run:\s*(ops_\w+)::(\w+)/g)) {
      const [, op, file, fn] = m;
      const src = readFileSync(join(control, `${file}.rs`), "utf8");
      const start = src.indexOf(`pub fn ${fn}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = src.slice(start, src.indexOf("\n}\n", start));
      if (/user_token\(ctx\)|ctx\.user_token/.test(body)) needsToken.add(op);
    }
    expect(needsToken.size).toBeGreaterThan(0);
    const reachable = new Set(atlasToolOpNames());
    for (const op of needsToken) if (reachable.has(op)) expect(RUN_WITHHELD_OPS.has(op)).toBe(true);
  });
});

describe("stop and undo", () => {
  test("takes back what the run did, newest first, and lists what it cannot", async () => {
    const db = freshDb();
    db.query(`INSERT INTO user_tasks (id, user_id, title) VALUES ('old', ?, 'Old title')`).run(USER);
    addRun(db);
    const control = fakeControl(db);
    const model = scriptedModel(PLAN_2, [
      createTask("Dentist"),
      say("Added it."),
      { content: null, toolCalls: [toolCall("u1", "atlas_lists", { action: "update_task", id: "old", title: "New title" })], tokens: 1 },
      say("Renamed the old task."),
    ]);
    const runner = createAgentRunner({ db, control, complete: model.complete, hasKey: () => true, sleep: noSleep, pollMs: 1 });
    await runner.executeRun("r1");
    expect(db.query(`SELECT COUNT(*) AS n FROM user_tasks`).get()).toEqual({ n: 2 });

    const res = await runner.stop("r1", USER, { undo: true });
    if (!res.ok) throw new Error(res.error);
    // It had already finished: nothing to stop, but the undo still runs.
    expect(res.stopped).toBe(false);
    expect(res.undo).toMatchObject({ failed: [], cannot: [] });
    const report = res.undo as Exclude<typeof res.undo, "after-step" | undefined>;
    expect(report.undone.map((u) => u.label)).toEqual(["Edited the task “New title”", "Created the task “Dentist”"]);
    // With what each wrote where, for the screens the Agent View tells (`db:changed`).
    expect(report.undone.map((u) => [u.table, u.kind])).toEqual([["user_tasks", "restore"], ["user_tasks", "delete"]]);
    const undoSteps = (db.query(`SELECT input_json FROM run_steps WHERE input_json LIKE '%undo_of%' ORDER BY step_index`).all() as Array<{ input_json: string }>).map((r) => JSON.parse(r.input_json));
    expect(undoSteps.map((i) => [i.table, i.kind])).toEqual([["user_tasks", "restore"], ["user_tasks", "delete"]]);
    expect(db.query(`SELECT id, title FROM user_tasks`).all()).toEqual([{ id: "old", title: "Old title" }]);

    // A second undo finds nothing left to do.
    const again = await runner.stop("r1", USER, { undo: true });
    expect(again.ok && again.undo).toEqual({ undone: [], failed: [], cannot: [] });
  });

  test("closes the run's open questions so they can never be approved later", async () => {
    const db = freshDb();
    addRun(db, "r1", { status: "running" });
    db.query(`INSERT INTO tool_calls (id, run_id, user_id, tool_name, status) VALUES ('tc1', 'r1', ?, 'mail.archive', 'awaiting_approval')`).run(USER);
    db.query(`INSERT INTO approvals (id, run_id, user_id, tool_call_id, action_summary) VALUES ('ap1', 'r1', ?, 'tc1', 'Archive')`).run(USER);
    db.query(`INSERT INTO tool_calls (id, user_id, tool_name, status) VALUES ('tc2', ?, 'mail.archive', 'awaiting_approval')`).run(USER);
    db.query(`INSERT INTO approvals (id, user_id, tool_call_id, action_summary) VALUES ('ap2', ?, 'tc2', 'Not this run')`).run(USER);
    const runner = createAgentRunner({ db, sleep: noSleep });
    const res = await runner.stop("r1", USER, { undo: false });
    expect(res).toEqual({ ok: true, stopped: true, approvalsClosed: 1 });
    expect(db.query(`SELECT id, status, approved_by FROM approvals ORDER BY id`).all()).toEqual([
      { id: "ap1", status: "rejected", approved_by: "system" },
      { id: "ap2", status: "pending", approved_by: null },
    ]);
    expect(db.query(`SELECT status FROM tool_calls WHERE id = 'tc1'`).get()).toEqual({ status: "rejected" });
    expect(run(db)).toMatchObject({ status: "cancelled", paused_at: null });
  });

  test("a queued call that was never approved is left out; one that ran cannot be undone", async () => {
    const db = freshDb();
    addRun(db, "r1", { status: "cancelled" });
    const record = (id: string, index: number, approval: string) =>
      db.query(`INSERT INTO run_steps (id, run_id, step_index, kind, input_json, output_json) VALUES (?, 'r1', ?, 'tool_call', '{}', ?)`)
        .run(id, index, JSON.stringify({ ok: true, undo: { label: `Archive ${approval}`, action: null, reason: "Ran outside.", approval_id: approval } }));
    db.query(`INSERT INTO tool_calls (id, run_id, user_id, tool_name) VALUES ('tc', 'r1', ?, 'mail.archive')`).run(USER);
    db.query(`INSERT INTO approvals (id, run_id, user_id, tool_call_id, action_summary, status) VALUES ('yes', 'r1', ?, 'tc', 'a', 'approved'), ('no', 'r1', ?, 'tc', 'b', 'rejected')`).run(USER, USER);
    record("s1", 0, "yes");
    record("s2", 1, "no");
    const report = createAgentRunner({ db, sleep: noSleep }).undoRun("r1", USER);
    expect(report.cannot).toEqual([{ stepId: "s1", label: "Archive yes", reason: "Ran outside." }]);
    expect(report.undone).toEqual([]);
  });

  test("another account's run cannot be paused, stopped or undone", async () => {
    const db = freshDb();
    addRun(db, "r1", { status: "running" });
    const runner = createAgentRunner({ db, sleep: noSleep });
    expect(runner.pause("r1", "someone-else")).toMatchObject({ ok: false, status: 404 });
    expect(await runner.stop("r1", "someone-else", { undo: true })).toMatchObject({ ok: false, status: 404 });
    expect(run(db).status).toBe("running");
  });

  test("only a live run can be paused or resumed", () => {
    const db = freshDb();
    addRun(db, "r1", { status: "completed" });
    const runner = createAgentRunner({ db, sleep: noSleep });
    expect(runner.pause("r1", USER)).toMatchObject({ ok: false, status: 409 });
    expect(runner.resume("r1", USER)).toMatchObject({ ok: false, status: 409 });
  });
});

describe("the loop", () => {
  test("a restarted brain closes the runs it left mid-way and old pending ones, and keeps fresh ones", () => {
    const db = freshDb();
    const old = new Date(Date.now() - STALE_PENDING_MS - 60_000).toISOString();
    addRun(db, "mid", { status: "running" });
    addRun(db, "old", { status: "pending", created_at: old });
    addRun(db, "new", { status: "pending" });
    const runner = createAgentRunner({ db, sleep: noSleep });
    expect(runner.recoverOrphans()).toBe(2);
    expect(run(db, "mid").status).toBe("failed");
    expect(run(db, "old").status).toBe("failed");
    expect(run(db, "new").status).toBe("pending");
  });

  test("works several pending runs at once, oldest first, up to its limit", async () => {
    const db = freshDb();
    for (let i = 0; i < MAX_PARALLEL_RUNS + 1; i++) addRun(db, `r${i}`, { created_at: `2026-10-28T09:0${i}:00.000Z` });
    const release: Array<() => void> = [];
    const runner = createAgentRunner({
      db, hasKey: () => true, sleep: noSleep,
      complete: () => new Promise((resolve) => release.push(() => resolve(say("ok")))),
    });
    runner.tick();
    expect(runner.inFlight).toEqual(["r0", "r1", "r2"]);
    runner.tick();
    expect(runner.inFlight).toHaveLength(MAX_PARALLEL_RUNS);
    expect(run(db, "r3").status).toBe("pending");
    // Let everything finish so no promise outlives the test.
    for (let i = 0; i < 40 && (runner.inFlight.length || release.length); i++) {
      while (release.length) release.shift()!();
      await new Promise((r) => setTimeout(r, 1));
      runner.tick();
    }
    expect(runner.inFlight).toEqual([]);
  });

  test("a paused run outlives the brain: the next one holds it paused, then resumes from the first step not started", async () => {
    const db = freshDb();
    addRun(db, "r1", { status: "running" });
    const left: RunPlan = {
      source: "model",
      written_at: "2026-10-28T09:00:00.000Z",
      steps: [
        { title: "Read the week", detail: "", status: "done", summary: "Three meetings, one free afternoon." },
        { title: "Add the dentist task", detail: "", status: "now", started_at: "2026-10-28T09:01:00.000Z" },
        { title: "Say what changed", detail: "", status: "todo" },
      ],
    };
    db.query(`UPDATE runs SET plan_json = ?, paused_at = '2026-10-28T09:01:30.000Z' WHERE id = 'r1'`).run(JSON.stringify(left));
    addRun(db, "gone", { status: "running" });

    const prompts: string[] = [];
    let sleeps = 0;
    const box = {} as { runner: ReturnType<typeof createAgentRunner> };
    box.runner = createAgentRunner({
      db, control: fakeControl(db), hasKey: () => true, pollMs: 1,
      complete: async (_m, messages) => { prompts.push(messages[0].content); return say("Told you what changed."); },
      sleep: async () => {
        sleeps++;
        // Held, still paused, and nothing is asked of the model while it waits.
        expect(run(db).paused_at).toBeTruthy();
        expect(prompts).toEqual([]);
        if (sleeps === 2) expect(box.runner.resume("r1", USER)).toEqual({ ok: true });
      },
    });
    // The sweep closes the run that was simply working, and leaves the paused one.
    expect(box.runner.recoverOrphans()).toBe(1);
    expect(run(db, "gone").status).toBe("failed");
    expect(run(db).status).toBe("running");
    expect(box.runner.adoptPaused()).toEqual(["r1"]);
    // The step in flight when the old brain went away is not run again.
    expect(planOf(db).steps.map((s) => s.status)).toEqual(["done", "stopped", "todo"]);

    for (let i = 0; i < 50 && box.runner.inFlight.length; i++) await new Promise((r) => setTimeout(r, 1));
    expect(box.runner.inFlight).toEqual([]);
    expect(sleeps).toBe(2);
    expect(run(db).status).toBe("completed");
    expect(planOf(db).steps.map((s) => s.status)).toEqual(["done", "stopped", "done"]);
    // Only the step not started was worked, and it was told what the first one found.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Three meetings, one free afternoon.");
  });

  test("a paused run whose plan cannot be read is closed, not held", () => {
    const db = freshDb();
    addRun(db, "r1", { status: "running" });
    db.query(`UPDATE runs SET plan_json = 'not a plan', paused_at = '2026-10-28T09:01:30.000Z' WHERE id = 'r1'`).run();
    const runner = createAgentRunner({ db, sleep: noSleep });
    expect(runner.recoverOrphans()).toBe(0);
    expect(runner.adoptPaused()).toEqual([]);
    expect(run(db)).toMatchObject({ status: "failed", paused_at: null });
    expect(readStoredPlan("not a plan")).toBeNull();
    expect(readStoredPlan(JSON.stringify({ steps: [{ title: "x", status: "exploded" }] }))?.steps[0].status).toBe("todo");
  });

  test("a run paused before it was picked up is not planned until resumed, and never goes stale", () => {
    const db = freshDb();
    const old = new Date(Date.now() - STALE_PENDING_MS - 60_000).toISOString();
    addRun(db, "r1", { status: "pending", created_at: old });
    let calls = 0;
    const runner = createAgentRunner({ db, hasKey: () => true, sleep: noSleep, complete: async () => { calls++; return null; } });
    expect(runner.pause("r1", USER)).toEqual({ ok: true });
    expect(runner.recoverOrphans()).toBe(0);
    runner.tick();
    expect(runner.inFlight).toEqual([]);
    expect(calls).toBe(0);
    expect(run(db).status).toBe("pending");
    expect(runner.resume("r1", USER)).toEqual({ ok: true });
    runner.tick();
    expect(runner.inFlight).toEqual(["r1"]);
  });

  test("a paused run holds no slot", async () => {
    const db = freshDb();
    for (let i = 0; i < MAX_PARALLEL_RUNS + 1; i++) addRun(db, `r${i}`, { created_at: `2026-10-28T09:0${i}:00.000Z` });
    const release: Array<() => void> = [];
    const runner = createAgentRunner({
      db, hasKey: () => true, sleep: noSleep,
      complete: () => new Promise((resolve) => release.push(() => resolve(say("ok")))),
    });
    runner.tick();
    expect(runner.inFlight).toEqual(["r0", "r1", "r2"]);
    expect(runner.pause("r0", USER)).toEqual({ ok: true });
    runner.tick();
    expect(runner.inFlight).toEqual(["r0", "r1", "r2", "r3"]);
    // Resume before draining, so the paused one is not left waiting forever.
    expect(runner.resume("r0", USER)).toEqual({ ok: true });
    for (let i = 0; i < 40 && (runner.inFlight.length || release.length); i++) {
      while (release.length) release.shift()!();
      await new Promise((r) => setTimeout(r, 1));
    }
    expect(runner.inFlight).toEqual([]);
  });

  test("a schedule's last run status follows its run", async () => {
    const db = freshDb();
    addRun(db);
    addRun(db, "r2", { status: "running" });
    db.query(`INSERT INTO schedules (id, user_id, agent_id, name, cron_expression, last_run_id, last_run_status) VALUES ('s1', ?, 'a1', 'Morning', '0 7 * * *', 'r1', 'pending'), ('s2', ?, 'a1', 'Evening', '0 19 * * *', 'r2', 'pending')`).run(USER, USER);
    const status = (id: string) => (db.query(`SELECT last_run_status AS s FROM schedules WHERE id = ?`).get(id) as { s: string }).s;
    const runner = createAgentRunner({ db, control: fakeControl(db), complete: scriptedModel(PLAN_2, [say("a"), say("b")]).complete, hasKey: () => true, sleep: noSleep, pollMs: 1 });
    runner.recoverOrphans();
    expect(status("s2")).toBe("failed");
    await runner.executeRun("r1");
    expect(status("s1")).toBe("completed");
    await runner.stop("r1", USER, { undo: false });
    expect(status("s1")).toBe("completed");
  });

  test("an older database gets the paused_at column", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT)`);
    ensureAgentRunSchema(db);
    ensureAgentRunSchema(db);
    const cols = (db.query(`PRAGMA table_info(runs)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(["id", "status", "paused_at"]);
    // And a database with no runs table yet is left alone.
    expect(() => ensureAgentRunSchema(new Database(":memory:"))).not.toThrow();
  });
});
