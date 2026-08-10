// The local-database WRITE capability matrix — the mirror image of ops_db.rs.
//
// WHY THIS IS NOT JUST A CALL TO db_insert / db_update
// `crate::db::db_insert` takes a table name and an arbitrary JSON object;
// `crate::db::db_update` takes a table name, arbitrary equality filters and an
// arbitrary patch. Both validate identifiers against the LIVE schema, so all 44
// tables are legal and `user_id` is just another column. Handing either to a
// model would be handing it the ability to write `user_roles`, to move a row to
// somebody else's account by patching `user_id`, or to rewrite `created_at` so
// a record it just made looks a year old.
//
// So a control-port write passes gates db_insert/db_update do not have:
//   1. the table is a compile-time literal chosen by the runner, never an
//      argument (there is no generic `db.insert` op, and there must not be),
//   2. every field in the request appears in that op's field list, with a
//      declared type, length bound and required-ness — an UNKNOWN field is
//      rejected rather than dropped, because a silently-dropped `priority`
//      makes the model report a high-priority task it did not create,
//   3. `user_id` comes from the authenticated Ctx and nowhere else, on both the
//      INSERT values and the UPDATE filters. That is the whole of row-level
//      security on this side of the migration: the SQLite file has no RLS and
//      the Postgres policies did not survive it.
//
// WHAT IS DELIBERATELY NOT WRITABLE HERE
// `updated_at` — db_schema.sql:910-918 installs AFTER UPDATE triggers on
// user_notes / user_tasks / user_events that stamp it, guarded by
// `WHEN NEW.updated_at = OLD.updated_at`. A caller-supplied value satisfies
// nothing but that guard's negation: the trigger declines to fire and the
// timestamp freezes at whatever the caller said. `created_at` and `id` for the
// same class of reason — they are provenance, and provenance a caller can
// choose is not provenance.
//
// Nothing here deletes. See the absence notes in registry.rs.

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use super::{ops_db, ops_project};
use crate::control::Ctx;

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------

/// What one writable field accepts. The point of the enum is that the error
/// message can name the expectation: a model that gets "'priority' must be one
/// of low, medium, high" fixes its call on the next turn, where one that gets
/// "invalid argument" guesses, and guessing costs a full round trip each time.
#[derive(Clone, Copy)]
pub enum Kind {
    /// Free text, bounded. Bounds are per field because a note body and a
    /// ticker name are not the same kind of string.
    Text { max: usize },
    /// One of a fixed set of words.
    Enum(&'static [&'static str]),
    /// True/false. Also accepts 0/1 — see `as_bool`.
    Bool,
    /// An instant. A date, or a datetime that carries an offset. See
    /// `as_timestamp` for why a naive datetime is refused.
    Timestamp,
    /// A ticker symbol.
    Symbol,
    /// A short list of short strings, stored in a JSON TEXT column.
    StringList { max_items: usize, max_len: usize },
}

pub struct Field {
    pub name: &'static str,
    pub kind: Kind,
    /// Required on CREATE. Meaningless on a patch, where "required" would mean
    /// "you must change this", which no update op wants to say.
    pub required: bool,
    /// Whether an explicit `null` in an UPDATE may clear the column. Columns
    /// with a schema DEFAULT that the app relies on (priority, completed) are
    /// not clearable: NULL there is not "unset", it is a value nothing renders.
    pub nullable: bool,
}

const fn req(name: &'static str, kind: Kind) -> Field {
    Field { name, kind, required: true, nullable: false }
}

const fn opt(name: &'static str, kind: Kind) -> Field {
    Field { name, kind, required: false, nullable: false }
}

/// Optional and clearable — the update form of a column that means something
/// when it is absent (a task with no due date, an event with no location).
const fn clearable(name: &'static str, kind: Kind) -> Field {
    Field { name, kind, required: false, nullable: true }
}

const PRIORITIES: &[&str] = &["low", "medium", "high"];

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/// One writable table and the exact shape of what may be written to it.
pub struct WriteCap {
    pub table: &'static str,
    /// What the thing is called in an error message. Errors are read by a
    /// model, so "task" beats "user_tasks row".
    pub noun: &'static str,
    /// The read op that hands out the ids this cap's updates need. Named in the
    /// error when an update arrives without one.
    pub list_op: &'static str,
    pub create: &'static [Field],
    pub patch: &'static [Field],
    /// What comes back after a successful write.
    ///
    /// Short columns only, and a strict subset of what ops_db.rs lets the same
    /// table be READ with (a test enforces the subset). `content` and
    /// `description` are excluded on purpose: the caller sent that text one
    /// moment ago, so echoing it back is pure token cost on both the tool
    /// result and every subsequent turn that carries it.
    pub receipt: &'static [&'static str],
}

pub static TASKS: WriteCap = WriteCap {
    table: "user_tasks",
    noun: "task",
    list_op: "tasks.list",
    create: &[
        req("title", Kind::Text { max: 200 }),
        opt("priority", Kind::Enum(PRIORITIES)),
        opt("due_date", Kind::Timestamp),
    ],
    patch: &[
        opt("title", Kind::Text { max: 200 }),
        opt("completed", Kind::Bool),
        opt("priority", Kind::Enum(PRIORITIES)),
        clearable("due_date", Kind::Timestamp),
    ],
    receipt: &["id", "title", "completed", "priority", "due_date", "updated_at"],
};

pub static NOTES: WriteCap = WriteCap {
    table: "user_notes",
    noun: "note",
    list_op: "notes.list",
    create: &[
        req("title", Kind::Text { max: 200 }),
        opt("content", Kind::Text { max: 5_000 }),
    ],
    patch: &[
        opt("title", Kind::Text { max: 200 }),
        clearable("content", Kind::Text { max: 5_000 }),
    ],
    // `color` is absent from both lists. The column exists and defaults to
    // 'amber', but a model has no basis on which to pick one of the app's
    // palette values, and a note in a colour the user did not choose reads as
    // a bug in their own notebook.
    receipt: &["id", "title", "updated_at"],
};

