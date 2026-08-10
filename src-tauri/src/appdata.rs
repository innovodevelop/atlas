// Where Atlas' data lives — one location, whichever bundle is running.
//
// WHY THIS IS NOT `app_data_dir()`. Tauri derives the app-data directory from
// the bundle identifier, so Atlas.app resolves
// `~/Library/Application Support/com.magnuspilegaard.atlas` and Lighthouse.app
// resolves `…/com.magnuspilegaard.lighthouse`. Two directories means two
// `atlas.db` files, and Lighthouse exists to inspect the CONSUMER's live state:
// a Lighthouse looking at its own empty database is not an admin tool, it is a
// second, emptier Atlas. So the database path is pinned to a constant that does
// not depend on the running bundle.
//
// WHICH CONSTANT, AND WHY THAT ONE. The shared directory IS Atlas' existing
// one. That is a deliberate choice over a neutral new name (`…/Atlas/`,
// `…/com.magnuspilegaard.shared/`): the user's memories, chat history, tasks,
// notes, mail mirror and approvals are ALREADY in
// `com.magnuspilegaard.atlas/atlas.db`, and every alternative constant makes
// the consumer app's database something that has to be COPIED on next launch.
// A copy that goes wrong — a partial write, a lost WAL, two launches copying at
// once — silently presents the user with an empty Atlas, which is the worst
// outcome this change could produce. Pinning the constant to where the data
// already is makes the Atlas-side migration a provable no-op (`AlreadyShared`,
// below: not one byte is read or written) while still satisfying the property
// that matters — the path is a constant, not a function of the running bundle.
//
// The migration is therefore not dead code, it is Lighthouse-side: a Lighthouse
// that ran before this change owns a per-bundle `atlas.db` of its own, and that
// database is copied into the shared slot if — and only if — the shared slot is
// empty. It is never the other way around, and the source is never deleted.

use std::path::{Path, PathBuf};

/// The directory both bundles open their database in. Named for Atlas'
/// identifier because that is where the data already lives; read as a constant,
/// never as "the running app's directory".
pub const SHARED_DIR_ID: &str = "com.magnuspilegaard.atlas";

pub const DB_FILE: &str = "atlas.db";

/// `~/Library/Application Support` on macOS — the same root Tauri's
/// `app_data_dir()` uses, so the shared directory is exactly Atlas' own and no
/// existing install has to move.
#[cfg(target_os = "macos")]
fn data_root() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
}

/// Non-macOS exists only so `cargo test` runs on a Linux CI box; Atlas does not
/// ship there.
#[cfg(not(target_os = "macos"))]
fn data_root() -> Option<PathBuf> {
    if let Some(x) = std::env::var_os("XDG_DATA_HOME") {
        return Some(PathBuf::from(x));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share"))
}

pub fn shared_dir() -> Option<PathBuf> {
    data_root().map(|root| root.join(SHARED_DIR_ID))
}

// ---------------------------------------------------------------------------
// The decision (pure)
// ---------------------------------------------------------------------------

/// What is on disk, reduced to the only five facts the decision depends on.
///
/// Bytes rather than a bare `exists` flag on purpose: a zero-length `atlas.db`
/// is what a migration killed halfway through leaves behind, and treating that
/// as "the shared database exists" would pin every later launch to an empty
/// file next to a perfectly good one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DbFacts {
    /// The running bundle's own app-data directory IS the shared directory.
    /// True for Atlas, and for any dev build using Atlas' identifier.
    pub same_path: bool,
    pub shared_bytes: u64,
    pub legacy_bytes: u64,
    /// Milliseconds since the epoch; 0 when unreadable. Only ever compared with
    /// each other, and only to decide whether to WARN.
    pub shared_mtime_ms: u64,
    pub legacy_mtime_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbPlan {
    /// This bundle's directory is the shared one. Nothing is examined, nothing
    /// is copied, nothing can go wrong. (Atlas, and `tauri dev`.)
    AlreadyShared,
    /// Open the shared database. Either it already has content, or nobody has
    /// any content at all and it is about to be created empty — which is what a
    /// brand-new user should get.
    UseShared,
    /// Both databases have content and the per-bundle one was written more
    /// recently. Still open the shared one: copying over it is the one action
    /// that could destroy data. Says so out loud instead, naming both files, so
    /// a user who really did put newer work in the other database can recover it
    /// by hand.
    UseSharedLegacyNewer,
    /// Only the per-bundle database has content. Copy it into the shared slot,
    /// leave the original untouched, then open the shared one.
    MigrateThenUseShared,
}

/// Pure, and the whole reason this is a separate function: this is the branch
/// that can lose a user's history, and it must be provable without a
/// filesystem, an app handle or a real database.
pub fn plan(f: DbFacts) -> DbPlan {
    if f.same_path {
        return DbPlan::AlreadyShared;
    }
    if f.shared_bytes > 0 {
        if f.legacy_bytes > 0 && f.legacy_mtime_ms > f.shared_mtime_ms {
            return DbPlan::UseSharedLegacyNewer;
        }
        return DbPlan::UseShared;
    }
    if f.legacy_bytes > 0 {
        return DbPlan::MigrateThenUseShared;
    }
    DbPlan::UseShared
}

// ---------------------------------------------------------------------------
// Applying it
// ---------------------------------------------------------------------------

fn file_facts(path: &Path) -> (u64, u64) {
    match std::fs::metadata(path) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            (m.len(), mtime)
        }
        Err(_) => (0, 0),
    }
}

