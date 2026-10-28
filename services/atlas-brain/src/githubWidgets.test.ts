// The developer widgets' GitHub reads, against what gh 2.86 really returned
// for innovodevelop/atlas on 2026-10-28 (abridged), with gh itself faked.
import { describe, expect, test } from "bun:test";
import { createGithubWidgets, ghProblem, parsePulls, parseReleases, parseRuns, runState, type GhResult, type GhRunner } from "./githubWidgets.ts";

const PR_LIST = JSON.stringify([
  { author: { id: "U_kgDOBrGpLg", is_bot: false, login: "innovodevelop", name: "Magnus Pilegaard" }, baseRefName: "atlas-redesign", createdAt: "2026-10-27T19:45:07Z", headRefName: "ws-beta-redesign", isDraft: false, number: 6, reviewDecision: "", reviewRequests: [], title: "Beta redesign, phase 1: the shell (tokens, veil sphere, icons, top bar, dock, Talk to Atlas, transitions)", updatedAt: "2026-10-28T15:42:50Z", url: "https://github.com/innovodevelop/atlas/pull/6" },
  { author: { login: "someone" }, baseRefName: "atlas-redesign", headRefName: "mail-audit", isDraft: false, number: 7, reviewDecision: "APPROVED", reviewRequests: [], title: "Mail audit trail", url: "https://github.com/innovodevelop/atlas/pull/7" },
  { author: { login: "someone" }, headRefName: "dock-nav", isDraft: true, number: 8, reviewDecision: "REVIEW_REQUIRED", reviewRequests: [{ __typename: "User", login: "innovodevelop" }], title: "Dock nav", url: "https://github.com/innovodevelop/atlas/pull/8" },
  { author: { login: "someone" }, isDraft: false, number: 9, reviewDecision: "CHANGES_REQUESTED", reviewRequests: [{ __typename: "Team", name: "core", slug: "core" }], title: "Sphere renderer", url: "https://github.com/innovodevelop/atlas/pull/9" },
  { number: "10", title: "malformed", url: "https://github.com/x" },
]);

const RUN_LIST = JSON.stringify([
  { conclusion: "success", createdAt: "2026-10-28T15:42:56Z", databaseId: 40718748863, displayTitle: "Beta redesign, phase 1", event: "pull_request", headBranch: "ws-beta-redesign", name: "CI", status: "completed", updatedAt: "2026-10-28T15:44:55Z", url: "https://github.com/innovodevelop/atlas/actions/runs/40718748863", workflowName: "CI" },
  { conclusion: "", createdAt: "2026-10-28T15:42:56Z", databaseId: 40718748681, displayTitle: "Beta redesign, phase 1", event: "pull_request", headBranch: "ws-beta-redesign", name: "Rust core", status: "queued", updatedAt: "2026-10-28T15:42:56Z", url: "https://github.com/innovodevelop/atlas/actions/runs/40718748681", workflowName: "Rust core" },
  { conclusion: "cancelled", createdAt: "2026-08-10T21:48:26Z", databaseId: 31435525482, event: "workflow_dispatch", headBranch: "atlas-redesign", name: "Release", status: "completed", url: "https://github.com/innovodevelop/atlas/actions/runs/31435525482" },
]);

const RELEASES = JSON.stringify([
  { tag_name: "v0.4.1", name: "Waypoint", draft: true, prerelease: false, published_at: null, created_at: "2026-10-27T10:00:00Z", html_url: "https://github.com/innovodevelop/atlas/releases/tag/untagged-1" },
  { tag_name: "v0.4.0", name: null, draft: false, prerelease: false, published_at: "2026-10-20T10:00:00Z", created_at: "2026-10-20T09:00:00Z", html_url: "https://github.com/innovodevelop/atlas/releases/tag/v0.4.0" },
  { name: "no tag" },
]);

const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: "" });

describe("parsing gh's answers", () => {
  test("pull requests: the design's four states, and who is asked to review", () => {
    const rows = parsePulls(JSON.parse(PR_LIST), "innovodevelop");
    expect(rows.map((r) => [r.number, r.state, r.askedYou])).toEqual([
      [6, "review", false],
      [7, "approved", false],
      [8, "draft", true],
      [9, "changes", false],
    ]);
    expect(rows[0]).toMatchObject({ author: "innovodevelop", head: "ws-beta-redesign", base: "atlas-redesign", url: "https://github.com/innovodevelop/atlas/pull/6" });
    // A team asked to review is not the signed-in user being asked.
    expect(parsePulls(JSON.parse(PR_LIST), null).some((r) => r.askedYou)).toBe(false);
    expect(parsePulls({ not: "a list" }, null)).toEqual([]);
  });

  test("workflow runs: status and conclusion as one word", () => {
    const rows = parseRuns(JSON.parse(RUN_LIST));
    expect(rows.map((r) => [r.workflow, r.state])).toEqual([["CI", "passed"], ["Rust core", "queued"], ["Release", "cancelled"]]);
    expect(runState("in_progress", "")).toBe("running");
    expect(runState("completed", "failure")).toBe("failed");
    expect(runState("completed", "timed_out")).toBe("failed");
    expect(runState("completed", "skipped")).toBe("skipped");
    expect(runState("waiting", null)).toBe("queued");
  });

  test("releases: drafts are kept and marked, rows without a tag are dropped", () => {
    expect(parseReleases(JSON.parse(RELEASES)).map((r) => [r.tag, r.draft, r.publishedAt])).toEqual([
      ["v0.4.1", true, null],
      ["v0.4.0", false, "2026-10-20T10:00:00Z"],
    ]);
  });
});

