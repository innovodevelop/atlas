// Design sync (feat-012): design/.sync-manifest.json mirrored into
// atlas_design_syncs, against the real schema and the real manifest.
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDesignSyncs, parseDesignManifest } from "./designSync.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCHEMA = readFileSync(join(ROOT, "src-tauri/src/db_schema.sql"), "utf8");

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function freshDb(): Database {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "atlas-design-")), "atlas.db"), { create: true });
  db.exec(SCHEMA);
  db.query(`INSERT INTO atlas_versions (id, semver) VALUES ('v0-2-0', 'v0.2.0')`).run();
  return db;
}

describe("parseDesignManifest", () => {
  test("the committed manifest: the Beta bundle being implemented, then the complete v0.2.0 suite", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "design/.sync-manifest.json"), "utf8"));
    const { entries, skipped } = parseDesignManifest(manifest);
    expect(skipped).toEqual([]);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    // The current bundle (2026-10-27 Beta redesign) is in progress, and says
    // so in the parser's own vocabulary — never "complete" by default.
    expect(entries[0].status).toBe("implementing");
    expect(entries[0].version_id).toBe("v0-4-0");
    expect(entries[0].surfaces.length).toBeGreaterThan(0);
    // The suite v2 port it is diffed against stays on record as shipped.
    expect(entries[1].status).toBe("complete");
    expect(entries[1].version_id).toBe("v0-2-0");
  });

  test("the top level is the current bundle and history follows it", () => {
    const { entries } = parseDesignManifest({
      name: "current", sha256: SHA_A, status: "implementing",
      history: [{ name: "older", sha256: SHA_B, status: "complete", version: "0.2.0" }],
    });
    expect(entries.map((e) => [e.bundle_name, e.status, e.version_id])).toEqual([
      ["current", "implementing", null],
      ["older", "complete", "v0-2-0"],
    ]);
  });

  test("an unstated or unknown status is 'received', never 'complete'", () => {
    const { entries } = parseDesignManifest({
      name: "x", sha256: SHA_A,
      history: [{ name: "y", sha256: SHA_B, status: "shipped" }],
    });
    expect(entries.map((e) => e.status)).toEqual(["received", "received"]);
  });

  test("a bundle without a valid sha256 is skipped and reported, not invented", () => {
    const { entries, skipped } = parseDesignManifest({ name: "x", sha256: "nope", history: [{ name: "y" }] });
    expect(entries).toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  test("a non-object manifest is reported", () => {
    expect(parseDesignManifest([]).skipped).toEqual(["manifest is not a JSON object"]);
  });
});

describe("applyDesignSyncs", () => {
  test("upserts by hash, and an unknown version is stored as NULL instead of breaking the foreign key", () => {
    const db = freshDb();
    const first = parseDesignManifest({ name: "b", sha256: SHA_A, status: "auditing", version: "v9.9.9", syncedAt: "2026-08-03T20:06:00+02:00" });
    applyDesignSyncs(db, first.entries);
    const second = parseDesignManifest({ name: "b", sha256: SHA_A, status: "complete", version: "v0.2.0", surfaces: ["Onboarding"] });
    applyDesignSyncs(db, second.entries);

    const rows = db.query(`SELECT bundle_name, status, version_id, surfaces FROM atlas_design_syncs`).all();
    expect(rows).toEqual([{ bundle_name: "b", status: "complete", version_id: "v0-2-0", surfaces: '["Onboarding"]' }]);
  });

  test("synced_at keeps the manifest's time, converted to UTC", () => {
    const db = freshDb();
    applyDesignSyncs(db, parseDesignManifest({ name: "b", sha256: SHA_A, syncedAt: "2026-08-03T20:06:00+02:00" }).entries);
    const row = db.query(`SELECT synced_at FROM atlas_design_syncs`).get() as { synced_at: string };
    expect(row.synced_at).toBe("2026-08-03T18:06:00.000Z");
  });
});
