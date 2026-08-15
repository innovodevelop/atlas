/**
 * Admin routes — version tracking, agent sessions, design sync, tests.
 *
 * All routes are prefixed /admin/ and authenticate exactly like every other
 * brain route: each handler calls `requireUser`, which enforces SIDECAR_TOKEN
 * when configured and then requires a bearer account JWT. `requireUser` is
 * injected (like `db`) rather than imported, so this module owns no auth logic.
 *
 * These routes read and write the local SQLite DB directly, and they do NOT
 * emit `db:changed`: the brain opens atlas.db through bun:sqlite and therefore
 * bypasses the Rust `db_*` commands that emit that event. Nothing here reaches
 * the Tauri event bus, which is why the frontend has to poll to see changes.
 */

import { Database } from "bun:sqlite";
import { parseVersionPlan, type Version } from "./versionPlan.ts";
import { ingestJsonlSessions } from "./jsonlIngest.ts";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "path";

type Json = Record<string, unknown>;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const PROJECT_ROOT = resolve(import.meta.dir, "../../..");

export type ApplyResult =
  | { ok: true; synced: number; features: number }
  | { ok: false; error: string };

/**
 * Write a parsed plan into SQLite: upsert everything present, delete everything
 * absent. Exported and taking `db` + `versions` directly so the reconciliation
 * can be tested without a Request, a file on disk, or a running server —
 * `syncVersionPlan` is only the HTTP wrapper around it.
 *
 * THE EMPTY GUARD IS LOAD-BEARING, NOT DEFENSIVE. `parseVersionPlan` never
 * throws: a renamed heading, a changed dash character or a truncated file all
 * parse to `[]` silently. Feed that to the reconciliation below and
 * `versionSlots` is the empty string, giving `DELETE FROM atlas_versions WHERE
 * id NOT IN ()`. That is not a SQL error — verified against bun:sqlite, it
 * matches every row and empties the table. One bad edit to a markdown file
 * would destroy the entire version history, inside a transaction that commits
 * happily. Hence: refuse, and say why.
 */
