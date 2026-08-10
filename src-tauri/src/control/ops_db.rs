// The local-database capability matrix.
//
// WHY THIS IS NOT JUST A CALL TO db_select
// `crate::db::db_select` takes a table name plus arbitrary equality filters and
// validates them against the LIVE schema — so any of the 44 tables is legal, and
// `user_id` is just another filter. Locally there is no RLS: the SQLite file is
// one trust boundary, and Postgres' per-row policy is not enforced by anything
// on this side of the migration. Handing that command to a model as-is would be
// handing it a multi-account read primitive over every table in the app.
//
// So a control-port db read must pass THREE gates that db_select does not have:
//   1. the table appears in TABLES below,
//   2. every column named in the request appears in that table's allowlist,
//   3. `user_id` comes from the authenticated Ctx and nowhere else.
// db_select's own identifier validation still runs underneath all of it; these
// gates narrow what may be asked, they do not replace what it checks.
//
// This module reads. It never reaches the insert/update/delete commands — see
// the absence notes in registry.rs for why deletion in particular is not a
// capability the brain gets.

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

use super::ops_project;
use crate::control::Ctx;

/// One readable table and the exact shape of what may be asked of it.
pub struct TableCap {
    pub table: &'static str,
    /// The only columns that may be selected, filtered on, or ordered by.
    /// Unknown columns are REJECTED rather than dropped: silently ignoring a
    /// filter turns "tasks due today" into "all tasks", and the model presents
    /// the wider answer as if it were the narrow one it asked for.
    ///
    /// `user_id` is deliberately absent from every list. It is never returned
    /// (it is the same value the caller already authenticated as, so it is pure
    /// token cost) and never accepted (see `read`).
    pub columns: &'static [&'static str],
    pub default_order: &'static str,
    /// Whether the natural reading of this table is oldest-first. Calendars read
    /// forwards; everything else reads newest-first.
    pub default_ascending: bool,
}

/// Every table the control port can read, and what of it.
///
/// `ai_insights` and `atlas_knowledge_entries` are Atlas' own generated
/// material and are listed here as readable, but NO op in registry.rs reaches
/// them in this milestone — the grant and the reach are separate, and both have
/// to say yes. Adding a knowledge/insight op later is then a registry change
/// only, with the column shape already reviewed.
pub static TABLES: &[TableCap] = &[
    TableCap {
        table: "user_tasks",
        columns: &["id", "title", "completed", "priority", "due_date", "created_at", "updated_at"],
        default_order: "created_at",
        default_ascending: false,
    },
    TableCap {
        table: "user_notes",
        columns: &["id", "title", "content", "color", "created_at", "updated_at"],
        default_order: "updated_at",
        default_ascending: false,
    },
    TableCap {
        table: "user_events",
        columns: &[
            "id",
            "title",
            "description",
            "start_time",
            "end_time",
            "location",
            "event_type",
            "attendees",
        ],
        default_order: "start_time",
        // Upcoming first: a calendar read that starts at the oldest meeting on
        // record answers nothing anyone asked.
        default_ascending: true,
    },
    TableCap {
        table: "user_watchlist",
        columns: &["id", "symbol", "name", "created_at"],
        default_order: "created_at",
        default_ascending: false,
    },
    TableCap {
        table: "ai_insights",
        columns: &["id", "insight_type", "title", "content", "priority", "is_read", "created_at"],
        default_order: "created_at",
        default_ascending: false,
    },
    TableCap {
        table: "atlas_knowledge_entries",
        // No `content` — a knowledge entry's body is an unbounded jsonb blob and
        // this is a listing surface, not a document reader.
        columns: &[
            "id",
            "category",
            "topic",
            "source",
            "confidence",
            "relevance_score",
            "is_validated",
            "created_at",
        ],
        default_order: "created_at",
        default_ascending: false,
    },
    TableCap {
        table: "mail_threads",
        columns: &[
            "id",
            "subject",
            "participants",
            "status",
            "unread_count",
            "last_message_at",
            "handled_at",
        ],
        default_order: "last_message_at",
        default_ascending: false,
    },
    TableCap {
        table: "mail_messages",
        // `extracted` is absent on purpose: that column is where the full
        // message bodies live (mail.rs writes body_text/body_html into it), and
        // those are attacker-authored text. `snippet` is the projection.
        columns: &[
            "id",
            "thread_id",
            "from_address",
            "subject",
            "snippet",
            "received_at",
            "category",
            "has_attachments",
        ],
        default_order: "received_at",
        default_ascending: true,
    },
];

