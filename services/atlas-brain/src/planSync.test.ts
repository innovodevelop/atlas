import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { containsFromCompare, createPlanSync, diffPlans, ghBinary, type Runner } from "./planSync.ts";
import { parseVersionPlan, type Version } from "./versionPlan.ts";

const PLAN_V1 = `## v0.4.0 — Waypoint {status: in-progress}

- [ ] IMAP connector {id: feat-020, status: in-progress}
- [ ] Mail sending {id: feat-021}
`;
const PLAN_V2 = `## v0.4.0 — Waypoint {status: in-progress}

- [x] IMAP connector {id: feat-020}
- [ ] Mail sending {id: feat-021}
- [ ] Outlook connector {id: feat-026}
`;

const PLAN_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const LOCAL_SHA = "c".repeat(40);
const BUILD_SHA = "d".repeat(40);

describe("diffPlans", () => {
  test("lists features that are new or changed on GitHub", () => {
    const github = parseVersionPlan(PLAN_V2);
    const local = parseVersionPlan(PLAN_V1);
    expect(diffPlans(github, local)).toEqual([
      { id: "feat-020", title: "IMAP connector", github: "done", local: "in-progress" },
      { id: "feat-026", title: "Outlook connector", github: "planned", local: null },
    ]);
  });

  test("an identical plan has nothing GitHub-only, and no local plan means all of it", () => {
    const plan = parseVersionPlan(PLAN_V2);
    expect(diffPlans(plan, plan)).toEqual([]);
    expect(diffPlans(plan, null).map((f) => f.id)).toEqual(["feat-020", "feat-021", "feat-026"]);
  });
});

describe("containsFromCompare", () => {
  test("a build at or after the plan commit contains it", () => {
    expect(containsFromCompare("identical")).toBe(true);
    expect(containsFromCompare("ahead")).toBe(true);
    expect(containsFromCompare("behind")).toBe(false);
    expect(containsFromCompare("diverged")).toBe(false);
    expect(containsFromCompare(undefined)).toBe(null);
  });
});

test("gh is found in Homebrew even with launchd's PATH", () => {
  expect(ghBinary((p) => p === "/opt/homebrew/bin/gh")).toBe("/opt/homebrew/bin/gh");
  expect(ghBinary(() => false)).toBe("gh");
});

test("a gh unpacked into ~/bin is found too, after Homebrew's", () => {
  const mine = join(homedir(), "bin", "gh");
  expect(ghBinary((p) => p === mine)).toBe(mine);
  expect(ghBinary((p) => p === mine || p === "/usr/local/bin/gh")).toBe("/usr/local/bin/gh");
});

/** A checkout on disk (for existsSync and the plan file) with a fake git. */
function fakeRepo(plan: string): string {
  const dir = mkdtempSync(join(tmpdir(), "plansync-"));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs/VERSION-PLAN.md"), plan);
  return dir;
}

function fakeRunner(opts: { githubPlan?: string; localContains: boolean; online?: boolean }): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const ok = (stdout: unknown) => ({ code: 0, stdout: typeof stdout === "string" ? stdout : JSON.stringify(stdout) });
  const run = (async (argv: string[]) => {
    calls.push(argv);
    const [bin, ...args] = argv;
    if (bin === "git") {
      if (args[0] === "remote") return ok("git@github.com:innovodevelop/atlas.git\n");
      if (args[0] === "rev-parse" && args[1] === "HEAD") return ok(`${LOCAL_SHA}\n`);
      if (args[0] === "rev-parse") return ok("atlas-redesign\n");
      if (args[0] === "status") return ok("");
      if (args[0] === "merge-base") return { code: opts.localContains ? 0 : 1, stdout: "" };
    }
    if (bin === "gh") {
      if (opts.online === false) return { code: 1, stdout: "" };
      const path = args[args.length - 1];
      if (path.includes("/branches/")) return ok({ commit: { sha: HEAD_SHA } });
      if (path.includes("/commits?")) return ok([{ sha: PLAN_SHA, commit: { message: "Plan: mark IMAP done\n\nbody", committer: { date: "2026-10-23T12:00:00Z" } } }]);
      if (path.includes("/contents/")) return ok(opts.githubPlan ?? PLAN_V2);
      if (path.includes(`/compare/${LOCAL_SHA}...${HEAD_SHA}`)) return ok({ status: "ahead", ahead_by: 3 });
      if (path.includes(`/compare/${PLAN_SHA}...${BUILD_SHA}`)) return ok({ status: "behind", ahead_by: 0 });
      if (path.includes(`/compare/${BUILD_SHA}...${HEAD_SHA}`)) return ok({ status: "ahead", ahead_by: 7 });
    }
    return { code: 1, stdout: "" };
  }) as Runner & { calls: string[][] };
  run.calls = calls;
  return run;
}

