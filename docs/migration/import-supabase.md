# One-time data import: Supabase → local SQLite — SUPERSEDED

**This migration already happened.** Supabase has since been deleted entirely
(Phase 8 of `docs/architecture-local-first-migration.md`), so the source
project this script pointed at no longer exists and it cannot be re-run. Kept
for historical reference only; the scripts it documents (`scripts/import-*.ts`)
are dead one-offs, not part of any current workflow.

Part of the local-first migration (`docs/architecture-local-first-migration.md`,
Phase 1). Copies every existing row out of the live Supabase project into the
on-device `atlas.db` so nothing Atlas has learned is lost at cutover.

## What you need

The Supabase **service-role** key. It bypasses RLS to read all rows (including
the encrypted mail tokens), so the importer can pull a complete snapshot.

- Supabase dashboard → project `gdhdqetwlinlpimpxokp` → **Settings → API →
  Project API keys → `service_role`** (click reveal).
- It is a **secret**. Pass it via the environment only — never paste it into a
  file or commit it. The importer reads it from `SUPABASE_SERVICE_ROLE_KEY`,
  uses it in-memory for the HTTP calls, and never writes or logs it.

## Run it

```bash
# from the helloatlas repo root
SUPABASE_SERVICE_ROLE_KEY='eyJ…service_role…' bun run scripts/import-supabase.ts
```

Optional:

- Preview without writing anything (fetch + counts only):
  ```bash
  SUPABASE_SERVICE_ROLE_KEY='eyJ…' bun run scripts/import-supabase.ts --dry-run
  ```
- Override the source or target:
  ```bash
  SUPABASE_URL='https://…supabase.co' \
  ATLAS_DB_PATH='/custom/atlas.db' \
  SUPABASE_SERVICE_ROLE_KEY='eyJ…' bun run scripts/import-supabase.ts
  ```

By default it writes to the same DB the desktop app opens:
`~/Library/Application Support/com.magnuspilegaard.atlas/atlas.db`
(the app creates this on first launch; the importer creates + applies the
schema itself if it isn't there yet). Safe to run before the app has ever run.

## What it does

- Applies `src-tauri/src/db_schema.sql` (idempotent).
- Imports exactly the tables that exist locally (44), paginating PostgREST at
  1000 rows/request.
- Transforms types to SQLite: `boolean → 0/1`, `jsonb → JSON text`, pgvector
  arrives as a `"[…]"` string and is stored as-is (Phase 3 re-encodes it into
  sqlite-vec). Only columns present in both cloud and local schema are written.
- Bulk-loads with foreign keys **off**, then runs `PRAGMA foreign_key_check`
  and reports any dangling references (rows whose parent was RLS-hidden or
  already deleted — usually safe to prune).
- Idempotent: `INSERT OR REPLACE` by primary key, so re-running is a top-up.

## Verify after import

```bash
sqlite3 ~/Library/Application\ Support/com.magnuspilegaard.atlas/atlas.db \
  "SELECT name, (SELECT count(*) FROM pragma_table_info(name)) cols FROM sqlite_master WHERE type='table' ORDER BY name;"
# spot-check a couple of tables you care about:
sqlite3 ~/Library/Application\ Support/com.magnuspilegaard.atlas/atlas.db \
  "SELECT count(*) FROM ai_memory; SELECT count(*) FROM atlas_knowledge_entries; SELECT count(*) FROM mail_messages;"
```

The importer also prints a per-table row count as it runs.

> Note: this is Phase 1. Reads/writes still go through Supabase until the later
> phases rewire the app onto these local tables; the import just gets the data
> in place so those phases have something to read.