pub static EVENTS: WriteCap = WriteCap {
    table: "user_events",
    noun: "event",
    list_op: "events.list",
    create: &[
        req("title", Kind::Text { max: 200 }),
        req("start_time", Kind::Timestamp),
        opt("end_time", Kind::Timestamp),
        opt("description", Kind::Text { max: 2_000 }),
        opt("location", Kind::Text { max: 200 }),
        opt("attendees", Kind::StringList { max_items: 25, max_len: 200 }),
    ],
    // No update op is registered for events in this milestone, so the patch
    // list is empty and `update` would refuse everything. Left as `&[]` rather
    // than removed so the shape of the matrix stays uniform and adding
    // `events.update` is a field-list change plus a registry line.
    patch: &[],
    receipt: &["id", "title", "start_time", "end_time", "location"],
};

pub static WATCHLIST: WriteCap = WriteCap {
    table: "user_watchlist",
    noun: "watchlist entry",
    list_op: "watchlist.list",
    create: &[
        req("symbol", Kind::Symbol),
        opt("name", Kind::Text { max: 100 }),
    ],
    patch: &[],
    receipt: &["id", "symbol", "name"],
};

/// Every cap, for the consistency tests — and test-only on purpose. No runner
/// may iterate this: each one names its cap directly, which is what pins an op
/// to one table at compile time. A runtime list would be the first step back
/// toward a table parameter.
#[cfg(test)]
pub static CAPS: &[&WriteCap] = &[&TASKS, &NOTES, &EVENTS, &WATCHLIST];

// ---------------------------------------------------------------------------
// Validation — pure, so every rule below is covered without an app
// ---------------------------------------------------------------------------

/// The longest id this port will echo back into an error message. Ids are
/// uuid v4 (36 chars) everywhere in db.rs; the bound exists so a hostile
/// `id` cannot turn a "no such task" into a paragraph of attacker text sitting
/// in the model's context.
const MAX_ID_LEN: usize = 64;

fn as_object<'a>(args: &'a Value, op: &str) -> Result<&'a Map<String, Value>, String> {
    args.as_object()
        .ok_or_else(|| format!("{op} needs an object of field/value pairs"))
}

fn field_list(fields: &[Field]) -> String {
    fields.iter().map(|f| f.name).collect::<Vec<_>>().join(", ")
}

fn as_text(name: &str, raw: &Value, max: usize) -> Result<Value, String> {
    let s = raw
        .as_str()
        .ok_or_else(|| format!("'{name}' must be a string"))?
        .trim();
    if s.is_empty() {
        return Err(format!("'{name}' must not be empty"));
    }
    let len = s.chars().count();
    if len > max {
        return Err(format!(
            "'{name}' is {len} characters; this field accepts at most {max}"
        ));
    }
    // Tabs and newlines are legitimate inside a note body. The rest of the
    // control range is not: it does not render, it survives round-trips through
    // the UI, and it is how a value smuggles a second line into anything that
    // later formats this row into text.
    if s.chars().any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t') {
        return Err(format!("'{name}' contains control characters"));
    }
    Ok(Value::String(s.to_string()))
}

fn as_enum(name: &str, raw: &Value, allowed: &[&str]) -> Result<Value, String> {
    let s = raw
        .as_str()
        .ok_or_else(|| format!("'{name}' must be a string"))?
        .trim();
    if allowed.contains(&s) {
        return Ok(Value::String(s.to_string()));
    }
    Err(format!(
        "'{name}' must be one of: {}",
        allowed.join(", ")
    ))
}

/// True/false, or 0/1.
///
/// The integer form is accepted because OUR OWN read side hands it out: SQLite
/// has no boolean type, so `tasks.list` returns `completed: 0`. A model that
/// echoes back what it just read must not be refused for our storage choice.
/// Strings ("true") are not accepted — nothing in this system produces them,
/// so accepting them would only paper over a caller that is guessing.
fn as_bool(name: &str, raw: &Value) -> Result<Value, String> {
    match raw {
        Value::Bool(b) => Ok(Value::Bool(*b)),
        Value::Number(n) => match n.as_i64() {
            Some(0) => Ok(Value::Bool(false)),
            Some(1) => Ok(Value::Bool(true)),
            _ => Err(format!("'{name}' must be true or false (or 0 or 1)")),
        },
        _ => Err(format!("'{name}' must be true or false (or 0 or 1)")),
    }
}

/// A date (`2026-08-10`) or an offset-carrying datetime
/// (`2026-08-10T14:00:00+02:00`, `2026-08-10T12:00:00Z`), normalised to the
/// schema's UTC format so it sorts against rows the app wrote.
///
/// A NAIVE datetime is REFUSED, and this is the one place leniency would do
/// real damage. "2026-08-10T14:00" is what a model produces when a user says
/// "book it for two"; if this function guessed UTC, the event would be stored
/// at 14:00Z and rendered at 16:00 in Copenhagen — a meeting silently moved two
/// hours, reported back as correct. There is no timezone available at this
/// layer to guess with, so the honest answer is to say what is missing.
///
/// A date-only value becomes UTC midnight, which is exactly how the webview's
/// `new Date('2026-08-10')` already reads the same string.
fn as_timestamp(name: &str, raw: &Value) -> Result<Value, String> {
    let s = raw
        .as_str()
        .ok_or_else(|| format!("'{name}' must be a string"))?
        .trim();
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Ok(Value::String(
            dt.with_timezone(&chrono::Utc)
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string(),
        ));
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Ok(Value::String(format!(
            "{}T00:00:00.000Z",
            d.format("%Y-%m-%d")
        )));
    }
    Err(format!(
        "'{name}' must be a date (2026-08-10) or a datetime carrying a UTC offset \
         (2026-08-10T14:00:00+02:00 or 2026-08-10T12:00:00Z). A time with no offset \
         cannot be placed on the clock and would be stored at the wrong hour."
    ))
}

