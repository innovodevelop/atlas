// Reconciliation of VERSION-PLAN.md into SQLite, against a real copy of the app
// schema. The sync used to be upsert-only, so anything deleted from the markdown
// lingered in the DB forever; adding reconciliation fixed that and introduced a
// far worse failure mode, which the first test here exists to prevent.
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyVersionPlan } from "./adminRoutes.ts";
import type { Version } from "./versionPlan.ts";

const SCHEMA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../src-tauri/src/db_schema.sql"),
  "utf8",
);

function freshDb(): Database {
  const dbPath = join(mkdtempSync(join(tmpdir(), "atlas-versions-")), "atlas.db");
  const db = new Database(dbPath, { create: true });
  db.exec(SCHEMA);
  return db;
}

const version = (id: string, featureIds: string[]): Version => ({
  id,
  semver: id.replace(/-/g, "."),
  codename: `codename-${id}`,
  status: "planned",
  features: featureIds.map((f) => ({ id: f, title: `title ${f}`, status: "planned" })),
});

const countVersions = (db: Database) =>
  (db.query(`SELECT COUNT(*) AS n FROM atlas_versions`).get() as { n: number }).n;
const countFeatures = (db: Database) =>
  (db.query(`SELECT COUNT(*) AS n FROM atlas_version_features`).get() as { n: number }).n;

test("an empty parse is REFUSED and destroys nothing", () => {
  // The failure this guards against is not hypothetical. parseVersionPlan never
  // throws — a renamed heading, a changed dash or a truncated file all parse to
  // [] silently. Without the guard, reconciliation builds
  // `DELETE FROM atlas_versions WHERE id NOT IN ()`, and bun:sqlite does NOT
  // treat an empty IN list as an error: it matches every row and empties the
  // table, inside a transaction that then commits. One bad markdown edit would
  // take the whole version history with it.
  const db = freshDb();
  applyVersionPlan(db, [version("v0-2-0", ["feat-001", "feat-002"])]);
  expect(countVersions(db)).toBe(1);
  expect(countFeatures(db)).toBe(2);

  const result = applyVersionPlan(db, []);

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("refusing to reconcile");
  expect(countVersions(db)).toBe(1);
  expect(countFeatures(db)).toBe(2);
  db.close();
});

test("a version dropped from the plan is removed, not orphaned", () => {
  const db = freshDb();
  applyVersionPlan(db, [version("v0-2-0", ["feat-001"]), version("v0-3-0", ["feat-010"])]);
  expect(countVersions(db)).toBe(2);

  applyVersionPlan(db, [version("v0-2-0", ["feat-001"])]);

  expect(countVersions(db)).toBe(1);
  // Its features must go too. They cascade from atlas_versions, but only while
  // PRAGMA foreign_keys is on, so reconciliation deletes them explicitly.
  expect(countFeatures(db)).toBe(1);
  db.close();
});

test("a feature dropped from a surviving version is removed", () => {
  const db = freshDb();
  applyVersionPlan(db, [version("v0-3-0", ["feat-010", "feat-011", "feat-012"])]);
  expect(countFeatures(db)).toBe(3);

  applyVersionPlan(db, [version("v0-3-0", ["feat-010", "feat-012"])]);

  expect(countFeatures(db)).toBe(2);
  const ids = db.query(`SELECT id FROM atlas_version_features ORDER BY id`).all() as { id: string }[];
  expect(ids.map((r) => r.id)).toEqual(["feat-010", "feat-012"]);
  db.close();
});

test("a version emptied of all features keeps the version and drops the features", () => {
  const db = freshDb();
  applyVersionPlan(db, [version("v0-4-0", ["feat-020", "feat-021"])]);
  applyVersionPlan(db, [version("v0-4-0", [])]);

  expect(countVersions(db)).toBe(1);
  expect(countFeatures(db)).toBe(0);
  db.close();
});

test("re-applying an unchanged plan is idempotent", () => {
  const db = freshDb();
  const plan = [version("v0-2-0", ["feat-001"]), version("v0-3-0", ["feat-010", "feat-011"])];
  applyVersionPlan(db, plan);
  const first = applyVersionPlan(db, plan);

  expect(first).toEqual({ ok: true, synced: 2, features: 3 });
  expect(countVersions(db)).toBe(2);
  expect(countFeatures(db)).toBe(3);
  db.close();
});