/// Default and maximum row counts. The maximum exists because the 4 KB
/// projection cap would otherwise do the limiting, and a query that reads 5000
/// rows to discard 4990 of them holds the single WAL connection the whole app
/// shares (db.rs) for no benefit.
const DEFAULT_LIMIT: i64 = 25;
const MAX_LIMIT: i64 = 200;

pub fn cap_for(table: &str) -> Option<&'static TableCap> {
    TABLES.iter().find(|t| t.table == table)
}

fn allows(cap: &TableCap, col: &str) -> bool {
    cap.columns.contains(&col)
}

/// The exact query the read will run: everything decided from untrusted input,
/// with no I/O.
///
/// Kept separate from `read` on purpose. This is the whole security decision —
/// which table, which columns, whose rows — and a function that also needs a
/// live `AppHandle` and an open SQLite file cannot be unit-tested. Splitting it
/// means the allowlist and the user-id injection are covered by tests that run
/// on every `cargo test`, with no app.
#[derive(Debug)]
pub struct Query {
    pub filters: Map<String, Value>,
    pub order_by: String,
    pub ascending: bool,
    pub limit: i64,
}

fn plan(
    cap: &TableCap,
    args: &Value,
    ctx: &Ctx,
    extra_filters: &[(&str, Value)],
) -> Result<Query, String> {
    if ctx.user_id.is_empty() {
        return Err("this request carries no user identity, so there is no account to read".into());
    }

    let mut filters: Map<String, Value> = Map::new();

    if let Some(requested) = args.get("filters") {
        let obj = requested
            .as_object()
            .ok_or_else(|| "'filters' must be an object of column/value pairs".to_string())?;
        for (col, value) in obj {
            // Discarded, not rejected: passing your own user_id alongside a
            // query is a natural thing for a caller to do, and failing the read
            // over it teaches nothing. What matters is that the value cannot
            // take effect — including when it is somebody else's.
            if col == "user_id" {
                continue;
            }
            if !allows(cap, col) {
                // `snippet`, not the raw key: this message goes back to the
                // model verbatim, and the key came off the wire. An unbounded
                // one turned a rejection into a bigger context payload than any
                // success on this op — on a Read-tier path that writes no audit
                // row and costs one rate-limit token.
                return Err(format!(
                    "'{}' is not a readable column on '{}'",
                    ops_project::snippet(col),
                    cap.table
                ));
            }
            filters.insert(col.clone(), value.clone());
        }
    }

    // Op-supplied pins (e.g. mail.read_thread fixing a thread id). They come
    // from op code rather than the wire, but they are still checked, so a
    // future op cannot widen the matrix by naming a column nobody reviewed.
    for (col, value) in extra_filters {
        if !allows(cap, col) {
            return Err(format!(
                "'{}' is not a readable column on '{}'",
                ops_project::snippet(col),
                cap.table
            ));
        }
        filters.insert((*col).to_string(), value.clone());
    }

    // The local stand-in for row-level security.
    //
    // There is no RLS in the SQLite file — it is one trust boundary, and the
    // Postgres per-row policies did not survive the migration. Scoping is
    // entirely this line's job. It is injected LAST so it overwrites anything
    // that got this far, and the only source is the authenticated Ctx.
    filters.insert("user_id".to_string(), Value::String(ctx.user_id.clone()));

    let order_by = match args.get("order_by").and_then(Value::as_str) {
        Some(col) if allows(cap, col) => col.to_string(),
        Some(col) => {
            return Err(format!(
                "'{}' is not a sortable column on '{}'",
                ops_project::snippet(col),
                cap.table
            ))
        }
        None => cap.default_order.to_string(),
    };
    let ascending = args
        .get("ascending")
        .and_then(Value::as_bool)
        .unwrap_or(cap.default_ascending);
    let limit = args
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT);

    Ok(Query { filters, order_by, ascending, limit })
}