/// Resolve the database path for this launch, performing the migration if the
/// facts call for one.
///
/// `legacy_dir` is the running bundle's own `app_data_dir()` — passed in rather
/// than recomputed so the identifier comes from Tauri's own config and not from
/// a second guess about which bundle we are.
///
/// Never returns a path to an empty database when a non-empty one exists: if the
/// copy fails, the ORIGINAL is returned and this launch runs unshared. That is a
/// worse product (Lighthouse and Atlas would see different data) and a much
/// better failure than a user opening Atlas to find their history gone.
pub fn resolve_db_path(legacy_dir: &Path) -> PathBuf {
    let legacy_db = legacy_dir.join(DB_FILE);

    let Some(shared_dir) = shared_dir() else {
        log::warn!("[db] no home directory: falling back to this bundle's own database");
        return legacy_db;
    };
    if let Err(e) = std::fs::create_dir_all(&shared_dir) {
        log::warn!("[db] shared directory {} unusable ({e}); falling back to this bundle's own database", shared_dir.display());
        return legacy_db;
    }
    let shared_db = shared_dir.join(DB_FILE);

    let same_path = shared_db == legacy_db;
    let (shared_bytes, shared_mtime_ms) = if same_path { (0, 0) } else { file_facts(&shared_db) };
    let (legacy_bytes, legacy_mtime_ms) = if same_path { (0, 0) } else { file_facts(&legacy_db) };
    let facts = DbFacts { same_path, shared_bytes, legacy_bytes, shared_mtime_ms, legacy_mtime_ms };

    match plan(facts) {
        DbPlan::AlreadyShared | DbPlan::UseShared => shared_db,
        DbPlan::UseSharedLegacyNewer => {
            log::warn!(
                "[db] opening the shared database at {} even though {} was written more recently; \
                 nothing is overwritten — if the second file holds work you need, close both apps \
                 and copy it over by hand",
                shared_db.display(),
                legacy_db.display()
            );
            shared_db
        }
        DbPlan::MigrateThenUseShared => match copy_database(&legacy_db, &shared_db) {
            Ok(()) => {
                log::info!(
                    "[db] copied {} into the shared location {} (the original is left in place)",
                    legacy_db.display(),
                    shared_db.display()
                );
                shared_db
            }
            Err(e) => {
                log::error!(
                    "[db] could not copy {} to {}: {e}. Running against the original so no data \
                     is hidden; this launch does not share a database with the other app.",
                    legacy_db.display(),
                    shared_db.display()
                );
                legacy_db
            }
        },
    }
}

