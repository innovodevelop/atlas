// The local store: three tables, and the projections every health surface reads.
//
// Everything here is derived. There is no sample table to fall back to and no
// bridge to re-ask — see the block above `health_metrics` in db_schema.sql — so
// the projections below are careful about one thing above all: a value they
// return always carries the DAY it is from and the SOURCE it came from. A
// health card that shows "62 bpm" without saying it is from three weeks ago is
// not a stale card, it is a false one, and this is the layer that makes the
// difference visible rather than leaving it to a component to remember.

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};

use super::import::{Derived, ImportReport};
use super::HealthError;

/// Rows returned by a single series read. A year of daily values is 365 rows,
/// which is what a chart wants; more than that is a data export, not a card.
pub const MAX_SERIES_ROWS: usize = 400;
/// Workouts returned by one read.
pub const MAX_WORKOUT_ROWS: usize = 200;

fn store_err(e: rusqlite::Error) -> HealthError {
    HealthError::Store(e.to_string())
}

fn now_iso() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ---------------------------------------------------------------------------
// How a metric is described to a person
// ---------------------------------------------------------------------------

/// How a stored number is turned into the string on a card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fmt {
    /// 8213 → "8,213"
    Whole,
    /// 8.13 → "8.1"
    Tenth,
    /// 432 → "7h 12m"
    Minutes,
}

/// The presentation vocabulary: every metric the importer can produce, with the
/// words a surface uses for it.
///
/// LIVING HERE RATHER THAN IN THE WEBVIEW because the formatting is a claim
/// about the number — "7h 12m" versus "432" versus "432 minutes" — and the
/// place that knows a value is a duration in minutes is the place that stored
/// it. `every_metric_the_importer_can_emit_has_a_name` is what keeps this table
/// and the importer's from drifting apart.
struct Presentation {
    metric: &'static str,
    label: &'static str,
    /// One of `HealthCategory` in src/lib/mocks/health.ts. A taxonomy, not a
    /// measurement — which is why it is safe to state here.
    category: &'static str,
    fmt: Fmt,
    /// Suffix for the formatted string. Empty for a duration, which formats its
    /// own units.
    suffix: &'static str,
}

static PRESENTATION: &[Presentation] = &[
    Presentation { metric: "steps", label: "Steps", category: "move", fmt: Fmt::Whole, suffix: "" },
    Presentation { metric: "distance_walking_running_km", label: "Walking + running distance", category: "move", fmt: Fmt::Tenth, suffix: " km" },
    Presentation { metric: "distance_cycling_km", label: "Cycling distance", category: "move", fmt: Fmt::Tenth, suffix: " km" },
    Presentation { metric: "flights_climbed", label: "Flights climbed", category: "move", fmt: Fmt::Whole, suffix: "" },
    Presentation { metric: "active_energy_kcal", label: "Active energy", category: "move", fmt: Fmt::Whole, suffix: " kcal" },
    Presentation { metric: "basal_energy_kcal", label: "Resting energy", category: "move", fmt: Fmt::Whole, suffix: " kcal" },
    Presentation { metric: "exercise_minutes", label: "Exercise", category: "move", fmt: Fmt::Minutes, suffix: "" },
    Presentation { metric: "stand_minutes", label: "Stand time", category: "move", fmt: Fmt::Minutes, suffix: "" },
    Presentation { metric: "heart_rate_bpm", label: "Heart rate", category: "heart", fmt: Fmt::Whole, suffix: " bpm" },
    Presentation { metric: "resting_heart_rate_bpm", label: "Resting heart rate", category: "heart", fmt: Fmt::Whole, suffix: " bpm" },
    Presentation { metric: "walking_heart_rate_bpm", label: "Walking heart rate", category: "heart", fmt: Fmt::Whole, suffix: " bpm" },
    Presentation { metric: "heart_rate_variability_ms", label: "Heart rate variability", category: "heart", fmt: Fmt::Whole, suffix: " ms" },
    Presentation { metric: "respiratory_rate_bpm", label: "Respiratory rate", category: "heart", fmt: Fmt::Whole, suffix: " br/min" },
    Presentation { metric: "body_mass_kg", label: "Weight", category: "body", fmt: Fmt::Tenth, suffix: " kg" },
    Presentation { metric: "sleep_asleep_minutes", label: "Time asleep", category: "sleep", fmt: Fmt::Minutes, suffix: "" },
    Presentation { metric: "sleep_core_minutes", label: "Core sleep", category: "sleep", fmt: Fmt::Minutes, suffix: "" },
    Presentation { metric: "sleep_deep_minutes", label: "Deep sleep", category: "sleep", fmt: Fmt::Minutes, suffix: "" },
    Presentation { metric: "sleep_rem_minutes", label: "REM sleep", category: "sleep", fmt: Fmt::Minutes, suffix: "" },
    Presentation { metric: "sleep_awake_minutes", label: "Awake in the night", category: "sleep", fmt: Fmt::Minutes, suffix: "" },
    Presentation { metric: "sleep_in_bed_minutes", label: "Time in bed", category: "sleep", fmt: Fmt::Minutes, suffix: "" },
];

