/**
 * Roadmap sync — keeps /versions in step with GitHub, and says how far each
 * copy of the code has caught up.
 *
 * GitHub is the source of truth for docs/VERSION-PLAN.md. Every
 * PLAN_SYNC_INTERVAL_MS while the brain runs, this reads the plan at the last
 * commit that changed it on PLAN_REF and reconciles atlas.db from it (only when
 * the content changed). Alongside that it answers, for the same plan commit:
 *
 *  - local checkout: does the git checkout on this Mac contain that commit,
 *    and how many commits is it behind PLAN_REF?
 *  - app build: does the running app's build commit contain it?
 *
 * and lists the features whose GitHub state isn't in the local plan file yet
 * ("on GitHub only"), so the page can tell a roadmap change that is merged from
 * one this Mac has actually pulled and built.
 *
 * Everything goes through the developer's `gh` login and local `git`; Atlas
 * stores no GitHub token. On a Mac without `gh` (any consumer install) the
 * check reports github.ok = false and the plan falls back to the local file.
 * Nothing here runs `git fetch` or touches the working tree: a commit missing
 * from the checkout simply counts as "not in the checkout".
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseVersionPlan, type Version } from "./versionPlan.ts";

export const PLAN_REPO = process.env.ATLAS_PLAN_REPO ?? "innovodevelop/atlas";
export const PLAN_REF = process.env.ATLAS_PLAN_REF ?? "atlas-redesign";
export const PLAN_PATH = "docs/VERSION-PLAN.md";
export const PLAN_SYNC_INTERVAL_MS = 5 * 60_000;
/** A status younger than this is served from cache instead of re-checked. */
const STATUS_FRESH_MS = 60_000;
const COMMAND_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlanCommit {
  sha: string;
  date: string | null;
  message: string | null;
}

export interface GithubOnlyFeature {
  id: string;
  title: string;
  github: string;
  /** The feature's status in the local plan file, or null if it isn't there. */
  local: string | null;
}

export interface Inclusion {
  /** null when it couldn't be determined (offline, commit unknown to GitHub). */
  containsPlan: boolean | null;
  /** Commits on PLAN_REF this copy doesn't have, when known. */
  behindBy: number | null;
}

export interface PlanSyncStatus {
  checkedAt: string;
  repo: string;
  ref: string;
  github: {
    ok: boolean;
    error: string | null;
    headSha: string | null;
    plan: PlanCommit | null;
    /** True when this check changed atlas.db. */
    applied: boolean;
  };
  local: Inclusion & {
    path: string | null;
    headSha: string | null;
    branch: string | null;
    /** The plan file has uncommitted edits in the checkout. */
    planDirty: boolean;
    error: string | null;
  };
  app: Inclusion & { buildSha: string | null };
  githubOnly: GithubOnlyFeature[];
  /** Where atlas.db's plan came from on the last apply. */
  source: "github" | "local" | null;
}

// ---------------------------------------------------------------------------
// Command runner (injectable for tests)
// ---------------------------------------------------------------------------

export interface RunResult {
  code: number;
  stdout: string;
}
export type Runner = (argv: string[], cwd?: string) => Promise<RunResult>;

export const bunRunner: Runner = async (argv, cwd) => {
  try {
    const proc = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      timeout: COMMAND_TIMEOUT_MS,
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout };
  } catch {
    return { code: -1, stdout: "" };
  }
};

/**
 * An app launched from Finder gets launchd's PATH (/usr/bin:/bin:…), which
 * has no Homebrew, so a bare "gh" isn't found even when it's installed. A gh
 * unpacked by hand (this Mac's lives in ~/bin) is just as invisible, so the
 * two usual per-user folders are looked in after Homebrew's.
 */