/// A ticker symbol, upper-cased. The charset is the one Finnhub and the
/// watchlist UI already use (`BRK.B`, `RDS-A`); anything else is a caller that
/// has confused a company name for a symbol, and saying so beats storing it.
fn as_symbol(name: &str, raw: &Value) -> Result<Value, String> {
    let s = raw
        .as_str()
        .ok_or_else(|| format!("'{name}' must be a string"))?
        .trim()
        .to_ascii_uppercase();
    let ok = !s.is_empty()
        && s.len() <= 12
        && s.chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.' || c == '-');
    if ok {
        Ok(Value::String(s))
    } else {
        Err(format!(
            "'{name}' must be a ticker symbol of up to 12 characters (letters, digits, '.' or '-'), \
             such as AAPL or BRK.B — not a company name"
        ))
    }
}

fn as_string_list(
    name: &str,
    raw: &Value,
    max_items: usize,
    max_len: usize,
) -> Result<Value, String> {
    let arr = raw
        .as_array()
        .ok_or_else(|| format!("'{name}' must be an array of strings"))?;
    if arr.len() > max_items {
        return Err(format!(
            "'{name}' has {} entries; this field accepts at most {max_items}",
            arr.len()
        ));
    }
    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        out.push(as_text(name, item, max_len)?);
    }
    // Handed to db_insert as an array: db.rs's json_to_sql serialises a
    // non-scalar to its JSON text, which is exactly the shape of the column
    // (`attendees TEXT DEFAULT '[]'`).
    Ok(Value::Array(out))
}

fn validate(field: &Field, raw: &Value) -> Result<Value, String> {
    match field.kind {
        Kind::Text { max } => as_text(field.name, raw, max),
        Kind::Enum(allowed) => as_enum(field.name, raw, allowed),
        Kind::Bool => as_bool(field.name, raw),
        Kind::Timestamp => as_timestamp(field.name, raw),
        Kind::Symbol => as_symbol(field.name, raw),
        Kind::StringList { max_items, max_len } => {
            as_string_list(field.name, raw, max_items, max_len)
        }
    }
}

fn require_identity(ctx: &Ctx) -> Result<(), String> {
    if ctx.user_id.is_empty() {
        return Err("this request carries no user identity, so there is no account to write to".into());
    }
    Ok(())
}

/// The exact INSERT this create will run: everything decided from untrusted
/// input, with no I/O. Split from the runner for the same reason ops_db.rs
/// splits `plan` from `read` — this is the whole security decision, and a
/// function that needs a live `AppHandle` and an open SQLite file cannot be
/// unit-tested.
pub fn plan_create(
    cap: &WriteCap,
    op: &str,
    args: &Value,
    ctx: &Ctx,
) -> Result<Map<String, Value>, String> {
    require_identity(ctx)?;
    let obj = as_object(args, op)?;
    let mut values: Map<String, Value> = Map::new();

    for (key, raw) in obj {
        // Discarded, not rejected — same reasoning as the read side: passing
        // your own user_id alongside a write is a natural thing for a caller to
        // do, and failing over it teaches nothing. What matters is that the
        // value cannot take effect, including when it is somebody else's.
        if key == "user_id" {
            continue;
        }
        let Some(field) = cap.create.iter().find(|f| f.name == key) else {
            // `snippet`, not the raw key. The message is returned verbatim to
            // the model, and the key is caller-chosen and unbounded: echoing it
            // whole made a REJECTION a larger context payload than any success
            // on the same op.
            return Err(format!(
                "'{}' is not a field {op} accepts; it takes: {}",
                ops_project::snippet(key),
                field_list(cap.create)
            ));
        };
        // On CREATE, an explicit null is the same statement as omitting the
        // field, and it must be treated that way: writing NULL into `priority`
        // would beat the column's DEFAULT 'medium' and leave a task the UI
        // renders with no priority at all.
        if raw.is_null() {
            continue;
        }
        values.insert(key.clone(), validate(field, raw)?);
    }

    for field in cap.create.iter().filter(|f| f.required) {
        if !values.contains_key(field.name) {
            return Err(format!("'{}' is required to create a {}", field.name, cap.noun));
        }
    }

    // The local stand-in for row-level security, injected LAST so it overwrites
    // anything that got this far. The only source is the authenticated Ctx.
    values.insert("user_id".to_string(), Value::String(ctx.user_id.clone()));
    Ok(values)
}

/// The exact UPDATE this patch will run.
#[derive(Debug)]
pub struct UpdatePlan {
    pub id: String,
    /// `id` AND `user_id` — both, always. `id` alone would let any caller that
    /// learned an id (from a shared calendar, from a screenshot, from a guess)
    /// rewrite another account's row, because db_update's filters are the only
    /// thing standing between the patch and the whole table.
    pub filters: Map<String, Value>,
    pub patch: Map<String, Value>,
}

pub fn plan_update(
    cap: &WriteCap,
    op: &str,
    args: &Value,
    ctx: &Ctx,
) -> Result<UpdatePlan, String> {
    require_identity(ctx)?;
    let obj = as_object(args, op)?;

    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            format!(
                "'id' is required: pass the id of the {} to change, as returned by {}",
                cap.noun, cap.list_op
            )
        })?;
    if id.chars().count() > MAX_ID_LEN
        || id
            .chars()
            .any(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
    {
        return Err(format!(
            "'id' is not shaped like an id from {} (letters, digits, '-' and '_', up to {MAX_ID_LEN} characters)",
            cap.list_op
        ));
    }

    let mut patch: Map<String, Value> = Map::new();
    for (key, raw) in obj {
        // `id` selects the row; `user_id` is never patchable, because patching
        // it is precisely how a row is moved into another account.
        if key == "id" || key == "user_id" {
            continue;
        }
        let Some(field) = cap.patch.iter().find(|f| f.name == key) else {
            return Err(format!(
                "'{}' is not a field {op} can change; it can change: {}",
                ops_project::snippet(key),
                field_list(cap.patch)
            ));
        };
        if raw.is_null() {
            if !field.nullable {
                return Err(format!(
                    "'{}' cannot be cleared; give it a value",
                    ops_project::snippet(key)
                ));
            }
            patch.insert(key.clone(), Value::Null);
            continue;
        }
        patch.insert(key.clone(), validate(field, raw)?);
    }
    if patch.is_empty() {
        return Err(format!(
            "{op} was given nothing to change; it needs at least one of: {}",
            field_list(cap.patch)
        ));
    }

    let mut filters = Map::new();
    filters.insert("id".to_string(), Value::String(id.to_string()));
    filters.insert("user_id".to_string(), Value::String(ctx.user_id.clone()));

    Ok(UpdatePlan { id: id.to_string(), filters, patch })
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

fn db_state(app: &AppHandle) -> Result<tauri::State<'_, crate::db::DbState>, String> {
    // `try_state` rather than `state`: the DB is opened in Tauri's setup hook
    // and the control port binds slightly before that, so a request arriving in
    // that window must get an honest "not ready" instead of a panic.
    app.try_state::<crate::db::DbState>()
        .ok_or_else(|| "the local database is not open yet".to_string())
}

