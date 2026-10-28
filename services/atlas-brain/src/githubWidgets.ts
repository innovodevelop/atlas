/**
 * The admin Home's developer widgets — open pull requests, and the latest
 * releases and workflow runs (left-out features, row 18) — read from GitHub
 * through the Mac's own `gh` login, the same way planSync.ts reads the plan.
 *
 * Atlas stores no GitHub token. On a Mac without `gh`, or with `gh` signed
 * out, the routes answer `ok: false` with the problem in words, and the
 * widgets stay dormant and say what they need. What leaves the Mac: the gh
 * CLI's own requests to api.github.com for this one repo, nothing else.
 *
 * Answers are cached for a minute and concurrent callers share one fetch, so
 * a Home with both widgets on it, polling, costs a handful of GitHub calls an
 * hour rather than one per render.
 */

import { PLAN_REPO, ghBinary } from "./planSync.ts";

const COMMAND_TIMEOUT_MS = 20_000;
const CACHE_MS = 60_000;
const PULLS_LIMIT = 20;
const RUNS_LIMIT = 20;
const RELEASES_LIMIT = 5;

// ---------------------------------------------------------------------------
// Running gh (injectable for tests)
// ---------------------------------------------------------------------------

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type GhRunner = (argv: string[]) => Promise<GhResult>;

export const bunGhRunner: GhRunner = async (argv) => {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", timeout: COMMAND_TIMEOUT_MS });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (err) {
    // Spawning itself failed: the binary is not there.
    return { code: -1, stdout: "", stderr: String(err) };
  }
};

// ---------------------------------------------------------------------------
// What went wrong, in words
// ---------------------------------------------------------------------------

/** `missing` and `signed-out` are dormant states the user fixes; `unreachable` is a network or GitHub problem. */
export type GhProblem = "missing" | "signed-out" | "unreachable";

