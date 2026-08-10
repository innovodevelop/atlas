// Health — the backend behind Atlas' health surface.
//
// THE PLATFORM WALL, FIRST, BECAUSE IT DECIDES EVERYTHING ELSE
// `HKHealthStore.isHealthDataAvailable()` returns FALSE on macOS 26.3. That was
// compiled and run natively this session, and it is a DEVICE CAPABILITY answer:
// signing the app and adding the HealthKit entitlement would not change it,
// because this Mac has no Health data store to serve from. The finding is
// written up in docs/decisions/008 and kept from going stale by
// src-tauri/tests/platform_health_home_wall.rs.
//
// So there is no live source to poll, no background sync to schedule, and no
// permission dialog to raise. What this module builds is the SEAM plus the one
// path that works today:
//
//   import.rs     the Apple Health export importer — a file the person exports
//                 from their iPhone. THE ONLY WORKING SOURCE.
//   xml.rs        a streaming, hostile-input-safe XML scanner
//   zip.rs        getting export.xml out of the zip Health actually produces
//   store.rs      the three tables and every projection a surface reads
//   companion.rs  the iOS companion — the trait, and a stub that refuses
//
// WHAT IS STORED: DERIVED VALUES, NEVER SAMPLES. A night of sleep is six
// numbers here, not four hundred interval samples. That is what the widgets ask
// for ("7h 12m, deep 1h 40m"), it is what keeps a 400 MB export from becoming a
// 400 MB database, and it is the on-disk half of a published commitment: what is
// read here is stored here, and the smallest thing that answers the question is
// the least of it to have lying around. See db_schema.sql. (Note the scope: this
// module makes no network call, but `control/ops_health.rs` exists to let a
// model read these figures, so "never leaves the device" is a promise the APP
// makes or breaks, not one this file can make alone. See `privacy()`.)
//
// EVERY COMMAND HERE IS `#[tauri::command(async)]`, INCLUDING THE SYNC-BODIED
// ONES. That attribute is what moves a command off the MAIN thread onto Tauri's
// worker pool. An import walks hundreds of megabytes; on the main thread it
// would freeze the window and the Web Inspector with it (see the incident note
// at the top of src/http.rs). A test at the bottom of this file refuses a
// command in this module that is not declared `async`.
//
// WHAT ATLAS ITSELF MAY DO WITH ANY OF IT: READ. Every health op on the control
// port is `Tier::Read` — see control/ops_health.rs — so the model can describe
// a person's health and can neither import, delete, nor alter it.

pub mod companion;
pub mod import;
pub mod store;
pub mod xml;
pub mod zip;

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::db::DbState;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why a health operation did not happen.
///
/// The variants are separate because the FIXES are separate: a malformed file
/// needs a fresh export, a too-large one needs a shorter date range, an
/// unavailable source needs an app that does not exist yet. Collapsing them
/// would leave the surface unable to tell the person which of those to do.
///
/// NO VARIANT EVER CARRIES BYTES FROM THE FILE. The strings are ours; the
/// closest any of them comes to quoting the input is an XML entity name, which
/// the scanner bounds to twelve characters first.
#[derive(Debug)]
pub enum HealthError {
    /// The file is not readable as a Health export.
    Malformed(String),
    /// A limit was hit — record count, nesting, total bytes.
    TooLarge(String),
    /// The file could not be opened or unpacked.
    Io(String),
    /// The local store could not be read or written.
    Store(String),
    /// This source cannot work on this platform yet (companion.rs).
    Unavailable(String),
    /// Atlas refused. Not a failure — a rule.
    Refused(String),
}

impl std::fmt::Display for HealthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HealthError::Malformed(m)
            | HealthError::TooLarge(m)
            | HealthError::Io(m)
            | HealthError::Unavailable(m)
            | HealthError::Refused(m) => write!(f, "{m}"),
            HealthError::Store(m) => write!(f, "the local health store failed: {m}"),
        }
    }
}

impl From<HealthError> for String {
    fn from(e: HealthError) -> String {
        e.to_string()
    }
}

impl From<xml::XmlError> for HealthError {
    fn from(e: xml::XmlError) -> Self {
        match e {
            // A limit is a different problem from a broken file: one is fixed
            // by exporting less, the other by exporting again.
            xml::XmlError::TooLarge(_) => HealthError::TooLarge(e.to_string()),
            xml::XmlError::Io(_) => HealthError::Io(e.to_string()),
            other => HealthError::Malformed(other.to_string()),
        }
    }
}

