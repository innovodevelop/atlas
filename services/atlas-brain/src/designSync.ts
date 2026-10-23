/**
 * Design sync (feat-012) — `design/.sync-manifest.json` → atlas_design_syncs.
 *
 * /design-sync rendered atlas_design_syncs, and nothing ever wrote it: its
 * empty state promised "the connector reads design/.sync-manifest.json", but
 * no code did. The manifest is the record every Claude Design handoff already
 * updates (see design/current/…/PROMPT.md), so it stays the source of truth
 * and this module only mirrors it, the same way VERSION-PLAN.md is mirrored.
 *
 * Manifest shape: the top level is the CURRENT bundle; `history` (optional)
 * holds earlier ones in the same shape. Per bundle, read here:
 *
 *   name | bundle   display name (required)
 *   sha256          bundle hash (required) — also the row id, so re-syncing
 *                   the same bundle updates its row instead of adding one
 *   syncedAt        when it was received
 *   status          received | auditing | implementing | complete | rejected
 *                   (default: received — an unstated status is not "done")
 *   completedAt     when implementation finished
 *   version         the semver it shipped in, e.g. "v0.2.0"
 *   surfaces        the surfaces it touched, as a string array
 *   audit, note     path to the audit doc + free text → audit_notes
 *
 * A bundle without a sha256 is skipped and reported, never invented: the
 * hash is what makes the row's identity honest.
 */

import { Database } from "bun:sqlite";

export type DesignSyncStatus = "received" | "auditing" | "implementing" | "complete" | "rejected";

const STATUSES: ReadonlySet<string> = new Set(["received", "auditing", "implementing", "complete", "rejected"]);

export interface DesignSyncEntry {
  id: string;
  bundle_name: string;
  sha256: string;
  version_id: string | null;
  status: DesignSyncStatus;
  surfaces: string[];
  audit_notes: string | null;
  synced_at: string | null;
  completed_at: string | null;
}

type Bundle = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Parse ISO-ish timestamps to UTC ISO; anything unparseable becomes null. */
function iso(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export function parseDesignManifest(manifest: unknown): { entries: DesignSyncEntry[]; skipped: string[] } {
  const entries: DesignSyncEntry[] = [];
  const skipped: string[] = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { entries, skipped: ["manifest is not a JSON object"] };
  }

  const top = manifest as Bundle;
  const history = Array.isArray(top.history) ? (top.history as unknown[]) : [];
  const bundles = [top, ...history];

  bundles.forEach((raw, i) => {
    if (!raw || typeof raw !== "object") {
      skipped.push(`history[${i - 1}] is not an object`);
      return;
    }
    const b = raw as Bundle;
    const name = str(b.name) ?? str(b.bundle);
    const sha = str(b.sha256)?.toLowerCase() ?? null;
    const label = name ?? (i === 0 ? "current bundle" : `history[${i - 1}]`);
    if (!name || !sha || !/^[0-9a-f]{64}$/.test(sha)) {
      skipped.push(`${label}: missing name or a valid sha256`);
      return;
    }
    const status = str(b.status)?.toLowerCase();
    const notes = [str(b.audit) && `Audit: ${str(b.audit)}`, str(b.note)].filter(Boolean).join("\n\n");
    const semver = str(b.version);

    entries.push({
      id: `design:${sha.slice(0, 16)}`,
      bundle_name: name,
      sha256: sha,
      version_id: semver ? semver.replace(/^(?!v)/, "v").replace(/\./g, "-") : null,
      status: status && STATUSES.has(status) ? (status as DesignSyncStatus) : "received",
      surfaces: Array.isArray(b.surfaces) ? b.surfaces.filter((s): s is string => typeof s === "string") : [],
      audit_notes: notes || null,
      synced_at: iso(b.syncedAt),
      completed_at: iso(b.completedAt),
    });
  });

  return { entries, skipped };
}

/**
 * Upsert the parsed bundles. A version that is not (yet) in atlas_versions is
 * stored as NULL rather than violating the foreign key — run the plan sync
 * first and the next design sync links it.
 */
export function applyDesignSyncs(db: Database, entries: DesignSyncEntry[]): { synced: number } {
  const versionExists = db.prepare(`SELECT 1 FROM atlas_versions WHERE id = ?`);
  const upsert = db.prepare(`
    INSERT INTO atlas_design_syncs (id, bundle_name, sha256, version_id, status, surfaces, audit_notes, synced_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')), ?)
    ON CONFLICT(id) DO UPDATE SET
      bundle_name = excluded.bundle_name,
      version_id = excluded.version_id,
      status = excluded.status,
      surfaces = excluded.surfaces,
      audit_notes = excluded.audit_notes,
      synced_at = excluded.synced_at,
      completed_at = excluded.completed_at
  `);
  db.transaction(() => {
    for (const e of entries) {
      const versionId = e.version_id && versionExists.get(e.version_id) ? e.version_id : null;
      upsert.run(
        e.id, e.bundle_name, e.sha256, versionId, e.status,
        JSON.stringify(e.surfaces), e.audit_notes, e.synced_at, e.completed_at,
      );
    }
  })();
  return { synced: entries.length };
}