export function ghProblem(r: GhResult): { problem: GhProblem; message: string } {
  const err = r.stderr.trim();
  // -1 is the runner's own code for a spawn that failed: no gh binary to run.
  if (r.code === -1 || /ENOENT|executable file not found|command not found/i.test(err)) {
    return { problem: "missing", message: "The GitHub CLI (gh) is not installed on this Mac." };
  }
  if (/gh auth login|not logged in|authentication|HTTP 401|Bad credentials/i.test(err)) {
    return { problem: "signed-out", message: "The GitHub CLI is not signed in. Run `gh auth login` in Terminal." };
  }
  const first = err.split("\n").find((l) => l.trim()) ?? `gh exited with ${r.code}`;
  return { problem: "unreachable", message: `GitHub could not be reached: ${first.slice(0, 200)}` };
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/** The design's chip words: waiting for review, approved, changes asked for, draft. */
export type PullState = "review" | "approved" | "changes" | "draft";

export interface PullRow {
  number: number;
  title: string;
  url: string;
  state: PullState;
  author: string | null;
  head: string | null;
  base: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** The signed-in gh user is asked to review it. */
  askedYou: boolean;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** `gh pr list --json …` → rows. Fields are read one by one; anything malformed is dropped, never trusted whole. */
export function parsePulls(raw: unknown, viewer: string | null): PullRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: PullRow[] = [];
  for (const item of raw) {
    const p = rec(item);
    const number = typeof p.number === "number" ? p.number : null;
    const url = str(p.url);
    const title = str(p.title);
    if (number == null || !url || !title) continue;
    const decision = str(p.reviewDecision);
    const state: PullState = p.isDraft === true ? "draft"
      : decision === "APPROVED" ? "approved"
      : decision === "CHANGES_REQUESTED" ? "changes"
      : "review";
    const requests = Array.isArray(p.reviewRequests) ? p.reviewRequests.map(rec) : [];
    rows.push({
      number,
      title,
      url,
      state,
      author: str(rec(p.author).login),
      head: str(p.headRefName),
      base: str(p.baseRefName),
      createdAt: str(p.createdAt),
      updatedAt: str(p.updatedAt),
      askedYou: !!viewer && requests.some((r) => r.login === viewer),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Releases and workflow runs
// ---------------------------------------------------------------------------

export type RunState = "queued" | "running" | "passed" | "failed" | "cancelled" | "skipped";

export interface RunRow {
  id: number;
  workflow: string;
  title: string | null;
  branch: string | null;
  event: string | null;
  state: RunState;
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ReleaseRow {
  tag: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
  createdAt: string | null;
  url: string;
}

/** gh's status and conclusion as one word the face can colour. */
export function runState(status: string | null, conclusion: string | null): RunState {
  if (status !== "completed") return status === "in_progress" ? "running" : "queued";
  switch (conclusion) {
    case "success": return "passed";
    case "cancelled": return "cancelled";
    case "skipped":
    case "neutral": return "skipped";
    default: return "failed";
  }
}

/** `gh run list --json …` → rows, newest first as gh gives them. */
export function parseRuns(raw: unknown): RunRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: RunRow[] = [];
  for (const item of raw) {
    const r = rec(item);
    const id = typeof r.databaseId === "number" ? r.databaseId : null;
    const url = str(r.url);
    const workflow = str(r.workflowName) ?? str(r.name);
    if (id == null || !url || !workflow) continue;
    rows.push({
      id,
      workflow,
      title: str(r.displayTitle),
      branch: str(r.headBranch),
      event: str(r.event),
      state: runState(str(r.status), str(r.conclusion)),
      url,
      createdAt: str(r.createdAt),
      updatedAt: str(r.updatedAt),
    });
  }
  return rows;
}

/** `gh api repos/R/releases` → rows. Drafts are listed because the signed-in user can see them; the face says which is which. */
export function parseReleases(raw: unknown): ReleaseRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: ReleaseRow[] = [];
  for (const item of raw) {
    const r = rec(item);
    const tag = str(r.tag_name);
    const url = str(r.html_url);
    if (!tag || !url) continue;
    rows.push({
      tag,
      name: str(r.name),
      draft: r.draft === true,
      prerelease: r.prerelease === true,
      publishedAt: str(r.published_at),
      createdAt: str(r.created_at),
      url,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// The two reports
// ---------------------------------------------------------------------------

type Failure = { ok: false; repo: string; checkedAt: string; problem: GhProblem; message: string };

export type PullsReport =
  | { ok: true; repo: string; checkedAt: string; viewer: string | null; pulls: PullRow[] }
  | Failure;

export type DeploysReport =
  | { ok: true; repo: string; checkedAt: string; releases: ReleaseRow[]; runs: RunRow[] }
  | Failure;

interface Deps {
  run?: GhRunner;
  gh?: string;
  repo?: string;
  now?: () => Date;
  cacheMs?: number;
}

const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** A cached, de-duplicated fetch: one in flight at a time, the answer kept for `ms`. */
function cached<T>(ms: number, now: () => Date, fetch: () => Promise<T>): () => Promise<T> {
  let value: { at: number; data: T } | null = null;
  let inFlight: Promise<T> | null = null;
  return () => {
    const t = now().getTime();
    if (value && t - value.at < ms) return Promise.resolve(value.data);
    if (inFlight) return inFlight;
    inFlight = fetch()
      .then((data) => {
        value = { at: now().getTime(), data };
        return data;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

export function createGithubWidgets({ run = bunGhRunner, gh = ghBinary(), repo = PLAN_REPO, now = () => new Date(), cacheMs = CACHE_MS }: Deps = {}) {
  // Who `gh` is signed in as never changes while the brain runs; ask once,
  // and only after an answer (a failure is asked again next time).
  let viewer: string | null | undefined;
  const whoAmI = async (): Promise<string | null> => {
    if (viewer !== undefined) return viewer;
    const r = await run([gh, "api", "user", "--jq", ".login"]);
    if (r.code !== 0) return null;
    viewer = r.stdout.trim() || null;
    return viewer;
  };

  const fail = (r: GhResult): Failure => ({ ok: false, repo, checkedAt: now().toISOString(), ...ghProblem(r) });

  const pulls = cached<PullsReport>(cacheMs, now, async () => {
    const r = await run([gh, "pr", "list", "--repo", repo, "--state", "open", "--limit", String(PULLS_LIMIT),
      "--json", "number,title,url,isDraft,reviewDecision,author,headRefName,baseRefName,createdAt,updatedAt,reviewRequests"]);
    if (r.code !== 0) return fail(r);
    const who = await whoAmI();
    return { ok: true, repo, checkedAt: now().toISOString(), viewer: who, pulls: parsePulls(parseJson(r.stdout), who) };
  });

  const deploys = cached<DeploysReport>(cacheMs, now, async () => {
    const [runs, releases] = await Promise.all([
      run([gh, "run", "list", "--repo", repo, "--limit", String(RUNS_LIMIT),
        "--json", "databaseId,name,workflowName,displayTitle,status,conclusion,headBranch,event,createdAt,updatedAt,url"]),
      run([gh, "api", `repos/${repo}/releases?per_page=${RELEASES_LIMIT}`]),
    ]);
    if (runs.code !== 0) return fail(runs);
    // Releases are the lesser half: a repo the token cannot list releases
    // for still has runs worth showing.
    return {
      ok: true,
      repo,
      checkedAt: now().toISOString(),
      releases: releases.code === 0 ? parseReleases(parseJson(releases.stdout)) : [],
      runs: parseRuns(parseJson(runs.stdout)),
    };
  });

  return { pulls, deploys };
}