/// Copy a SQLite database, safely enough to bet a user's history on.
///
/// `VACUUM INTO`, not `fs::copy`. The database is opened in WAL mode, and on
/// this machine `atlas.db-wal` is larger than `atlas.db` — a plain file copy of
/// the main file alone would silently drop every transaction still in the log,
/// which is most of a recent session. `VACUUM INTO` runs inside a read
/// transaction, so it also produces a consistent snapshot of a database another
/// process is writing to.
///
/// Published by `hard_link`, not `rename`. Both are atomic, but `rename`
/// OVERWRITES: two launches migrating at once (or one migrating while the other
/// has already opened the destination) would leave a process holding an unlinked
/// inode, writing to a file nobody can see. `hard_link` fails with
/// `AlreadyExists` instead, which is the correct answer — somebody else got
/// there first, and their copy is as good as ours.
///
/// The source is never modified and never removed.
fn copy_database(src: &Path, dst: &Path) -> Result<(), String> {
    let tmp = dst.with_file_name(format!("{DB_FILE}.migrating.{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);

    let tmp_sql = tmp
        .to_str()
        .ok_or_else(|| "the destination path is not valid UTF-8".to_string())?
        .replace('\'', "''");
    {
        let conn = rusqlite::Connection::open(src).map_err(|e| e.to_string())?;
        conn.execute_batch(&format!("VACUUM INTO '{tmp_sql}'"))
            .map_err(|e| e.to_string())?;
    }

    let published = std::fs::hard_link(&tmp, dst);
    let _ = std::fs::remove_file(&tmp);
    match published {
        Ok(()) => Ok(()),
        // Somebody else published first. Theirs is a copy of the same source.
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// The running bundle's identifier
// ---------------------------------------------------------------------------

/// CFBundleIdentifier out of an XML `Info.plist`.
///
/// Needed before Tauri exists: the WebKit cache purge runs before the builder is
/// constructed (see lib.rs), so `app.config().identifier` is not available yet,
/// and a hard-coded identifier there makes Lighthouse purge ATLAS' cache and
/// stamp Atlas' marker — so each app's launch looks like an update to the other
/// and they purge each other's caches forever.
///
/// Deliberately a scan for one key rather than a plist parser: the only fact
/// needed is one string, an unparseable or binary plist must fall back rather
/// than fail, and pulling in a plist dependency to read one value is not worth a
/// line in Cargo.lock.
pub fn plist_bundle_id(xml: &str) -> Option<String> {
    let after_key = xml.split("<key>CFBundleIdentifier</key>").nth(1)?;
    let open = after_key.find("<string>")? + "<string>".len();
    let rest = &after_key[open..];
    let close = rest.find("</string>")?;
    let id = rest[..close].trim();
    (!id.is_empty()).then(|| id.to_string())
}

/// The identifier of the .app this executable is inside, or `fallback` when it
/// is not inside one (a `cargo run` / `tauri dev` binary).
pub fn running_bundle_id(fallback: &str) -> String {
    std::env::current_exe()
        .ok()
        // …/Foo.app/Contents/MacOS/exe -> …/Foo.app/Contents
        .and_then(|exe| exe.parent().and_then(Path::parent).map(Path::to_path_buf))
        .map(|contents| contents.join("Info.plist"))
        .and_then(|plist| std::fs::read_to_string(plist).ok())
        .and_then(|xml| plist_bundle_id(&xml))
        .unwrap_or_else(|| fallback.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(shared: u64, legacy: u64) -> DbFacts {
        DbFacts {
            same_path: false,
            shared_bytes: shared,
            legacy_bytes: legacy,
            shared_mtime_ms: 1_000,
            legacy_mtime_ms: 1_000,
        }
    }

    /// Atlas. Its own directory is the shared one, so the 589,824-byte database
    /// this task exists to protect is never read, copied or replaced.
    #[test]
    fn the_bundle_that_owns_the_shared_directory_migrates_nothing() {
        let f = DbFacts { same_path: true, ..facts(0, 0) };
        assert_eq!(plan(f), DbPlan::AlreadyShared);
        // Even with a large database sitting in both slots, same_path wins first.
        let f = DbFacts { same_path: true, ..facts(589_824, 589_824) };
        assert_eq!(plan(f), DbPlan::AlreadyShared);
    }

    /// CASE (a): the per-bundle database has content and the shared slot does
    /// not. This is the only case that copies anything.
    #[test]
    fn a_lone_per_bundle_database_is_copied_into_the_shared_slot() {
        assert_eq!(plan(facts(0, 40_960)), DbPlan::MigrateThenUseShared);
    }

    /// CASE (b): both exist. The shared one is opened and the other is left
    /// exactly where it is — a copy here is the one action that could destroy
    /// data, so it never happens.
    #[test]
    fn when_both_exist_the_shared_one_is_used_and_nothing_is_overwritten() {
        assert_eq!(plan(facts(589_824, 40_960)), DbPlan::UseShared);
    }

    /// CASE (b), the uncomfortable half: the per-bundle database is NEWER. Still
    /// no copy — but the launch says so, because silently preferring the older
    /// file is how a user concludes their afternoon's work vanished.
    #[test]
    fn a_newer_per_bundle_database_is_reported_rather_than_copied_over_the_shared_one() {
        let f = DbFacts { legacy_mtime_ms: 2_000, ..facts(589_824, 40_960) };
        assert_eq!(plan(f), DbPlan::UseSharedLegacyNewer);
        // Equal timestamps are not "newer": no warning for the common case.
        let f = DbFacts { legacy_mtime_ms: 1_000, ..facts(589_824, 40_960) };
        assert_eq!(plan(f), DbPlan::UseShared);
    }

    /// CASE (c): a brand-new user with neither file. Create the shared one.
    #[test]
    fn a_brand_new_user_gets_the_shared_database_created_for_them() {
        assert_eq!(plan(facts(0, 0)), DbPlan::UseShared);
    }

    /// CASE (d): Lighthouse launching first on a machine where only Atlas has
    /// ever run. The shared slot is Atlas' real database; Lighthouse has none of
    /// its own. Nothing is copied and Lighthouse sees the live consumer state,
    /// which is the entire point of the app.
    #[test]
    fn lighthouse_first_on_an_atlas_only_machine_just_opens_atlas_database() {
        assert_eq!(plan(facts(589_824, 0)), DbPlan::UseShared);
    }

    /// A migration that died between creating the file and filling it leaves a
    /// zero-length `atlas.db`. Treating that as "the shared database exists"
    /// would pin every future launch to an empty file with a real one beside it.
    #[test]
    fn a_zero_length_shared_database_does_not_count_as_existing() {
        assert_eq!(plan(facts(0, 40_960)), DbPlan::MigrateThenUseShared);
    }

    /// Idempotence, stated as a property: whatever the facts, running the plan
    /// twice cannot copy twice, because the first copy makes `shared_bytes > 0`
    /// and every branch with content in the shared slot is a no-copy branch.
    #[test]
    fn migration_is_idempotent_because_a_populated_shared_slot_never_copies() {
        for legacy in [0u64, 1, 40_960] {
            for legacy_mtime_ms in [0u64, 1_000, 9_999] {
                let f = DbFacts { legacy_bytes: legacy, legacy_mtime_ms, ..facts(589_824, legacy) };
                assert_ne!(
                    plan(f),
                    DbPlan::MigrateThenUseShared,
                    "a second launch tried to copy over a populated shared database: {f:?}"
                );
            }
        }
    }

    // --- the copy itself ---------------------------------------------------

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("atlas-appdata-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// The reason this is `VACUUM INTO` and not `fs::copy`: with WAL on, rows
    /// that are committed but not yet checkpointed live in `atlas.db-wal`, and
    /// copying the main file alone loses them. This writes a row, does NOT
    /// checkpoint, and asserts the row survives the copy.
    #[test]
    fn a_committed_row_still_in_the_wal_survives_the_copy() {
        let dir = temp_dir("wal");
        let src = dir.join("source.db");
        let dst = dir.join(DB_FILE);
        {
            let conn = rusqlite::Connection::open(&src).unwrap();
            conn.execute_batch(
                "PRAGMA journal_mode=WAL;
                 CREATE TABLE memories (id TEXT PRIMARY KEY, body TEXT);
                 INSERT INTO memories VALUES ('m1','the user''s history');",
            )
            .unwrap();
            // Deliberately left open and un-checkpointed: the WAL is where the
            // row is at this moment.
            assert!(dir.join("source.db-wal").exists(), "the test needs a real WAL to be meaningful");
            copy_database(&src, &dst).unwrap();
        }
        let copy = rusqlite::Connection::open(&dst).unwrap();
        let body: String = copy
            .query_row("SELECT body FROM memories WHERE id='m1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(body, "the user's history");
        assert!(src.exists(), "the source must never be removed");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Two launches racing. The second copy must not replace a file the first
    /// may already have open — `hard_link` refuses, and refusing is success.
    #[test]
    fn a_second_copy_cannot_clobber_a_database_that_is_already_there() {
        let dir = temp_dir("race");
        let src = dir.join("source.db");
        let dst = dir.join(DB_FILE);
        {
            let conn = rusqlite::Connection::open(&src).unwrap();
            conn.execute_batch("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('first');")
                .unwrap();
        }
        copy_database(&src, &dst).unwrap();
        let len_before = std::fs::metadata(&dst).unwrap().len();

        // The source moves on; a stale second migration attempt must still not
        // touch the published file.
        {
            let conn = rusqlite::Connection::open(&src).unwrap();
            conn.execute_batch("INSERT INTO t VALUES ('second');").unwrap();
        }
        copy_database(&src, &dst).unwrap();

        let conn = rusqlite::Connection::open(&dst).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1, "the second copy overwrote a published database");
        assert_eq!(std::fs::metadata(&dst).unwrap().len(), len_before);
        // No temp file left behind either.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("migrating"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind: {leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    // --- bundle identifier -------------------------------------------------

    #[test]
    fn the_bundle_identifier_is_read_out_of_an_xml_info_plist() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>app</string>
  <key>CFBundleIdentifier</key><string>com.magnuspilegaard.lighthouse</string>
  <key>CFBundleName</key><string>Lighthouse</string>
</dict></plist>"#;
        assert_eq!(plist_bundle_id(xml).as_deref(), Some("com.magnuspilegaard.lighthouse"));
    }

    /// A binary plist, a truncated file, or a key that is simply absent must
    /// fall back rather than produce nonsense — the caller uses this to decide
    /// which cache directory to DELETE.
    #[test]
    fn an_unreadable_plist_yields_no_identifier_rather_than_a_wrong_one() {
        assert_eq!(plist_bundle_id(""), None);
        assert_eq!(plist_bundle_id("bplist00\u{0}\u{1}garbage"), None);
        assert_eq!(plist_bundle_id("<key>CFBundleName</key><string>Atlas</string>"), None);
        assert_eq!(plist_bundle_id("<key>CFBundleIdentifier</key><string></string>"), None);
        assert_eq!(plist_bundle_id("<key>CFBundleIdentifier</key>"), None);
    }
}