describe("what went wrong, in words", () => {
  test("no gh, gh signed out, GitHub unreachable", () => {
    expect(ghProblem({ code: -1, stdout: "", stderr: "ENOENT: no such file or directory, posix_spawn 'gh'" }).problem).toBe("missing");
    expect(ghProblem({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }).problem).toBe("signed-out");
    const off = ghProblem({ code: 1, stdout: "", stderr: "error connecting to api.github.com\ncheck your internet connection" });
    expect(off).toEqual({ problem: "unreachable", message: "GitHub could not be reached: error connecting to api.github.com" });
  });
});

describe("createGithubWidgets", () => {
  function fakeGh(answers: Record<string, GhResult>) {
    const calls: string[][] = [];
    const run: GhRunner = async (argv) => {
      calls.push(argv);
      const key = Object.keys(answers).find((k) => argv.join(" ").includes(k));
      return key ? answers[key] : { code: 1, stdout: "", stderr: "unexpected call" };
    };
    return { run, calls };
  }

  test("pulls: gh's argv carries the repo as its own argument, and the viewer is asked once", async () => {
    const { run, calls } = fakeGh({ "pr list": ok(PR_LIST), "api user": ok("innovodevelop\n") });
    let t = 0;
    const w = createGithubWidgets({ run, gh: "/opt/homebrew/bin/gh", repo: "innovodevelop/atlas", now: () => new Date(t), cacheMs: 60_000 });
    const r = await w.pulls();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.viewer).toBe("innovodevelop");
    expect(r.pulls.find((p) => p.number === 8)?.askedYou).toBe(true);
    expect(calls[0].slice(0, 5)).toEqual(["/opt/homebrew/bin/gh", "pr", "list", "--repo", "innovodevelop/atlas"]);

    // Within the minute: the cached answer, no new call.
    t = 30_000;
    await w.pulls();
    expect(calls.length).toBe(2);
    // After it: asked again, but the viewer is not.
    t = 61_000;
    await w.pulls();
    expect(calls.filter((c) => c.includes("pr")).length).toBe(2);
    expect(calls.filter((c) => c.includes("user")).length).toBe(1);
  });

  test("callers at the same moment share one fetch", async () => {
    const { run, calls } = fakeGh({ "run list": ok(RUN_LIST), "releases": ok(RELEASES) });
    const w = createGithubWidgets({ run, gh: "gh", repo: "innovodevelop/atlas" });
    const [a, b] = await Promise.all([w.deploys(), w.deploys()]);
    expect(a).toBe(b);
    expect(calls.length).toBe(2);
    if (!a.ok) throw new Error("expected ok");
    expect(a.runs).toHaveLength(3);
    expect(a.releases.map((r) => r.tag)).toEqual(["v0.4.1", "v0.4.0"]);
  });

  test("deploys: runs without releases still answer; no runs is the failure", async () => {
    const half = fakeGh({ "run list": ok(RUN_LIST), "releases": { code: 1, stdout: "", stderr: "HTTP 404" } });
    const r = await createGithubWidgets({ run: half.run, gh: "gh" }).deploys();
    expect(r.ok && r.releases).toEqual([]);

    const none = fakeGh({ "run list": { code: 4, stdout: "", stderr: "gh auth login" }, "releases": ok("[]") });
    const f = await createGithubWidgets({ run: none.run, gh: "gh", repo: "innovodevelop/atlas" }).deploys();
    expect(f).toMatchObject({ ok: false, problem: "signed-out", repo: "innovodevelop/atlas" });
  });

  test("a missing gh is the dormant answer, and the next check after the minute finds it once installed", async () => {
    let missing = true;
    const run: GhRunner = async (argv) => (missing ? { code: -1, stdout: "", stderr: "ENOENT" } : argv.includes("user") ? ok("me") : ok("[]"));
    let t = 0;
    const w = createGithubWidgets({ run, gh: "gh", now: () => new Date(t) });
    expect(await w.pulls()).toMatchObject({ ok: false, problem: "missing" });
    missing = false;
    t = 61_000;
    expect(await w.pulls()).toMatchObject({ ok: true, pulls: [] });
  });
});