fn create(app: &AppHandle, cap: &WriteCap, op: &str, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    let values = plan_create(cap, op, args, ctx)?;
    let inserted = crate::db::db_insert(
        app.clone(),
        db_state(app)?,
        cap.table.to_string(),
        Value::Object(values),
    )?;
    let row = inserted
        .as_array()
        .and_then(|rows| rows.first().cloned())
        .ok_or_else(|| format!("the {} was not returned after being written", cap.noun))?;
    Ok(json!({ "action": "created", "row": ops_project::pick(&row, cap.receipt) }))
}

/// Which row a COMMITTED update reports, given how the follow-up read went.
///
/// THE RE-READ IS COSMETIC AND MUST NEVER DECIDE THE OUTCOME. It exists only to
/// pick up the trigger-stamped `updated_at` (see `update`), and it can fail for
/// reasons that have nothing to do with the write: the row exceeded the
/// projection cap, the Bun brain holds the second connection to atlas.db and
/// SQLite returned SQLITE_BUSY, or the shared `DbState` mutex was poisoned by a
/// panic on another thread. `update` used to turn every one of those into
/// `Err("the task was changed but could not be read back")`, which mod.rs
/// records as `tool_calls.status = failed` — so the model told the user their
/// task had NOT been updated after it already had. Being told "marking it
/// complete failed" is the case where the user acts on the lie and does it
/// again.
///
/// So a failed re-read falls back to the row `db_update` returned. Its
/// `updated_at` is one edit stale, because SQLite computes RETURNING before
/// AFTER triggers run. A stale timestamp is a far smaller lie than a write
/// reported as not having happened.
fn row_to_report(committed: Value, reread: Result<Option<Value>, String>) -> Value {
    match reread {
        Ok(Some(fresh)) => fresh,
        Ok(None) | Err(_) => committed,
    }
}

fn update(app: &AppHandle, cap: &'static WriteCap, op: &str, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    let plan = plan_update(cap, op, args, ctx)?;
    let changed: Vec<Value> = plan
        .patch
        .keys()
        .map(|k| Value::String(k.clone()))
        .collect();

    let updated = crate::db::db_update(
        app.clone(),
        db_state(app)?,
        cap.table.to_string(),
        plan.filters,
        plan.patch,
    )?;
    // This is the LAST point at which the answer may be a failure: after it, the
    // UPDATE has committed and nothing downstream is allowed to say otherwise.
    let Some(committed) = updated.as_array().and_then(|rows| rows.first().cloned()) else {
        // Missing and belonging-to-somebody-else are deliberately the same
        // answer, as they are on the read side: distinguishing them would
        // confirm the existence of another account's records.
        return Err(format!(
            "no {} with id '{}' belongs to this account",
            cap.noun, plan.id
        ));
    };

    // Re-read rather than project what db_update returned.
    //
    // SQLite computes a RETURNING clause's output before AFTER triggers run, so
    // the row db_update hands back carries the PREVIOUS `updated_at` — the
    // trigger at db_schema.sql:913 stamps the new one afterwards. Reporting the
    // old timestamp would have the model tell the user their task was last
    // touched at a time that is now wrong by exactly this edit.
    let reread = ops_db::read_one(app, cap.table, &plan.id, ctx);
    let row = row_to_report(committed, reread);

    Ok(json!({
        "action": "updated",
        "changed": changed,
        // `receipt` is a fixed projection, so if `read_one` had to shrink an
        // over-long field it also drops the `truncated` marker it added. The
        // clipped value still ends in '…'; nothing here is claimed to be whole.
        "row": ops_project::pick(&row, cap.receipt),
    }))
}

// ---------------------------------------------------------------------------
// Runners
//
// One per op, and each names its cap as a literal — the table an op can write
// is fixed at compile time and visible in this file, rather than being a string
// the caller supplies. There is deliberately no generic "db.insert" op: it
// would put the whole matrix behind one name and make the audit question
// "which tables can the brain write?" unanswerable from the registry.
// ---------------------------------------------------------------------------

pub fn tasks_create(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    create(app, &TASKS, "tasks.create", args, ctx)
}

pub fn tasks_update(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    update(app, &TASKS, "tasks.update", args, ctx)
}

pub fn notes_create(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    create(app, &NOTES, "notes.create", args, ctx)
}

pub fn notes_update(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    update(app, &NOTES, "notes.update", args, ctx)
}

pub fn events_create(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    create(app, &EVENTS, "events.create", args, ctx)
}

/// What an attempted watchlist INSERT actually means.
#[derive(Debug)]
enum Added {
    Created(Value),
    /// The row is already there. Not a failure — the caller's goal is met.
    AlreadyThere,
}

