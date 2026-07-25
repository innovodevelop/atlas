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

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, Once};

use base64::Engine;
use rusqlite::types::{Value as SqlValue, ValueRef};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde_json::{Map, Value as Json};
use tauri::{Emitter, State};

/// The full schema (44 tables + indexes + updated_at triggers), applied
/// idempotently on every open via `CREATE TABLE IF NOT EXISTS`.
const SCHEMA: &str = include_str!("db_schema.sql");

/// Semantic-memory virtual tables (Phase 3): the sqlite-vec KNN index over the
/// 768-dim embeddings + an FTS5 keyword mirror of chunk_text. Kept separate
/// from db_schema.sql because virtual tables require the vec extension loaded
/// first (registered in `ensure_vec_extension`). Embeddings from Gemini are
/// unit-normalized, so default L2 distance ranks identically to cosine and
/// cosine_similarity = 1 - L2^2/2.
const VEC_SCHEMA: &str = "\
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(\
  id TEXT PRIMARY KEY, embedding float[768]);\
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(\
  id UNINDEXED, chunk_text, tokenize='porter unicode61');";

static VEC_INIT: Once = Once::new();

/// Register sqlite-vec as an auto-extension so every connection opened afterward
/// gets the vec0 virtual table. Process-global; safe to call repeatedly.
fn ensure_vec_extension() {
    VEC_INIT.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

/// Managed state: the single long-lived SQLite connection.
pub struct DbState {
    pub conn: Mutex<Connection>,
}

/// Dedupe ai_memory to one row per (user_id, key) BEFORE the schema batch runs:
/// db_schema.sql now carries `CREATE UNIQUE INDEX idx_ai_memory_user_key`, and
/// on a pre-existing DB with duplicate facts that statement would fail unless
/// the duplicates are collapsed first. Keeps the newest row per group (by
/// updated_at, then rowid), sums mention_count into the survivor. Idempotent —
/// a no-op once unique — and safe on a fresh DB (table may not exist yet).
fn migrate_ai_memory(conn: &Connection) -> Result<(), String> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_memory'",
            [],
            |_| Ok(true),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(false);
    if !exists {
        return Ok(());
    }
    // Order matters for launch latency: the dedupe's correlated subquery is a
    // full table scan per row without an index (measured: 40k dirty rows =
    // ~70 s, blocking the window). Build a NON-unique lookup index first, run
    // the dedupe inside a transaction (so a crash can't leave summed counts
    // AND their duplicates behind — a re-run would sum twice), then promote to
    // the unique index the ON CONFLICT upsert targets.
    //
    // `SET updated_at = updated_at` looks redundant but is load-bearing: it
    // suppresses trg_ai_memory_updated, which would otherwise stamp every
    // deduped survivor as brand-new and skew recall's recency scoring against
    // memories that were never duplicated.
    conn.execute_batch(
        "BEGIN IMMEDIATE;
         CREATE INDEX IF NOT EXISTS idx_ai_memory_user_key_scan ON ai_memory(user_id, key);
         WITH survivors AS (
           SELECT (SELECT a2.id FROM ai_memory a2
                    WHERE a2.user_id = a1.user_id AND a2.key = a1.key
                    ORDER BY a2.updated_at DESC, a2.rowid DESC LIMIT 1) AS keep_id,
                  SUM(COALESCE(a1.mention_count, 1)) AS total_mentions
           FROM ai_memory a1 GROUP BY a1.user_id, a1.key HAVING COUNT(*) > 1
         )
         UPDATE ai_memory
            SET mention_count = (SELECT s.total_mentions FROM survivors s WHERE s.keep_id = ai_memory.id),
                updated_at = updated_at
          WHERE id IN (SELECT keep_id FROM survivors);
         DELETE FROM ai_memory WHERE EXISTS (
           SELECT 1 FROM ai_memory a2
            WHERE a2.user_id = ai_memory.user_id AND a2.key = ai_memory.key
              AND (a2.updated_at > ai_memory.updated_at
                   OR (a2.updated_at = ai_memory.updated_at AND a2.rowid > ai_memory.rowid))
         );
         COMMIT;",
    )
    .map_err(|e| format!("ai_memory dedupe migration failed: {e}"))?;

    // Promote to the unique index separately and non-fatally: if any duplicate
    // survived (e.g. legacy rows with a NULL updated_at that the comparisons
    // above can't order), the app must still start — upserts degrade to plain
    // inserts rather than the window never appearing.
    if let Err(e) = conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memory_user_key ON ai_memory(user_id, key);",
    ) {
        eprintln!("[atlas] ai_memory unique index not created (duplicates remain?): {e}");
    }
    Ok(())
}

