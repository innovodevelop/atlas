// Atlas local app database — the SQLite core of the local-first migration
// (docs/architecture-local-first-migration.md, Phase 1). Mirrors the Supabase
// Postgres schema on-device; replaces cloud tables + RLS with one local trust
// boundary. Analytics stay in DuckDB (portfolio_db.rs); this is the OLTP store.
//
// Unlike portfolio_db (fresh DuckDB connection per command), this is a hot
// transactional DB, so ONE WAL-mode connection lives behind a Mutex, registered
// with `.manage()` (same shape as MusicState) and opened once in lib.rs setup().
//
// The command surface is intentionally GENERIC — db_select/insert/update/delete
// take a table name + JSON, mirroring the `supabase.from(table)...` builder the
// frontend already speaks. The Phase 4 supabase-shim routes .from() calls here,
// so we don't hand-write 44 tables' worth of commands. All identifiers are
// validated against the live schema (sqlite_master / table_info) before they
// touch SQL; all values are bound parameters — no string interpolation of data.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use base64::Engine;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params_from_iter, Connection, OptionalExtension};
use serde_json::{Map, Value as Json};
use tauri::State;

/// The full schema (44 tables + indexes + updated_at triggers), applied
/// idempotently on every open via `CREATE TABLE IF NOT EXISTS`.
const SCHEMA: &str = include_str!("db_schema.sql");

/// Managed state: the single long-lived SQLite connection.
pub struct DbState {
    pub conn: Mutex<Connection>,
}

impl DbState {
    /// Open (creating if absent) the DB at `path`, set pragmas, ensure schema.
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;\
             PRAGMA busy_timeout = 5000;\
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(DbState { conn: Mutex::new(conn) })
    }

    #[cfg(test)]
    fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        Ok(DbState { conn: Mutex::new(conn) })
    }
}

// --------------------------------------------------------------------------
// JSON <-> SQLite value bridging
// --------------------------------------------------------------------------

/// Bind a JSON value to SQLite. Objects/arrays become JSON text (our jsonb
/// columns are TEXT); booleans become 0/1; numbers keep int/float shape.
fn json_to_sql(v: &Json) -> SqlValue {
    match v {
        Json::Null => SqlValue::Null,
        Json::Bool(b) => SqlValue::Integer(if *b { 1 } else { 0 }),
        Json::Number(n) => n
            .as_i64()
            .map(SqlValue::Integer)
            .unwrap_or_else(|| SqlValue::Real(n.as_f64().unwrap_or(0.0))),
        Json::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

/// Read a SQLite value back to JSON. Note: jsonb columns come back as JSON
/// *strings* (their stored text) — the Phase 4 shim re-parses known-jsonb
/// columns; the raw DB layer stays type-agnostic.
fn sql_to_json(v: ValueRef) -> Json {
    match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => Json::from(i),
        ValueRef::Real(f) => Json::from(f),
        ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => Json::String(base64::engine::general_purpose::STANDARD.encode(b)),
    }
}

// --------------------------------------------------------------------------
// Identifier validation (defends every SQL string built below)
// --------------------------------------------------------------------------

fn is_ident(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        && !s.as_bytes()[0].is_ascii_digit()
}

/// Confirm `table` is a real table and return its column set. Rejects anything
/// not matching a row in sqlite_master, so a table name can never inject SQL.
fn table_columns(conn: &Connection, table: &str) -> Result<HashSet<String>, String> {
    if !is_ident(table) {
        return Err(format!("invalid table name: {table}"));
    }
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?1",
            [table],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);
    if !exists {
        return Err(format!("unknown table: {table}"));
    }
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{table}\")"))
        .map_err(|e| e.to_string())?;
    let cols = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(cols)
}

fn check_col(cols: &HashSet<String>, col: &str) -> Result<(), String> {
    if is_ident(col) && cols.contains(col) {
        Ok(())
    } else {
        Err(format!("unknown column: {col}"))
    }
}

/// Materialise a prepared query's rows into a JSON array of objects.
fn query_to_json(stmt: &mut rusqlite::Statement, binds: &[SqlValue]) -> Result<Json, String> {
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query(params_from_iter(binds.iter())).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut obj = Map::with_capacity(names.len());
        for (i, name) in names.iter().enumerate() {
            let vr = row.get_ref(i).map_err(|e| e.to_string())?;
            obj.insert(name.clone(), sql_to_json(vr));
        }
        out.push(Json::Object(obj));
    }
    Ok(Json::Array(out))
}

// --------------------------------------------------------------------------
// Core CRUD (free functions — unit-testable with an in-memory connection)
// --------------------------------------------------------------------------