/// Does this `db_insert` error mean "that row already exists"?
///
/// Matched on the text because that is all there is: `db.rs` maps every
/// rusqlite error through `e.to_string()`, so the UNIQUE violation reaches here
/// as SQLite's own sentence — `UNIQUE constraint failed: user_watchlist.user_id,
/// user_watchlist.symbol`. Narrow on purpose: `constraint failed` alone would
/// also swallow a NOT NULL or CHECK violation, which are real bugs and must
/// keep failing loudly.
fn is_duplicate_row(err: &str) -> bool {
    err.to_ascii_lowercase().contains("unique constraint failed")
}

fn classify_insert(inserted: Result<Value, String>) -> Result<Added, String> {
    match inserted {
        Ok(v) => v
            .as_array()
            .and_then(|rows| rows.first().cloned())
            .map(Added::Created)
            .ok_or_else(|| "the watchlist entry was not returned after being written".to_string()),
        Err(e) if is_duplicate_row(&e) => Ok(Added::AlreadyThere),
        Err(e) => Err(e),
    }
}

/// Add a symbol to the watchlist.
///
/// `user_watchlist` carries `UNIQUE (user_id, symbol)`, so a second add of the
/// same symbol comes back as a raw "UNIQUE constraint failed" from SQLite. That
/// is a failure the model would try to recover from — by rephrasing, by
/// retrying, by telling the user something went wrong — when the truth is that
/// what it asked for is already the case. So a duplicate is reported as
/// `unchanged`, which is both true and terminal.
///
/// THE PROBE ALONE DID NOT DELIVER THAT. It was a check-then-insert across two
/// separate `DbState` lock acquisitions, so two adds of the same symbol that
/// overlap both see an empty probe and the loser gets exactly the raw constraint
/// error this design exists to avoid. That is ordinary model behaviour, not a
/// rare interleaving: a tool-loop retry after a timeout, or two parallel tool
/// calls in one turn, produce it, and the 20/min bucket does nothing about two
/// SIMULTANEOUS calls. The probe is kept because it returns the EXISTING row
/// (which the insert error cannot), and the constraint error is now caught and
/// translated to the same `unchanged` answer the probe produces.
pub fn watchlist_add(app: &AppHandle, args: &Value, ctx: &Ctx) -> Result<Value, String> {
    let values = plan_create(&WATCHLIST, "watchlist.add", args, ctx)?;
    let symbol = values
        .get("symbol")
        .cloned()
        .unwrap_or(Value::Null);

    let unchanged = |row: Option<&Value>| {
        json!({
            "action": "unchanged",
            "row": match row {
                Some(r) => ops_project::pick(r, WATCHLIST.receipt),
                // The row exists — the INSERT just told us so — but the read
                // that would describe it did not come back. Reporting the
                // symbol alone beats claiming the add failed when it did not.
                None => json!({ "symbol": symbol.clone() }),
            },
        })
    };

    let existing = ops_db::read(
        app,
        WATCHLIST.table,
        &json!({ "limit": 1 }),
        ctx,
        &[("symbol", symbol.clone())],
    )?;
    if let Some(row) = existing["items"].as_array().and_then(|a| a.first()) {
        return Ok(unchanged(Some(row)));
    }

    let inserted = crate::db::db_insert(
        app.clone(),
        db_state(app)?,
        WATCHLIST.table.to_string(),
        Value::Object(values),
    );
    match classify_insert(inserted)? {
        Added::Created(row) => {
            Ok(json!({ "action": "created", "row": ops_project::pick(&row, WATCHLIST.receipt) }))
        }
        // Lost the race. Re-probe so the answer still carries the real row; if
        // even that fails, still answer `unchanged` rather than a constraint
        // error, because the symbol is on the watchlist either way.
        Added::AlreadyThere => {
            let row = ops_db::read(
                app,
                WATCHLIST.table,
                &json!({ "limit": 1 }),
                ctx,
                &[("symbol", symbol.clone())],
            )
            .ok()
            .and_then(|out| out["items"].as_array().and_then(|a| a.first().cloned()));
            Ok(unchanged(row.as_ref()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::Profile;

    fn ctx(user_id: &str) -> Ctx {
        Ctx {
            user_id: user_id.to_string(),
            user_token: None,
            profile: Profile::Background,
            request_id: "test".into(),
        }
    }

    // -- the RLS stand-in ---------------------------------------------------

    #[test]
    fn a_caller_supplied_user_id_never_reaches_an_insert() {
        // The write-to-another-account attempt, stated outright.
        let values = plan_create(
            &TASKS,
            "tasks.create",
            &json!({ "title": "buy milk", "user_id": "someone-else" }),
            &ctx("me"),
        )
        .expect("well-formed — it just does not get what it asked for");

        assert_eq!(
            values["user_id"],
            json!("me"),
            "the Ctx user must win; this is the only thing scoping the write"
        );
        assert_eq!(values["title"], json!("buy milk"));
    }

    #[test]
    fn a_caller_supplied_user_id_never_reaches_an_update_filter() {
        let plan = plan_update(
            &TASKS,
            "tasks.update",
            &json!({ "id": "t1", "completed": true, "user_id": "someone-else" }),
            &ctx("me"),
        )
        .expect("well-formed");

        assert_eq!(plan.filters["user_id"], json!("me"));
        assert_eq!(plan.filters["id"], json!("t1"));
        // And it is not smuggled in through the patch either, which would move
        // the row into another account rather than read from one.
        assert!(
            !plan.patch.contains_key("user_id"),
            "user_id must never be patchable"
        );
        assert_eq!(plan.patch["completed"], json!(true));
    }

    /// Build an args object with one caller-chosen key, without relying on the
    /// json! macro accepting a runtime key.
    fn args_with(pairs: &[(&str, Value)]) -> Value {
        let mut m = Map::new();
        for (k, v) in pairs {
            m.insert((*k).to_string(), v.clone());
        }
        Value::Object(m)
    }

    #[test]
    fn every_op_scopes_its_update_to_the_ctx_user() {
        // Not just tasks: whatever caps grow patch fields later, the filter
        // pair is the invariant.
        for cap in CAPS.iter().filter(|c| !c.patch.is_empty()) {
            let args = args_with(&[
                ("id", json!("x1")),
                (cap.patch[0].name, sample_for(&cap.patch[0])),
                ("user_id", json!("other")),
            ]);
            let plan = plan_update(cap, "op", &args, &ctx("me"))
                .unwrap_or_else(|e| panic!("{}: {e}", cap.table));
            assert_eq!(plan.filters["user_id"], json!("me"), "{}", cap.table);
        }
    }

    fn sample_for(field: &Field) -> Value {
        match field.kind {
            Kind::Text { .. } => json!("x"),
            Kind::Enum(allowed) => json!(allowed[0]),
            Kind::Bool => json!(true),
            Kind::Timestamp => json!("2026-08-10"),
            Kind::Symbol => json!("AAPL"),
            Kind::StringList { .. } => json!(["a"]),
        }
    }

    #[test]
    fn a_write_with_no_identity_is_refused() {
        assert!(plan_create(&TASKS, "tasks.create", &json!({ "title": "x" }), &ctx("")).is_err());
        assert!(
            plan_update(&TASKS, "tasks.update", &json!({ "id": "t1", "completed": true }), &ctx(""))
                .is_err()
        );
    }

    // -- field discipline ---------------------------------------------------

    #[test]
    fn unknown_fields_are_rejected_not_dropped() {
        // A silently-dropped field is the dangerous case: the model asked for a
        // high-priority task, got a success, and tells the user it is high.
        for bad in ["prioritty", "completed", "created_at", "updated_at", "id", "color"] {
            let args = args_with(&[("title", json!("x")), (bad, json!("high"))]);
            let Err(err) = plan_create(&TASKS, "tasks.create", &args, &ctx("me")) else {
                panic!("'{bad}' was accepted on create — a dropped field is a silent lie");
            };
            assert!(err.contains(bad), "the error must name the field: {err}");
            assert!(err.contains("title"), "and list what IS accepted: {err}");
        }
    }

    #[test]
    fn provenance_columns_are_not_patchable() {
        for bad in ["created_at", "updated_at"] {
            let args = args_with(&[("id", json!("t1")), (bad, json!("2020-01-01"))]);
            assert!(
                plan_update(&TASKS, "tasks.update", &args, &ctx("me")).is_err(),
                "{bad} must not be patchable — it is the record of when this happened"
            );
        }
    }

    #[test]
    fn required_fields_are_named_when_missing() {
        let err = plan_create(&TASKS, "tasks.create", &json!({ "priority": "high" }), &ctx("me"))
            .expect_err("a task with no title is not a task");
        assert!(err.contains("title"), "{err}");

        let err = plan_create(&EVENTS, "events.create", &json!({ "title": "standup" }), &ctx("me"))
            .expect_err("an event with no start time cannot be placed");
        assert!(err.contains("start_time"), "{err}");
    }

    #[test]
    fn an_update_that_changes_nothing_is_refused_with_the_options() {
        let err = plan_update(&TASKS, "tasks.update", &json!({ "id": "t1" }), &ctx("me"))
            .expect_err("an update with no patch is a no-op dressed as an action");
        for expected in ["title", "completed", "priority", "due_date"] {
            assert!(err.contains(expected), "the error must list {expected}: {err}");
        }
    }

    #[test]
    fn an_update_without_an_id_names_the_op_that_hands_out_ids() {
        let err = plan_update(&TASKS, "tasks.update", &json!({ "completed": true }), &ctx("me"))
            .expect_err("no id, no row");
        assert!(err.contains("id"), "{err}");
        assert!(err.contains("tasks.list"), "the model must be told where ids come from: {err}");
    }

    #[test]
    fn an_id_that_is_not_shaped_like_one_is_refused() {
        for bad in [
            "t1' OR '1'='1",
            "../../etc/passwd",
            &"x".repeat(MAX_ID_LEN + 1),
        ] {
            assert!(
                plan_update(&TASKS, "tasks.update", &json!({ "id": bad, "completed": true }), &ctx("me"))
                    .is_err(),
                "id '{bad}' must be refused before it reaches a filter or an error message"
            );
        }
        // The real shape still passes, so this test cannot go vacuously green.
        assert!(plan_update(
            &TASKS,
            "tasks.update",
            &json!({ "id": "0f8f2a1e-6c9b-4e2a-9a1d-2b7c5e4f0a11", "completed": true }),
            &ctx("me")
        )
        .is_ok());
    }

    // -- value validation ---------------------------------------------------

    #[test]
    fn enums_are_closed() {
        assert!(plan_create(&TASKS, "op", &json!({ "title": "x", "priority": "URGENT" }), &ctx("me")).is_err());
        let err = plan_create(&TASKS, "op", &json!({ "title": "x", "priority": "urgent" }), &ctx("me"))
            .expect_err("urgent is not a priority this app has");
        assert!(err.contains("low, medium, high"), "{err}");
    }

    #[test]
    fn completed_accepts_the_integer_the_read_side_hands_out() {
        // tasks.list returns `completed: 0` because SQLite has no boolean.
        for (input, expected) in [(json!(0), json!(false)), (json!(1), json!(true)), (json!(true), json!(true))] {
            let plan = plan_update(&TASKS, "op", &json!({ "id": "t1", "completed": input }), &ctx("me")).unwrap();
            assert_eq!(plan.patch["completed"], expected);
        }
        for bad in [json!("true"), json!(2), json!(-1), json!(null)] {
            assert!(
                plan_update(&TASKS, "op", &json!({ "id": "t1", "completed": bad }), &ctx("me")).is_err(),
                "completed={bad} must be refused"
            );
        }
    }

    #[test]
    fn a_datetime_without_an_offset_is_refused_rather_than_guessed() {
        // The failure this prevents: "book it for two" stored as 14:00Z and
        // shown at 16:00 in Copenhagen, reported back as correct.
        let err = plan_create(
            &EVENTS,
            "events.create",
            &json!({ "title": "standup", "start_time": "2026-08-10T14:00:00" }),
            &ctx("me"),
        )
        .expect_err("a naive datetime cannot be placed on the clock");
        assert!(err.contains("offset"), "{err}");
    }

    #[test]
    fn timestamps_normalise_to_the_schema_format() {
        let values = plan_create(
            &EVENTS,
            "events.create",
            &json!({ "title": "standup", "start_time": "2026-08-10T14:00:00+02:00" }),
            &ctx("me"),
        )
        .unwrap();
        assert_eq!(values["start_time"], json!("2026-08-10T12:00:00.000Z"));

        let values = plan_create(
            &TASKS,
            "tasks.create",
            &json!({ "title": "x", "due_date": "2026-08-10" }),
            &ctx("me"),
        )
        .unwrap();
        assert_eq!(values["due_date"], json!("2026-08-10T00:00:00.000Z"));
    }

    #[test]
    fn symbols_are_normalised_and_company_names_are_refused() {
        let values = plan_create(&WATCHLIST, "watchlist.add", &json!({ "symbol": " aapl " }), &ctx("me")).unwrap();
        assert_eq!(values["symbol"], json!("AAPL"));
        assert!(plan_create(&WATCHLIST, "watchlist.add", &json!({ "symbol": "BRK.B" }), &ctx("me")).is_ok());

        for bad in ["Apple Inc.", "", "TOOLONGSYMBOL1", "AAPL;DROP"] {
            assert!(
                plan_create(&WATCHLIST, "watchlist.add", &json!({ "symbol": bad }), &ctx("me")).is_err(),
                "'{bad}' is not a symbol"
            );
        }
    }

    #[test]
    fn text_is_bounded_and_control_characters_are_refused() {
        let long = "x".repeat(201);
        let err = plan_create(&TASKS, "op", &json!({ "title": long }), &ctx("me")).expect_err("bounded");
        assert!(err.contains("200"), "the error must name the bound: {err}");

        assert!(plan_create(&TASKS, "op", &json!({ "title": "a\u{0}b" }), &ctx("me")).is_err());
        assert!(plan_create(&TASKS, "op", &json!({ "title": "   " }), &ctx("me")).is_err());
        // Newlines survive in a note body — they are the only reason a body is
        // multi-line at all.
        let values = plan_create(&NOTES, "op", &json!({ "title": "t", "content": "a\nb" }), &ctx("me")).unwrap();
        assert_eq!(values["content"], json!("a\nb"));
    }

    #[test]
    fn attendee_lists_are_bounded_in_both_directions() {
        let many: Vec<String> = (0..26).map(|i| format!("p{i}@example.invalid")).collect();
        assert!(plan_create(
            &EVENTS,
            "op",
            &json!({ "title": "x", "start_time": "2026-08-10", "attendees": many }),
            &ctx("me")
        )
        .is_err());
        assert!(plan_create(
            &EVENTS,
            "op",
            &json!({ "title": "x", "start_time": "2026-08-10", "attendees": "alice" }),
            &ctx("me")
        )
        .is_err());
        let values = plan_create(
            &EVENTS,
            "op",
            &json!({ "title": "x", "start_time": "2026-08-10", "attendees": ["alice", "bob"] }),
            &ctx("me"),
        )
        .unwrap();
        assert_eq!(values["attendees"], json!(["alice", "bob"]));
    }

    // -- null semantics -----------------------------------------------------

    #[test]
    fn a_null_on_create_leaves_the_column_default_alone() {
        let values = plan_create(
            &TASKS,
            "tasks.create",
            &json!({ "title": "x", "priority": Value::Null, "due_date": Value::Null }),
            &ctx("me"),
        )
        .unwrap();
        assert!(
            !values.contains_key("priority"),
            "writing NULL here would beat the DEFAULT 'medium' and leave a task with no priority"
        );
        assert!(!values.contains_key("due_date"));
    }

    #[test]
    fn a_null_on_update_clears_only_what_is_clearable() {
        let plan = plan_update(
            &TASKS,
            "tasks.update",
            &json!({ "id": "t1", "due_date": Value::Null }),
            &ctx("me"),
        )
        .expect("a task can lose its due date");
        assert_eq!(plan.patch["due_date"], Value::Null);

        assert!(
            plan_update(&TASKS, "tasks.update", &json!({ "id": "t1", "priority": Value::Null }), &ctx("me"))
                .is_err(),
            "a task with a NULL priority renders as nothing at all"
        );
    }

    // -- matrix consistency -------------------------------------------------

    #[test]
    fn every_receipt_column_is_one_the_read_side_would_also_return() {
        // A write must not become a way to see a column a read cannot.
        for cap in CAPS {
            let read_cap = ops_db::cap_for(cap.table)
                .unwrap_or_else(|| panic!("{} is writable but not readable", cap.table));
            for col in cap.receipt {
                assert!(
                    read_cap.columns.contains(col),
                    "{}: receipt column '{col}' is not readable via ops_db",
                    cap.table
                );
            }
        }
    }

    #[test]
    fn no_cap_accepts_an_identity_or_provenance_column() {
        for cap in CAPS {
            for field in cap.create.iter().chain(cap.patch.iter()) {
                assert!(
                    !["user_id", "id", "created_at", "updated_at"].contains(&field.name),
                    "{}: '{}' must never be settable by a caller",
                    cap.table,
                    field.name
                );
            }
        }
    }

    #[test]
    fn cap_field_names_are_unique_within_a_list() {
        for cap in CAPS {
            for list in [cap.create, cap.patch] {
                for (i, field) in list.iter().enumerate() {
                    assert!(
                        list.iter().take(i).all(|prev| prev.name != field.name),
                        "{}: duplicate field {}",
                        cap.table,
                        field.name
                    );
                }
            }
        }
    }

    // -- a committed write is never reported as a failure -------------------

    /// The re-read is cosmetic. It used to be able to fail the whole op.
    ///
    /// `update` ended with `read_one(..)?.ok_or_else(|| "the {noun} was changed
    /// but could not be read back")?`, so a row over the 4 KB projection cap, a
    /// SQLITE_BUSY from the Bun brain's second connection, or a poisoned mutex
    /// turned a COMMITTED update into `Err` — which mod.rs writes to
    /// `tool_calls.status = 'failed'`, and the model then tells the user their
    /// task was not updated after it was.
    #[test]
    fn a_committed_update_is_never_reported_as_a_failure() {
        let committed = json!({ "id": "t1", "title": "buy milk", "updated_at": "2026-08-08T09:00:00.000Z" });

        for reread in [
            // The re-read itself blew up: locked db, poisoned mutex, closed db.
            Err("database is locked".to_string()),
            Err("the local database is not open yet".to_string()),
            // The re-read came back empty — the row was deleted between the two
            // statements, or the read simply did not see it.
            Ok(None),
        ] {
            let row = row_to_report(committed.clone(), reread);
            assert_eq!(
                row["id"],
                json!("t1"),
                "the write committed; the report must describe it, not disown it"
            );
            assert_eq!(row["title"], json!("buy milk"));
        }

        // And when the re-read DOES work it still wins, because that is the
        // only way the post-trigger `updated_at` reaches the caller.
        let fresh = json!({ "id": "t1", "title": "buy milk", "updated_at": "2026-08-08T09:30:00.000Z" });
        let row = row_to_report(committed, Ok(Some(fresh)));
        assert_eq!(row["updated_at"], json!("2026-08-08T09:30:00.000Z"));
    }

    /// The structural half of the same fix: nothing between the committed
    /// UPDATE and the response is allowed to propagate a failure.
    #[test]
    fn the_update_runner_never_propagates_the_re_read() {
        let src = include_str!("ops_write.rs");
        let body = fn_body(src, "fn update(app: &AppHandle");
        for line in body.lines().filter(|l| l.contains("read_one")) {
            assert!(
                !line.contains('?') && !line.contains("ok_or_else"),
                "`{}` lets the re-read decide whether the write happened",
                line.trim()
            );
        }
        assert!(
            body.contains("row_to_report("),
            "the committed-vs-re-read decision must stay in one reviewed place"
        );
    }

    /// Everything between `fn <needle>` and the first line that is exactly `}`.
    fn fn_body<'a>(src: &'a str, needle: &str) -> &'a str {
        let from = src.find(needle).unwrap_or_else(|| panic!("{needle} not found"));
        let rest = &src[from..];
        let end = rest.find("\n}\n").unwrap_or_else(|| panic!("{needle} has no end"));
        &rest[..end]
    }

    // -- the watchlist race -------------------------------------------------

    /// Two adds of the same symbol in flight at once.
    ///
    /// The probe and the insert take the shared `DbState` lock separately, so
    /// both callers can see an empty probe and the loser gets SQLite's raw
    /// "UNIQUE constraint failed: user_watchlist.user_id, user_watchlist.symbol"
    /// — precisely the error the `unchanged` design exists to avoid. A tool-loop
    /// retry after a timeout, or two parallel tool calls in one turn, produce
    /// it, and a 20/min bucket does nothing about two SIMULTANEOUS calls.
    #[test]
    fn a_lost_insert_race_reports_unchanged_not_a_constraint_error() {
        let raced = Err(
            "UNIQUE constraint failed: user_watchlist.user_id, user_watchlist.symbol".to_string(),
        );
        assert!(
            matches!(classify_insert(raced), Ok(Added::AlreadyThere)),
            "losing the race means the symbol is on the watchlist, which is what was asked for"
        );

        // A real failure must still fail. This translation is narrow on purpose:
        // it must not become "any insert error means it was already there".
        for genuine in [
            "no such table: user_watchlist",
            "database is locked",
            "NOT NULL constraint failed: user_watchlist.symbol",
            "CHECK constraint failed: user_watchlist",
            "disk I/O error",
        ] {
            assert!(
                classify_insert(Err(genuine.to_string())).is_err(),
                "'{genuine}' is a real failure and must not be reported as unchanged"
            );
        }

        // The success path is unchanged.
        let created = classify_insert(Ok(json!([{ "id": "w1", "symbol": "AAPL" }])));
        assert!(matches!(created, Ok(Added::Created(_))));
        // An insert that returned no row is still an error — a "created" answer
        // with nothing created would be a fabrication.
        assert!(classify_insert(Ok(json!([]))).is_err());
    }

    // -- error messages are not a context payload ---------------------------

    /// An error must never be a larger context payload than a success. Both
    /// unknown-field messages name the caller's key back to the model, and the
    /// key comes off the wire with no length bound of its own.
    #[test]
    fn a_rejected_field_name_is_bounded_before_it_is_echoed() {
        let hostile = "z".repeat(50_000);

        let args = args_with(&[("title", json!("x")), (hostile.as_str(), json!(1))]);
        let err = plan_create(&TASKS, "tasks.create", &args, &ctx("me")).unwrap_err();
        assert!(err.len() < 300, "create rejection is {} bytes", err.len());

        let args = args_with(&[("id", json!("t1")), (hostile.as_str(), json!(1))]);
        let err = plan_update(&TASKS, "tasks.update", &args, &ctx("me")).unwrap_err();
        assert!(err.len() < 300, "update rejection is {} bytes", err.len());

        // A short field name is still echoed in full, or the model cannot see
        // what it got wrong.
        let args = args_with(&[("title", json!("x")), ("prioritty", json!("high"))]);
        let err = plan_create(&TASKS, "tasks.create", &args, &ctx("me")).unwrap_err();
        assert!(err.contains("prioritty"), "{err}");
    }

    #[test]
    fn tables_outside_the_write_matrix_have_no_cap() {
        // Real tables db_insert would happily write, and that no op may reach.
        let writable: Vec<&str> = CAPS.iter().map(|c| c.table).collect();
        for table in [
            "profiles",
            "user_roles",
            "ai_memory",
            "memory_vectors",
            "mail_threads",
            "approvals",
            "tool_calls",
            "atlas_system_settings",
        ] {
            assert!(!writable.contains(&table), "{table} must not be writable");
        }
    }
}
