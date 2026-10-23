// The internal changelog (feat-014) is the git log filed against versions.
// These tests pin the two judgement calls — which version a commit belongs to,
// and what a commit's title/description become — against the real schema.
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyChangelog, buildChangelog, categorize, parseGitLog, readGitLog, GIT_LOG_FORMAT, type GitCommit } from "./changelog.ts";

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/db_schema.sql"),
  "utf8",
);

const versions = [
  { id: "v0-2-0", semver: "v0.2.0", status: "released", target_date: "2026-08-04" },
  { id: "v0-3-0", semver: "v0.3.0", status: "in-progress", target_date: "2026-11-01" },
  { id: "v0-4-0", semver: "v0.4.0", status: "in-progress", target_date: "2026-11-29" },
  { id: "v1-0-0", semver: "v1.0.0", status: "planned", target_date: "2027-02" },
];
const features = new Map([
  ["feat-001", "v0-2-0"],
  ["feat-014", "v0-3-0"],
  ["feat-018", "v0-3-0"],
  ["feat-020", "v0-4-0"],
]);

const commit = (over: Partial<GitCommit>): GitCommit => ({
  sha: "a".repeat(40),
  date: "2026-10-23T17:02:49+02:00",
  subject: "Do a thing",
  body: "",
  ...over,
});

describe("filing commits against versions", () => {
  test("a commit naming one version's features goes to that version, whatever its date", () => {
    const [e] = buildChangelog([commit({ date: "2026-08-01T10:00:00Z", body: "Mail Stage 6e / feat-020." })], versions, features);
    expect(e.version_id).toBe("v0-4-0");
    expect(e.related_feature).toBe("feat-020");
  });

  test("before a release's date, a commit belongs to that release", () => {
    const [e] = buildChangelog([commit({ date: "2026-08-04T23:30:00+00:00" })], versions, features);
    expect(e.version_id).toBe("v0-2-0");
  });

  test("after every release, an unattributed commit goes to the earliest version in progress", () => {
    const [e] = buildChangelog([commit({ date: "2026-08-05T00:00:00Z" })], versions, features);
    expect(e.version_id).toBe("v0-3-0");
  });

  test("features spanning two versions fall back to the date rule, and name no single feature", () => {
    const [e] = buildChangelog(
      [commit({ date: "2026-10-01T00:00:00Z", body: "Touches feat-014 and feat-020." })],
      versions,
      features,
    );
    expect(e.version_id).toBe("v0-3-0");
    expect(e.related_feature).toBeNull();
  });

  test("a feature id the plan does not know is ignored, not trusted", () => {
    const [e] = buildChangelog([commit({ body: "feat-999 does not exist" })], versions, features);
    expect(e.related_feature).toBeNull();
    expect(e.version_id).toBe("v0-3-0");
  });

  test("with no versions at all, commits are kept unfiled rather than dropped", () => {
    const [e] = buildChangelog([commit({})], [], new Map());
    expect(e.version_id).toBeNull();
  });
});

describe("titles, descriptions, categories", () => {
  test("conventional prefixes set the category and are stripped from the title", () => {
    const [e] = buildChangelog([commit({ subject: "fix: add user?.id to usePersonality effect" })], versions, features);
    expect(e.category).toBe("fixed");
    expect(e.title).toBe("add user?.id to usePersonality effect");
  });

  test("the description is the first paragraph of the body, without trailers", () => {
    const [e] = buildChangelog(
      [commit({ body: "keywordScore tokenized queries\nwith a split.\n\nSecond paragraph.\n\nCo-Authored-By: Someone <x@y.z>" })],
      versions,
      features,
    );
    expect(e.description).toBe("keywordScore tokenized queries with a split.");
  });

  test("a trailer-only body has no description", () => {
    const [e] = buildChangelog([commit({ body: "Co-Authored-By: Someone <x@y.z>" })], versions, features);
    expect(e.description).toBeNull();
  });

  test.each([
    ["Make the Rust CI job able to compile", "infrastructure"],
    ["Rotate the updater signing key (the old one was burned)", "infrastructure"],
    ["Drop the 12 dependencies Wave 1b orphaned", "removed"],
    ["Fix boolean filters in the local Supabase shim", "fixed"],
    ["Add the Bluetooth usage string before the code that needs it", "added"],
    ["Add System Status surface with health monitoring and self-repair pipeline", "added"],
    ["Never commit secrets to the repo", "security"],
    ["Recall: match Danish words whole", "changed"],
  ] as const)("%s → %s", (subject, category) => {
    expect(categorize(subject)).toBe(category);
  });
});

describe("git log parsing", () => {
  test("splits records and fields, keeping multi-line bodies intact", () => {
    const raw =
      `${"1".repeat(40)}\x1f2026-10-23T17:02:49+02:00\x1fFirst\x1fLine one\nLine two\n\x1e\n` +
      `${"2".repeat(40)}\x1f2026-10-22T10:00:00+02:00\x1fSecond\x1f\x1e\n`;
    const commits = parseGitLog(raw);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({ sha: "1".repeat(40), date: "2026-10-23T17:02:49+02:00", subject: "First", body: "Line one\nLine two" });
    expect(commits[1].body).toBe("");
  });

  test("reads this repository's own history (the format string round-trips through real git)", () => {
    expect(GIT_LOG_FORMAT).toContain("%H");
    const result = readGitLog(resolve(import.meta.dir, "../../.."));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.commits.length).toBeGreaterThan(0);
      expect(result.commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("a directory that is not a repository is an error, not an empty changelog", () => {
    const result = readGitLog(mkdtempSync(join(tmpdir(), "atlas-nogit-")));
    expect(result.ok).toBe(false);
  });
});

describe("applyChangelog", () => {
  function seededDb(): Database {
    const db = new Database(join(mkdtempSync(join(tmpdir(), "atlas-changelog-")), "atlas.db"), { create: true });
    db.exec(SCHEMA);
    for (const v of versions) {
      db.query(`INSERT INTO atlas_versions (id, semver, status, target_date) VALUES (?, ?, ?, ?)`).run(v.id, v.semver, v.status, v.target_date);
    }
    for (const [id, versionId] of features) {
      db.query(`INSERT INTO atlas_version_features (id, version_id, title) VALUES (?, ?, ?)`).run(id, versionId, id);
    }
    return db;
  }

  test("writes rows the /versions panel reads, and re-syncing upserts instead of duplicating", () => {
    const db = seededDb();
    const commits = [commit({ sha: "b".repeat(40), body: "feat-020" }), commit({ sha: "c".repeat(40) })];
    expect(applyChangelog(db, commits).synced).toBe(2);
    expect(applyChangelog(db, commits).synced).toBe(2);

    const rows = db.query(`SELECT id, version_id, related_feature FROM atlas_changelog ORDER BY id`).all();
    expect(rows).toEqual([
      { id: `git:${"b".repeat(40)}`, version_id: "v0-4-0", related_feature: "feat-020" },
      { id: `git:${"c".repeat(40)}`, version_id: "v0-3-0", related_feature: null },
    ]);
  });
});