/// `filters` are equality clauses (col = value), AND-combined — the common
/// `.eq('user_id', x).eq('id', y)` case. Richer operators land in the shim.
fn select(
    conn: &Connection,
    table: &str,
    filters: &Map<String, Json>,
    order_by: Option<&str>,
    ascending: bool,
    limit: Option<i64>,
) -> Result<Json, String> {
    let cols = table_columns(conn, table)?;
    let mut sql = format!("SELECT * FROM \"{table}\"");
    let mut binds: Vec<SqlValue> = Vec::new();
    if !filters.is_empty() {
        let mut clauses = Vec::new();
        for (k, v) in filters {
            check_col(&cols, k)?;
            clauses.push(format!("\"{k}\" = ?"));
            binds.push(json_to_sql(v));
        }
        sql.push_str(&format!(" WHERE {}", clauses.join(" AND ")));
    }
    if let Some(ob) = order_by {
        check_col(&cols, ob)?;
        sql.push_str(&format!(" ORDER BY \"{ob}\" {}", if ascending { "ASC" } else { "DESC" }));
    }
    if let Some(l) = limit {
        sql.push_str(&format!(" LIMIT {}", l.max(0)));
    }
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    query_to_json(&mut stmt, &binds)
}

/// Insert one row (a JSON object). A missing `id` is generated (uuid v4) when
/// the table has an `id` column, matching Supabase's server-side default.
/// Returns the inserted row via RETURNING *.
fn insert_one(conn: &Connection, table: &str, row: &Map<String, Json>) -> Result<Json, String> {
    let cols = table_columns(conn, table)?;
    let mut keys: Vec<String> = Vec::new();
    let mut binds: Vec<SqlValue> = Vec::new();

    let has_id_provided = row.contains_key("id");
    for (k, v) in row {
        check_col(&cols, k)?;
        keys.push(k.clone());
        binds.push(json_to_sql(v));
    }
    if !has_id_provided && cols.contains("id") {
        keys.push("id".to_string());
        binds.push(SqlValue::Text(uuid::Uuid::new_v4().to_string()));
    }
    if keys.is_empty() {
        return Err("insert: no valid columns".into());
    }
    let placeholders = vec!["?"; keys.len()].join(",");
    let col_list = keys.iter().map(|k| format!("\"{k}\"")).collect::<Vec<_>>().join(",");
    let sql = format!("INSERT INTO \"{table}\" ({col_list}) VALUES ({placeholders}) RETURNING *");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = query_to_json(&mut stmt, &binds)?;
    // RETURNING yields the single inserted row.
    Ok(rows.as_array().and_then(|a| a.first().cloned()).unwrap_or(Json::Null))
}

/// Insert an object or an array of objects; returns an array of inserted rows.
fn insert(conn: &Connection, table: &str, values: &Json) -> Result<Json, String> {
    let rows: Vec<&Map<String, Json>> = match values {
        Json::Object(o) => vec![o],
        Json::Array(a) => a
            .iter()
            .map(|v| v.as_object().ok_or_else(|| "insert: array items must be objects".to_string()))
            .collect::<Result<_, _>>()?,
        _ => return Err("insert: values must be an object or array of objects".into()),
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(insert_one(conn, table, row)?);
    }
    Ok(Json::Array(out))
}

/// Update rows matching `filters` (equality, AND). Filters must be non-empty —
/// a guard against accidental whole-table updates. Returns updated rows.
fn update(
    conn: &Connection,
    table: &str,
    filters: &Map<String, Json>,
    patch: &Map<String, Json>,
) -> Result<Json, String> {
    if filters.is_empty() {
        return Err("update requires at least one filter".into());
    }
    if patch.is_empty() {
        return Err("update requires at least one column".into());
    }
    let cols = table_columns(conn, table)?;
    let mut binds: Vec<SqlValue> = Vec::new();

    let mut sets = Vec::new();
    for (k, v) in patch {
        check_col(&cols, k)?;
        sets.push(format!("\"{k}\" = ?"));
        binds.push(json_to_sql(v));
    }
    let mut wheres = Vec::new();
    for (k, v) in filters {
        check_col(&cols, k)?;
        wheres.push(format!("\"{k}\" = ?"));
        binds.push(json_to_sql(v));
    }
    let sql = format!(
        "UPDATE \"{table}\" SET {} WHERE {} RETURNING *",
        sets.join(","),
        wheres.join(" AND ")
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    query_to_json(&mut stmt, &binds)
}

/// Delete rows matching `filters` (equality, AND). Non-empty filters required.
/// Returns the deleted rows.
fn delete(conn: &Connection, table: &str, filters: &Map<String, Json>) -> Result<Json, String> {
    if filters.is_empty() {
        return Err("delete requires at least one filter".into());
    }
    let cols = table_columns(conn, table)?;
    let mut binds: Vec<SqlValue> = Vec::new();
    let mut wheres = Vec::new();
    for (k, v) in filters {
        check_col(&cols, k)?;
        wheres.push(format!("\"{k}\" = ?"));
        binds.push(json_to_sql(v));
    }
    let sql = format!("DELETE FROM \"{table}\" WHERE {} RETURNING *", wheres.join(" AND "));
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    query_to_json(&mut stmt, &binds)
}

// --------------------------------------------------------------------------
// Tauri commands (thin wrappers over the core fns)
// --------------------------------------------------------------------------

#[tauri::command]
pub fn db_select(
    state: State<'_, DbState>,
    table: String,
    filters: Option<Map<String, Json>>,
    order_by: Option<String>,
    ascending: Option<bool>,
    limit: Option<i64>,
) -> Result<Json, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    select(
        &conn,
        &table,
        &filters.unwrap_or_default(),
        order_by.as_deref(),
        ascending.unwrap_or(true),
        limit,
    )
}

