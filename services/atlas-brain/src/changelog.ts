/**
 * Internal changelog (feat-014) — derived from git history, not hand-written.
 *
 * atlas_changelog existed with a UI on /versions and nothing that ever wrote a
 * row, so the panel was permanently empty. A hand-maintained CHANGELOG.md
 * would be a sixth planning document to drift out of date; the commit log is
 * already written, already reviewed, and already says what changed and why.
 * So the changelog is the commit log, filed against versions:
 *
 *   - Every non-merge commit becomes one row, id `git:<sha>`. Re-running the
 *     sync upserts, so a row's version or category can be corrected by a
 *     later plan change without duplicating anything.
 *   - A commit is filed against a version by the `feat-NNN` ids its message
 *     names, when they all belong to one version. Otherwise by date: the
 *     earliest released version whose target date is on or after the commit,
 *     else the earliest version still in progress. The date rule is a
 *     fallback, not a claim — a commit that names its feature is filed right.
 *   - The category is a heuristic on the subject line. It is display-only; a
 *     wrong guess mislabels a pill, it never moves a commit between versions.
 *
 * The parsing and filing are pure functions over plain data so they can be
 * tested without git; `readGitLog` is the only part that touches the repo,
 * and it needs a source checkout — like every admin route, it does not work
 * from the compiled sidecar, where the repo root resolves to `/`.
 */

import { Database } from "bun:sqlite";

export type ChangelogCategory = "added" | "changed" | "fixed" | "removed" | "security" | "infrastructure";

export interface GitCommit {
  sha: string;
  date: string; // ISO 8601, author date
  subject: string;
  body: string;
}

export interface ChangelogEntry {
  id: string;
  version_id: string | null;
  category: ChangelogCategory;
  title: string;
  description: string | null;
  related_feature: string | null;
  created_at: string;
}

interface VersionRef {
  id: string;
  semver: string;
  status: string;
  target_date: string | null;
}

// Field and record separators that cannot appear in a commit message.
const FS = "\x1f";
const RS = "\x1e";
export const GIT_LOG_FORMAT = `%H${FS}%aI${FS}%s${FS}%b${RS}`;

const MAX_COMMITS = 2000;
const DESCRIPTION_MAX_CHARS = 600;

export function parseGitLog(raw: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const record of raw.split(RS)) {
    const trimmed = record.replace(/^\n+/, "");
    if (!trimmed) continue;
    const [sha, date, subject, body = ""] = trimmed.split(FS);
    if (!sha || !date || subject === undefined) continue;
    commits.push({ sha: sha.trim(), date: date.trim(), subject: subject.trim(), body: body.trim() });
  }
  return commits;
}

export function readGitLog(repoRoot: string): { ok: true; commits: GitCommit[] } | { ok: false; error: string } {
  try {
    const proc = Bun.spawnSync(
      ["git", "-C", repoRoot, "log", "--no-merges", `--max-count=${MAX_COMMITS}`, `--format=${GIT_LOG_FORMAT}`],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) {
      return { ok: false, error: `git log failed: ${new TextDecoder().decode(proc.stderr).slice(0, 300)}` };
    }
    return { ok: true, commits: parseGitLog(new TextDecoder().decode(proc.stdout)) };
  } catch (err) {
    return { ok: false, error: `git unavailable: ${String(err).slice(0, 300)}` };
  }
}

/** Conventional-commit prefixes (`feat:`, `fix(scope):`) are stripped from titles. */
const CONVENTIONAL_PREFIX = /^(feat|fix|chore|ci|build|docs|refactor|perf|test|style|security)(\([^)]*\))?!?:\s*/i;

export function categorize(subject: string): ChangelogCategory {
  const conv = CONVENTIONAL_PREFIX.exec(subject)?.[1]?.toLowerCase();
  if (conv === "security") return "security";
  if (conv === "fix") return "fixed";
  if (conv === "feat") return "added";
  if (conv === "ci" || conv === "build" || conv === "chore") return "infrastructure";

  // Security wins outright; then the leading verb, which says what the commit
  // did; only then subject keywords, which say what it touched ("Add System
  // Status surface with … pipeline" added a surface, it is not CI work).
  const s = subject.replace(CONVENTIONAL_PREFIX, "");
  if (/\b(security|vulnerab\w*|CVE-|secrets?\b|credential|xss|injection)/i.test(s)) return "security";
  if (/^(fix(es|ed)?|hotfix|correct|repair|stop)\b/i.test(s)) return "fixed";
  if (/^(remove|drop|delete|retire|un-?bundle)\b/i.test(s)) return "removed";
  if (/^(add|implement|introduce|build out|create|new)\b/i.test(s)) return "added";
  if (/^(ci|build|release|bump)\b|\b(CI|pipeline|signing|updater|workflow)\b/.test(s)) return "infrastructure";
  return "changed";
}