/// Post-schema reconciliation: forgetting happens in the brain sidecar too
/// (bun:sqlite), which can delete memory_vectors rows but cannot touch the
/// vec0 index (no extension loading there). Purge index entries whose base row
/// is gone so a forgotten memory can't linger as a KNN/FTS candidate.
/// Best-effort by design — recall joins memory_vectors, so residue is a rank
/// artifact, never a data leak; failing here must not brick app startup.
fn reconcile_vector_indexes(conn: &Connection) {
    if let Err(e) = conn.execute_batch(
        "DELETE FROM memory_vec WHERE id NOT IN (SELECT id FROM memory_vectors);\
         DELETE FROM memory_fts WHERE id NOT IN (SELECT id FROM memory_vectors);",
    ) {
        eprintln!("[db] vector-index reconciliation skipped: {e}");
    }
}

impl DbState {
    /// Open (creating if absent) the DB at `path`, set pragmas, ensure schema.
    pub fn open(path: &Path) -> Result<Self, String> {
        ensure_vec_extension();
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;\
             PRAGMA busy_timeout = 5000;\
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| e.to_string())?;
        migrate_ai_memory(&conn)?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        conn.execute_batch(VEC_SCHEMA).map_err(|e| e.to_string())?;
        reconcile_vector_indexes(&conn);
        Ok(DbState { conn: Mutex::new(conn) })
    }

    #[cfg(test)]
    fn open_in_memory() -> Result<Self, String> {
        ensure_vec_extension();
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys = ON;").map_err(|e| e.to_string())?;
        migrate_ai_memory(&conn)?;
        conn.execute_batch(SCHEMA).map_err(|e| e.to_string())?;
        conn.execute_batch(VEC_SCHEMA).map_err(|e| e.to_string())?;
        reconcile_vector_indexes(&conn);
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
// Semantic memory (Phase 3): sqlite-vec + FTS5 port of recall_memories()
// --------------------------------------------------------------------------

/// Pack a float embedding as little-endian f32 bytes (what sqlite-vec expects).
fn embedding_to_blob(v: &[f32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(v.len() * 4);
    for f in v {
        b.extend_from_slice(&f.to_le_bytes());
    }
    b
}

/// Build a safe FTS5 MATCH query from free text: alphanumeric tokens, quoted,
/// OR-combined (mirrors plainto_tsquery's "any term" behavior loosely).
fn fts_query(text: &str) -> Option<String> {
    let toks: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.chars().count() >= 2)
        .map(|t| format!("\"{}\"", t.to_lowercase()))
        .collect();
    if toks.is_empty() {
        None
    } else {
        Some(toks.join(" OR "))
    }
}

const EMBED_DIM: usize = 768;

/// Insert/replace a memory chunk + its embedding across the base table, the
/// vec0 KNN index, and the FTS5 keyword index (kept in lockstep).
fn upsert_vector(
    conn: &Connection,
    id: &str,
    user_id: &str,
    chunk_text: &str,
    embedding: &[f32],
    memory_item_id: Option<&str>,
    knowledge_entry_id: Option<&str>,
) -> Result<(), String> {
    if embedding.len() != EMBED_DIM {
        return Err(format!("embedding must be {EMBED_DIM}-dim, got {}", embedding.len()));
    }
    let blob = embedding_to_blob(embedding);
    conn.execute(
        "INSERT OR REPLACE INTO memory_vectors \
         (id, user_id, memory_item_id, knowledge_entry_id, embedding, chunk_text) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![id, user_id, memory_item_id, knowledge_entry_id, &blob, chunk_text],
    )
    .map_err(|e| e.to_string())?;
    // vec0 has no UPDATE; delete + insert to refresh.
    conn.execute("DELETE FROM memory_vec WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO memory_vec (id, embedding) VALUES (?1, ?2)", params![id, &blob])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM memory_fts WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    conn.execute("INSERT INTO memory_fts (id, chunk_text) VALUES (?1, ?2)", params![id, chunk_text])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Hybrid retrieval — the local port of the Postgres recall_memories() RPC.
/// Blends semantic (sqlite-vec cosine, from normalized embeddings) and lexical
/// (FTS5 bm25) scores, shaped by recency and importance, with the exact weights
/// of the original: 0.65*sim + 0.35*min(fts,1), *(0.5+0.5*recency),
/// *(0.5+importance/20); keep sim>0.25 OR fts>0.05; recency uses created_at
/// with a 65-day decay constant.
fn recall(
    conn: &Connection,
    user_id: &str,
    query_embedding: &[f32],
    query_text: &str,
    match_count: i64,
) -> Result<Json, String> {
    if query_embedding.len() != EMBED_DIM {
        return Err(format!("query embedding must be {EMBED_DIM}-dim, got {}", query_embedding.len()));
    }
    let qblob = embedding_to_blob(query_embedding);
    let k = (match_count.max(1) * 8).max(8);

    // 1. Semantic KNN. Embeddings are unit-normalized, so cosine_sim = 1 - L2^2/2.
    let mut sims: HashMap<String, f64> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT id, distance FROM memory_vec WHERE embedding MATCH ?1 AND k = ?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![qblob, k], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, dist) = row.map_err(|e| e.to_string())?;
            sims.insert(id, (1.0 - dist * dist / 2.0).clamp(0.0, 1.0));
        }
    }

    // 2. Lexical (bm25 is more-negative-is-better; normalize to ~[0,1]).
    let mut ftsm: HashMap<String, f64> = HashMap::new();
    if let Some(q) = fts_query(query_text) {
        let mut stmt = conn
            .prepare("SELECT id, bm25(memory_fts) FROM memory_fts WHERE memory_fts MATCH ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![q], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, bm) = row.map_err(|e| e.to_string())?;
            ftsm.insert(id, (-bm / 10.0).clamp(0.0, 1.0));
        }
    }

    // Candidate union.
    let mut ids: Vec<String> = sims.keys().cloned().collect();
    for id in ftsm.keys() {
        if !sims.contains_key(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return Ok(Json::Array(vec![]));
    }

    // 3. Pull metadata for the candidates (user filter, recency, importance, fakes).
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT mv.id, mv.chunk_text, mv.memory_item_id, mv.knowledge_entry_id, \
                (strftime('%s','now') - strftime('%s', mv.created_at)) AS age, \
                am.importance, am.is_fake, ake.relevance_score, ake.is_fake \
         FROM memory_vectors mv \
         LEFT JOIN ai_memory am ON am.id = mv.memory_item_id \
         LEFT JOIN atlas_knowledge_entries ake ON ake.id = mv.knowledge_entry_id \
         WHERE mv.user_id = ? AND mv.id IN ({placeholders})"
    );
    let mut binds: Vec<SqlValue> = Vec::with_capacity(ids.len() + 1);
    binds.push(SqlValue::Text(user_id.to_string()));
    for id in &ids {
        binds.push(SqlValue::Text(id.clone()));
    }

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query(params_from_iter(binds.iter())).map_err(|e| e.to_string())?;
    let mut scored: Vec<(f64, Json)> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let id: String = row.get(0).map_err(|e| e.to_string())?;
        let chunk: String = row.get(1).map_err(|e| e.to_string())?;
        let mem_id: Option<String> = row.get(2).map_err(|e| e.to_string())?;
        let kn_id: Option<String> = row.get(3).map_err(|e| e.to_string())?;
        let age: Option<i64> = row.get(4).map_err(|e| e.to_string())?;
        let am_imp: Option<i64> = row.get(5).map_err(|e| e.to_string())?;
        let am_fake: Option<i64> = row.get(6).map_err(|e| e.to_string())?;
        let ake_rel: Option<f64> = row.get(7).map_err(|e| e.to_string())?;
        let ake_fake: Option<i64> = row.get(8).map_err(|e| e.to_string())?;

        if am_fake.unwrap_or(0) == 1 || ake_fake.unwrap_or(0) == 1 {
            continue;
        }
        let sim = *sims.get(&id).unwrap_or(&0.0);
        let fts = *ftsm.get(&id).unwrap_or(&0.0);
        if !(sim > 0.25 || fts > 0.05) {
            continue;
        }
        let age_s = age.unwrap_or(0).max(0) as f64;
        let recency = (-age_s / (86400.0 * 65.0)).exp();
        let importance = am_imp
            .map(|i| i as f64)
            .or_else(|| ake_rel.map(|r| (r * 10.0).clamp(1.0, 10.0)))
            .unwrap_or(5.0);
        let score = (0.65 * sim + 0.35 * fts.min(1.0)) * (0.5 + 0.5 * recency) * (0.5 + importance / 20.0);
        scored.push((
            score,
            serde_json::json!({
                "id": id, "chunk_text": chunk, "memory_item_id": mem_id,
                "knowledge_entry_id": kn_id, "score": score, "similarity": sim,
            }),
        ));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let out: Vec<Json> = scored.into_iter().take(match_count.max(0) as usize).map(|(_, j)| j).collect();
    Ok(Json::Array(out))
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
pub fn db_insert(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    table: String,
    values: Json,
) -> Result<Json, String> {
    let out = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        insert(&conn, &table, &values)?
    };
    // Local "realtime": tell listeners the table changed (replaces Supabase
    // postgres_changes channels — the frontend shim re-queries on this).
    let _ = app.emit("db:changed", serde_json::json!({ "table": table, "op": "insert" }));
    Ok(out)
}

