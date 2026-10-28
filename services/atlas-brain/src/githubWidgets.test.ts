// The developer widgets' GitHub reads, against what gh 2.86 really returned
// for innovodevelop/atlas on 2026-10-28 (abridged), with gh itself faked.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMMAND_TIMEOUT_MS, TIMED_OUT, createGithubWidgets, ghProblem, makeGhRunner, parsePulls, parseReleases, parseRuns, runState,
  type GhResult, type GhRunner,
} from "./githubWidgets.ts";

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
    // A gh stopped at the deadline is GitHub not answering, not a dormant widget.
    expect(ghProblem({ code: TIMED_OUT, stdout: "", stderr: "gh did not answer within 6 seconds" })).toEqual({
      problem: "unreachable",
      message: "GitHub could not be reached: gh did not answer within 6 seconds",
    });
  });
});

describe("the deadline", () => {
  test("the brain answers before the webview gives up on it", () => {
    // useAdminApi.ts aborts every admin request after BRAIN_TIMEOUT_MS. The
    // routes run their gh calls side by side, so one call's deadline is the
    // route's; it must leave room under the webview's, or the widget says
    // "brain not answering" when GitHub is what is slow. Read as text: the
    // two numbers live in two packages with nothing else holding them together.
    const hook = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../src/hooks/useAdminApi.ts"), "utf8");
    const m = hook.match(/const BRAIN_TIMEOUT_MS = ([\d_]+);/);
    expect(m).not.toBeNull();
    const webview = Number(m![1].replaceAll("_", ""));
    expect(COMMAND_TIMEOUT_MS + 1_000).toBeLessThanOrEqual(webview);
  });

  test("a gh that does not finish is stopped at the deadline and reads as unreachable", async () => {
    const started = Date.now();
    const r = await makeGhRunner(150)(["sleep", "5"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r.code).toBe(TIMED_OUT);
    expect(ghProblem(r).problem).toBe("unreachable");
  });

  test("a gh that finishes in time answers as it is; a missing one is missing", async () => {
    expect(await makeGhRunner(5_000)(["echo", "innovodevelop"])).toEqual({ code: 0, stdout: "innovodevelop\n", stderr: "" });
    const none = await makeGhRunner(5_000)(["/nonexistent/gh", "pr", "list"]);
    expect(ghProblem(none).problem).toBe("missing");
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

  test("pulls: the list and the viewer are asked side by side, and a viewer that times out leaves the list standing", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run: GhRunner = async (argv) => {
      started.push(argv.slice(1, 3).join(" "));
      await gate;
      return argv.includes("user") ? { code: TIMED_OUT, stdout: "", stderr: "gh did not answer within 6 seconds" } : ok(PR_LIST);
    };
    const pending = createGithubWidgets({ run, gh: "gh" }).pulls();
    await Promise.resolve();
    // Both are under way before either answers: the route waits for one deadline, not two.
    expect(started).toEqual(["pr list", "api user"]);
    release();
    const r = await pending;
    expect(r).toMatchObject({ ok: true, viewer: null });
    expect(r.ok && r.pulls).toHaveLength(4);
  });

  test("pulls: a list that times out is the unreachable answer", async () => {
    const run: GhRunner = async () => ({ code: TIMED_OUT, stdout: "", stderr: "gh did not answer within 6 seconds" });
    expect(await createGithubWidgets({ run, gh: "gh", repo: "innovodevelop/atlas" }).pulls()).toMatchObject({ ok: false, problem: "unreachable", repo: "innovodevelop/atlas" });
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