#[tauri::command]
pub fn db_insert(state: State<'_, DbState>, table: String, values: Json) -> Result<Json, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    insert(&conn, &table, &values)
}

#[tauri::command]
pub fn db_update(
    state: State<'_, DbState>,
    table: String,
    filters: Map<String, Json>,
    patch: Map<String, Json>,
) -> Result<Json, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    update(&conn, &table, &filters, &patch)
}

#[tauri::command]
pub fn db_delete(
    state: State<'_, DbState>,
    table: String,
    filters: Map<String, Json>,
) -> Result<Json, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    delete(&conn, &table, &filters)
}

/// One row of `db_info`: a table and its current row count.
#[derive(serde::Serialize)]
pub struct TableInfo {
    pub name: String,
    pub rows: i64,
}

/// Verification command: list every app table with its row count.
#[tauri::command]
pub fn db_info(state: State<'_, DbState>) -> Result<Vec<TableInfo>, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let names: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master \
                 WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .map_err(|e| e.to_string())?;
        let collected = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        collected
    };
    let mut out = Vec::with_capacity(names.len());
    for name in names {
        let count: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM \"{name}\""), [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        out.push(TableInfo { name, rows: count });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Json) -> Map<String, Json> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn insert_select_update_delete_roundtrip() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();

        // insert with an explicit id, jsonb value, and a boolean
        let inserted = insert(
            &conn,
            "user_tasks",
            &json!({ "id": "t1", "user_id": "u1", "title": "buy milk", "completed": false }),
        )
        .unwrap();
        assert_eq!(inserted.as_array().unwrap().len(), 1);
        assert_eq!(inserted[0]["title"], json!("buy milk"));
        assert_eq!(inserted[0]["completed"], json!(0)); // bool -> 0

        // insert without id -> generated uuid
        let gen = insert(&conn, "user_tasks", &json!({ "user_id": "u1", "title": "walk dog" })).unwrap();
        let gen_id = gen[0]["id"].as_str().unwrap();
        assert_eq!(gen_id.len(), 36); // uuid v4

        // select with filter
        let rows = select(&conn, "user_tasks", &obj(json!({ "user_id": "u1" })), Some("title"), true, None).unwrap();
        assert_eq!(rows.as_array().unwrap().len(), 2);
        assert_eq!(rows[0]["title"], json!("buy milk")); // ASC by title

        // update (also proves the updated_at trigger path doesn't blow up)
        let updated = update(
            &conn,
            "user_tasks",
            &obj(json!({ "id": "t1" })),
            &obj(json!({ "completed": true, "title": "buy oat milk" })),
        )
        .unwrap();
        assert_eq!(updated[0]["completed"], json!(1));
        assert_eq!(updated[0]["title"], json!("buy oat milk"));

        // delete
        let deleted = delete(&conn, "user_tasks", &obj(json!({ "id": "t1" }))).unwrap();
        assert_eq!(deleted.as_array().unwrap().len(), 1);
        let remaining = select(&conn, "user_tasks", &Map::new(), None, true, None).unwrap();
        assert_eq!(remaining.as_array().unwrap().len(), 1);
    }

    #[test]
    fn rejects_bad_identifiers_and_guards() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();

        // injection / unknown table
        assert!(select(&conn, "user_tasks; DROP TABLE user_tasks", &Map::new(), None, true, None).is_err());
        assert!(select(&conn, "no_such_table", &Map::new(), None, true, None).is_err());
        // unknown column
        assert!(select(&conn, "user_tasks", &obj(json!({ "nope": 1 })), None, true, None).is_err());
        // unfiltered update/delete are refused
        assert!(update(&conn, "user_tasks", &Map::new(), &obj(json!({ "title": "x" }))).is_err());
        assert!(delete(&conn, "user_tasks", &Map::new()).is_err());
    }
}
