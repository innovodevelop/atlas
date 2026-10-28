// The Agent View's controls (agentRoutes.ts): the run routes reach the
// runner, the session stop does what each kind of session allows and no
// more, and index.ts actually routes every handler (the defect
// adminRoutes.test.ts was written for, guarded here for the new table).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CI_REPO, ciRunId, createAgentRunHandlers, plausibleId, type SpawnFn } from "./agentRoutes.ts";
import { createAgentRunner } from "./agentRunner.ts";
import { executeRepair, repairRunning, stopRepair } from "./selfRepair.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, "../../../src-tauri/src/db_schema.sql"), "utf8");
const USER = "u-test";

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  db.query(`INSERT INTO agents (id, user_id, name, system_prompt) VALUES ('a1', ?, 'Helper', 'p')`).run(USER);
  return db;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const req = () => new Request("http://127.0.0.1/admin/x", { method: "POST" });

function handlers(db: Database, spawn?: SpawnFn) {
  const runner = createAgentRunner({ db, sleep: () => Promise.resolve() });
  return createAgentRunHandlers({ db, runner, requireUser: () => ({ userId: USER }), json, spawn });
}

function addSession(db: Database, id: string, type: string, status = "active") {
  db.query(`INSERT INTO atlas_agent_sessions (id, session_type, status, metadata) VALUES (?, ?, ?, '{}')`).run(id, type, status);
}
const sessionStatus = (db: Database, id: string) => (db.query(`SELECT status FROM atlas_agent_sessions WHERE id = ?`).get(id) as { status: string }).status;

describe("ids off the path", () => {
  test("only id-shaped segments pass", () => {
    expect(plausibleId("0f8f2a1e-6c9b-4e2a-9a1d-2b7c5e4f0a11")).toBe(true);
    expect(plausibleId("repair-lx2-ab12cd")).toBe(true);
    for (const bad of [undefined, "", "a b", "a;b", "../x", "x".repeat(81)]) expect(plausibleId(bad)).toBe(false);
  });
  test("a CI session names its GitHub run", () => {
    expect(ciRunId("ci-123456")).toBe("123456");
    expect(ciRunId("ci-12a")).toBeNull();
    expect(ciRunId("sess-1")).toBeNull();
  });
});

describe("run routes", () => {
  test("pause, resume and stop reach the runner", async () => {
    const db = freshDb();
    db.query(`INSERT INTO runs (id, user_id, agent_id, goal_text, status) VALUES ('r1', ?, 'a1', 'g', 'running')`).run(USER);
    const h = handlers(db);
    expect((await h.pauseRun(req(), "r1").json())).toEqual({ ok: true });
    expect((db.query(`SELECT paused_at FROM runs`).get() as { paused_at: string | null }).paused_at).toBeTruthy();
    expect((await h.resumeRun(req(), "r1").json())).toEqual({ ok: true });
    const stop = await h.stopRun(req(), "r1", true);
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ ok: true, stopped: true, approvalsClosed: 0, undo: { undone: [], failed: [], cannot: [] } });
  });
  test("an unknown or malformed run is refused with a status, not a crash", async () => {
    const h = handlers(freshDb());
    expect(h.pauseRun(req(), "nope").status).toBe(404);
    expect(h.pauseRun(req(), "a;b").status).toBe(400);
    expect((await h.stopRun(req(), undefined, false)).status).toBe(400);
  });
});

describe("stopping a session", () => {
  test("a CI run is cancelled on GitHub with separate arguments, then marked cancelled", async () => {
    const db = freshDb();
    addSession(db, "ci-987", "ci-pipeline");
    const argv: string[][] = [];
    const h = handlers(db, (a) => { argv.push(a); return { exitCode: 0, stderr: "" }; });
    const res = h.stopSession(req(), "ci-987");
    expect(await res.json()).toEqual({ ok: true, session_type: "ci-pipeline", outcome: "cancel-requested" });
    expect(argv).toEqual([["gh", "run", "cancel", "987", "--repo", CI_REPO]]);
    expect(sessionStatus(db, "ci-987")).toBe("cancelled");
  });
  test("when GitHub refuses, the session stays as it was and the error is passed on", async () => {
    const db = freshDb();
    addSession(db, "ci-5", "ci-pipeline");
    const h = handlers(db, () => ({ exitCode: 1, stderr: "run 5 is already completed" }));
    const res = h.stopSession(req(), "ci-5");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toContain("already completed");
    expect(sessionStatus(db, "ci-5")).toBe("active");
  });
  test("a Claude Code session is refused: Atlas only reads its transcript", async () => {
    const db = freshDb();
    addSession(db, "cc-1", "claude-code");
    const res = handlers(db, () => { throw new Error("must not spawn"); }).stopSession(req(), "cc-1");
    expect(res.status).toBe(422);
    expect(sessionStatus(db, "cc-1")).toBe("active");
  });
  test("an ended session cannot be stopped again", () => {
    const db = freshDb();
    addSession(db, "ci-1", "ci-pipeline", "completed");
    expect(handlers(db).stopSession(req(), "ci-1").status).toBe(409);
    expect(handlers(db).stopSession(req(), "missing").status).toBe(404);
  });
  test("a self-repair this process is not running is closed as stopped", async () => {
    const db = freshDb();
    addSession(db, "repair-x", "autonomous");
    const res = handlers(db).stopSession(req(), "repair-x");
    expect(await res.json()).toEqual({ ok: true, session_type: "autonomous", outcome: "closed" });
    expect(sessionStatus(db, "repair-x")).toBe("cancelled");
    const events = db.query(`SELECT payload FROM atlas_agent_events WHERE session_id = 'repair-x'`).all() as Array<{ payload: string }>;
    expect(events.map((e) => JSON.parse(e.payload).stage)).toEqual(["stopped"]);
  });
});

describe("a running self-repair", () => {
  test("stops after the model call in flight and never comes back to life", async () => {
    const db = freshDb();
    addSession(db, "repair-live", "autonomous");
    let calls = 0;
    const result = await executeRepair(
      { errorId: "e1", errorType: "TypeError", errorMessage: "x is undefined", stackTrace: null, context: null, severity: "high" },
      {
        db,
        sessionId: "repair-live",
        complete: async () => {
          calls++;
          expect(repairRunning("repair-live")).toBe(true);
          expect(stopRepair("repair-live")).toBe(true);
          return "ROOT CAUSE: x";
        },
        runTests: async () => { throw new Error("the test stage must not run"); },
      },
    );
    expect(calls).toBe(1);
    expect(result.status).toBe("rejected");
    expect(repairRunning("repair-live")).toBe(false);
    expect(sessionStatus(db, "repair-live")).toBe("cancelled");
    const meta = JSON.parse((db.query(`SELECT metadata FROM atlas_agent_sessions WHERE id = 'repair-live'`).get() as { metadata: string }).metadata);
    expect(meta).toMatchObject({ pipeline_status: "cancelled", pipeline_stage: "stopped" });
  });
});

describe("the route table", () => {
  const index = readFileSync(join(HERE, "index.ts"), "utf8");
  test("every handler is dispatched from index.ts, as POST, under /admin/", () => {
    for (const name of ["pauseRun", "resumeRun", "stopRun", "stopSession"]) {
      const line = index.split("\n").find((l) => l.includes(`agentRuns.${name}(`));
      expect(line, name).toBeDefined();
      expect(line).toContain('req.method === "POST"');
      expect(line).toContain('"/admin/');
    }
  });
  test("the runner is started unless switched off", () => {
    expect(index).toContain('if (process.env.ATLAS_AGENT_RUNNER !== "off") agentRunner.start();');
  });
});