const TRAILER = /^(Co-Authored-By|Signed-off-by|Reviewed-by|Claude-Session|Change-Id):/i;

/** The body's prose, without the trailers (Co-Authored-By, Claude-Session, …). */
function describe(body: string): string | null {
  const prose = body
    .split("\n")
    .filter((line) => !TRAILER.test(line))
    .join("\n")
    .trim();
  if (!prose) return null;
  const firstParagraph = prose.split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, " ").trim();
  return firstParagraph.length > DESCRIPTION_MAX_CHARS
    ? `${firstParagraph.slice(0, DESCRIPTION_MAX_CHARS - 1)}…`
    : firstParagraph;
}

function semverKey(semver: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(semver);
  if (!m) return [Infinity, Infinity, Infinity];
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function bySemver(a: VersionRef, b: VersionRef): number {
  const ka = semverKey(a.semver);
  const kb = semverKey(b.semver);
  for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
  return 0;
}

/** A plain `YYYY-MM-DD` target, or null for free-form ones ("2027-02", "after v1.0"). */
function targetDay(target: string | null): string | null {
  return target && /^\d{4}-\d{2}-\d{2}$/.test(target.trim()) ? target.trim() : null;
}

/**
 * File commits against versions. `featureVersion` maps every known feature id
 * to the version that owns it, as reconciled from VERSION-PLAN.md.
 */
export function buildChangelog(
  commits: GitCommit[],
  versions: VersionRef[],
  featureVersion: Map<string, string>,
): ChangelogEntry[] {
  const ordered = [...versions].sort(bySemver);
  const released = ordered.filter((v) => v.status === "released" && targetDay(v.target_date));
  const current = ordered.find((v) => v.status === "in-progress") ?? ordered.find((v) => v.status === "planned");

  const byDate = (iso: string): string | null => {
    const day = iso.slice(0, 10);
    const shippedIn = released.find((v) => day <= targetDay(v.target_date)!);
    return shippedIn?.id ?? current?.id ?? null;
  };

  return commits.map((c) => {
    const message = `${c.subject}\n${c.body}`;
    const featureIds = [...new Set(message.match(/\bfeat-\d{3}\b/g) ?? [])].filter((f) => featureVersion.has(f));
    const featureVersions = new Set(featureIds.map((f) => featureVersion.get(f)!));
    const versionId = featureVersions.size === 1 ? [...featureVersions][0] : byDate(c.date);

    return {
      id: `git:${c.sha}`,
      version_id: versionId,
      category: categorize(c.subject),
      title: c.subject.replace(CONVENTIONAL_PREFIX, "").trim() || c.subject,
      description: describe(c.body),
      related_feature: featureIds.length === 1 ? featureIds[0] : null,
      created_at: new Date(c.date).toISOString(),
    };
  });
}

/** Upsert the entries. Rows are never deleted: history only grows. */
export function applyChangelog(db: Database, commits: GitCommit[]): { synced: number } {
  const versions = db.query(`SELECT id, semver, status, target_date FROM atlas_versions`).all() as VersionRef[];
  const featureRows = db.query(`SELECT id, version_id FROM atlas_version_features`).all() as Array<{ id: string; version_id: string }>;
  const entries = buildChangelog(commits, versions, new Map(featureRows.map((f) => [f.id, f.version_id])));

  const upsert = db.prepare(`
    INSERT INTO atlas_changelog (id, version_id, category, title, description, related_feature, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      version_id = excluded.version_id,
      category = excluded.category,
      title = excluded.title,
      description = excluded.description,
      related_feature = excluded.related_feature,
      created_at = excluded.created_at
  `);
  db.transaction(() => {
    for (const e of entries) {
      upsert.run(e.id, e.version_id, e.category, e.title, e.description, e.related_feature, e.created_at);
    }
  })();
  return { synced: entries.length };
}
