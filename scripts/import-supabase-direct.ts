#!/usr/bin/env bun
/**
 * One-time Supabase -> local SQLite importer, DIRECT-DATABASE variant.
 *
 * Use this instead of import-supabase.ts when the Supabase REST API is
 * restricted (e.g. a free-tier project paused/limited for exceeding the edge-
 * function quota — PostgREST returns 402). This connects straight to Postgres
 * through the connection pooler, which is NOT behind the restricted API
 * gateway, so it keeps working without upgrading the plan.
 *
 * SECURITY: needs the Postgres connection string (contains the DB password).
 * Read from the environment only — never written to disk or logged.
 *
 *   SUPABASE_DB_URL='postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:5432/postgres'
 *   ATLAS_DB_PATH=/path/to/atlas.db   (optional; defaults to the app-support location)
 *
 * Get the string from: Supabase dashboard -> Project Settings -> Database ->
 * "Connection string" -> **Session pooler** (IPv4-friendly). Paste your DB
 * password in place of [YOUR-PASSWORD].
 *
 * Run:
 *   SUPABASE_DB_URL='postgresql://...' bun run scripts/import-supabase-direct.ts
 *   # dry run (read + count, write nothing):
 *   SUPABASE_DB_URL='postgresql://...' bun run scripts/import-supabase-direct.ts --dry-run
 */

import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdirSync, existsSync } from "node:fs";

let DB_URL = process.env.SUPABASE_DB_URL ?? "";
const DRY_RUN = process.argv.includes("--dry-run");

const DB_PATH =
  process.env.ATLAS_DB_PATH ??
  join(homedir(), "Library", "Application Support", "com.magnuspilegaard.atlas", "atlas.db");

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "src", "db_schema.sql");

function die(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!DB_URL) {
  die(
    "SUPABASE_DB_URL is required.\n" +
      "  Supabase dashboard → Project Settings → Database → Connection string → Session pooler.\n" +
      "  Put your DB password in place of [YOUR-PASSWORD], then:\n" +
      "  SUPABASE_DB_URL='postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres' bun run scripts/import-supabase-direct.ts",
  );
}
if (!existsSync(SCHEMA_PATH)) die(`schema not found at ${SCHEMA_PATH}`);
// Supabase requires TLS; make sure the pooler connection negotiates it.
if (!/sslmode=/.test(DB_URL)) DB_URL += (DB_URL.includes("?") ? "&" : "?") + "sslmode=require";

// Postgres value -> SQLite bindable. Direct DB rows are already typed (unlike
// PostgREST JSON): Dates, bigints, booleans, and parsed jsonb objects.
function toSqlite(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number" || typeof v === "string") return v;
  return JSON.stringify(v); // jsonb objects & arrays
}

mkdirSync(dirname(DB_PATH), { recursive: true }); // must exist before opening the DB
const db = new Database(DB_PATH, { create: true });
db.exec(readFileSync(SCHEMA_PATH, "utf8")); // idempotent
db.exec("PRAGMA foreign_keys = OFF;"); // bulk load; verify at the end

const localTables = db
  .query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all()
  .map((r) => r.name);

console.log(`\nAtlas Supabase → SQLite import (direct DB)${DRY_RUN ? " — DRY RUN" : ""}`);
console.log(`  target: ${DB_PATH}`);
console.log(`  tables: ${localTables.length}\n`);

const sql = new SQL(DB_URL);
let grandTotal = 0;
const errors: string[] = [];

for (const table of localTables) {
  const localCols = new Set(
    db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all().map((r) => r.name),
  );
  try {
    // Direct SQL — no API gateway, no 1000-row cap.
    const rows = (await sql.unsafe(`SELECT * FROM public."${table}"`)) as Record<string, unknown>[];

    if (!DRY_RUN && rows.length) {
      const tx = db.transaction((batch: Record<string, unknown>[]) => {
        for (const row of batch) {
          const cols = Object.keys(row).filter((c) => localCols.has(c));
          if (cols.length === 0) continue;
          const sqlStr = `INSERT OR REPLACE INTO "${table}" (${cols
            .map((c) => `"${c}"`)
            .join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
          db.query(sqlStr).run(...cols.map((c) => toSqlite(row[c])));
        }
      });
      tx(rows);
    }
    grandTotal += rows.length;
    console.log(`  ${rows.length.toString().padStart(6)}  ${table}`);
  } catch (e) {
    const msg = `${table}: ${(e as Error).message}`;
    errors.push(msg);
    console.log(`  ${"ERR".padStart(6)}  ${table}  — ${(e as Error).message}`);
  }
}

await sql.end();

console.log(`\n  ${grandTotal} rows across ${localTables.length} tables${DRY_RUN ? " (nothing written)" : ""}.`);

if (!DRY_RUN) {
  db.exec("PRAGMA foreign_keys = ON;");
  const violations = db.query("PRAGMA foreign_key_check").all();
  if (violations.length) {
    console.log(`\n⚠ ${violations.length} foreign-key violation(s) (dangling references — usually safe to prune):`);
    for (const v of violations.slice(0, 20)) console.log("   ", JSON.stringify(v));
  } else {
    console.log("  Foreign-key check: clean ✓");
  }
}

db.close();
if (errors.length) {
  console.error(`\n✗ ${errors.length} table(s) failed:`);
  for (const e of errors) console.error("   ", e);
  process.exit(1);
}
console.log("\n✓ Import complete.\n");