fn presentation_for(metric: &str) -> Option<&'static Presentation> {
    PRESENTATION.iter().find(|p| p.metric == metric)
}

/// "8213" → "8,213". Thousands separators without a formatting crate.
fn grouped(n: i64) -> String {
    let negative = n < 0;
    let digits = n.abs().to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3 + 1);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if negative {
        out.insert(0, '-');
    }
    out
}

/// The string a card shows. Duration is the one that matters: a sleep widget
/// says "7h 12m", never "432".
fn format_value(metric: &str, value: f64) -> String {
    let Some(p) = presentation_for(metric) else {
        // A metric with no presentation entry still gets a truthful string
        // rather than being dropped — but a test below means this never
        // happens for a metric the importer can produce.
        return format!("{value:.1}");
    };
    match p.fmt {
        Fmt::Whole => format!("{}{}", grouped(value.round() as i64), p.suffix),
        Fmt::Tenth => format!("{:.1}{}", value, p.suffix),
        Fmt::Minutes => {
            let total = value.round().max(0.0) as i64;
            let (h, m) = (total / 60, total % 60);
            if h > 0 {
                format!("{h}h {m}m")
            } else {
                format!("{m}m")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Writing an import
// ---------------------------------------------------------------------------

/// Write a whole import: every derived metric, every workout, and the sync
/// state, in ONE transaction.
///
/// All-or-nothing on purpose. A half-applied import leaves a person's history
/// with a seam in it that nothing in the app could detect afterwards — the rows
/// look exactly like rows from a smaller export. Either the whole file lands or
/// the previous state is untouched.
///
/// `source_kind` is the `HealthSource::kind()` this came from — one of the two
/// values the `health_sync_state` CHECK constraint accepts. Passed in rather
/// than hard-coded here, so the seam in companion.rs and the schema cannot
/// disagree about what a source is called.
pub fn apply_import(
    conn: &mut Connection,
    user_id: &str,
    source_kind: &str,
    derived: &Derived,
) -> Result<(), HealthError> {
    let tx = conn.transaction().map_err(store_err)?;
    let now = now_iso();
    {
        let mut metric_stmt = tx
            .prepare(
                "INSERT INTO health_metrics
                   (id, user_id, day, metric, value, unit, stat, sample_count, source, low, high, imported_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(user_id, day, metric) DO UPDATE SET
                   value = excluded.value,
                   unit = excluded.unit,
                   stat = excluded.stat,
                   sample_count = excluded.sample_count,
                   source = excluded.source,
                   low = excluded.low,
                   high = excluded.high,
                   imported_at = excluded.imported_at",
            )
            .map_err(store_err)?;
        for row in &derived.metrics {
            metric_stmt
                .execute(rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    user_id,
                    row.day.to_string(),
                    row.metric,
                    row.value,
                    row.unit,
                    row.stat.as_str(),
                    row.sample_count as i64,
                    row.source.as_deref(),
                    row.low,
                    row.high,
                    now,
                ])
                .map_err(store_err)?;
        }

        let mut workout_stmt = tx
            .prepare(
                "INSERT INTO health_workouts
                   (id, user_id, external_id, activity, started_at, ended_at, day,
                    duration_min, distance_km, energy_kcal, avg_heart_rate, source, imported_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(user_id, external_id) DO UPDATE SET
                   activity = excluded.activity,
                   duration_min = excluded.duration_min,
                   distance_km = excluded.distance_km,
                   energy_kcal = excluded.energy_kcal,
                   avg_heart_rate = excluded.avg_heart_rate,
                   imported_at = excluded.imported_at",
            )
            .map_err(store_err)?;
        for w in &derived.workouts {
            workout_stmt
                .execute(rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    user_id,
                    w.external_id,
                    w.activity,
                    w.started_at,
                    w.ended_at,
                    w.day.to_string(),
                    w.duration_min,
                    w.distance_km,
                    w.energy_kcal,
                    w.avg_heart_rate,
                    w.source.as_deref(),
                    now,
                ])
                .map_err(store_err)?;
        }
    }
    write_sync_state(&tx, user_id, source_kind, &derived.report, &now)?;
    tx.commit().map_err(store_err)
}

fn write_sync_state(
    conn: &Connection,
    user_id: &str,
    source_kind: &str,
    report: &ImportReport,
    now: &str,
) -> Result<(), HealthError> {
    conn.execute(
        "INSERT INTO health_sync_state
           (id, user_id, source_kind, state, detail, export_date, file_name, file_bytes,
            first_day, last_day, days, records_read, records_used, records_rejected,
            workouts, last_import_at)
         VALUES (?1, ?2, ?16, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(user_id, source_kind) DO UPDATE SET
           state = excluded.state,
           detail = excluded.detail,
           export_date = excluded.export_date,
           file_name = excluded.file_name,
           file_bytes = excluded.file_bytes,
           first_day = excluded.first_day,
           last_day = excluded.last_day,
           days = excluded.days,
           records_read = excluded.records_read,
           records_used = excluded.records_used,
           records_rejected = excluded.records_rejected,
           workouts = excluded.workouts,
           last_import_at = excluded.last_import_at",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            user_id,
            "ok",
            import_detail(report),
            report.export_date.as_deref(),
            report.file_name,
            report.file_bytes.map(|b| b as i64),
            report.first_day.map(|d| d.to_string()),
            report.last_day.map(|d| d.to_string()),
            report.days as i64,
            report.records_read as i64,
            report.records_used as i64,
            report.rejections.total() as i64,
            report.workouts as i64,
            now,
            source_kind,
        ],
    )
    .map_err(store_err)?;
    Ok(())
}

/// The sentence under the source name.
///
/// SAYS WHAT WAS SKIPPED. An import that silently used 4 of 40,000 records
/// leaves a surface showing a nearly-empty year with no way for anyone to find
/// out why — so the count of rejected records is in the sentence, not only in a
/// column nobody reads.
pub fn import_detail(report: &ImportReport) -> String {
    if report.records_read == 0 {
        return "This file contained no health records.".to_string();
    }
    let mut s = match (report.first_day, report.last_day) {
        (Some(a), Some(b)) if a != b => format!("{} days, {a} to {b}", report.days),
        (Some(a), _) => format!("1 day, {a}"),
        _ => "No days with data".to_string(),
    };
    if report.workouts > 0 {
        s.push_str(&format!(" · {} workouts", report.workouts));
    }
    let rejected = report.rejections.total();
    if rejected > 0 {
        s.push_str(&format!(" · {rejected} records skipped"));
    }
    s
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// One row of `health_metrics`, as read back.
///
/// A struct rather than nine positional arguments: `(value, samples, low, high)`
/// are four numbers in a row, and swapping two of them at a call site would
/// compile, run, and put the day's minimum where its average belongs.
struct Stored {
    metric: String,
    day: String,
    value: f64,
    unit: String,
    stat: String,
    samples: i64,
    source: Option<String>,
    low: Option<f64>,
    high: Option<f64>,
}

/// One derived metric as a surface reads it.
fn metric_json(row: &Stored) -> Value {
    let Stored { day, value, unit, stat, samples, source, low, high, .. } = row;
    let (value, samples, low, high) = (*value, *samples, *low, *high);
    let metric = row.metric.as_str();
    let p = presentation_for(metric);
    let mut out = Map::new();
    out.insert("id".into(), json!(metric));
    out.insert("metric".into(), json!(metric));
    out.insert("name".into(), json!(p.map(|p| p.label).unwrap_or(metric)));
    out.insert("category".into(), json!(p.map(|p| p.category).unwrap_or("body")));
    // The formatted string AND the number. A card renders the first; anything
    // that computes (a trend, a model answering "am I walking more?") needs the
    // second, and asking it to re-parse "8,213 steps" would be absurd.
    out.insert("value".into(), json!(format_value(metric, value)));
    out.insert("raw".into(), json!(value));
    out.insert("unit".into(), json!(unit));
    out.insert("stat".into(), json!(stat));
    // THE DAY IS NOT OPTIONAL. Every read here returns the most recent day each
    // metric was measured, and those differ — weight is weekly, heart rate is
    // continuous — so a card without its own date would show a three-week-old
    // weight next to a live pulse as though both were today.
    out.insert("day".into(), json!(day));
    out.insert("sampleCount".into(), json!(samples));
    out.insert(
        "source".into(),
        source.clone().map(Value::String).unwrap_or(Value::Null),
    );
    out.insert("low".into(), low.map(|v| json!(v)).unwrap_or(Value::Null));
    out.insert("high".into(), high.map(|v| json!(v)).unwrap_or(Value::Null));
    // The daily range in words, for a card that has room for one line.
    let range = match (low, high) {
        (Some(l), Some(h)) if (h - l).abs() > f64::EPSILON => Some(format!(
            "{}–{}",
            format_value(metric, l),
            format_value(metric, h)
        )),
        _ => None,
    };
    out.insert("range".into(), range.map(Value::String).unwrap_or(Value::Null));
    Value::Object(out)
}

/// The most recent day each metric was measured.
pub fn latest_metrics(conn: &Connection, user_id: &str) -> Result<Vec<Value>, HealthError> {
    let mut stmt = conn
        .prepare(
            "SELECT hm.metric, hm.day, hm.value, hm.unit, hm.stat, hm.sample_count,
                    hm.source, hm.low, hm.high
             FROM health_metrics hm
             JOIN (SELECT metric, MAX(day) AS day FROM health_metrics
                   WHERE user_id = ?1 GROUP BY metric) newest
               ON newest.metric = hm.metric AND newest.day = hm.day
             WHERE hm.user_id = ?1
             ORDER BY hm.metric",
        )
        .map_err(store_err)?;
    let rows = stmt
        .query_map([user_id], |r| {
            Ok(metric_json(&Stored {
                metric: r.get(0)?,
                day: r.get(1)?,
                value: r.get(2)?,
                unit: r.get(3)?,
                stat: r.get(4)?,
                samples: r.get(5)?,
                source: r.get(6)?,
                low: r.get(7)?,
                high: r.get(8)?,
            }))
        })
        .map_err(store_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(store_err)
}

/// One metric, newest day first.
pub fn series(
    conn: &Connection,
    user_id: &str,
    metric: &str,
    limit: usize,
) -> Result<Value, HealthError> {
    let limit = limit.clamp(1, MAX_SERIES_ROWS);
    let mut stmt = conn
        .prepare(
            "SELECT day, value, low, high, sample_count, source, unit, stat
             FROM health_metrics
             WHERE user_id = ?1 AND metric = ?2
             ORDER BY day DESC LIMIT ?3",
        )
        .map_err(store_err)?;
    let rows: Vec<Value> = stmt
        .query_map(rusqlite::params![user_id, metric, limit as i64], |r| {
            let value: f64 = r.get(1)?;
            Ok(json!({
                "day": r.get::<_, String>(0)?,
                "raw": value,
                "value": format_value(metric, value),
                "low": r.get::<_, Option<f64>>(2)?,
                "high": r.get::<_, Option<f64>>(3)?,
                "sampleCount": r.get::<_, i64>(4)?,
                "source": r.get::<_, Option<String>>(5)?,
                "unit": r.get::<_, String>(6)?,
                "stat": r.get::<_, String>(7)?,
            }))
        })
        .map_err(store_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(store_err)?;
    Ok(json!({
        "metric": metric,
        "name": presentation_for(metric).map(|p| p.label).unwrap_or(metric),
        "days": rows,
        "returned": rows.len(),
        // Reported so a caller can tell "this is all there is" from "this is
        // the first page". A series silently cut at the limit and described as
        // a whole history is the fabrication this product refuses.
        "truncated": rows.len() >= limit,
    }))
}

pub fn workouts(conn: &Connection, user_id: &str, limit: usize) -> Result<Vec<Value>, HealthError> {
    let limit = limit.clamp(1, MAX_WORKOUT_ROWS);
    let mut stmt = conn
        .prepare(
            "SELECT activity, started_at, ended_at, day, duration_min, distance_km,
                    energy_kcal, avg_heart_rate, source
             FROM health_workouts
             WHERE user_id = ?1
             ORDER BY started_at DESC LIMIT ?2",
        )
        .map_err(store_err)?;
    let rows = stmt
        .query_map(rusqlite::params![user_id, limit as i64], |r| {
            Ok(json!({
                "activity": r.get::<_, String>(0)?,
                "startedAt": r.get::<_, String>(1)?,
                "endedAt": r.get::<_, String>(2)?,
                "day": r.get::<_, String>(3)?,
                "durationMin": r.get::<_, f64>(4)?,
                "distanceKm": r.get::<_, Option<f64>>(5)?,
                "energyKcal": r.get::<_, Option<f64>>(6)?,
                "avgHeartRate": r.get::<_, Option<f64>>(7)?,
                "source": r.get::<_, Option<String>>(8)?,
            }))
        })
        .map_err(store_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(store_err)
}

/// The sync-state row for the Apple export, if there has ever been an import.
fn export_source(conn: &Connection, user_id: &str) -> Result<Option<Value>, HealthError> {
    conn.query_row(
        "SELECT state, detail, export_date, file_name, last_import_at, days,
                records_read, records_used, records_rejected, workouts, first_day, last_day
         FROM health_sync_state WHERE user_id = ?1 AND source_kind = 'apple_export'",
        [user_id],
        |r| {
            Ok(json!({
                "id": "apple_export",
                "name": "Apple Health export",
                "kind": "apple_export",
                "state": r.get::<_, String>(0)?,
                "detail": r.get::<_, Option<String>>(1)?,
                "exportDate": r.get::<_, Option<String>>(2)?,
                "fileName": r.get::<_, Option<String>>(3)?,
                "lastImportAt": r.get::<_, Option<String>>(4)?,
                "days": r.get::<_, i64>(5)?,
                "recordsRead": r.get::<_, i64>(6)?,
                "recordsUsed": r.get::<_, i64>(7)?,
                "recordsRejected": r.get::<_, i64>(8)?,
                "workouts": r.get::<_, i64>(9)?,
                "firstDay": r.get::<_, Option<String>>(10)?,
                "lastDay": r.get::<_, Option<String>>(11)?,
                "enabled": true,
            }))
        },
    )
    .optional()
    .map_err(store_err)
}

/// Counts and the covered range, from the rows themselves rather than from the
/// sync-state row — so a stale counter cannot describe a store it disagrees
/// with.
fn coverage(conn: &Connection, user_id: &str) -> Result<Value, HealthError> {
    let (metrics, days, first, last): (i64, i64, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT COUNT(*), COUNT(DISTINCT day), MIN(day), MAX(day)
             FROM health_metrics WHERE user_id = ?1",
            [user_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(store_err)?;
    let workouts: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM health_workouts WHERE user_id = ?1",
            [user_id],
            |r| r.get(0),
        )
        .map_err(store_err)?;
    Ok(json!({
        "metrics": metrics,
        "days": days,
        "workouts": workouts,
        "firstDay": first,
        "lastDay": last,
    }))
}

/// The whole health surface, as of the last import.
pub fn snapshot(
    conn: &Connection,
    user_id: &str,
    now: DateTime<Utc>,
    sources_extra: Vec<Value>,
    privacy: Value,
) -> Result<Value, HealthError> {
    let metrics = latest_metrics(conn, user_id)?;
    let coverage = coverage(conn, user_id)?;
    let mut sources: Vec<Value> = Vec::new();
    if let Some(export) = export_source(conn, user_id)? {
        sources.push(export);
    }
    sources.extend(sources_extra);

    Ok(json!({
        "capturedAt": now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        // The one flag a page needs before it decides between a surface and an
        // empty state. False is a true and complete answer here — this Mac has
        // no health data source of its own (ADR 008), so "nothing yet" is the
        // day-one state of every install, not an error.
        "hasData": !metrics.is_empty(),
        "sources": sources,
        "metrics": metrics,
        "workouts": workouts(conn, user_id, 20)?,
        "coverage": coverage,
        "privacy": privacy,
        // EMPTY, AND EMPTY ON PURPOSE — each of these is a piece of the design's
        // vocabulary with nothing behind it on this platform:
        //   signals       per-signal toggles over a live stream. Nothing here
        //                 streams; an import is a file, not a feed.
        //   devices       requires pairing. There is no companion (see
        //                 companion.rs and docs/decisions/009).
        //   clay          the figure is shaded by live signals, which is the
        //                 same absence as `signals`.
        //   primaryDevice a paired wearable, same again.
        // Rendering any of them from an import would be inventing a live
        // connection out of a file somebody dragged in last month.
        "signals": [],
        "devices": [],
        "clay": [],
        "primaryDevice": Value::Null,
    }))
}

/// Delete every health row this user has. Returns what went.
///
/// THE COUNTERPART TO "IT NEVER LEAVES THE DEVICE": data that cannot be removed
/// is not really under the person's control, and health data is the category
/// where that matters most. Deliberately NOT reachable from the control port —
/// see ops_health.rs.
pub fn forget(conn: &mut Connection, user_id: &str) -> Result<Value, HealthError> {
    let tx = conn.transaction().map_err(store_err)?;
    let metrics = tx
        .execute("DELETE FROM health_metrics WHERE user_id = ?1", [user_id])
        .map_err(store_err)?;
    let workouts = tx
        .execute("DELETE FROM health_workouts WHERE user_id = ?1", [user_id])
        .map_err(store_err)?;
    let state = tx
        .execute("DELETE FROM health_sync_state WHERE user_id = ?1", [user_id])
        .map_err(store_err)?;
    tx.commit().map_err(store_err)?;
    Ok(json!({ "metrics": metrics, "workouts": workouts, "sources": state }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::import::{ingest, Limits};
    use chrono::NaiveDate;

    /// The REAL schema file, applied to an in-memory DB. Anything these tests
    /// prove is therefore proved against the SQL that ships.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch("PRAGMA foreign_keys = ON;").expect("pragma");
        conn.execute_batch(include_str!("../db_schema.sql"))
            .expect("db_schema.sql applies cleanly");
        conn
    }

    const EXPORT: &str = r#"<HealthData>
 <ExportDate value="2026-08-08 09:15:00 +0200"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:10:00 +0200" value="8213"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-08-08 07:00:00 +0200" endDate="2026-08-08 07:10:00 +0200" value="4100"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-08-08 07:00:00 +0200" endDate="2026-08-08 07:00:00 +0200" value="58"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Watch" unit="count/min" startDate="2026-08-08 07:05:00 +0200" endDate="2026-08-08 07:05:00 +0200" value="66"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" value="HKCategoryValueSleepAnalysisAsleepCore" startDate="2026-08-07 23:10:00 +0200" endDate="2026-08-08 03:00:00 +0200"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" value="HKCategoryValueSleepAnalysisAsleepDeep" startDate="2026-08-08 03:00:00 +0200" endDate="2026-08-08 04:40:00 +0200"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" value="HKCategoryValueSleepAnalysisAsleepREM" startDate="2026-08-08 04:40:00 +0200" endDate="2026-08-08 06:22:00 +0200"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="42.5" durationUnit="min" totalDistance="8.1" totalDistanceUnit="km" sourceName="Watch" startDate="2026-08-07 17:00:00 +0200" endDate="2026-08-07 17:42:30 +0200"/>
</HealthData>"#;

    fn imported() -> Connection {
        let mut conn = db();
        let derived = ingest(EXPORT.as_bytes(), Limits::default()).expect("readable");
        apply_import(&mut conn, "u1", "apple_export", &derived).expect("stored");
        conn
    }

    fn card<'a>(metrics: &'a [Value], metric: &str) -> &'a Value {
        metrics
            .iter()
            .find(|m| m["metric"] == json!(metric))
            .unwrap_or_else(|| panic!("no card for {metric}"))
    }

    /// The whole point of the module header: what lands in SQLite is the
    /// derived value, and the samples behind it are gone.
    #[test]
    fn only_derived_values_reach_the_database() {
        let conn = imported();
        // Two step days, one heart-rate day, three sleep stages plus the
        // asleep total on one night: nine rows for ten records.
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM health_metrics", [], |r| r.get(0))
            .unwrap();
        // Steps on two days (2 rows), two heart-rate SAMPLES collapsed into one
        // row with a range, and three sleep intervals turned into four derived
        // rows — core, deep, REM, and the asleep total that is not in the file
        // at all. The count is incidental; the shape is the point.
        assert_eq!(rows, 7, "one row per (day, metric), never per sample");
        let hr_rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM health_metrics WHERE metric='heart_rate_bpm'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hr_rows, 1, "two samples must not become two rows");
        let hr_samples: i64 = conn
            .query_row(
                "SELECT sample_count FROM health_metrics WHERE metric='heart_rate_bpm'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hr_samples, 2, "the one row must remember how many samples it stands for");
        // And there is no table the samples could have gone into.
        let sample_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'health_sample%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sample_tables, 0);
    }

    /// The sentence the sleep widget shows, end to end from XML to JSON.
    #[test]
    fn the_sleep_card_reads_seven_hours_twelve_not_four_hundred_and_thirty_two() {
        let conn = imported();
        let metrics = latest_metrics(&conn, "u1").expect("read");
        assert_eq!(card(&metrics, "sleep_asleep_minutes")["value"], json!("7h 12m"));
        assert_eq!(card(&metrics, "sleep_deep_minutes")["value"], json!("1h 40m"));
        assert_eq!(card(&metrics, "sleep_asleep_minutes")["raw"], json!(432.0));
        assert_eq!(card(&metrics, "sleep_asleep_minutes")["name"], json!("Time asleep"));
        assert_eq!(card(&metrics, "sleep_asleep_minutes")["category"], json!("sleep"));
    }

    /// Every card carries the day it is from. Weight is weekly and heart rate
    /// is continuous; without the day they would sit side by side looking
    /// equally current.
    #[test]
    fn every_card_says_which_day_it_is_from_and_where_it_came_from() {
        let conn = imported();
        let metrics = latest_metrics(&conn, "u1").expect("read");
        let steps = card(&metrics, "steps");
        assert_eq!(steps["day"], json!("2026-08-08"));
        assert_eq!(steps["value"], json!("4,100"));
        assert_eq!(steps["source"], json!("iPhone"));
        // The older day is still stored — `latest_metrics` shows the newest.
        let hist = series(&conn, "u1", "steps", 10).expect("series");
        assert_eq!(hist["returned"], json!(2));
        assert_eq!(hist["days"][1]["value"], json!("8,213"));
        assert_eq!(hist["truncated"], json!(false));
    }

    #[test]
    fn an_averaged_metric_carries_its_daily_range() {
        let conn = imported();
        let hr = latest_metrics(&conn, "u1").expect("read");
        let hr = card(&hr, "heart_rate_bpm");
        assert_eq!(hr["value"], json!("62 bpm"));
        assert_eq!(hr["low"], json!(58.0));
        assert_eq!(hr["high"], json!(66.0));
        assert_eq!(hr["range"], json!("58 bpm–66 bpm"));
        assert_eq!(hr["sampleCount"], json!(2));
    }

    /// Re-importing is the obvious second thing a person does. It must replace
    /// the day, not add to it, and must not duplicate a workout.
    #[test]
    fn importing_the_same_export_twice_changes_nothing() {
        let mut conn = imported();
        let before: (i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM health_metrics), (SELECT COUNT(*) FROM health_workouts)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let derived = ingest(EXPORT.as_bytes(), Limits::default()).expect("readable");
        apply_import(&mut conn, "u1", "apple_export", &derived).expect("stored twice");
        let after: (i64, i64) = conn
            .query_row(
                "SELECT (SELECT COUNT(*) FROM health_metrics), (SELECT COUNT(*) FROM health_workouts)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(before, after, "a second import duplicated rows");
        let steps: f64 = conn
            .query_row(
                "SELECT value FROM health_metrics WHERE metric='steps' AND day='2026-08-08'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(steps, 4100.0, "the day was added to instead of replaced");
    }

    /// Another account's rows must be invisible, in SQL and not by filtering
    /// afterwards.
    #[test]
    fn one_persons_health_data_is_not_another_persons() {
        let mut conn = imported();
        let derived = ingest(EXPORT.as_bytes(), Limits::default()).expect("readable");
        apply_import(&mut conn, "u2", "apple_export", &derived).expect("stored");
        assert_eq!(latest_metrics(&conn, "u1").unwrap().len(), 6);
        assert_eq!(latest_metrics(&conn, "nobody").unwrap().len(), 0);
        assert_eq!(coverage(&conn, "nobody").unwrap()["metrics"], json!(0));
        // And forgetting one account leaves the other alone.
        forget(&mut conn, "u1").expect("forgotten");
        assert_eq!(latest_metrics(&conn, "u1").unwrap().len(), 0);
        assert_eq!(latest_metrics(&conn, "u2").unwrap().len(), 6);
    }

    #[test]
    fn forgetting_removes_the_metrics_the_workouts_and_the_source() {
        let mut conn = imported();
        let gone = forget(&mut conn, "u1").expect("forget");
        assert_eq!(gone["metrics"], json!(7));
        assert_eq!(gone["workouts"], json!(1));
        assert_eq!(gone["sources"], json!(1));
        let snap = snapshot(&conn, "u1", Utc::now(), vec![], json!([])).expect("snapshot");
        assert_eq!(snap["hasData"], json!(false));
        assert_eq!(snap["sources"], json!([]));
    }

    /// Day one of every install, because macOS has no health data source at
    /// all. It has to be a clean, complete answer rather than an error.
    #[test]
    fn a_store_with_nothing_in_it_answers_honestly() {
        let conn = db();
        let snap = snapshot(&conn, "u1", Utc::now(), vec![], json!([])).expect("snapshot");
        assert_eq!(snap["hasData"], json!(false));
        assert_eq!(snap["metrics"], json!([]));
        assert_eq!(snap["coverage"]["days"], json!(0));
        assert_eq!(snap["coverage"]["firstDay"], Value::Null);
        // The parts of the design with nothing behind them are empty rather
        // than populated with plausible-looking furniture.
        for invented in ["signals", "devices", "clay"] {
            assert_eq!(snap[invented], json!([]), "{invented}");
        }
        assert_eq!(snap["primaryDevice"], Value::Null);
    }

    /// The detail line has to say when records were skipped, or a nearly-empty
    /// import looks like a nearly-empty life.
    #[test]
    fn the_source_line_says_what_was_skipped() {
        let mut conn = db();
        let derived = ingest(
            r#"<HealthData>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-08-07 07:00:00 +0200" endDate="2026-08-07 07:10:00 +0200" value="900"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2026-08-07 08:00:00 +0200" endDate="2026-08-07 08:10:00 +0200" value="999999999"/>
</HealthData>"#
                .as_bytes(),
            Limits::default(),
        )
        .expect("readable");
        apply_import(&mut conn, "u1", "apple_export", &derived).expect("stored");
        let snap = snapshot(&conn, "u1", Utc::now(), vec![], json!([])).expect("snapshot");
        let detail = snap["sources"][0]["detail"].as_str().expect("a detail line");
        assert!(detail.contains("1 records skipped"), "{detail}");
        assert_eq!(snap["sources"][0]["recordsRejected"], json!(1));
    }

    /// A metric the importer can produce but this table has never heard of would
    /// render as its raw identifier on a card. This is the guard that keeps the
    /// two vocabularies together.
    #[test]
    fn every_metric_the_importer_can_emit_has_a_name() {
        for metric in crate::health::import::emittable_metrics() {
            assert!(
                presentation_for(metric).is_some(),
                "the importer can emit '{metric}' and nothing here knows how to name it"
            );
        }
        // And the other direction: an entry nobody can produce is a card that
        // will never render, left behind by a rename.
        let emittable = crate::health::import::emittable_metrics();
        for p in PRESENTATION {
            assert!(
                emittable.contains(&p.metric),
                "'{}' is presented but nothing can produce it",
                p.metric
            );
        }
    }

    #[test]
    fn numbers_are_formatted_the_way_a_person_reads_them() {
        assert_eq!(grouped(0), "0");
        assert_eq!(grouped(999), "999");
        assert_eq!(grouped(1_000), "1,000");
        assert_eq!(grouped(8_213), "8,213");
        assert_eq!(grouped(1_234_567), "1,234,567");
        assert_eq!(format_value("sleep_asleep_minutes", 432.0), "7h 12m");
        assert_eq!(format_value("sleep_awake_minutes", 8.0), "8m");
        assert_eq!(format_value("distance_walking_running_km", 8.14), "8.1 km");
        assert_eq!(format_value("steps", 8213.4), "8,213");
    }

    /// A `NaiveDate` sorts correctly as text only in ISO form, and every query
    /// above orders and compares `day` as text.
    #[test]
    fn days_are_stored_in_a_form_that_sorts() {
        let d = NaiveDate::from_ymd_opt(2026, 8, 7).expect("a date");
        assert_eq!(d.to_string(), "2026-08-07");
        assert!("2026-08-07" < "2026-08-08");
        assert!("2026-09-01" > "2026-08-31");
    }
}
