// System Status's native half (Beta redesign, rows 75, 78 and 79).
//
//   storage     How much of this Mac Atlas takes, in bytes: atlas.db on disk,
//               how much of it is memory, the mail cache and the audit trail
//               (SQLite's own page accounting, the `dbstat` table the bundled
//               SQLite is compiled with), and the on-device models.
//   versions    Which version of this app ran when, recorded once per launch,
//               so the screen can say "up for 14 days since the last update"
//               and list installs and updates under Recently.
//   home        A live, timed check of the linked Home Assistant bridge: one
//               authenticated GET of `/api/`, the cheapest call HA answers.
//
// Nothing here writes anywhere but `atlas_app_versions`, and nothing leaves
// the Mac except the Home Assistant check, which goes to the bridge address the
// user linked, on their own network.
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::db::DbState;

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------
// Versions (row 78)
// ---------------------------------------------------------------------------

/// Record `version` for `bundle` when it differs from the last version that
/// bundle recorded. Keyed by bundle because Atlas.app and Lighthouse.app share
/// one atlas.db and are updated separately; a row per CHANGE (not per version)
/// so a downgrade and the re-update after it both count as events.
pub fn note_version(conn: &Connection, bundle: &str, version: &str, at: &str) -> rusqlite::Result<bool> {
    let last: Option<String> = conn
        .query_row(
            "SELECT version FROM atlas_app_versions WHERE bundle_id = ?1 ORDER BY id DESC LIMIT 1",
            params![bundle],
            |r| r.get(0),
        )
        .optional()?;
    if last.as_deref() == Some(version) {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO atlas_app_versions (bundle_id, version, previous_version, first_seen_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![bundle, version, last, at],
    )?;
    Ok(true)
}

/// Called once from `setup`, right after the database opens. A failure is
/// logged and ignored: a missing history line must never stop the app starting.
pub fn record_launch(app: &AppHandle) {
    let version = app.package_info().version.to_string();
    let bundle = crate::appdata::running_bundle_id(crate::BUNDLE_ID);
    let state = app.state::<DbState>();
    let Ok(conn) = state.conn.lock() else {
        log::warn!("[system] database lock poisoned; app version not recorded");
        return;
    };
    match note_version(&conn, &bundle, &version, &now_iso()) {
        Ok(true) => log::info!("[system] {bundle} {version} recorded as running on this Mac"),
        Ok(false) => {}
        Err(e) => log::warn!("[system] could not record the app version: {e}"),
    }
}

/// This bundle's running version and its recorded history, newest first.
#[tauri::command]
pub fn system_app_history(app: AppHandle, state: State<'_, DbState>) -> Result<Value, String> {
    let version = app.package_info().version.to_string();
    let bundle = crate::appdata::running_bundle_id(crate::BUNDLE_ID);
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT version, previous_version, first_seen_at FROM atlas_app_versions
             WHERE bundle_id = ?1 ORDER BY id DESC LIMIT 20",
        )
        .map_err(|e| e.to_string())?;
    let history = stmt
        .query_map(params![bundle], |r| {
            Ok(json!({
                "version": r.get::<_, String>(0)?,
                "previous_version": r.get::<_, Option<String>>(1)?,
                "first_seen_at": r.get::<_, String>(2)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(json!({ "bundle_id": bundle, "version": version, "history": history }))
}

// ---------------------------------------------------------------------------
// Storage (row 79)
// ---------------------------------------------------------------------------

/// Which of the design's rows a table's pages belong to. The audit trail is the
/// list db.rs guards, so `mail_audit_events` counts as audit, not mail.
pub fn category(table: &str) -> &'static str {
    if crate::db::AUDIT_TABLES.contains(&table) {
        "audit"
    } else if table.starts_with("mail_") {
        "mail"
    } else if table == "ai_memory" || table.starts_with("memory_") || table == "atlas_knowledge_entries" {
        // memory_vectors, plus the shadow tables of the memory_vec / memory_fts
        // virtual tables, which is where most of memory's bytes are.
        "memory"
    } else {
        "other"
    }
}

/// Bytes of pages per table, with each index's pages counted under the table it
/// indexes. `dbstat` walks every b-tree, so this runs on a separate read-only
/// connection (see `system_storage`) rather than under the app's database lock.
pub fn page_bytes_by_table(conn: &Connection) -> rusqlite::Result<Vec<(String, u64)>> {
    let owner: std::collections::HashMap<String, String> = {
        let mut stmt = conn.prepare("SELECT name, tbl_name FROM sqlite_master")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let per_btree: Vec<(String, i64)> = {
        // `aggregate = TRUE` makes dbstat answer one row per b-tree instead of
        // one per page; it needs SQLite 3.31, which the bundled build is past.
        let mut stmt = conn.prepare("SELECT name, pgsize FROM dbstat WHERE aggregate = TRUE")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut by_table: std::collections::BTreeMap<String, u64> = Default::default();
    for (name, bytes) in per_btree {
        let table = owner.get(&name).cloned().unwrap_or(name);
        *by_table.entry(table).or_default() += bytes.max(0) as u64;
    }
    Ok(by_table.into_iter().collect())
}

#[derive(Default, Debug, PartialEq)]
pub struct Parts {
    pub memory: u64,
    pub mail: u64,
    pub audit: u64,
    pub other: u64,
}

pub fn split_parts(tables: &[(String, u64)]) -> Parts {
    let mut p = Parts::default();
    for (name, bytes) in tables {
        match category(name) {
            "memory" => p.memory += bytes,
            "mail" => p.mail += bytes,
            "audit" => p.audit += bytes,
            _ => p.other += bytes,
        }
    }
    p
}

fn file_bytes(path: &Path) -> u64 {
    fs::symlink_metadata(path).map(|m| if m.is_file() { m.len() } else { 0 }).unwrap_or(0)
}

/// Every regular file under `dir`. Symlinks are not followed: a linked folder
/// is somebody else's bytes, and following one could walk out of the tree.
fn dir_bytes(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_bytes(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

/// The models Atlas runs on this Mac, and where they were measured.
///
/// In the installed app the models are compiled INTO the two sidecars (the
/// brain carries the multilingual-e5 embedder, the voice gateway its VAD), so
/// the sidecar binaries are what they weigh on disk. From a source checkout
/// (`tauri dev`, no sidecars beside the executable) the model folders are
/// measured instead. Neither found: no figure, rather than a zero.
fn models_on_disk() -> Option<(u64, &'static str)> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let sidecars: Vec<PathBuf> = ["atlas-brain", "atlas-voice-gateway"].iter().map(|n| exe_dir.join(n)).collect();
    if sidecars.iter().any(|p| p.is_file()) {
        return Some((sidecars.iter().map(|p| file_bytes(p)).sum(), "sidecars"));
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent()?;
    let dirs: Vec<PathBuf> = ["services/atlas-brain/models", "services/voice-gateway/models", "public/models"]
        .iter()
        .map(|d| root.join(d))
        .collect();
    if dirs.iter().any(|d| d.is_dir()) {
        return Some((dirs.iter().map(|d| dir_bytes(d)).sum(), "checkout"));
    }
    None
}

/// Bytes on disk, per the design's "On this Mac" rows. Read once per visit and
/// on "Check again" — a `dbstat` walk is proportional to the database size.
#[tauri::command(async)]
pub fn system_storage(state: State<'_, DbState>) -> Result<Value, String> {
    let path: String = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.path().map(str::to_string).filter(|p| !p.is_empty()).ok_or("atlas.db has no file on disk")?
    };
    let db = Path::new(&path);
    let main_bytes = file_bytes(db);
    let wal_bytes = file_bytes(Path::new(&format!("{path}-wal")));

    // WAL mode lets this reader walk the pages while the app keeps writing.
    let pages = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .and_then(|c| {
            c.busy_timeout(Duration::from_secs(5))?;
            page_bytes_by_table(&c)
        });
    let (parts, pages_error) = match pages {
        Ok(tables) => (Some(split_parts(&tables)), None),
        Err(e) => (None, Some(e.to_string())),
    };
    let models = models_on_disk();

    Ok(json!({
        "database": { "bytes": main_bytes + wal_bytes, "wal_bytes": wal_bytes },
        "parts": parts.map(|p| json!({ "memory": p.memory, "mail": p.mail, "audit": p.audit, "other": p.other })),
        "parts_error": pages_error,
        "models": models.map(|(bytes, source)| json!({ "bytes": bytes, "source": source })),
        "measured_at": now_iso(),
    }))
}

// ---------------------------------------------------------------------------
// Home Assistant (row 75)
// ---------------------------------------------------------------------------

/// How long the check waits. A bridge on the local network answers in tens of
/// milliseconds; five seconds is "not answering", not "slow".
const HA_TIMEOUT: Duration = Duration::from_secs(5);

/// One timed, authenticated GET of `/api/` on the linked bridge.
///
/// The token is read from the Keychain for the request and never written into
/// the result: errors name the KIND of failure, not the transport's message,
/// which can carry the request line.
#[tauri::command(async)]
pub fn system_probe_home_assistant(state: State<'_, DbState>, user_id: String) -> Result<Value, String> {
    if user_id.trim().is_empty() {
        return Err("no user".into());
    }
    let bridge: Option<(String, String, Option<String>, i64)> = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT b.id, b.name, b.base_url,
                    (SELECT COUNT(*) FROM home_devices d WHERE d.bridge_id = b.id)
             FROM home_bridges b WHERE b.user_id = ?1 AND b.kind = 'home_assistant'",
            params![user_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
    };
    let Some((_, name, base_url, devices)) = bridge else {
        return Ok(json!({ "linked": false }));
    };
    let answer = |ok: bool, latency: Option<u128>, error: Option<String>| {
        json!({
            "linked": true, "name": name, "devices": devices,
            "ok": ok, "latency_ms": latency.map(|l| l as u64), "error": error,
            "checked_at": now_iso(),
        })
    };
    let Some(base) = base_url.map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| u.starts_with("http://") || u.starts_with("https://")) else {
        return Ok(answer(false, None, Some("no bridge address stored — link it again in Smart Home".into())));
    };
    let Some(token) = crate::home::keys::ha_token() else {
        return Ok(answer(false, None, Some("the bridge token is missing from the Keychain — link it again in Smart Home".into())));
    };

    let started = Instant::now();
    let res = crate::http::agent()
        .get(&format!("{base}/api/"))
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(HA_TIMEOUT)
        .call();
    let ms = started.elapsed().as_millis();
    Ok(match res {
        Ok(r) => {
            let body = r.into_string().unwrap_or_default();
            if body.contains("API running") {
                answer(true, Some(ms), None)
            } else {
                answer(false, Some(ms), Some("that address answered, but not as Home Assistant".into()))
            }
        }
        Err(ureq::Error::Status(401 | 403, _)) => answer(false, Some(ms), Some("the bridge refused the token".into())),
        Err(ureq::Error::Status(code, _)) => answer(false, Some(ms), Some(format!("the bridge answered HTTP {code}"))),
        Err(ureq::Error::Transport(t)) => answer(false, None, Some(format!("not reachable ({})", t.kind()))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_is_recorded_once_per_change() {
        let state = DbState::open_in_memory().unwrap();
        let conn = state.conn.lock().unwrap();
        assert!(note_version(&conn, "com.x", "1.0.0", "2026-10-01T00:00:00.000Z").unwrap());
        assert!(!note_version(&conn, "com.x", "1.0.0", "2026-10-02T00:00:00.000Z").unwrap());
        assert!(note_version(&conn, "com.x", "1.1.0", "2026-10-03T00:00:00.000Z").unwrap());
        // Another bundle over the same database keeps its own line.
        assert!(note_version(&conn, "com.y", "1.1.0", "2026-10-03T00:00:00.000Z").unwrap());
        // A downgrade is an event too.
        assert!(note_version(&conn, "com.x", "1.0.0", "2026-10-04T00:00:00.000Z").unwrap());
        let prev: Option<String> = conn
            .query_row(
                "SELECT previous_version FROM atlas_app_versions WHERE bundle_id = 'com.x' ORDER BY id DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(prev.as_deref(), Some("1.1.0"));
    }

    #[test]
    fn tables_fall_into_the_designs_rows() {
        assert_eq!(category("tool_calls"), "audit");
        assert_eq!(category("mail_audit_events"), "audit");
        assert_eq!(category("mail_messages"), "mail");
        assert_eq!(category("memory_vec_chunks"), "memory");
        assert_eq!(category("ai_memory"), "memory");
        assert_eq!(category("chat_turns"), "other");
        let parts = split_parts(&[("mail_messages".into(), 4096), ("tool_calls".into(), 1024), ("ai_memory".into(), 2048), ("x".into(), 8)]);
        assert_eq!(parts, Parts { memory: 2048, mail: 4096, audit: 1024, other: 8 });
    }

    #[test]
    fn dbstat_counts_pages_per_table_with_their_indexes() {
        let state = DbState::open_in_memory().unwrap();
        let conn = state.conn.lock().unwrap();
        let tables = page_bytes_by_table(&conn).unwrap();
        let total: u64 = tables.iter().map(|(_, b)| b).sum();
        let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
        let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
        // Every b-tree page is counted once; only free pages sit outside them.
        assert!(total > 0 && total <= (page_size * page_count) as u64);
        // Indexes are folded into their table: no index name survives.
        assert!(tables.iter().all(|(name, _)| !name.starts_with("idx_")));
    }
}
