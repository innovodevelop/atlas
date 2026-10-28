// The test-run reports end to end on the brain side, against a real copy of
// the app schema: the brain creates its own atlas_test_reports table, and
// GET /admin/tests/runs hands each run back with its report parsed, or null.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdminHandlers } from "./adminRoutes.ts";
import { parseBunTest } from "./testReport.ts";

const SCHEMA = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/db_schema.sql"), "utf8");

function freshDb(): Database {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "atlas-testruns-")), "atlas.db"), { create: true });
  db.exec(SCHEMA);
  return db;
}

const requireUser = () => ({ userId: "u1", email: "u1@example.test", token: "t" });
const req = (path: string) => new Request(`http://brain${path}`);

test("each run comes back with its report, parsed; a run without one has null", async () => {
  const db = freshDb();
  const admin = createAdminHandlers({ db, requireUser });
  db.query(`INSERT INTO atlas_test_suites (id, name, ci_job) VALUES ('s1', 'a.test.ts', 'atlas-brain')`).run();
  db.query(`INSERT INTO atlas_test_runs (id, suite_id, status, run_at) VALUES ('r1', 's1', 'passed', '2026-10-28T10:00:00Z')`).run();
  db.query(`INSERT INTO atlas_test_runs (id, suite_id, status, run_at) VALUES ('r2', 's1', 'failed', '2026-10-28T11:00:00Z')`).run();
  const report = parseBunTest("a.test.ts:\n(pass) one [1.00ms]\n\n 1 pass\n 0 fail\nRan 1 test across 1 file. [5.00ms]");
  db.query(`INSERT INTO atlas_test_reports (run_id, job, report) VALUES ('r1', 'atlas-brain', ?)`).run(JSON.stringify(report));

  const rows = (await admin.getTestRuns(req("/admin/tests/runs")).json()) as Array<{ id: string; report: unknown }>;
  expect(rows.map((r) => r.id)).toEqual(["r2", "r1"]);
  expect(rows[0].report).toBeNull();
  expect(rows[1].report).toEqual(report);

  const one = (await admin.getTestRuns(req("/admin/tests/runs?suite_id=s1"), "s1").json()) as Array<{ report: unknown }>;
  expect(one).toHaveLength(2);
});

test("creating the handlers twice on one database is harmless", () => {
  const db = freshDb();
  createAdminHandlers({ db, requireUser });
  createAdminHandlers({ db, requireUser });
  const cols = db.query(`PRAGMA table_info(atlas_test_reports)`).all() as Array<{ name: string }>;
  expect(cols.map((c) => c.name)).toEqual(["run_id", "job", "report", "created_at"]);
});
