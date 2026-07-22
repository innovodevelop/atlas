#!/usr/bin/env bun
/**
 * One-time Supabase -> local SQLite importer (local-first migration, Phase 1).
 *
 * Pulls every row of every mirrored table out of the live Supabase project via
 * PostgREST and writes it into the on-device atlas.db that the Tauri app uses.
 * Idempotent: re-running REPLACEs rows by primary key, so it's safe to run more
 * than once (e.g. a top-up right before cutover).
 *
 * SECURITY: this needs the Supabase **service-role** key (it bypasses RLS to
 * read all users' rows and the encrypted mail tokens). That key is a secret —
 * it is read from the environment and never written to disk or logged. Do NOT
 * paste it into source or commit it.
 *
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ...   (required — Supabase → Settings → API → service_role)
 *   SUPABASE_URL=https://gdhdqetwlinlpimpxokp.supabase.co   (optional; this is the default)
 *   ATLAS_DB_PATH=/path/to/atlas.db    (optional; defaults to the app-support location)
 *
 * Run:
 *   SUPABASE_SERVICE_ROLE_KEY=... bun run scripts/import-supabase.ts
 *   # dry run (fetch + count, write nothing):
 *   SUPABASE_SERVICE_ROLE_KEY=... bun run scripts/import-supabase.ts --dry-run
 */

import { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';

const SUPABASE_URL = (process.env.SUPABASE_URL ?? 'https://gdhdqetwlinlpimpxokp.supabase.co').replace(/\/$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const DRY_RUN = process.argv.includes('--dry-run');
const PAGE = 1000; // PostgREST default max rows per request

const DB_PATH =
  process.env.ATLAS_DB_PATH ??
  join(homedir(), 'Library', 'Application Support', 'com.magnuspilegaard.atlas', 'atlas.db');

// Schema lives next to db.rs; apply it so the importer works standalone (before
// the app has ever been launched to create the DB itself).
const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'src', 'db_schema.sql');

function die(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

if (!SERVICE_KEY) {
  die(
    'SUPABASE_SERVICE_ROLE_KEY is required.\n' +
      '  Get it from Supabase → Project Settings → API → "service_role" (secret).\n' +
      '  Run:  SUPABASE_SERVICE_ROLE_KEY=eyJ... bun run scripts/import-supabase.ts',
  );
}
if (!existsSync(SCHEMA_PATH)) die(`schema not found at ${SCHEMA_PATH}`);

// Convert a PostgREST JSON value to something bun:sqlite can bind.
//   boolean            -> 0/1
//   object/array (json)-> JSON string  (our jsonb columns are TEXT)
//   pgvector           -> arrives as a "[...]" string already; stored as-is
//   number/string/null -> unchanged
function toSqlite(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string') return v;
  return JSON.stringify(v); // objects & arrays
}

async function fetchPage(table: string, offset: number): Promise<Record<string, unknown>[]> {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=*&limit=${PAGE}&offset=${offset}`;
  const res = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (res.status === 404) return [] as Record<string, unknown>[]; // table not in cloud — skip
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${table} → ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as Record<string, unknown>[];
}

mkdirSync(dirname(DB_PATH), { recursive: true }); // must exist before opening the DB
const db = new Database(DB_PATH, { create: true });
db.exec(readFileSync(SCHEMA_PATH, 'utf8')); // idempotent (CREATE ... IF NOT EXISTS)
db.exec('PRAGMA foreign_keys = OFF;'); // bulk load; verify integrity at the end

// Import exactly the tables that exist locally (source of truth = the schema we
// just applied), so we never try to write a table the mirror doesn't have.
const localTables = db
  .query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all()
  .map((r) => r.name);

console.log(`\nAtlas Supabase → SQLite import${DRY_RUN ? ' (DRY RUN)' : ''}`);
console.log(`  source: ${SUPABASE_URL}`);
console.log(`  target: ${DB_PATH}`);
console.log(`  tables: ${localTables.length}\n`);

let grandTotal = 0;
const errors: string[] = [];

for (const table of localTables) {
  // Local columns for this table — only import intersecting keys.
  const localCols = new Set(
    db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all().map((r) => r.name),
  );

  let offset = 0;
  let imported = 0;
  try {
    for (;;) {
      const rows = await fetchPage(table, offset);
      if (rows.length === 0) break;

      if (!DRY_RUN) {
        const tx = db.transaction((batch: Record<string, unknown>[]) => {
          for (const row of batch) {
            const cols = Object.keys(row).filter((c) => localCols.has(c));
            if (cols.length === 0) continue;
            const placeholders = cols.map(() => '?').join(',');
            const sql = `INSERT OR REPLACE INTO "${table}" (${cols
              .map((c) => `"${c}"`)
              .join(',')}) VALUES (${placeholders})`;
            db.query(sql).run(...cols.map((c) => toSqlite(row[c])));
          }
        });
        tx(rows);
      }

      imported += rows.length;
      offset += rows.length;
      if (rows.length < PAGE) break;
    }
    grandTotal += imported;
    console.log(`  ${imported.toString().padStart(6)}  ${table}`);
  } catch (e) {
    const msg = `${table}: ${(e as Error).message}`;
    errors.push(msg);
    console.log(`  ${'ERR'.padStart(6)}  ${table}  — ${(e as Error).message}`);
  }
}

console.log(`\n  ${grandTotal} rows across ${localTables.length} tables${DRY_RUN ? ' (nothing written)' : ''}.`);

if (!DRY_RUN) {
  db.exec('PRAGMA foreign_keys = ON;');
  const violations = db.query('PRAGMA foreign_key_check').all();
  if (violations.length) {
    console.log(`\n⚠ ${violations.length} foreign-key violation(s) after import (dangling references):`);
    for (const v of violations.slice(0, 20)) console.log('   ', JSON.stringify(v));
    if (violations.length > 20) console.log(`    …and ${violations.length - 20} more`);
    console.log('  (These are rows whose parent was RLS-hidden or already deleted; usually safe to prune.)');
  } else {
    console.log('  Foreign-key check: clean ✓');
  }
}

db.close();
if (errors.length) {
  console.error(`\n✗ ${errors.length} table(s) failed:`);
  for (const e of errors) console.error('   ', e);
  process.exit(1);
}
console.log('\n✓ Import complete.\n');
