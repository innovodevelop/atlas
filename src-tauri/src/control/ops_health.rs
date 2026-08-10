// Health ops: three reads, and nothing else. Ever.
//
// WHY EVERY OP HERE IS `Tier::Read`, AND WHY THAT IS A PRODUCT DECISION RATHER
// THAN A MILESTONE
// Atlas' health surface makes a promise in words — "Atlas can read your health
// data, never change it" (`health::privacy()`). This file is where that promise
// is either true or decoration. Read tier is the only tier that cannot mutate
// anything, and `the_health_privacy_card_matches_the_tiers_that_enforce_it` in
// registry.rs asserts the two agree, so the sentence on the screen cannot drift
// away from the table that enforces it.
//
// Read tier also means `summary_keys: None` throughout, which is not laziness:
// `None` is the FAIL-CLOSED default — an op that declares no approvals card
// cannot be queued at all. A read never reaches the queue, so there is nothing
// to declare, and declaring something would be inventing a card nobody will
// ever see.
//
// WHAT IS DELIBERATELY ABSENT
//
//   health.import    Takes a filesystem PATH and reports what it found there:
//                    the size, whether it parsed, how many records. That is a
//                    file-probing primitive wearing a health tool's clothes — a
//                    model could walk a directory by error message alone. It is
//                    also not a capability anybody needs: importing is a person
//                    choosing a file in a picker, standing at the screen.
//   health.forget    Deletes a person's entire health history. The answer to
//                    "can Atlas delete my health data on its own" has to be no,
//                    and the cheapest way to guarantee it is for no op here to
//                    name the command.
//   anything writing Nothing in this module writes a row. Health data comes
//                    from the person's own export and from nowhere else; a tool
//                    that could add a day would be a tool that could invent one.
//
// Both absent commands are on `DENIED` in registry.rs, so they are refused by
// two independent layers rather than by this comment.
//
// AND ONE THING WORTH SAYING OUT LOUD: WHAT A READ HERE EXPOSES.
// These ops put a person's sleep, weight and resting heart rate into a model's
// context. That is the point — an assistant that cannot see it cannot answer
// "did I sleep badly this week?" — but it is why the projection below is a
// hand-written list of fields rather than the snapshot: the snapshot carries
// per-source provenance, file names and import diagnostics, none of which
// answers a question and all of which would be sitting in a prompt.

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use super::ops_project;
use crate::control::Ctx;
use crate::db::DbState;
use crate::health::health_series;
use crate::health::health_snapshot;
use crate::health::health_workouts;
use crate::health::metric_names;

fn db(app: &AppHandle) -> Result<State<'_, DbState>, String> {
    app.try_state::<DbState>()
        .ok_or_else(|| "the local database is not open yet".to_string())
}

/// The account whose health this is.
///
/// Required rather than defaulted. Every query is scoped by user_id in SQL, so
/// an empty one returns a person with no health data — which reads exactly like
/// "you have never imported anything" and is a different statement from "this
/// request carried no identity".
fn user(ctx: &Ctx) -> Result<String, String> {
    if ctx.user_id.is_empty() {
        return Err("this request carries no user identity, so there is no health data to read".into());
    }
    Ok(ctx.user_id.clone())
}

/// The health snapshot, projected down to what a model can answer with.
///
/// Everything dropped here is dropped for a reason: `privacy` is a page's
/// furniture, `signals`/`devices`/`clay`/`primaryDevice` are empty on this
/// platform and cost tokens to say so, and the source block's file names and
/// per-reason rejection counts are diagnostics for a human on the Sources
/// screen. What survives is the numbers and — never optional — the DAY each one
/// is from, because a model handed a three-week-old weight with no date will
/// describe it as today's.
fn project(snap: &Value) -> Value {
    let metrics: Vec<Value> = snap["metrics"]
        .as_array()
        .unwrap_or(&Vec::new())
        .iter()
        .map(|m| {
            json!({
                "metric": m["metric"],
                "name": m["name"],
                "value": m["value"],
                "raw": m["raw"],
                "unit": m["unit"],
                "stat": m["stat"],
                "day": m["day"],
                "range": m["range"],
                "source": m["source"],
            })
        })
        .collect();

    // Whether there is anything at all, and how far back it goes. A model that
    // cannot see this answers "how did I sleep in June?" from an empty store by
    // apologising vaguely instead of saying the import does not cover June.
    let coverage = &snap["coverage"];
    json!({
        "has_data": snap["hasData"],
        "captured_at": snap["capturedAt"],
        "coverage": {
            "first_day": coverage["firstDay"],
            "last_day": coverage["lastDay"],
            "days": coverage["days"],
            "workouts": coverage["workouts"],
        },
        "metrics": ops_project::capped(metrics),
        // The vocabulary for health.metric_history, told up front rather than
        // discovered by being refused.
        "metric_names": metric_names(),
    })
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/// The most recent value of every metric, with the day each came from.
pub fn summary(app: &AppHandle, _args: &Value, ctx: &Ctx) -> Result<Value, String> {
    let snap = health_snapshot(db(app)?, user(ctx)?)?;
    Ok(project(&snap))
}

/// One metric over time.
pub fn metric_history(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    let metric = args
        .get("metric")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            // The whole vocabulary in the refusal: a model told only "invalid"
            // spends its next turn guessing.
            format!(
                "health.metric_history needs a 'metric', one of: {}",
                metric_names().join(", ")
            )
        })?
        .to_string();
    let days = args
        .get("days")
        .and_then(Value::as_u64)
        .unwrap_or(30)
        .min(400) as usize;
    health_series(db(app)?, user(ctx)?, metric, days)
}