/// Run the planned query. Everything untrusted was decided in `plan`; this is
/// the I/O, and it is the only part of a read that cannot be unit-tested.
fn fetch(
    app: &AppHandle,
    cap: &TableCap,
    args: &Value,
    ctx: &Ctx,
    extra_filters: &[(&str, Value)],
) -> Result<Value, String> {
    let q = plan(cap, args, ctx, extra_filters)?;

    // The one long-lived WAL connection, from the same managed state the IPC
    // commands use. `try_state` rather than `state`: the DB is opened in Tauri's
    // setup hook, and the control port binds slightly before that, so a request
    // arriving in that window must get an honest "not ready" instead of a panic.
    let state = app
        .try_state::<crate::db::DbState>()
        .ok_or_else(|| "the local database is not open yet".to_string())?;

    crate::db::db_select(
        state,
        cap.table.to_string(),
        Some(q.filters),
        Some(q.order_by),
        Some(q.ascending),
        Some(q.limit),
    )
}

/// Project every returned row down to the table's readable columns.
fn project(rows: &Value, cap: &TableCap) -> Vec<Value> {
    rows.as_array()
        .map(|a| a.iter().map(|r| ops_project::pick(r, cap.columns)).collect())
        .unwrap_or_default()
}

/// What a LIST read hands back: projected rows under the size cap, with
/// anything that did not fit reported as `truncated`.
pub fn project_list(rows: &Value, cap: &TableCap) -> Value {
    ops_project::capped(project(rows, cap))
}

/// What a SINGLE-ROW read hands back.
///
/// Deliberately NOT `project_list(..)["items"][0]`, and that is the entire
/// reason this function exists. It used to be exactly that, and the size cap
/// then answered a question it has no business answering: a row whose
/// projection exceeded 4 KB was dropped, `first()` saw nothing, and the caller
/// reported the row as non-existent. With one row `continue` and `break` are
/// the same statement, so the earlier list-cap fix did nothing for this path.
///
/// `fit_one` shrinks the row instead of dropping it, so the answer to "does this
/// exist" no longer depends on how long an attacker made a subject line.
pub fn project_one(rows: &Value, cap: &TableCap) -> Option<Value> {
    project(rows, cap).into_iter().next().map(ops_project::fit_one)
}

/// Run one allowlisted read and return the projected, capped list.
pub fn read(
    app: &AppHandle,
    table: &'static str,
    args: &Value,
    ctx: &Ctx,
    extra_filters: &[(&str, Value)],
) -> Result<Value, String> {
    let cap = cap_for(table)
        .ok_or_else(|| format!("'{table}' is not a table the control port can read"))?;
    let rows = fetch(app, cap, args, ctx, extra_filters)?;
    Ok(project_list(&rows, cap))
}

/// Read exactly one row by id, already scoped to the Ctx user. `None` when the
/// row does not exist OR belongs to somebody else — the two are deliberately
/// indistinguishable to the caller, since telling them apart would confirm the
/// existence of another account's records.
///
/// `None` means exactly those two things and nothing else. It must never mean
/// "the row was too big to report", which is what it used to mean as well.
pub fn read_one(
    app: &AppHandle,
    table: &'static str,
    id: &str,
    ctx: &Ctx,
) -> Result<Option<Value>, String> {
    let cap = cap_for(table)
        .ok_or_else(|| format!("'{table}' is not a table the control port can read"))?;
    let rows = fetch(
        app,
        cap,
        &serde_json::json!({ "limit": 1 }),
        ctx,
        &[("id", Value::String(id.to_string()))],
    )?;
    Ok(project_one(&rows, cap))
}

// ---------------------------------------------------------------------------
// Runners
//
// One line each, and each one names its table as a literal. That is the point:
// the table a given op can reach is fixed at compile time and visible in this
// file, rather than being a string the caller supplies. There is deliberately
// no generic "db.select" op — an op that takes the table name from the request
// would put the whole matrix behind one name and make the audit question
// "which tables can the brain read?" unanswerable from the registry.
// ---------------------------------------------------------------------------

pub fn tasks(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    read(app, "user_tasks", args, ctx, &[])
}

pub fn notes(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    read(app, "user_notes", args, ctx, &[])
}

pub fn events(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    read(app, "user_events", args, ctx, &[])
}