impl From<zip::ZipError> for HealthError {
    fn from(e: zip::ZipError) -> Self {
        match e {
            zip::ZipError::Io(_) => HealthError::Io(e.to_string()),
            other => HealthError::Malformed(other.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// The privacy rules Atlas actually enforces
// ---------------------------------------------------------------------------

/// The privacy statements the code backs, reported so the surface cannot claim
/// more than is true.
///
/// SAME DEVICE AS `home::autonomy()`, and for the same reason. A "health data
/// stays on this device" line is worth nothing if it lives only in marketing
/// copy; here it is generated next to the code that makes it true, and
/// `the_health_privacy_card_matches_the_tiers_that_enforce_it` in
/// control/registry.rs asserts that the read-only claim is exactly what the op
/// table enforces. `fixed: true` says these are NOT switches — there is no
/// setting to turn any of them off, so a UI must render them as statements.
pub fn privacy() -> Value {
    json!([
        {
            "id": "on_device",
            // WAS "Health data never leaves this Mac", which is a claim about
            // the whole APP made by a module that can only speak for itself.
            // `control/ops_health.rs` registers three read ops whose stated
            // purpose is to put sleep, weight and resting heart rate into a
            // model's context — so the absolute sentence was true only for as
            // long as nobody wired them up, and it was the user-facing half of
            // the pair that was wrong. Scoped to what this code does.
            "name": "Your export is read and stored only on this Mac",
            "note": "The file is read here and the daily figures are written to Atlas' own \
                     database on this machine. No part of the health code makes a network call, \
                     and nothing uploads, syncs or backs up what it reads.",
            "enabled": true,
            "fixed": true,
        },
        {
            "id": "derived_only",
            "name": "Only daily summaries are kept",
            "note": "Atlas keeps one value per day per measurement — 8,213 steps, 7h 12m \
                     asleep — and discards the individual samples as it reads them.",
            "enabled": true,
            "fixed": true,
        },
        {
            "id": "atlas_reads_only",
            "name": "Atlas can read your health data, never change it",
            "note": "Every health tool Atlas has is read-only. Importing and deleting are \
                     things you do, on this screen; no tool can do either.",
            "enabled": true,
            "fixed": true,
        },
        {
            // The sentence the absolute "never leaves this Mac" was hiding.
            // Reading is local; ANSWERING is not necessarily, because an answer
            // is composed by a model. Today no tool the model can call reaches
            // these ops at all — `ATLAS_TOOL_OPS` in orchestrator.ts declares no
            // `atlas_health` group — and that is a fact worth stating rather
            // than a gap worth hiding. `the_health_privacy_copy_matches_what_the
            // _model_can_reach` in src/hooks/useHealth.test.ts fails the build if
            // the group appears while this sentence still says it has not.
            "id": "asking_is_separate",
            "name": "Asking Atlas about it is a separate question",
            "note": "Nothing here sends your health data anywhere. But an answer is written by \
                     a model, so if Atlas is ever given a tool that reads these figures, they \
                     go to the model that answers — today it has none, and this line changes \
                     the day that does.",
            "enabled": true,
            "fixed": true,
        },
    ])
}

fn changed(app: &AppHandle, table: &str) {
    let _ = app.emit("db:changed", json!({ "table": table, "op": "upsert" }));
}

fn user_or_refuse(user_id: &str) -> Result<(), String> {
    if user_id.trim().is_empty() {
        // An empty user_id would query no rows, which reads exactly like "you
        // have no health data" — a statement about a person, from a request
        // that carried no identity.
        return Err("this request carries no user identity, so there is no health data to read".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Commands
//
// Every one is `#[tauri::command(async)]`. See the header.
// ---------------------------------------------------------------------------

/// The whole health surface as of the last import.
#[tauri::command(async)]
pub fn health_snapshot(state: State<'_, DbState>, user_id: String) -> Result<Value, String> {
    user_or_refuse(&user_id)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    store::snapshot(
        &conn,
        &user_id,
        chrono::Utc::now(),
        // The companion is listed even though it cannot work, so the Sources
        // screen shows two ways in and says which one is real. See companion.rs.
        vec![companion::source_entry()],
        privacy(),
    )
    .map_err(String::from)
}

/// Import an Apple Health export from `path`.
///
/// THE ONE WRITE IN THIS MODULE, and it is driven by a file the person chose in
/// a picker. Deliberately NOT on the control port's allowlist: a tool that takes
/// a path and reports what it found there is a file-probing primitive, and the
/// person who wants their health data imported is standing in front of the
/// screen when they want it.
#[tauri::command(async)]
pub fn health_import(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    path: String,
) -> Result<Value, String> {
    user_or_refuse(&user_id)?;
    let path = PathBuf::from(path.trim());
    if path.as_os_str().is_empty() {
        return Err("Choose the export.zip you saved from the Health app on your iPhone.".into());
    }
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let report = import::import_apple_export(&mut conn, &user_id, &path).map_err(String::from)?;
    drop(conn);
    changed(&app, "health_metrics");
    Ok(report_json(&report))
}

/// One metric over time, newest day first.
#[tauri::command(async)]
pub fn health_series(
    state: State<'_, DbState>,
    user_id: String,
    metric: String,
    days: usize,
) -> Result<Value, String> {
    user_or_refuse(&user_id)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    store::series(&conn, &user_id, metric.trim(), days).map_err(String::from)
}

/// Recent workouts.
#[tauri::command(async)]
pub fn health_workouts(
    state: State<'_, DbState>,
    user_id: String,
    limit: usize,
) -> Result<Value, String> {
    user_or_refuse(&user_id)?;
    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    Ok(json!({ "workouts": store::workouts(&conn, &user_id, limit).map_err(String::from)? }))
}

/// Delete every health row this account has.
///
/// Also deliberately absent from the control port: the answer to "can Atlas
/// delete my health history on its own" has to be no, and the cheapest way to
/// guarantee that is for no op to name this command.
#[tauri::command(async)]
pub fn health_forget(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
) -> Result<Value, String> {
    user_or_refuse(&user_id)?;
    let mut conn = state.conn.lock().map_err(|e| e.to_string())?;
    let removed = store::forget(&mut conn, &user_id).map_err(String::from)?;
    drop(conn);
    changed(&app, "health_metrics");
    Ok(removed)
}

/// The import report, in the field names the surface reads.
fn report_json(report: &import::ImportReport) -> Value {
    json!({
        "fileName": report.file_name,
        "fileBytes": report.file_bytes,
        "exportDate": report.export_date,
        "recordsRead": report.records_read,
        "recordsUsed": report.records_used,
        "recordsIgnored": report.records_ignored,
        "recordsRejected": report.rejections.total(),
        // WHY records were skipped, from a fixed vocabulary — never text taken
        // from the file. An import that silently used 4 of 40,000 records leaves
        // a person staring at an empty year with nothing to go on.
        "rejectionReasons": report.rejections.reasons()
            .into_iter()
            .map(|(reason, count)| json!({ "reason": reason, "count": count }))
            .collect::<Vec<Value>>(),
        "workouts": report.workouts,
        "days": report.days,
        "firstDay": report.first_day.map(|d| d.to_string()),
        "lastDay": report.last_day.map(|d| d.to_string()),
        "detail": store::import_detail(report),
    })
}

// ---------------------------------------------------------------------------
// Reads the control port calls (ops_health.rs)
//
// Plain functions rather than commands: they take a `&DbState` off the handle
// the same way, but they are not part of the IPC surface, because nothing in
// the webview needs them separately from the snapshot.
// ---------------------------------------------------------------------------

/// Metric names a caller may ask `health_series` for. Published so a tool can
/// be told the vocabulary instead of guessing at it.
pub fn metric_names() -> Vec<&'static str> {
    import::emittable_metrics()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `#[tauri::command]` without `(async)` runs the body on the MAIN thread.
    /// An import reads hundreds of megabytes; on the main thread that is a
    /// frozen window and a dead Web Inspector for the duration. The macro
    /// erases the attribute before anything else can see it, so a text scan is
    /// the only check available.
    #[test]
    fn every_command_in_this_module_leaves_the_main_thread() {
        let src = include_str!("mod.rs");
        let mut commands = 0usize;
        for (i, line) in src.lines().enumerate() {
            let trimmed = line.trim();
            if !trimmed.starts_with("#[tauri::command") {
                continue;
            }
            commands += 1;
            assert_eq!(
                trimmed, "#[tauri::command(async)]",
                "line {} declares a command that would run on the main thread",
                i + 1
            );
        }
        // Without this the test passes vacuously the day the attribute is
        // written differently and the scan stops matching anything.
        assert_eq!(commands, 5, "found {commands} commands in this module");
    }

    /// The privacy card is a claim about the code. Two of the four are checked
    /// here (read-only is checked against the op table in control/registry.rs,
    /// which is where the tiers live; the fourth is bound to the brain's tool
    /// declarations by src/hooks/useHealth.test.ts).
    #[test]
    fn the_privacy_rules_are_statements_rather_than_switches() {
        let rules = privacy();
        let rules = rules.as_array().expect("a list");
        assert_eq!(rules.len(), 4);
        for rule in rules {
            assert_eq!(rule["enabled"], json!(true));
            assert_eq!(
                rule["fixed"],
                json!(true),
                "a rule rendered as a switch implies it can be turned off; none of these can"
            );
            assert!(rule["note"].as_str().expect("a note").len() > 40);
        }
        let ids: Vec<&str> = rules.iter().filter_map(|r| r["id"].as_str()).collect();
        assert_eq!(ids, ["on_device", "derived_only", "atlas_reads_only", "asking_is_separate"]);

        // The absolute claim is gone on purpose. `control/ops_health.rs`
        // registers three read ops whose stated point is to put these figures
        // into a model's context, so "never leaves this Mac" was a promise this
        // module cannot make on the app's behalf — and the sentence a person
        // reads was the one that was wrong.
        let names = rules.iter().filter_map(|r| r["name"].as_str()).collect::<Vec<_>>().join(" | ");
        assert!(
            !names.contains("never leaves"),
            "the on-device claim must be scoped to what this code does: {names}"
        );
    }

    /// "Health data never leaves this Mac" is the load-bearing claim of the
    /// whole module. This is the cheapest true check on it: no module under
    /// src/health may name an outbound HTTP client. `ureq` is a dependency of
    /// this crate and one `use` line away in any of these files.
    #[test]
    fn nothing_in_this_module_can_make_a_network_call() {
        for (name, src) in [
            ("mod.rs", include_str!("mod.rs")),
            ("import.rs", include_str!("import.rs")),
            ("store.rs", include_str!("store.rs")),
            ("xml.rs", include_str!("xml.rs")),
            ("zip.rs", include_str!("zip.rs")),
            ("companion.rs", include_str!("companion.rs")),
        ] {
            // Split literals, reassembled at compile time: written whole, each
            // needle would match THIS FILE and the test would fail on itself.
            for outbound in [
                concat!("ureq", "::"),
                concat!("Tcp", "Stream"),
                concat!("req", "west"),
                concat!("crate::http", "::"),
            ] {
                assert!(
                    !src.contains(outbound),
                    "health/{name} names {outbound}, and the privacy card promises this \
                     module makes no network call"
                );
            }
        }
    }

    /// An identity-free request must not read a store scoped by an empty
    /// user_id — it matches no rows today only because no row happens to carry
    /// one, which is data luck rather than a rule.
    #[test]
    fn a_request_with_no_identity_reads_nobodys_health_data() {
        let err = user_or_refuse("   ").expect_err("an empty user_id is not an empty person");
        assert!(err.contains("identity"), "{err}");
        assert!(user_or_refuse("u1").is_ok());
    }

    /// The import report has to carry the skipped count and the reasons, or a
    /// half-read export is indistinguishable from a quiet life.
    #[test]
    fn the_import_report_says_what_it_could_not_read() {
        let derived = import::ingest(
            r#"<HealthData>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:10:00 +0200" value="900"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="furlongs" startDate="2026-08-07 08:00:00 +0200" endDate="2026-08-07 08:10:00 +0200" value="900"/>
</HealthData>"#
                .as_bytes(),
            import::Limits::default(),
        )
        .expect("readable");
        let out = report_json(&derived.report);
        assert_eq!(out["recordsRead"], json!(2));
        assert_eq!(out["recordsUsed"], json!(1));
        assert_eq!(out["recordsRejected"], json!(1));
        assert_eq!(out["rejectionReasons"][0]["reason"], json!("a unit Atlas does not know"));
        assert_eq!(out["rejectionReasons"][0]["count"], json!(1));
        assert!(out["detail"].as_str().expect("detail").contains("1 records skipped"));
    }

    /// The two failures the task names, at the module's own error boundary:
    /// both must become a `HealthError` a surface can show, and neither may be
    /// mistaken for the other.
    #[test]
    fn a_malformed_file_and_an_oversized_one_are_different_errors() {
        let malformed: HealthError = xml::XmlError::Malformed("no".into()).into();
        assert!(matches!(malformed, HealthError::Malformed(_)));
        let big: HealthError = xml::XmlError::TooLarge("too much".into()).into();
        assert!(matches!(big, HealthError::TooLarge(_)));
        let missing: HealthError = zip::ZipError::Io("no such file".into()).into();
        assert!(matches!(missing, HealthError::Io(_)));
        // Every one of them prints a sentence, because every one of them is
        // shown to a person.
        for e in [malformed, big, missing] {
            assert!(!e.to_string().is_empty());
        }
    }

    #[test]
    fn the_published_metric_vocabulary_is_the_importers() {
        let names = metric_names();
        assert!(names.contains(&"steps"));
        assert!(names.contains(&"sleep_asleep_minutes"));
        assert_eq!(names, import::emittable_metrics());
    }
}
