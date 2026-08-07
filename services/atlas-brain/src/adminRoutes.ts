/**
 * Admin routes — version tracking, agent sessions, design sync, tests.
 *
 * All routes are prefixed /admin/ and protected by the sidecar token (same as
 * every other brain route). They operate on the local SQLite DB and emit Tauri
 * events for live UI updates.
 */

import { Database } from "bun:sqlite";
import { parseVersionPlan } from "./versionPlan.ts";
import { resolve } from "path";

type Json = Record<string, unknown>;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

export function createAdminHandlers(db: Database) {
  return {
    syncVersionPlan,
    getVersions,
    getVersionDetail,
    getChangelog,
    getAgentSessions,
    getAgentEvents,
    getTestSuites,
    getTestRuns,
    runTest,
    getDesignSyncs,
  };

  function syncVersionPlan(): Response {
    const planPath = resolve(PROJECT_ROOT, "docs/VERSION-PLAN.md");
    let md: string;
    try {
      md = require("fs").readFileSync(planPath, "utf8");
    } catch {
      return json({ error: "VERSION-PLAN.md not found" }, 404);
    }

    const versions = parseVersionPlan(md);
    const upsertVersion = db.prepare(`
      INSERT INTO atlas_versions (id, semver, codename, status, target_date)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        semver = excluded.semver,
        codename = excluded.codename,
        status = excluded.status,
        target_date = excluded.target_date
    `);
    const upsertFeature = db.prepare(`
      INSERT INTO atlas_version_features (id, version_id, title, status, assigned_agent, design_ref, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        assigned_agent = excluded.assigned_agent,
        design_ref = excluded.design_ref,
        priority = excluded.priority
    `);

    const tx = db.transaction(() => {
      for (const v of versions) {
        upsertVersion.run(v.id, v.semver, v.codename, v.status, v.target_date ?? null);
        for (let i = 0; i < v.features.length; i++) {
          const f = v.features[i];
          upsertFeature.run(f.id, v.id, f.title, f.status, f.agent ?? null, f.design ?? null, i + 1);
        }
      }
    });
    tx();

    return json({ synced: versions.length, features: versions.reduce((n, v) => n + v.features.length, 0) });
  }

  function getVersions(): Response {
    const rows = db.query(`
      SELECT v.*,
        (SELECT COUNT(*) FROM atlas_version_features WHERE version_id = v.id) as feature_count,
        (SELECT COUNT(*) FROM atlas_version_features WHERE version_id = v.id AND status = 'done') as done_count
      FROM atlas_versions v
      ORDER BY v.semver ASC
    `).all();
    return json(rows);
  }

  function getVersionDetail(versionId: string): Response {
    const version = db.query(`SELECT * FROM atlas_versions WHERE id = ?`).get(versionId);
    if (!version) return json({ error: "Version not found" }, 404);
    const features = db.query(`
      SELECT * FROM atlas_version_features WHERE version_id = ? ORDER BY priority ASC
    `).all(versionId);
    const changelog = db.query(`
      SELECT * FROM atlas_changelog WHERE version_id = ? ORDER BY created_at DESC
    `).all(versionId);
    const agents = db.query(`
      SELECT * FROM atlas_agent_sessions WHERE version_id = ? ORDER BY started_at DESC LIMIT 20
    `).all(versionId);
    return json({ ...version as object, features, changelog, agents });
  }

  function getChangelog(versionId?: string): Response {
    const q = versionId
      ? db.query(`SELECT c.*, v.semver FROM atlas_changelog c LEFT JOIN atlas_versions v ON v.id = c.version_id WHERE c.version_id = ? ORDER BY c.created_at DESC`).all(versionId)
      : db.query(`SELECT c.*, v.semver FROM atlas_changelog c LEFT JOIN atlas_versions v ON v.id = c.version_id ORDER BY c.created_at DESC LIMIT 100`).all();
    return json(q);
  }

  function getAgentSessions(status?: string): Response {
    const q = status
      ? db.query(`SELECT * FROM atlas_agent_sessions WHERE status = ? ORDER BY started_at DESC LIMIT 50`).all(status)
      : db.query(`SELECT * FROM atlas_agent_sessions ORDER BY started_at DESC LIMIT 50`).all();
    return json(q);
  }

  function getAgentEvents(sessionId: string): Response {
    const rows = db.query(`
      SELECT * FROM atlas_agent_events WHERE session_id = ? ORDER BY ts DESC LIMIT 200
    `).all(sessionId);
    return json(rows);
  }

  function getTestSuites(): Response {
    const rows = db.query(`
      SELECT s.*,
        (SELECT COUNT(*) FROM atlas_test_runs WHERE suite_id = s.id) as total_runs,
        (SELECT status FROM atlas_test_runs WHERE suite_id = s.id ORDER BY run_at DESC LIMIT 1) as last_status,
        (SELECT run_at FROM atlas_test_runs WHERE suite_id = s.id ORDER BY run_at DESC LIMIT 1) as last_run_at
      FROM atlas_test_suites s
      ORDER BY s.name ASC
    `).all();
    return json(rows);
  }

  function getTestRuns(suiteId?: string): Response {
    const q = suiteId
      ? db.query(`SELECT * FROM atlas_test_runs WHERE suite_id = ? ORDER BY run_at DESC LIMIT 50`).all(suiteId)
      : db.query(`SELECT * FROM atlas_test_runs ORDER BY run_at DESC LIMIT 50`).all();
    return json(q);
  }

  function runTest(suiteId: string): Response {
    const suite = db.query(`SELECT * FROM atlas_test_suites WHERE id = ?`).get(suiteId) as { ci_job?: string; name: string } | null;
    if (!suite) return json({ error: "Suite not found" }, 404);

    const runId = crypto.randomUUID();
    db.query(`INSERT INTO atlas_test_runs (id, suite_id, status, triggered_by) VALUES (?, ?, 'running', 'manual')`).run(runId, suiteId);

    // Fire-and-forget the test execution
    const ciJob = suite.ci_job ?? "frontend";
    const startMs = Date.now();
    Bun.spawn(["bash", "-c", `cd "${PROJECT_ROOT}" && bun run ci:quick 2>&1`], {
      stdout: "pipe",
      stderr: "pipe",
    }).exited.then((code) => {
      const durationMs = Date.now() - startMs;
      const status = code === 0 ? "passed" : "failed";
      db.query(`UPDATE atlas_test_runs SET status = ?, duration_ms = ? WHERE id = ?`).run(status, durationMs, runId);
    }).catch((err) => {
      db.query(`UPDATE atlas_test_runs SET status = 'failed', error_message = ? WHERE id = ?`).run(String(err), runId);
    });

    return json({ runId, status: "running" });
  }

  function getDesignSyncs(): Response {
    const rows = db.query(`SELECT * FROM atlas_design_syncs ORDER BY synced_at DESC LIMIT 20`).all();
    return json(rows);
  }
}