pub fn watchlist(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    read(app, "user_watchlist", args, ctx, &[])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::Profile;
    use serde_json::json;

    fn ctx(user_id: &str) -> Ctx {
        Ctx {
            user_id: user_id.to_string(),
            user_token: None,
            profile: Profile::Background,
            request_id: "test".into(),
        }
    }

    fn tasks() -> &'static TableCap {
        cap_for("user_tasks").expect("user_tasks is in the matrix")
    }

    #[test]
    fn a_caller_supplied_user_id_never_reaches_the_query() {
        // The multi-account read attempt: ask for somebody else's rows outright.
        let q = plan(
            tasks(),
            &json!({ "filters": { "user_id": "someone-else", "completed": 0 } }),
            &ctx("me"),
            &[],
        )
        .expect("the request is well-formed — it just does not get what it asked for");

        assert_eq!(
            q.filters["user_id"],
            json!("me"),
            "the Ctx user must win; this is the only thing scoping the read"
        );
        // The legitimate part of the request survives.
        assert_eq!(q.filters["completed"], json!(0));
    }

    #[test]
    fn an_op_pinned_filter_cannot_override_the_user_either() {
        let q = plan(
            tasks(),
            &json!({}),
            &ctx("me"),
            &[("id", json!("t1")), ("user_id", json!("someone-else"))],
        );
        // `user_id` is not an allowlisted column, so an op that tried this is
        // refused outright rather than quietly corrected.
        assert!(q.is_err(), "op-supplied user_id must be rejected");
    }

    #[test]
    fn a_read_with_no_identity_is_refused() {
        assert!(
            plan(tasks(), &json!({}), &ctx(""), &[]).is_err(),
            "an unidentified caller must not fall through to an unscoped read"
        );
    }

    fn with_filter(col: &str, value: Value) -> Value {
        let mut filters = Map::new();
        filters.insert(col.to_string(), value);
        json!({ "filters": Value::Object(filters) })
    }

    #[test]
    fn non_allowlisted_columns_are_rejected_not_ignored() {
        // Baseline: an allowlisted column really does pass, so a later rename
        // cannot make this test vacuously green.
        assert!(plan(tasks(), &with_filter("created_at", json!("x")), &ctx("me"), &[]).is_ok());

        for bad in [
            "is_fake",          // a real column, on a different table
            "rowid",            // real on THIS table, and not in the allowlist
            "nope",             // not a column anywhere
            "id; DROP TABLE user_tasks",
        ] {
            assert!(
                plan(tasks(), &with_filter(bad, json!(1)), &ctx("me"), &[]).is_err(),
                "filtering on '{bad}' must be rejected, not silently dropped"
            );
        }
        // ORDER BY answers to the same allowlist.
        assert!(plan(tasks(), &json!({ "order_by": "rowid" }), &ctx("me"), &[]).is_err());
        assert!(plan(tasks(), &json!({ "order_by": "user_id" }), &ctx("me"), &[]).is_err());
    }

    #[test]
    fn non_allowlisted_tables_have_no_query_at_all() {
        assert!(cap_for("ai_memory").is_none());
        assert!(cap_for("profiles").is_none());
    }

    #[test]
    fn limits_are_clamped_and_defaulted() {
        let q = plan(tasks(), &json!({}), &ctx("me"), &[]).unwrap();
        assert_eq!(q.limit, DEFAULT_LIMIT);
        assert_eq!(q.order_by, "created_at");
        assert!(!q.ascending);

        assert_eq!(plan(tasks(), &json!({ "limit": 99999 }), &ctx("me"), &[]).unwrap().limit, MAX_LIMIT);
        assert_eq!(plan(tasks(), &json!({ "limit": 0 }), &ctx("me"), &[]).unwrap().limit, 1);
        assert_eq!(plan(tasks(), &json!({ "limit": -5 }), &ctx("me"), &[]).unwrap().limit, 1);
    }

    #[test]
    fn malformed_filters_are_refused_rather_than_guessed_at() {
        assert!(plan(tasks(), &json!({ "filters": "completed" }), &ctx("me"), &[]).is_err());
        assert!(plan(tasks(), &json!({ "filters": [1, 2] }), &ctx("me"), &[]).is_err());
    }

    #[test]
    fn every_matrix_entry_is_self_consistent() {
        for cap in TABLES {
            assert!(
                allows(cap, cap.default_order),
                "{}: default_order '{}' is not in its own column allowlist",
                cap.table,
                cap.default_order
            );
            assert!(
                !cap.columns.contains(&"user_id"),
                "{}: user_id must never be an allowlisted column — it is injected",
                cap.table
            );
            assert!(!cap.columns.is_empty(), "{}: empty allowlist", cap.table);
        }
    }

    #[test]
    fn matrix_table_names_are_unique() {
        for (i, cap) in TABLES.iter().enumerate() {
            assert!(
                TABLES.iter().take(i).all(|prev| prev.table != cap.table),
                "duplicate matrix entry for {}",
                cap.table
            );
        }
    }

    #[test]
    fn tables_outside_the_matrix_have_no_capability() {
        // Real tables in db_schema.sql that db_select would happily read.
        for table in [
            "profiles",
            "ai_memory",
            "memory_vectors",
            "mail_accounts",
            "mail_drafts",
            "atlas_system_settings",
            "user_roles",
            "",
        ] {
            assert!(cap_for(table).is_none(), "{table} must not be readable");
        }
    }

    // -- the single-row lookup ---------------------------------------------

    /// The defect, stated as the two calls it made disagree.
    ///
    /// `mail_threads.subject` is unbounded at ingest and is in the read
    /// allowlist, so whoever emails the user chooses its length. `read_one`
    /// took items[0] of a `capped()` list, so a ~5 KB subject dropped the only
    /// row, `first()` returned `None`, and `mail.read_thread` answered "no such
    /// thread in the local mail store" about a thread that exists — and
    /// `confirm_thread` then made mail.archive and mail.mark_read refuse it too.
    /// One inbound subject line made a thread permanently unreadable and
    /// un-archivable, with Atlas asserting it did not exist.
    #[test]
    fn a_thread_with_a_hostile_subject_is_still_found_by_id() {
        let cap = cap_for("mail_threads").expect("mail_threads is in the matrix");
        let rows = json!([{
            "id": "thread-1",
            "subject": "x".repeat(5_000),
            "status": "unhandled",
            "user_id": "me",
        }]);

        // The LIST answer legitimately drops it — a list may be partial.
        assert_eq!(project_list(&rows, cap)["returned"], json!(0));
        assert_eq!(project_list(&rows, cap)["truncated"], json!(true));

        // The SINGLE-ROW answer must not. This assertion was false.
        let one = project_one(&rows, cap)
            .expect("the thread exists; answering 'no such thread' is a fabrication");
        assert_eq!(one["id"], json!("thread-1"));
        assert_eq!(one["truncated"], json!(true), "the clipped subject must say so");
        // The projection still applies: user_id is not a readable column.
        assert!(one.get("user_id").is_none());
    }

    #[test]
    fn project_one_still_returns_nothing_when_the_query_found_nothing() {
        let cap = cap_for("mail_threads").expect("mail_threads is in the matrix");
        // The genuine absent case must stay absent — the fix must not turn a
        // missing row (or another account's row, which the query never returns)
        // into a fabricated one.
        assert!(project_one(&json!([]), cap).is_none());
        assert!(project_one(&Value::Null, cap).is_none());
    }

    /// `fit_one` stamps `truncated` onto the row it shrank. If a readable column
    /// were ever called that, the marker would overwrite real data and the model
    /// would read a stored value as a size warning.
    #[test]
    fn no_readable_column_collides_with_the_truncation_marker() {
        for cap in TABLES {
            assert!(
                !cap.columns.contains(&"truncated"),
                "{}: a 'truncated' column would collide with the fit_one marker",
                cap.table
            );
        }
    }

    /// The rejection message is echoed to the model verbatim, and the key comes
    /// off the wire. Unbounded, it made a refusal a bigger context payload than
    /// any success on the same op — for one rate-limit token and no audit row.
    #[test]
    fn a_rejected_column_name_is_bounded_before_it_is_echoed() {
        let hostile = "a".repeat(50_000);
        let err = plan(tasks(), &with_filter(&hostile, json!(1)), &ctx("me"), &[])
            .expect_err("an unknown column is rejected");
        assert!(err.len() < 200, "the error is {} bytes long", err.len());

        // Same for ORDER BY, which builds its message the same way.
        let err = plan(tasks(), &json!({ "order_by": hostile }), &ctx("me"), &[])
            .expect_err("an unknown sort column is rejected");
        assert!(err.len() < 200, "the error is {} bytes long", err.len());

        // And a short name is still named, or the model cannot fix its call.
        let err = plan(tasks(), &with_filter("nope", json!(1)), &ctx("me"), &[]).unwrap_err();
        assert!(err.contains("nope"), "{err}");
    }

    #[test]
    fn bodies_are_not_reachable_through_the_mail_matrix() {
        let cap = cap_for("mail_messages").expect("mail_messages is in the matrix");
        assert!(
            !allows(cap, "extracted"),
            "the extracted column carries full message bodies and must stay out"
        );
    }
}