/// Recent workouts, newest first.
pub fn workouts(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(10).min(50) as usize;
    let out = health_workouts(db(app)?, user(ctx)?, limit)?;
    let rows: Vec<Value> = out["workouts"].as_array().cloned().unwrap_or_default();
    Ok(ops_project::capped(rows))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot_fixture() -> Value {
        json!({
            "capturedAt": "2026-08-08T09:00:00.000Z",
            "hasData": true,
            "coverage": { "metrics": 40, "days": 12, "workouts": 3,
                          "firstDay": "2026-07-28", "lastDay": "2026-08-08" },
            "metrics": [
                { "id": "steps", "metric": "steps", "name": "Steps", "category": "move",
                  "value": "8,213", "raw": 8213.0, "unit": "count", "stat": "sum",
                  "day": "2026-08-08", "sampleCount": 40, "source": "Magnus' iPhone",
                  "low": null, "high": null, "range": null },
                { "id": "body_mass_kg", "metric": "body_mass_kg", "name": "Weight",
                  "category": "body", "value": "78.4 kg", "raw": 78.4, "unit": "kg",
                  "stat": "avg", "day": "2026-07-19", "sampleCount": 1,
                  "source": "Withings", "low": 78.4, "high": 78.4, "range": null },
            ],
            "workouts": [],
            "privacy": [{ "id": "on_device", "enabled": true }],
            "signals": [], "devices": [], "clay": [], "primaryDevice": null,
            "sources": [{ "id": "apple_export", "fileName": "export.zip",
                          "recordsRejected": 12 }],
        })
    }

    /// A card without its own date is the failure this projection exists to
    /// prevent: weight is weekly and steps are continuous, so a model handed
    /// both undated will describe a three-week-old weight as today's.
    #[test]
    fn every_value_reaching_the_model_carries_the_day_it_is_from() {
        let out = project(&snapshot_fixture());
        let items = out["metrics"]["items"].as_array().expect("a metric list");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["day"], json!("2026-08-08"));
        assert_eq!(items[1]["day"], json!("2026-07-19"));
        // Both the readable string and the number: one is for saying, the other
        // for comparing.
        assert_eq!(items[0]["value"], json!("8,213"));
        assert_eq!(items[0]["raw"], json!(8213.0));
    }

    /// "How did I sleep in June?" against a store that starts in July has a
    /// true answer, and the model can only give it if it can see the range.
    #[test]
    fn the_model_is_told_how_far_back_the_data_goes() {
        let out = project(&snapshot_fixture());
        assert_eq!(out["has_data"], json!(true));
        assert_eq!(out["coverage"]["first_day"], json!("2026-07-28"));
        assert_eq!(out["coverage"]["last_day"], json!("2026-08-08"));
        assert_eq!(out["coverage"]["days"], json!(12));
    }

    /// The page's furniture, the empty design vocabulary and the import
    /// diagnostics are not worth a token — and the file name in particular is
    /// something from the user's disk that has no business in a prompt.
    #[test]
    fn the_page_only_parts_of_the_snapshot_are_not_forwarded() {
        let out = project(&snapshot_fixture());
        for page_only in ["privacy", "signals", "devices", "clay", "primaryDevice", "sources"] {
            assert!(out.get(page_only).is_none(), "{page_only} reached the model");
        }
        assert!(!out.to_string().contains("export.zip"), "a file name reached the model");
    }

    /// The vocabulary travels with the answer, so the follow-up call does not
    /// have to be a guess.
    #[test]
    fn the_metric_names_a_history_call_accepts_are_published_with_the_summary() {
        let out = project(&snapshot_fixture());
        let names = out["metric_names"].as_array().expect("a name list");
        assert!(names.contains(&json!("steps")));
        assert!(names.contains(&json!("sleep_asleep_minutes")));
        assert!(names.contains(&json!("heart_rate_bpm")));
        // The published list IS the one the store can serve, so a model that
        // reads it and calls back with one of these names cannot miss.
        assert_eq!(
            names.len(),
            crate::health::metric_names().len(),
            "the summary publishes a different vocabulary from the one health.metric_history takes"
        );
    }

    /// An empty store is a complete answer here, not an error: macOS has no
    /// health source of its own, so "nothing imported yet" is day one of every
    /// install.
    #[test]
    fn an_empty_store_projects_to_an_honest_nothing() {
        let out = project(&json!({
            "hasData": false, "capturedAt": "2026-08-08T09:00:00.000Z",
            "metrics": [],
            "coverage": { "metrics": 0, "days": 0, "workouts": 0,
                          "firstDay": null, "lastDay": null },
        }));
        assert_eq!(out["has_data"], json!(false));
        assert_eq!(out["metrics"]["items"], json!([]));
        assert_eq!(out["coverage"]["first_day"], Value::Null);
    }

    #[test]
    fn a_request_with_no_identity_reads_nobodys_health_data() {
        let ctx = Ctx {
            user_id: String::new(),
            user_token: None,
            profile: crate::control::Profile::Background,
            request_id: "t".into(),
        };
        let err = user(&ctx).expect_err("an empty user_id is not an empty person");
        assert!(err.contains("identity"), "{err}");
    }
}