export function ghBinary(exists: (p: string) => boolean = existsSync): string {
  for (const p of ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", join(homedir(), "bin", "gh"), join(homedir(), ".local", "bin", "gh")]) {
    if (exists(p)) return p;
  }
  return "gh";
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const SHA = /^[0-9a-f]{7,40}$/;

/**
 * Features whose state on GitHub isn't what the local plan file says: new on
 * GitHub, or a different status or title. Without a local plan every feature
 * is GitHub-only. Features only in the local file (unpushed edits) are not
 * listed; planDirty / the checkout being ahead covers that.
 */
export function diffPlans(github: Version[], local: Version[] | null): GithubOnlyFeature[] {
  const localFeatures = new Map<string, { status: string; title: string }>();
  for (const v of local ?? []) for (const f of v.features) localFeatures.set(f.id, f);
  const out: GithubOnlyFeature[] = [];
  for (const v of github) {
    for (const f of v.features) {
      const l = localFeatures.get(f.id);
      if (!l || l.status !== f.status || l.title !== f.title) {
        out.push({ id: f.id, title: f.title, github: f.status, local: l?.status ?? null });
      }
    }
  }
  return out;
}

/**
 * GitHub's compare of plan...X: X contains the plan commit when X is the same
 * commit or ahead of it.
 */
export function containsFromCompare(status: string | undefined): boolean | null {
  if (status === "identical" || status === "ahead") return true;
  if (status === "behind" || status === "diverged") return false;
  return null;
}

/** A content fingerprint, so an unchanged plan isn't re-applied every tick. */
function fingerprint(md: string): string {
  return String(Bun.hash(md));
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

interface GhCommit {
  sha?: string;
  commit?: { message?: string; committer?: { date?: string } };
}

interface Deps {
  db: Database;
  apply: (db: Database, versions: Version[]) => { ok: boolean; error?: string };
  run?: Runner;
  gh?: string;
  /** Directories to try for the local checkout, in order. */
  repoCandidates?: string[];
  now?: () => Date;
}

/** Where the git checkout of PLAN_REPO might be on this Mac. */
export function defaultRepoCandidates(projectRoot: string): string[] {
  const home = homedir();
  const fromEnv = process.env.ATLAS_REPO_DIR;
  return [
    ...(fromEnv ? [fromEnv] : []),
    projectRoot,
    ...["atlas", "Developer/atlas", "Projects/atlas", "code/atlas", "Code/atlas", "src/atlas",
      "GitHub/atlas", "Documents/atlas", "Desktop/atlas", "innovodevelop/atlas"].map((d) => join(home, d)),
  ];
}

export function createPlanSync({ db, apply, run = bunRunner, gh = ghBinary(), repoCandidates = [], now = () => new Date() }: Deps) {
  let lastApplied: string | null = null;
  let source: PlanSyncStatus["source"] = null;
  let cached: { status: PlanSyncStatus; at: number } | null = null;
  let inFlight: Promise<PlanSyncStatus> | null = null;
  let repoDir: string | null | undefined;
  // Compares of two fixed SHAs never change.
  const compareCache = new Map<string, { status?: string; ahead_by?: number }>();

  // Typed loosely on purpose: these are GitHub's REST shapes, read field by
  // field below with optional chaining, never trusted whole.
  const ghJson = async <T>(path: string): Promise<T | null> => {
    const r = await run([gh, "api", path]);
    if (r.code !== 0) return null;
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      return null;
    }
  };

  const compare = async (base: string, head: string) => {
    const key = `${base}...${head}`;
    if (compareCache.has(key)) return compareCache.get(key)!;
    const c = await ghJson<{ status?: string; ahead_by?: number }>(`repos/${PLAN_REPO}/compare/${key}?per_page=1`);
    // Only cache an answer; a failure (offline, unknown SHA) is retried later.
    const result = c ? { status: c.status, ahead_by: c.ahead_by } : {};
    if (c) compareCache.set(key, result);
    return result;
  };

  const git = (args: string[]) => run(["git", ...args], repoDir ?? undefined);

  async function findRepo(): Promise<string | null> {
    if (repoDir !== undefined) return repoDir;
    for (const dir of repoCandidates) {
      if (!existsSync(join(dir, ".git")) || !existsSync(join(dir, PLAN_PATH))) continue;
      const remote = await run(["git", "remote", "get-url", "origin"], dir);
      if (remote.code === 0 && remote.stdout.includes(PLAN_REPO)) {
        repoDir = resolve(dir);
        return repoDir;
      }
    }
    repoDir = null;
    return null;
  }

  async function check(buildSha: string | null): Promise<PlanSyncStatus> {
    const status: PlanSyncStatus = {
      checkedAt: now().toISOString(),
      repo: PLAN_REPO,
      ref: PLAN_REF,
      github: { ok: false, error: null, headSha: null, plan: null, applied: false },
      local: { path: null, headSha: null, branch: null, planDirty: false, containsPlan: null, behindBy: null, error: null },
      app: { buildSha: buildSha && SHA.test(buildSha) ? buildSha : null, containsPlan: null, behindBy: null },
      githubOnly: [],
      source,
    };

    // --- GitHub -----------------------------------------------------------
    let githubPlan: Version[] | null = null;
    const branch = await ghJson<{ commit?: { sha?: string } }>(`repos/${PLAN_REPO}/branches/${encodeURIComponent(PLAN_REF)}`);
    const commits = branch
      ? await ghJson<GhCommit[]>(`repos/${PLAN_REPO}/commits?sha=${encodeURIComponent(PLAN_REF)}&path=${PLAN_PATH}&per_page=1`)
      : null;
    const planCommit = Array.isArray(commits) ? commits[0] : null;
    if (!branch || !planCommit?.sha) {
      status.github.error = branch
        ? `No commit on ${PLAN_REF} touches ${PLAN_PATH}.`
        : "GitHub unreachable through gh (not installed, signed out, or offline).";
    } else {
      status.github.headSha = branch.commit?.sha ?? null;
      status.github.plan = {
        sha: planCommit.sha,
        date: planCommit.commit?.committer?.date ?? null,
        message: (planCommit.commit?.message ?? "").split("\n")[0] || null,
      };
      // Read the plan AT that commit, so the content and the SHA agree.
      const raw = await run([gh, "api", "-H", "Accept: application/vnd.github.raw",
        `repos/${PLAN_REPO}/contents/${PLAN_PATH}?ref=${planCommit.sha}`]);
      if (raw.code === 0 && raw.stdout.trim()) {
        githubPlan = parseVersionPlan(raw.stdout);
        status.github.ok = true;
        const fp = fingerprint(raw.stdout);
        if (fp !== lastApplied) {
          const r = apply(db, githubPlan);
          if (r.ok) {
            lastApplied = fp;
            source = "github";
            status.github.applied = true;
          } else {
            status.github.error = r.error ?? "The plan on GitHub could not be applied.";
          }
        }
      } else {
        status.github.error = `Could not read ${PLAN_PATH} at ${planCommit.sha.slice(0, 7)}.`;
      }
    }

    // --- Local checkout ---------------------------------------------------
    let localPlan: Version[] | null = null;
    const dir = await findRepo();
    if (!dir) {
      status.local.error = "No git checkout of the repo found on this Mac (set ATLAS_REPO_DIR).";
    } else {
      status.local.path = dir;
      const head = await git(["rev-parse", "HEAD"]);
      status.local.headSha = head.code === 0 ? head.stdout.trim() : null;
      const br = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
      status.local.branch = br.code === 0 ? br.stdout.trim() : null;
      const dirty = await git(["status", "--porcelain", "--", PLAN_PATH]);
      status.local.planDirty = dirty.code === 0 && dirty.stdout.trim() !== "";
      try {
        const md = readFileSync(join(dir, PLAN_PATH), "utf8");
        localPlan = parseVersionPlan(md);
        // Without GitHub, the checkout's plan is the best there is.
        if (!status.github.ok) {
          const fp = fingerprint(md);
          if (fp !== lastApplied && apply(db, localPlan).ok) {
            lastApplied = fp;
            source = "local";
          }
        }
      } catch {
        status.local.error = `${PLAN_PATH} is missing from the checkout.`;
      }
      const planSha = status.github.plan?.sha;
      if (planSha) {
        // 0: contained. 1: not an ancestor. 128: the commit isn't in this
        // checkout's object store at all (never fetched), which also means no.
        const anc = await git(["merge-base", "--is-ancestor", planSha, "HEAD"]);
        status.local.containsPlan = anc.code === 0 ? true : anc.code === 1 || anc.code === 128 ? false : null;
      }
      if (status.local.headSha && status.github.headSha) {
        // 404s when HEAD has unpushed commits; behindBy then stays unknown.
        const c = await compare(status.local.headSha, status.github.headSha);
        status.local.behindBy = typeof c.ahead_by === "number" ? c.ahead_by : null;
      }
    }

    // --- Running app build -------------------------------------------------
    const build = status.app.buildSha;
    if (build && status.github.plan) {
      status.app.containsPlan = containsFromCompare((await compare(status.github.plan.sha, build)).status);
      if (status.github.headSha) {
        const c = await compare(build, status.github.headSha);
        status.app.behindBy = typeof c.ahead_by === "number" ? c.ahead_by : null;
      }
    }

    status.source = source;
    if (githubPlan) status.githubOnly = diffPlans(githubPlan, localPlan);
    return status;
  }

  /** Run a check, sharing one in flight between concurrent callers. */
  function sync(buildSha: string | null = null): Promise<PlanSyncStatus> {
    if (!inFlight) {
      inFlight = check(buildSha)
        .then((s) => {
          cached = { status: s, at: Date.now() };
          return s;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  }

  /** The latest status, re-checked when stale or for a different app build. */
  async function status(buildSha: string | null): Promise<PlanSyncStatus> {
    if (cached && Date.now() - cached.at < STATUS_FRESH_MS && cached.status.app.buildSha === buildSha) {
      return cached.status;
    }
    return sync(buildSha);
  }

  /** Background loop while the brain runs. Returns a stop function. */
  function start(intervalMs = PLAN_SYNC_INTERVAL_MS, firstDelayMs = 20_000): () => void {
    const tick = () => {
      // Keep the build the page last reported, so the cached status stays
      // complete between page visits.
      sync(cached?.status.app.buildSha ?? null).catch((e) => console.error("[plan-sync]", e));
    };
    const first = setTimeout(tick, firstDelayMs);
    const every = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }

  return { sync, status, start };
}