#[tauri::command]
pub fn db_update(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    table: String,
    filters: Map<String, Json>,
    patch: Map<String, Json>,
) -> Result<Json, String> {
    let out = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        update(&conn, &table, &filters, &patch)?
    };
    let _ = app.emit("db:changed", serde_json::json!({ "table": table, "op": "update" }));
    Ok(out)
}

#[tauri::command]
pub fn db_delete(
    app: tauri::AppHandle,
    state: State<'_, DbState>,
    table: String,
    filters: Map<String, Json>,
) -> Result<Json, String> {
    let out = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        delete(&conn, &table, &filters)?
    };
    let _ = app.emit("db:changed", serde_json::json!({ "table": table, "op": "delete" }));
    Ok(out)
}

/// Hybrid semantic+lexical memory retrieval (local recall_memories).
#[tauri::command]
pub fn memory_recall(
    state: State<'_, DbState>,
    user_id: String,
    query_embedding: Vec<f32>,
    query_text: String,
    match_count: Option<i64>,
) -> Result<Json, String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    recall(&conn, &user_id, &query_embedding, &query_text, match_count.unwrap_or(12))
}

/// Insert/replace a memory chunk + embedding (base table + vec0 + FTS5).
#[tauri::command]
pub fn memory_upsert_vector(
    state: State<'_, DbState>,
    id: String,
    user_id: String,
    chunk_text: String,
    embedding: Vec<f32>,
    memory_item_id: Option<String>,
    knowledge_entry_id: Option<String>,
) -> Result<(), String> {
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    upsert_vector(
        &conn,
        &id,
        &user_id,
        &chunk_text,
        &embedding,
        memory_item_id.as_deref(),
        knowledge_entry_id.as_deref(),
    )
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

    // A unit basis vector in 768-space (already normalized) for deterministic
    // cosine tests.
    fn basis(i: usize) -> Vec<f32> {
        let mut v = vec![0f32; super::EMBED_DIM];
        v[i] = 1.0;
        v
    }

    #[test]
    fn hybrid_recall_ranks_and_filters() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();

        upsert_vector(&conn, "a", "u", "apple pie recipe", &basis(0), None, None).unwrap();
        upsert_vector(&conn, "b", "u", "quantum physics lecture", &basis(1), None, None).unwrap();
        upsert_vector(&conn, "c", "u", "apple orchard tour", &basis(2), None, None).unwrap();

        // Query identical to a's vector, text mentions "apple".
        let res = recall(&conn, "u", &basis(0), "apple", 5).unwrap();
        let arr = res.as_array().unwrap();

        // a is the nearest vector (sim ~1) AND matches the term -> ranked first.
        assert_eq!(arr[0]["id"], json!("a"));
        assert!(arr[0]["similarity"].as_f64().unwrap() > 0.9);
        // b (orthogonal vector, no "apple") is filtered out by sim>0.25 OR fts>0.05.
        assert!(arr.iter().all(|r| r["id"] != json!("b")));

        // Wrong user sees nothing.
        assert_eq!(recall(&conn, "other", &basis(0), "apple", 5).unwrap().as_array().unwrap().len(), 0);

        // is_fake knowledge is excluded even on a strong vector hit.
        insert(
            &conn,
            "atlas_knowledge_entries",
            &json!({ "id": "k1", "user_id": "u", "topic": "t", "content": "{}", "is_fake": true }),
        )
        .unwrap();
        upsert_vector(&conn, "d", "u", "apple cider", &basis(0), None, Some("k1")).unwrap();
        let res2 = recall(&conn, "u", &basis(0), "apple", 5).unwrap();
        assert!(res2.as_array().unwrap().iter().all(|r| r["id"] != json!("d")));
    }

    #[test]
    fn ai_memory_migration_dedupes_and_is_idempotent() {
        ensure_vec_extension();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        // Pre-Phase-3 DB: same table shape, but no unique (user_id, key) index,
        // so duplicate facts exist. The CREATE TABLE here must stay column-
        // compatible with db_schema.sql (IF NOT EXISTS skips it later).
        conn.execute_batch(
            "CREATE TABLE ai_memory (
               id TEXT PRIMARY KEY, user_id TEXT NOT NULL, memory_type TEXT NOT NULL,
               category TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
               importance INTEGER DEFAULT 5, last_mentioned TEXT, mention_count INTEGER DEFAULT 1,
               is_validated INTEGER DEFAULT 0, is_fake INTEGER DEFAULT 0, validation_score REAL DEFAULT 0,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
               updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
             INSERT INTO ai_memory (id,user_id,memory_type,category,key,value,mention_count,updated_at) VALUES
               ('a','u','fact','personal','car','old',   2, '2026-01-01T00:00:00.000Z'),
               ('b','u','fact','personal','car','new',   3, '2026-02-01T00:00:00.000Z'),
               ('c','v','fact','personal','car','other', 1, '2026-01-15T00:00:00.000Z');",
        )
        .unwrap();

        migrate_ai_memory(&conn).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute_batch(VEC_SCHEMA).unwrap();
        reconcile_vector_indexes(&conn);

        // Newest row survives with the group's summed mention_count; the other
        // user's same key is untouched.
        let (id, value, mentions): (String, String, i64) = conn
            .query_row(
                "SELECT id, value, mention_count FROM ai_memory WHERE user_id='u' AND key='car'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((id.as_str(), value.as_str(), mentions), ("b", "new", 5));
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM ai_memory", [], |r| r.get(0)).unwrap();
        assert_eq!(total, 2);

        // Re-run = no-op (idempotent), and the unique index now enforces the rule.
        migrate_ai_memory(&conn).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        let total2: i64 = conn.query_row("SELECT COUNT(*) FROM ai_memory", [], |r| r.get(0)).unwrap();
        assert_eq!(total2, 2);
        assert!(conn
            .execute(
                "INSERT INTO ai_memory (id,user_id,memory_type,category,key,value)
                 VALUES ('d','u','fact','personal','car','dupe')",
                [],
            )
            .is_err());
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
