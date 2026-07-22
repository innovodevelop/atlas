#!/usr/bin/env bun
/**
 * One-time Supabase -> local SQLite importer, DIRECT-DATABASE variant.
 *
 * Use this when the Supabase REST API is restricted (free-tier project limited
 * for exceeding the edge-function quota — PostgREST returns 402). This connects
 * straight to Postgres through the connection pooler, which is NOT behind the
 * restricted API gateway, so data can be pulled without upgrading the plan.
 *
 * Uses postgres.js (reliable SSL + pooler handling) rather than Bun's native
 * SQL client, which can segfault on connection failures.
 *
 * SECURITY: needs the DB password. Passed via env (SUPABASE_DB_PASSWORD), used
 * literally — so special characters can't corrupt a connection URL — never
 * written to disk or logged.
 *
 * Two env vars:
 *   SUPABASE_DB_URL       the Session-pooler connection string, pasted VERBATIM
 *                         from Supabase (you may leave the literal
 *                         [YOUR-PASSWORD] placeholder in it — the password is
 *                         supplied separately below). Gives host/port/user/db.
 *   SUPABASE_DB_PASSWORD  your database password (literal, no URL-encoding).
 *   ATLAS_DB_PATH         optional; defaults to the app-support location.
 *
 * Get the string from: Supabase dashboard -> Project Settings -> Database ->
 * Connection string -> **Session pooler** (IPv4-friendly).
 *
 * Run:
 *   SUPABASE_DB_URL='postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres' \
 *   SUPABASE_DB_PASSWORD='your-db-password' \
 *   bun run scripts/import-supabase-direct.ts --dry-run
 */

import postgres from "postgres";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, mkdirSync, existsSync } from "node:fs";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const DB_PASSWORD_ENV = process.env.SUPABASE_DB_PASSWORD ?? "";
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
    "SUPABASE_DB_URL is required (Supabase → Settings → Database → Connection string → Session pooler).\n" +
      "  Paste it verbatim (the [YOUR-PASSWORD] placeholder is fine) and give the password separately:\n" +
      "  SUPABASE_DB_URL='postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres' \\\n" +
      "  SUPABASE_DB_PASSWORD='your-db-password' bun run scripts/import-supabase-direct.ts",
  );
}
if (!existsSync(SCHEMA_PATH)) die(`schema not found at ${SCHEMA_PATH}`);

// Parse host/port/user/db from the URL without tripping over the password
// (mask it first so `new URL` always parses, even with the [YOUR-PASSWORD]
// placeholder or special characters).
const m = DB_URL.match(/^postgres(?:ql)?:\/\/([^:@/]+):([^@]*)@/i);
const urlPassword = m ? m[1 + 1] : ""; // group 2 = password in the URL
const masked = DB_URL.replace(/^(postgres(?:ql)?:\/\/[^:@/]+:)[^@]*@/i, "$1x@");
let host: string, port: number, user: string, database: string;
try {
  const u = new URL(masked);
  host = u.hostname;
  port = Number(u.port || 5432);
  user = decodeURIComponent(u.username);
  database = (u.pathname.replace(/^\//, "").split("?")[0]) || "postgres";
} catch {
  die(`could not parse SUPABASE_DB_URL — expected postgresql://user:pass@host:port/db`);
}

// Prefer the separately-supplied password; else the one embedded in the URL.
// Reject the literal placeholder.
let password = DB_PASSWORD_ENV || (urlPassword && urlPassword !== "[YOUR-PASSWORD]" ? decodeURIComponent(urlPassword) : "");
if (!password || password === "[YOUR-PASSWORD]") {
  die("No DB password. Set SUPABASE_DB_PASSWORD='your-db-password' (or put it into the URL).");
}

// Postgres value -> SQLite bindable. postgres.js returns native types.
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
console.log(`  source: ${user}@${host}:${port}/${database}`);
console.log(`  target: ${DB_PATH}`);
console.log(`  tables: ${localTables.length}\n`);

// One connection, SSL required (Supabase). postgres.js handles the pooler.
const sql = postgres({
  host,
  port,
  user,
  password,
  database,
  ssl: "require",
  max: 1,
  idle_timeout: 20,
  connect_timeout: 15,
  onnotice: () => {},
});

let grandTotal = 0;
const errors: string[] = [];

try {
  for (const table of localTables) {
    const localCols = new Set(
      db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all().map((r) => r.name),
    );
    try {
      const rows = (await sql.unsafe(`SELECT * FROM public."${table}"`)) as unknown as Record<string, unknown>[];

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
      errors.push(`${table}: ${(e as Error).message}`);
      console.log(`  ${"ERR".padStart(6)}  ${table}  — ${(e as Error).message}`);
    }
  }
} finally {
  await sql.end({ timeout: 5 });
}

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
  // If EVERY table failed, it's a connection problem, not per-table data.
  if (errors.length === localTables.length) {
    console.error(
      `\n✗ Could not read any table — this is a connection failure, not your data.\n` +
        `  First error: ${errors[0]}\n` +
        `  Checklist: use the **Session pooler** string (host aws-0-<region>.pooler.supabase.com),\n` +
        `  the DB password (not the API key), and SUPABASE_DB_PASSWORD set. If it says the project\n` +
        `  is paused, the DB itself is down and only un-pausing / quota reset will help.\n`,
    );
  } else {
    console.error(`\n✗ ${errors.length} table(s) failed:`);
    for (const e of errors) console.error("   ", e);
  }
  process.exit(1);
}
console.log("\n✓ Import complete.\n");