export function applyVersionPlan(db: Database, versions: Version[]): ApplyResult {
  if (versions.length === 0) {
    return { ok: false, error: "VERSION-PLAN.md parsed to zero versions — refusing to reconcile" };
  }

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

    // Reconcile in the same transaction: VERSION-PLAN.md is the source of
    // truth, so a version or feature deleted from it must disappear here too.
    // Upsert alone only ever adds, which left removed rows in the DB forever.
    // The `?` lists below are built from array LENGTH only — no parsed value
    // is ever concatenated into SQL.
    const versionIds = versions.map((v) => v.id);
    const versionSlots = versionIds.map(() => "?").join(",");

    // Features of versions that vanished from the file. They do cascade from
    // atlas_versions, but only while PRAGMA foreign_keys is on; deleting them
    // explicitly makes reconciliation independent of that pragma.
    db.prepare(`DELETE FROM atlas_version_features WHERE version_id NOT IN (${versionSlots})`).run(...versionIds);

    // Features dropped from a version that still exists.
    for (const v of versions) {
      const featureIds = v.features.map((f) => f.id);
      if (featureIds.length === 0) {
        db.prepare(`DELETE FROM atlas_version_features WHERE version_id = ?`).run(v.id);
        continue;
      }
      const featureSlots = featureIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM atlas_version_features WHERE version_id = ? AND id NOT IN (${featureSlots})`)
        .run(v.id, ...featureIds);
    }

    db.prepare(`DELETE FROM atlas_versions WHERE id NOT IN (${versionSlots})`).run(...versionIds);
  });
  tx();

  return {
    ok: true,
    synced: versions.length,
    features: versions.reduce((n, v) => n + v.features.length, 0),
  };
}

interface Deps {
  db: Database;
  requireUser: (req: Request) => { userId: string; email: string; token: string };
}

/**
 * ci_job → the command that job actually runs. An allowlist of fixed argv
 * arrays, never a template: the job name comes out of the DB, and pasting it
 * into a shell string would turn atlas_test_suites into a command-injection
 * sink. Job names mirror the CI jobs in scripts/ci/run.sh; `edge-functions` is
 * deliberately absent because it needs deno plus a per-directory loop, which
 * has no single-command form to allowlist.
 */
const CI_JOBS: Record<string, { cwd: string; argv: string[] }> = {
  frontend: { cwd: PROJECT_ROOT, argv: ["bun", "run", "ci:quick"] },
  "atlas-brain": { cwd: resolve(PROJECT_ROOT, "services/atlas-brain"), argv: ["bunx", "tsc", "--noEmit"] },
  "voice-gateway": { cwd: resolve(PROJECT_ROOT, "services/voice-gateway"), argv: ["bunx", "tsc", "--noEmit"] },
  all: { cwd: PROJECT_ROOT, argv: ["bun", "run", "ci"] },
};

// Keep the stored log bounded — a full CI run prints far more than any panel
// shows, and atlas.db is the user's own database.
const OUTPUT_TAIL_CHARS = 20_000;

/**
 * major/minor/patch as numbers. The patch is optional because VERSION-PLAN.md
 * headings are free-form (`## v0.10 — …` parses as v0.10.0); anything with no
 * leading numeric version at all sorts last rather than being guessed at.
 */
function semverKey(semver: unknown): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(semver ?? ""));
  if (!m) return [Infinity, Infinity, Infinity];
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function compareSemver(a: unknown, b: unknown): number {
  const ka = semverKey(a);
  const kb = semverKey(b);
  for (let i = 0; i < 3; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  // Equal (or both unparseable) — fall back to the raw string so the order is
  // stable across calls.
  return String(a ?? "").localeCompare(String(b ?? ""));
}

export function createAdminHandlers({ db, requireUser }: Deps) {
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
    discoverTests,
    getDesignSyncs,
    ingestSessions,
    getCiRuns,
  };

  function syncVersionPlan(req: Request): Response {
    requireUser(req);
    const planPath = resolve(PROJECT_ROOT, "docs/VERSION-PLAN.md");
    let md: string;
    try {
      md = readFileSync(planPath, "utf8");
    } catch {
      return json({ error: "VERSION-PLAN.md not found" }, 404);
    }

    const result = applyVersionPlan(db, parseVersionPlan(md));
    if (!result.ok) return json({ error: result.error }, 422);
    return json({ synced: result.synced, features: result.features });
  }

  function getVersions(req: Request): Response {
    requireUser(req);
    // No ORDER BY here: `ORDER BY v.semver ASC` was a lexicographic sort, so
    // v0.10.0 came before v0.9.0 ("1" < "9"). SQLite has no semver type, so the
    // components are compared numerically after the query instead.
    const rows = db.query(`
      SELECT v.*,
        (SELECT COUNT(*) FROM atlas_version_features WHERE version_id = v.id) as feature_count,
        (SELECT COUNT(*) FROM atlas_version_features WHERE version_id = v.id AND status = 'done') as done_count
      FROM atlas_versions v
    `).all() as Array<Record<string, unknown>>;
    rows.sort((a, b) => compareSemver(a.semver, b.semver));
    return json(rows);
  }

  function getVersionDetail(req: Request, versionId: string): Response {
    requireUser(req);
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

  function getChangelog(req: Request, versionId?: string): Response {
    requireUser(req);
    const q = versionId
      ? db.query(`SELECT c.*, v.semver FROM atlas_changelog c LEFT JOIN atlas_versions v ON v.id = c.version_id WHERE c.version_id = ? ORDER BY c.created_at DESC`).all(versionId)
      : db.query(`SELECT c.*, v.semver FROM atlas_changelog c LEFT JOIN atlas_versions v ON v.id = c.version_id ORDER BY c.created_at DESC LIMIT 100`).all();
    return json(q);
  }

  function getAgentSessions(req: Request, status?: string): Response {
    requireUser(req);
    const q = status
      ? db.query(`SELECT * FROM atlas_agent_sessions WHERE status = ? ORDER BY started_at DESC LIMIT 50`).all(status)
      : db.query(`SELECT * FROM atlas_agent_sessions ORDER BY started_at DESC LIMIT 50`).all();
    return json(q);
  }

  function getAgentEvents(req: Request, sessionId: string): Response {
    requireUser(req);
    const rows = db.query(`
      SELECT * FROM atlas_agent_events WHERE session_id = ? ORDER BY ts DESC LIMIT 200
    `).all(sessionId);
    return json(rows);
  }

  function getTestSuites(req: Request): Response {
    requireUser(req);
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

  function getTestRuns(req: Request, suiteId?: string): Response {
    requireUser(req);
    const q = suiteId
      ? db.query(`SELECT * FROM atlas_test_runs WHERE suite_id = ? ORDER BY run_at DESC LIMIT 50`).all(suiteId)
      : db.query(`SELECT * FROM atlas_test_runs ORDER BY run_at DESC LIMIT 50`).all();
    return json(q);
  }

  function runTest(req: Request, suiteId: string): Response {
    requireUser(req);
    const suite = db.query(`SELECT * FROM atlas_test_suites WHERE id = ?`).get(suiteId) as { ci_job?: string; name: string } | null;
    if (!suite) return json({ error: "Suite not found" }, 404);

    const ciJob = suite.ci_job ?? "frontend";
    const job = CI_JOBS[ciJob];
    const runId = crypto.randomUUID();

    // An unrecognised ci_job is recorded as a failed run rather than quietly
    // running some other suite's command: a green tick for a command nobody
    // asked for is worse than a visible failure.
    if (!job) {
      const message = `Unknown ci_job "${ciJob}" — known jobs: ${Object.keys(CI_JOBS).join(", ")}`;
      db.query(`INSERT INTO atlas_test_runs (id, suite_id, status, triggered_by, error_message) VALUES (?, ?, 'failed', 'manual', ?)`)
        .run(runId, suiteId, message);
      return json({ runId, status: "failed", error: message }, 400);
    }

    db.query(`INSERT INTO atlas_test_runs (id, suite_id, status, triggered_by) VALUES (?, ?, 'running', 'manual')`).run(runId, suiteId);

    // Fire-and-forget the test execution. argv form with an explicit cwd — no
    // shell, so nothing that came out of the DB can be parsed as a command.
    const startMs = Date.now();
    void (async () => {
      try {
        const proc = Bun.spawn(job.argv, { cwd: job.cwd, stdout: "pipe", stderr: "pipe" });
        // Drain both pipes while the child runs. An unread pipe fills and then
        // blocks the child forever, which used to leave the run stuck at
        // 'running' for any job that prints more than a pipe buffer.
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        const durationMs = Date.now() - startMs;
        db.query(`UPDATE atlas_test_runs SET status = ?, duration_ms = ?, output = ? WHERE id = ?`)
          .run(code === 0 ? "passed" : "failed", durationMs, `${stdout}${stderr}`.slice(-OUTPUT_TAIL_CHARS), runId);
      } catch (err) {
        db.query(`UPDATE atlas_test_runs SET status = 'failed', duration_ms = ?, error_message = ? WHERE id = ?`)
          .run(Date.now() - startMs, String(err), runId);
      }
    })();

    return json({ runId, status: "running" });
  }

  /**
   * Discover test suites from the filesystem and upsert them into
   * atlas_test_suites — the row `runTest` later reads `ci_job` from to decide
   * what `Bun.spawn` runs. That makes this function just as security-relevant
   * as the CI_JOBS allowlist above, even though it never spawns anything
   * itself:
   *
   *   - `ci_job` is never taken from a file name, a file's contents, or
   *     anything else this function discovers. It is assigned from a fixed
   *     path → CI_JOBS-key mapping below, so every row this route can ever
   *     write already carries a `ci_job` that `runTest`'s own allowlist
   *     recognises. There is no path from "a file exists in the repo" to "an
   *     unrecognised or attacker-chosen ci_job lands in the DB" — even a
   *     malicious path would just fail the `service in CI_JOBS` check below
   *     and be skipped.
   *   - Suite ids are a deterministic slug of the discovered path (`discover:
   *     <path>`), not a random uuid, so re-running discovery upserts the same
   *     rows instead of accumulating duplicates for the same file forever.
   *   - Discovery only lists two directory shapes — `tests/*.{test,spec}.ts`
   *     and `services/<known-job>/src/*.test.ts` — one level deep, no
   *     recursion and no symlink following, and it never reads file
   *     contents. It cannot itself execute anything; that stays entirely
   *     inside `runTest`'s fixed argv arrays.
   */
  function discoverTests(req: Request): Response {
    requireUser(req);

    const discovered: Array<{ id: string; name: string; description: string; ci_job: string }> = [];

    // tests/ — repo-root specs. Everything here runs under the 'frontend' CI
    // job (bun run ci:quick) today, so that's the only ci_job this branch
    // can assign; there is no other job in CI_JOBS that covers this directory.
    const testsDir = resolve(PROJECT_ROOT, "tests");
    if (existsSync(testsDir)) {
      for (const entry of readdirSync(testsDir)) {
        if (!/\.(test|spec)\.tsx?$/.test(entry)) continue;
        discovered.push({
          id: `discover:tests/${entry}`,
          name: entry,
          description: `tests/${entry}`,
          ci_job: "frontend",
        });
      }
    }

    // services/*/src/*.test.ts — per-service unit tests. The service
    // directory name doubles as the ci_job, but only after confirming it's
    // already a CI_JOBS key: a future services/foo with no matching CI entry
    // is skipped rather than assigned a guessed-at job.
    const servicesDir = resolve(PROJECT_ROOT, "services");
    if (existsSync(servicesDir)) {
      for (const service of readdirSync(servicesDir)) {
        if (!(service in CI_JOBS)) continue;
        const srcDir = resolve(servicesDir, service, "src");
        if (!existsSync(srcDir)) continue;
        for (const entry of readdirSync(srcDir)) {
          if (!/\.test\.tsx?$/.test(entry)) continue;
          discovered.push({
            id: `discover:services/${service}/src/${entry}`,
            name: `${service}/${entry}`,
            description: `services/${service}/src/${entry}`,
            ci_job: service,
          });
        }
      }
    }

    const upsert = db.prepare(`
      INSERT INTO atlas_test_suites (id, name, description, ci_job)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        ci_job = excluded.ci_job
    `);
    const tx = db.transaction(() => {
      for (const d of discovered) upsert.run(d.id, d.name, d.description, d.ci_job);
    });
    tx();

    return json({ discovered: discovered.length });
  }

  function getDesignSyncs(req: Request): Response {
    requireUser(req);
    const rows = db.query(`SELECT * FROM atlas_design_syncs ORDER BY synced_at DESC LIMIT 20`).all();
    return json(rows);
  }

  function ingestSessions(req: Request): Response {
    requireUser(req);
    const result = ingestJsonlSessions(db);
    return json(result);
  }

  /**
   * CI pipeline monitoring — runs `gh run list` for the repo and upserts
   * results as ci-pipeline agent sessions. Uses the gh CLI (already
   * authenticated on this machine) rather than a raw API call, matching
   * the shell-out precedent in health/zip.rs.
   */
  function getCiRuns(req: Request): Response {
    requireUser(req);

    try {
      const proc = Bun.spawnSync(
        ["gh", "run", "list", "--repo", "innovodevelop/atlas", "--limit", "20", "--json", "databaseId,name,status,conclusion,headBranch,createdAt,updatedAt,url"],
        { stdout: "pipe", stderr: "pipe" },
      );

      if (proc.exitCode !== 0) {
        const stderr = new TextDecoder().decode(proc.stderr);
        return json({ error: `gh failed: ${stderr.slice(0, 300)}` }, 502);
      }

      const runs = JSON.parse(new TextDecoder().decode(proc.stdout)) as Array<{
        databaseId: number;
        name: string;
        status: string;
        conclusion: string | null;
        headBranch: string;
        createdAt: string;
        updatedAt: string;
        url: string;
      }>;

      // Upsert each run as a ci-pipeline session
      const upsert = db.prepare(`
        INSERT INTO atlas_agent_sessions (id, session_type, source_id, status, task_summary, started_at, ended_at, metadata)
        VALUES (?, 'ci-pipeline', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          task_summary = excluded.task_summary,
          ended_at = excluded.ended_at,
          metadata = excluded.metadata
      `);

      const tx = db.transaction(() => {
        for (const run of runs) {
          const status = run.status === "in_progress" ? "active"
            : run.conclusion === "success" ? "completed"
            : run.conclusion === "failure" ? "failed"
            : run.conclusion === "cancelled" ? "cancelled"
            : "completed";
          const ended = run.status === "completed" ? run.updatedAt : null;
          upsert.run(
            `ci-${run.databaseId}`,
            run.url,
            status,
            `${run.name} (${run.headBranch})`,
            run.createdAt,
            ended,
            JSON.stringify({ branch: run.headBranch, conclusion: run.conclusion }),
          );
        }
      });
      tx();

      return json({ synced: runs.length });
    } catch (err) {
      return json({ error: `CI fetch failed: ${String(err).slice(0, 300)}` }, 500);
    }
  }
}
