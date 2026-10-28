/**
 * The Agent View's controls (Beta redesign, left-out rows 85–88).
 *
 *   POST /admin/agent-runs/:id/pause          a run waits before its next step
 *   POST /admin/agent-runs/:id/resume         …and goes on from there
 *   POST /admin/agent-runs/:id/stop[?undo=1]  stop it; with undo, take back
 *                                             what it did, newest first
 *   POST /admin/agent-sessions/:id/stop       stop a session the brain tracks
 *
 * Runs are worked by the brain's own runner (agentRunner.ts), so pausing and
 * stopping one is a call into that runner. Sessions are other processes Atlas
 * watches, and each kind can be stopped only as far as Atlas has a hold on it:
 *
 *   ci-pipeline  `gh run cancel` asks GitHub to cancel the workflow run, with
 *                the same `gh` login the CI sync already uses. That request is
 *                the one thing here that leaves the Mac.
 *   autonomous   a self-repair runs in this process; its AbortController
 *                stops it between stages (selfRepair.ts, stopRepair).
 *   claude-code  refused. Atlas reads the session's transcript file and has no
 *                hold on the process writing it; the screen says to stop it
 *                where it runs instead of drawing a button that cannot work.
 *
 * Same auth as every brain route (`requireUser`, injected). The routes are
 * under /admin/ because only the admin Agent View calls them.
 */
import type { Database } from "bun:sqlite";
import type { AgentRunner } from "./agentRunner.ts";
import { markRepairStopped, repairRunning, stopRepair } from "./selfRepair.ts";

/** The repository the CI sync reads (adminRoutes.ts getCiRuns); cancels go to the same one. */
export const CI_REPO = "innovodevelop/atlas";

export interface SpawnResult { exitCode: number | null; stderr: string }
export type SpawnFn = (argv: string[]) => SpawnResult | Promise<SpawnResult>;

/**
 * How long `gh run cancel` may take. Under the webview's own 8 s limit on an
 * admin call (useAdminApi BRAIN_TIMEOUT_MS), so the screen hears the answer
 * rather than a timeout while GitHub goes on to cancel anyway.
 */
export const GH_CANCEL_TIMEOUT_MS = 7_000;

interface Deps {
  db: Database;
  runner: Pick<AgentRunner, "pause" | "resume" | "stop">;
  requireUser: (req: Request) => { userId: string };
  json: (body: unknown, status?: number) => Response;
  /** Runs `gh`; injected so the tests never reach GitHub. */
  spawn?: SpawnFn;
}

/** Ids reach SQL only as bound values, but a path segment that is not an id is refused outright. */
export function plausibleId(id: string | undefined): id is string {
  return typeof id === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(id);
}

/** The GitHub run id inside a CI session id (`ci-<databaseId>`, see getCiRuns), or null. */
export function ciRunId(sessionId: string): string | null {
  return /^ci-(\d{1,20})$/.exec(sessionId)?.[1] ?? null;
}

/**
 * Run `gh` without blocking the brain: a synchronous spawn would hold every
 * other request and the agent runner for as long as GitHub takes to answer.
 */
async function spawnLive(argv: string[]): Promise<SpawnResult> {
  try {
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), GH_CANCEL_TIMEOUT_MS);
    try {
      const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
      return { exitCode: proc.signalCode ? null : exitCode, stderr: proc.signalCode ? "gh did not answer in time." : stderr };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { exitCode: null, stderr: String(e) };
  }
}

export function createAgentRunHandlers({ db, runner, requireUser, json, spawn = spawnLive }: Deps) {
  return { pauseRun, resumeRun, stopRun, stopSession };

  function pauseRun(req: Request, runId: string | undefined): Response {
    const { userId } = requireUser(req);
    if (!plausibleId(runId)) return json({ error: "Not a run id." }, 400);
    const r = runner.pause(runId, userId);
    return r.ok ? json({ ok: true }) : json({ error: r.error }, r.status);
  }

  function resumeRun(req: Request, runId: string | undefined): Response {
    const { userId } = requireUser(req);
    if (!plausibleId(runId)) return json({ error: "Not a run id." }, 400);
    const r = runner.resume(runId, userId);
    return r.ok ? json({ ok: true }) : json({ error: r.error }, r.status);
  }

  async function stopRun(req: Request, runId: string | undefined, undo: boolean): Promise<Response> {
    const { userId } = requireUser(req);
    if (!plausibleId(runId)) return json({ error: "Not a run id." }, 400);
    const r = await runner.stop(runId, userId, { undo });
    return r.ok ? json(r) : json({ error: r.error }, r.status);
  }

  async function stopSession(req: Request, sessionId: string | undefined): Promise<Response> {
    requireUser(req);
    if (!plausibleId(sessionId)) return json({ error: "Not a session id." }, 400);
    const s = db.prepare(`SELECT id, session_type, status FROM atlas_agent_sessions WHERE id = ?`).get(sessionId) as
      | { id: string; session_type: string; status: string }
      | null;
    if (!s) return json({ error: "No such session." }, 404);
    if (s.status !== "active" && s.status !== "paused") return json({ error: "This session has already ended." }, 409);
    const at = new Date().toISOString();

    switch (s.session_type) {
      case "ci-pipeline": {
        const ghId = ciRunId(s.id);
        if (!ghId) return json({ error: "This session does not name a GitHub run, so there is nothing to cancel." }, 422);
        // Separate arguments, never a shell string; the id is digits only.
        const r = await spawn(["gh", "run", "cancel", ghId, "--repo", CI_REPO]);
        if (r.exitCode !== 0) return json({ error: `GitHub did not cancel the run: ${r.stderr.trim().slice(0, 300) || "gh failed"}` }, 502);
        db.prepare(`UPDATE atlas_agent_sessions SET status = 'cancelled', ended_at = COALESCE(ended_at, ?) WHERE id = ?`).run(at, s.id);
        return json({ ok: true, session_type: s.session_type, outcome: "cancel-requested" });
      }
      case "autonomous": {
        // A repair this process is not running (the brain restarted under it)
        // is already dead; marking it stopped is then the whole of the work.
        const wasRunning = repairRunning(s.id) && stopRepair(s.id);
        markRepairStopped(db, s.id);
        return json({ ok: true, session_type: s.session_type, outcome: wasRunning ? "stopped" : "closed" });
      }
      case "claude-code":
        return json({ error: "Atlas only reads this session's transcript; it has no hold on the process. Stop it in the terminal or app where it runs." }, 422);
      default:
        return json({ error: `Atlas cannot stop a ${s.session_type} session.` }, 422);
    }
  }
}
