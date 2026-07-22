// Atlas local app database — the SQLite core of the local-first migration
// (docs/architecture-local-first-migration.md, Phase 1). Mirrors the Supabase
// Postgres schema on-device; replaces cloud tables + RLS with one local trust
// boundary. Analytics stay in DuckDB (portfolio_db.rs); this is the OLTP store.
//
// Unlike portfolio_db (which opens a fresh DuckDB connection per command), this
// is a hot, frequently-hit transactional DB, so we keep ONE WAL-mode connection
// alive behind a Mutex and register it with `.manage()` — same shape as
// MusicState. Opened once in lib.rs `.setup()` where the AppHandle can resolve
// the app-data dir.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::State;

/// The full schema (43 tables + indexes + updated_at triggers), applied
/// idempotently on every open via `CREATE TABLE IF NOT EXISTS`.
const SCHEMA: &str = include_str!("db_schema.sql");

/// Managed state: the single long-lived SQLite connection.
pub struct DbState {
    pub conn: Mutex<Connection>,
}

impl DbState {
    /// Open (creating if absent) the DB at `path`, set the pragmas, and ensure
    /// the schema exists. Errors are stringified to match the house style
    /// (commands return `Result<_, String>` → JS promise rejection).
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        // WAL: concurrent reads while a write is in flight (the UI reads a lot).
        // busy_timeout: wait rather than SQLITE_BUSY under contention.
        // foreign_keys: enforce the app-internal FKs (off by default in SQLite).
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;\
             PRAGMA busy_timeout = 5000;\
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(DbState { conn: Mutex::new(conn) })
    }
}

/// One row of `db_info`: a table and its current row count.
#[derive(serde::Serialize)]
pub struct TableInfo {
    pub name: String,
    pub rows: i64,
}

/// Phase-1 verification command: list every app table with its row count.
/// Proves the schema was created and the managed connection is live; the
/// frontend/debug tools can call it to confirm the local DB is healthy.
#[tauri::command]
pub fn db_info(state: State<'_, DbState>) -> Result<Vec<TableInfo>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let names: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master \
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
                 ORDER BY name",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
    };

    let mut out = Vec::with_capacity(names.len());
    for name in names {
        // Table names come from sqlite_master (trusted), quoted defensively.
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM \"{name}\""), [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        out.push(TableInfo { name, rows: count });
    }
    Ok(out)
}