function checker(run: Runner, repo: string) {
  const applied: Version[][] = [];
  const sync = createPlanSync({
    db: new Database(":memory:"),
    apply: (_db, v) => {
      applied.push(v);
      return { ok: true };
    },
    run,
    gh: "gh",
    repoCandidates: [join(repo, "missing"), repo],
  });
  return { sync, applied };
}

describe("createPlanSync", () => {
  test("applies GitHub's plan and tells GitHub-only changes from what this Mac has", async () => {
    const repo = fakeRepo(PLAN_V1);
    const { sync, applied } = checker(fakeRunner({ localContains: false }), repo);
    const s = await sync.sync(BUILD_SHA);

    expect(s.github.ok).toBe(true);
    expect(s.github.plan).toEqual({ sha: PLAN_SHA, date: "2026-10-23T12:00:00Z", message: "Plan: mark IMAP done" });
    expect(s.github.applied).toBe(true);
    expect(s.source).toBe("github");
    expect(applied).toHaveLength(1);

    expect(s.local.path).toBe(repo);
    expect(s.local.containsPlan).toBe(false);
    expect(s.local.behindBy).toBe(3);
    expect(s.app).toEqual({ buildSha: BUILD_SHA, containsPlan: false, behindBy: 7 });
    expect(s.githubOnly.map((f) => f.id)).toEqual(["feat-020", "feat-026"]);
  });

  test("an unchanged plan is not re-applied, and a pulled checkout has nothing GitHub-only", async () => {
    const repo = fakeRepo(PLAN_V2);
    const { sync, applied } = checker(fakeRunner({ localContains: true }), repo);
    await sync.sync(null);
    const second = await sync.sync(null);
    expect(applied).toHaveLength(1);
    expect(second.github.applied).toBe(false);
    expect(second.local.containsPlan).toBe(true);
    expect(second.githubOnly).toEqual([]);
    expect(second.app.containsPlan).toBe(null);
  });

  test("offline, the local checkout's plan is applied instead", async () => {
    const repo = fakeRepo(PLAN_V1);
    const { sync, applied } = checker(fakeRunner({ localContains: false, online: false }), repo);
    const s = await sync.sync(null);
    expect(s.github.ok).toBe(false);
    expect(s.github.error).toContain("GitHub unreachable");
    expect(s.source).toBe("local");
    expect(applied[0][0].features.map((f) => f.status)).toEqual(["in-progress", "planned"]);
    expect(s.githubOnly).toEqual([]);
  });

  test("a malformed build sha is ignored rather than sent to GitHub", async () => {
    const repo = fakeRepo(PLAN_V2);
    const run = fakeRunner({ localContains: true });
    const { sync } = checker(run, repo);
    const s = await sync.sync("main; rm -rf /");
    expect(s.app.buildSha).toBe(null);
    expect(run.calls.some((c) => c.join(" ").includes("rm -rf"))).toBe(false);
  });

  test("concurrent callers share one check", async () => {
    const repo = fakeRepo(PLAN_V2);
    const run = fakeRunner({ localContains: true });
    const { sync } = checker(run, repo);
    await Promise.all([sync.sync(null), sync.sync(null), sync.status(null)]);
    expect(run.calls.filter((c) => c.join(" ").includes("/branches/"))).toHaveLength(1);
  });
});
