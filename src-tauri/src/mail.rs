// Atlas Mail bridge (Stage 6B, contract docs/design-sync/2026-07-27-mail-contract.md).
//
// This module exists ONLY for the two things the generic CRUD in db.rs cannot do:
// talking to the atlas-mail Cloudflare worker, and performing the idempotent
// multi-row upsert that turns its D1 rows into atlas.db rows. Every plain mail
// read/write the UI needs goes through db_select/db_insert/db_update instead.
//
// Idempotency is the whole point of the sync: a re-sync must not duplicate a
// thread, duplicate a message, or move an unread count that did not move on the
// server. That is why every write below is keyed on the schema's UNIQUE
// constraints and why unread_count is ASSIGNED from the server, never
// incremented locally.

use std::collections::HashMap;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::db::DbState;

/// The deployed admin-mailbox worker. `ATLAS_MAIL_API` overrides it so a local
/// `wrangler dev` can be pointed at without a rebuild.
const MAIL_API: &str = "https://atlas-mail.magnus-d7d.workers.dev";

/// CONTRACT-GAP: the worker exposes no "which mailbox am I" route, so the
/// mailbox is normally learned from the thread rows themselves. On a genuinely
/// empty mailbox there are no rows to learn it from, and the account row still
/// has to exist for the UI to distinguish "never synced" from "nothing has
/// arrived". This is the address Email Routing delivers to today.
const DEFAULT_MAILBOX: &str = "contact@helloatlas.dk";

/// Mirrors the CHECK constraint on mail_threads.status (and the worker's own
/// `allowed[]`). A row carrying anything else is skipped rather than allowed to
/// abort the whole sync transaction.
const THREAD_STATUSES: [&str; 7] = [
    "triage", "approve", "drafting", "escalate", "snooze", "handled", "handoff",
];

/// How long a `snooze` rule parks a thread when its `action_config` says
/// nothing. The rules editor writes `{}` today, so in practice this IS the
/// snooze length — it is a named constant rather than an inline literal so the
/// value is findable when the editor grows a duration field.
const DEFAULT_SNOOZE_HOURS: i64 = 24;

fn api_base() -> String {
    std::env::var("ATLAS_MAIL_API").unwrap_or_else(|_| MAIL_API.to_string())
}

/// Timestamps are written in db_schema.sql's exact format so rows this module
/// writes sort identically to rows written by a column DEFAULT.
fn now_iso() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ---------------------------------------------------------------------------
// Worker HTTP (ureq, same blocking style as datafetch.rs)
// ---------------------------------------------------------------------------

/// Never surface a raw worker body: it can echo mailbox contents into a toast.
fn http_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(401, _) => "Your Atlas session is not authorised for this mailbox.".into(),
        ureq::Error::Status(404, _) => "That thread no longer exists on the server.".into(),
        ureq::Error::Status(code, _) => format!("Atlas Mail server error ({code})."),
        ureq::Error::Transport(_) => "Could not reach the Atlas Mail server.".into(),
    }
}

fn get_json(token: &str, path: &str) -> Result<Value, String> {
    ureq::get(&format!("{}{path}", api_base()))
        .set("Authorization", &format!("Bearer {token}"))
        .call()
        .map_err(http_err)?
        .into_json::<Value>()
        .map_err(|_| "Atlas Mail sent a response Atlas could not read.".to_string())
}

fn post_json(token: &str, path: &str, body: Value) -> Result<Value, String> {
    ureq::post(&format!("{}{path}", api_base()))
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(body)
        .map_err(http_err)?
        .into_json::<Value>()
        .map_err(|_| "Atlas Mail sent a response Atlas could not read.".to_string())
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/// Append one row to the LOCAL audit trail. INSERT only — the table carries
/// BEFORE UPDATE/DELETE triggers that RAISE(ABORT) and would take the whole
/// surrounding transaction down with them.
///
/// Only the events this contract assigns to Rust are written here (the sync
/// itself, the rules engine, and the blocked send). The user-initiated actions
/// relayed by mail_mark_read / mail_set_status are logged once by the hook that
/// initiated them — logging them here as well would put two rows in an
/// append-only trail for one action, and there is no way to remove the
/// duplicate afterwards.
///
/// `rule_id` is the only optional column this module fills: a `rule_matched`
/// row that does not name the rule cannot answer "which rule did that", which
/// is the entire question the trail exists for.
#[allow(clippy::too_many_arguments)]
fn audit(
    conn: &Connection,
    user_id: &str,
    thread_id: Option<&str>,
    actor: &str,
    action: &str,
    detail: &str,
    rule_id: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO mail_audit_events (id, user_id, thread_id, ts, actor, action, detail, rule_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            uuid::Uuid::new_v4().to_string(),
            user_id,
            thread_id,
            now_iso(),
            actor,
            action,
            detail,
            rule_id,
        ],
    )
    .map_err(|e| format!("Could not write the local audit record: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Local upserts
// ---------------------------------------------------------------------------

/// Find-or-create the account row for a hosted mailbox.
///
/// `provider` is `'imap'` because the CHECK constraint allows only
/// gmail/outlook/imap and this build ships no schema migration; of the three it
/// is the closest honest description of a mailbox Atlas reads over a server API
/// rather than a vendor SDK.
///
/// The id is derived from the user AND the address. It used to be the address
/// alone, which did not match the user-scoped lookup below: a second admin
/// syncing the same shared mailbox missed the SELECT, minted the same id, and
/// hit `UNIQUE constraint failed: mail_accounts.id` — aborting the entire sync,
/// not just that mailbox. Rows written by builds that used the unscoped id keep
/// working untouched: the lookup finds them by (user_id, provider,
/// email_address) and an existing row's id is never re-minted.
fn ensure_account(tx: &Transaction, user_id: &str, mailbox: &str, synced_at: &str) -> Result<String, String> {
    let lookup = |t: &Transaction| -> Result<Option<String>, String> {
        t.query_row(
            "SELECT id FROM mail_accounts WHERE user_id = ?1 AND provider = 'imap' AND email_address = ?2",
            rusqlite::params![user_id, mailbox],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    };

    let existing = lookup(tx)?;

    if let Some(id) = existing {
        // Deliberately does not touch autonomy_mode: 'autonomous' is only ever
        // reached by an explicit user choice, so a sync must never rewrite it.
        tx.execute(
            "UPDATE mail_accounts SET status = 'active', last_error = NULL, last_synced_at = ?1 WHERE id = ?2",
            rusqlite::params![synced_at, id],
        )
        .map_err(|e| e.to_string())?;
        return Ok(id);
    }

    let id = format!("cfmail:{user_id}:{mailbox}");
    // autonomy_mode is omitted so the column DEFAULT ('approve_all') applies.
    if let Err(e) = tx.execute(
        "INSERT INTO mail_accounts (id, user_id, provider, email_address, status, last_synced_at)
         VALUES (?1, ?2, 'imap', ?3, 'active', ?4)",
        rusqlite::params![id, user_id, mailbox, synced_at],
    ) {
        // A constraint can still fire here if a concurrent sync inserted the row
        // between the lookup and this statement. Re-run the SAME user-scoped
        // lookup rather than letting one collision abort every mailbox in the
        // sync; because the re-lookup is user-scoped it can only ever hand back
        // a row this user owns, so recovering cannot cross accounts.
        return lookup(tx)?.ok_or_else(|| format!("Could not create the local mailbox record: {e}"));
    }
    Ok(id)
}

/// `participants` is a JSON string on both sides — copy it verbatim rather than
/// decode-and-re-encode, so a re-sync of an unchanged thread produces a
/// byte-identical column. A value that is not a JSON array is rejected: the
/// column feeds the UI's sender list directly.
fn participants_json(v: &Value) -> Option<String> {
    let s = v.as_str()?;
    match serde_json::from_str::<Value>(s) {
        Ok(Value::Array(_)) => Some(s.to_string()),
        _ => None,
    }
}

fn as_opt_str(v: &Value) -> Option<&str> {
    v.as_str()
}

struct ThreadUpsert {
    /// The LOCAL mail_threads.id, so the caller can hand the row to the rules
    /// engine without a second lookup.
    id: String,
    inserted: bool,
}

/// Look up by the UNIQUE(account_id, provider_thread_id) key, insert if absent,
/// update if present. The local `id` is minted once and never regenerated —
/// drafts, audit rows and the UI's selection all hang off it.
fn upsert_thread(
    tx: &Transaction,
    user_id: &str,
    account_id: &str,
    row: &Value,
    synced_at: &str,
) -> Result<ThreadUpsert, String> {
    let provider_thread_id = row["id"].as_str().ok_or("missing id")?;
    let participants = participants_json(&row["participants"]).ok_or("malformed participants")?;
    let status = row["status"].as_str().unwrap_or("triage");
    if !THREAD_STATUSES.contains(&status) {
        return Err("unknown status".into());
    }
    let subject = as_opt_str(&row["subject"]);
    let last_message_at = as_opt_str(&row["last_message_at"]);
    // Assigned, never incremented — this is what stops a re-sync double-counting.
    let unread = row["unread_count"].as_i64().unwrap_or(0);

    let existing: Option<String> = tx
        .query_row(
            "SELECT id FROM mail_threads WHERE account_id = ?1 AND provider_thread_id = ?2",
            rusqlite::params![account_id, provider_thread_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    match existing {
        Some(id) => {
            // snoozed_until / handled_at are absent from the list projection, so
            // they are left untouched here; only the detail fetch owns them.
            tx.execute(
                "UPDATE mail_threads
                    SET subject = ?1, participants = ?2, status = ?3, unread_count = ?4,
                        last_message_at = ?5, updated_at = ?6
                  WHERE id = ?7",
                rusqlite::params![subject, participants, status, unread, last_message_at, synced_at, &id],
            )
            .map_err(|e| e.to_string())?;
            Ok(ThreadUpsert { id, inserted: false })
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO mail_threads
                   (id, user_id, account_id, provider_thread_id, subject, participants,
                    status, unread_count, last_message_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    &id,
                    user_id,
                    account_id,
                    provider_thread_id,
                    subject,
                    participants,
                    status,
                    unread,
                    last_message_at,
                    synced_at,
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(ThreadUpsert { id, inserted: true })
        }
    }
}

/// The worker sends no snippet, so derive one. Whitespace-collapsed because raw
/// mail bodies are full of hard-wrap newlines that render as gaps in a list row.
fn snippet_of(body_text: Option<&str>) -> Option<String> {
    let text = body_text?;
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(200).collect())
}

// ---------------------------------------------------------------------------
// Rules engine
//
// Rules live in mail_rules and are evaluated HERE, during sync, rather than in
// the webview: a rule must fire when mail arrives, and the Mail screen — or the
// whole window — is usually closed when that happens. A rules engine that only
// runs while its own settings page is open is not a rules engine.
//
// Two invariants keep it from fighting the user:
//   * only a thread the SERVER still has in 'triage' is a candidate, so a
//     thread anybody has already placed is never re-placed; and
//   * a thread that already has a `rule_matched` audit row is skipped, so a
//     rule fires at most once per thread no matter how often sync runs.
// ---------------------------------------------------------------------------

/// The predicate fields this matcher evaluates, lower-cased once at parse time.
struct Predicate {
    from_contains: Option<String>,
    subject_contains: Option<String>,
    mailbox: Option<String>,
    unread_only: bool,
    /// The stored predicate constrains something the thread LIST projection
    /// cannot see (`body_contains`, `has_attachments` — bodies and attachments
    /// arrive only in the per-thread detail fetch). Such a rule never matches.
    ///
    /// Dropping the term instead and matching on what is left would be worse
    /// than useless: "body contains invoice AND from contains @acme" would
    /// become "from contains @acme", and the rule would move mail the user
    /// explicitly scoped it away from — out of Triage, where they would not
    /// look for it. The sync reports these as a warning instead of silently
    /// doing nothing.
    unsupported: bool,
}

/// One enabled mail_rules row.
struct Rule {
    id: String,
    label: String,
    /// NULL means "every mailbox"; otherwise the rule is scoped to one account.
    account_id: Option<String>,
    action: String,
    action_config: Value,
    predicate: Predicate,
}

/// A thread the list sync just wrote, reduced to the fields a rule matches on.
/// Collected inside the sync transaction and evaluated after it commits,
/// because applying a rule has to talk to the worker.
struct RuleCandidate {
    thread_id: String,
    account_id: String,
    provider_thread_id: String,
    mailbox: String,
    subject: String,
    /// Participant addresses minus the mailbox's own. The list projection
    /// carries no per-message sender — only the thread's participant array,
    /// which the worker builds as [from, to…, cc…]. Our own address is on every
    /// thread, so leaving it in would make a rule like `from_contains:
    /// "helloatlas"` match the entire mailbox.
    correspondents: Vec<String>,
    unread: i64,
}

impl RuleCandidate {
    fn new(thread_id: &str, account_id: &str, mailbox: &str, row: &Value) -> Option<Self> {
        let mailbox = mailbox.to_lowercase();
        let correspondents = row["participants"]
            .as_str()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|a| a.trim().to_lowercase())
            .filter(|a| !a.is_empty() && a != &mailbox)
            .collect();
        Some(Self {
            thread_id: thread_id.to_string(),
            account_id: account_id.to_string(),
            provider_thread_id: row["id"].as_str()?.to_string(),
            mailbox,
            subject: row["subject"].as_str().unwrap_or("").to_lowercase(),
            correspondents,
            unread: row["unread_count"].as_i64().unwrap_or(0),
        })
    }
}

/// Every field present is an AND, matching what the editor's own
/// `describePredicate` tells the user it built. Absent or blank = unconstrained.
fn parse_predicate(raw: &str) -> Predicate {
    let v: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let text = |key: &str| {
        v.get(key)
            .and_then(Value::as_str)
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
    };
    Predicate {
        from_contains: text("from_contains"),
        subject_contains: text("subject_contains"),
        mailbox: text("mailbox"),
        unread_only: v.get("unread_only").and_then(Value::as_bool).unwrap_or(false),
        unsupported: text("body_contains").is_some()
            || v.get("has_attachments").and_then(Value::as_bool).unwrap_or(false),
    }
}

impl Rule {
    fn matches(&self, c: &RuleCandidate) -> bool {
        if self.predicate.unsupported {
            return false;
        }
        if let Some(scope) = &self.account_id {
            if scope != &c.account_id {
                return false;
            }
        }
        if let Some(m) = &self.predicate.mailbox {
            if &c.mailbox != m {
                return false;
            }
        }
        if let Some(s) = &self.predicate.subject_contains {
            if !c.subject.contains(s.as_str()) {
                return false;
            }
        }
        if let Some(f) = &self.predicate.from_contains {
            if !c.correspondents.iter().any(|a| a.contains(f.as_str())) {
                return false;
            }
        }
        if self.predicate.unread_only && c.unread <= 0 {
            return false;
        }
        true
    }
}

/// `position` is the user's own ordering and decides which rule wins; the
/// created_at tie-break only makes two rules sharing a position deterministic,
/// so "first match" cannot mean different things on two runs.
fn load_rules(conn: &Connection, user_id: &str) -> Result<Vec<Rule>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, label, account_id, action, predicate, action_config
               FROM mail_rules
              WHERE user_id = ?1 AND enabled = 1
              ORDER BY position ASC, created_at ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params![user_id], |r| {
            Ok(Rule {
                id: r.get(0)?,
                label: r.get(1)?,
                account_id: r.get::<_, Option<String>>(2)?,
                action: r.get(3)?,
                predicate: parse_predicate(&r.get::<_, String>(4)?),
                action_config: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or(Value::Null),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

/// Missing row = the account was removed mid-sync. The safe reading of an
/// unknown autonomy setting is the strictest one, never the most permissive.
fn autonomy_mode(conn: &Connection, account_id: &str) -> String {
    conn.query_row(
        "SELECT autonomy_mode FROM mail_accounts WHERE id = ?1",
        rusqlite::params![account_id],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or_else(|| "approve_all".to_string())
}

fn rule_already_applied(conn: &Connection, thread_id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM mail_audit_events WHERE thread_id = ?1 AND action = 'rule_matched' LIMIT 1",
        rusqlite::params![thread_id],
        |_| Ok(()),
    )
    .optional()
    .map(|hit| hit.is_some())
    .map_err(|e| e.to_string())
}

/// Rule action → mail_threads.status, with the autonomy gate applied. The bool
/// is "this was held for approval rather than carried out as written".
fn rule_target_status(action: &str, autonomy: &str) -> Option<(&'static str, bool)> {
    // Only 'autonomous' is an explicit user choice to let Atlas finish a thread
    // unattended. 'conditional' is deliberately NOT read as permission:
    // autonomy_condition has no evaluator in this build, so treating it as a
    // yes would be guessing, and guessing wrong here removes mail from Triage
    // without anyone having seen it.
    let unattended_ok = autonomy == "autonomous";
    match action {
        "approve" => Some(("approve", false)),
        // Drafting writes a reply; it never puts one on the wire. mail_send_reply
        // is the only send path and it refuses outright, so 'drafting' is safe
        // under every autonomy mode.
        "draft" => Some(("drafting", false)),
        "escalate" => Some(("escalate", false)),
        "snooze" => Some(("snooze", false)),
        "handoff" => Some(("handoff", false)),
        // 'handle' is the one action that declares a thread finished without a
        // human seeing it. Under approve_all/conditional it is downgraded to the
        // approval queue rather than dropped: the rule still routes the thread,
        // the user still gets the last word.
        "handle" if unattended_ok => Some(("handled", false)),
        "handle" => Some(("approve", true)),
        _ => None,
    }
}

/// One decided rule application, waiting to be pushed to the worker.
struct RulePlan {
    thread_id: String,
    provider_thread_id: String,
    rule_id: String,
    rule_label: String,
    action: String,
    status: &'static str,
    held_for_approval: bool,
    snoozed_until: Option<String>,
}

struct RuleOutcome {
    applied: usize,
    warnings: Vec<String>,
}

/// Match and apply rules for the threads this sync just wrote.
///
/// Three phases on purpose: decide under one lock with no network call in hand,
/// then do the HTTP, then write locally in one transaction. Holding the DB mutex
/// across a request would stall every other Tauri command for the duration.
fn apply_rules(
    state: &State<'_, DbState>,
    token: &str,
    user_id: &str,
    candidates: &[RuleCandidate],
) -> Result<RuleOutcome, String> {
    let mut warnings: Vec<String> = Vec::new();
    if candidates.is_empty() {
        return Ok(RuleOutcome { applied: 0, warnings });
    }

    let mut plans: Vec<RulePlan> = Vec::new();
    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let rules = load_rules(&conn, user_id)?;
        if rules.is_empty() {
            return Ok(RuleOutcome { applied: 0, warnings });
        }
        for r in rules.iter().filter(|r| r.predicate.unsupported) {
            warnings.push(format!(
                "Rule '{}' never runs: matching on body text or attachments needs the message body, \
                 which the thread list does not carry.",
                r.label
            ));
        }

        let mut autonomy: HashMap<String, String> = HashMap::new();
        for c in candidates {
            if rule_already_applied(&conn, &c.thread_id)? {
                continue;
            }
            let Some(rule) = rules.iter().find(|r| r.matches(c)) else { continue };
            let mode = match autonomy.get(&c.account_id) {
                Some(m) => m.clone(),
                None => {
                    let m = autonomy_mode(&conn, &c.account_id);
                    autonomy.insert(c.account_id.clone(), m.clone());
                    m
                }
            };
            let Some((status, held_for_approval)) = rule_target_status(&rule.action, &mode) else {
                warnings.push(format!("Rule '{}' has an action Atlas cannot carry out.", rule.label));
                continue;
            };
            let snoozed_until = (status == "snooze").then(|| {
                let hours = rule
                    .action_config
                    .get("snooze_hours")
                    .and_then(Value::as_i64)
                    .filter(|h| *h > 0)
                    .unwrap_or(DEFAULT_SNOOZE_HOURS);
                (Utc::now() + chrono::Duration::hours(hours))
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string()
            });
            plans.push(RulePlan {
                thread_id: c.thread_id.clone(),
                provider_thread_id: c.provider_thread_id.clone(),
                rule_id: rule.id.clone(),
                rule_label: rule.label.clone(),
                action: rule.action.clone(),
                status,
                held_for_approval,
                snoozed_until,
            });
        }
    }

    // Server first, for the same reason mail_set_status does it: a status the
    // worker does not share is silently reverted by the next list sync, and the
    // audit row would then describe a move that did not survive the hour.
    let mut confirmed: Vec<RulePlan> = Vec::new();
    for plan in plans {
        match post_json(
            token,
            &format!("/api/threads/{}/status", plan.provider_thread_id),
            json!({ "status": plan.status }),
        ) {
            Ok(_) => confirmed.push(plan),
            Err(e) => warnings.push(format!("Rule '{}' could not be applied: {e}", plan.rule_label)),
        }
    }

    if confirmed.is_empty() {
        return Ok(RuleOutcome { applied: 0, warnings });
    }

    let conn = state.conn.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let now = now_iso();
    for plan in &confirmed {
        // COALESCE, not a plain assignment: only a 'snooze' rule computes a wake
        // time, and the other five actions must not blank one that is already set.
        tx.execute(
            "UPDATE mail_threads
                SET status = ?1,
                    snoozed_until = COALESCE(?2, snoozed_until),
                    handled_at = CASE WHEN ?1 = 'handled' THEN ?3 ELSE handled_at END,
                    updated_at = ?3
              WHERE id = ?4",
            rusqlite::params![plan.status, plan.snoozed_until, now, plan.thread_id],
        )
        .map_err(|e| e.to_string())?;

        let detail = if plan.held_for_approval {
            format!(
                "'{}' ({}) → approve; held for approval because this mailbox is not set to autonomous",
                plan.rule_label, plan.action
            )
        } else {
            format!("'{}' ({}) → {}", plan.rule_label, plan.action, plan.status)
        };
        audit(
            &tx,
            user_id,
            Some(&plan.thread_id),
            "rule",
            "rule_matched",
            &detail,
            Some(&plan.rule_id),
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(RuleOutcome { applied: confirmed.len(), warnings })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// List sync: account + every thread, in one transaction.
///
/// Deliberately does NOT fan out a detail fetch per thread — 200 requests on
/// every refresh is exactly the behaviour the perf review exists to prevent.
/// Message bodies arrive via `mail_thread_fetch` for the selected thread only.
#[tauri::command]
pub fn mail_sync(
    app: AppHandle,
    state: State<'_, DbState>,
    token: String,
    user_id: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let limit = limit.unwrap_or(200).min(200);
    let payload = get_json(&token, &format!("/api/threads?limit={limit}"))?;
    let rows = payload["threads"].as_array().cloned().unwrap_or_default();

    let synced_at = now_iso();
    let primary_mailbox = rows
        .iter()
        .find_map(|r| r["mailbox"].as_str())
        .unwrap_or(DEFAULT_MAILBOX)
        .to_string();

    let mut warnings: Vec<String> = Vec::new();
    let mut inserted = 0usize;
    let mut updated = 0usize;
    let mut skipped: HashMap<String, usize> = HashMap::new();
    let mut candidates: Vec<RuleCandidate> = Vec::new();

    let primary_account_id = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        // One transaction for the whole list: a half-applied thread list looks
        // to the user exactly like mail having disappeared.
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        let mut accounts: HashMap<String, String> = HashMap::new();
        let primary = ensure_account(&tx, &user_id, &primary_mailbox, &synced_at)?;
        accounts.insert(primary_mailbox.clone(), primary.clone());

        for row in &rows {
            let mailbox = row["mailbox"].as_str().unwrap_or(&primary_mailbox).to_string();
            let account_id = match accounts.get(&mailbox) {
                Some(id) => id.clone(),
                None => {
                    let id = ensure_account(&tx, &user_id, &mailbox, &synced_at)?;
                    // Cloned rather than moved: `mailbox` is still needed below
                    // to build this row's rule candidate.
                    accounts.insert(mailbox.clone(), id.clone());
                    id
                }
            };
            // A single malformed row is collected as a warning and the sync
            // continues; only a failure to reach step 2 at all aborts.
            match upsert_thread(&tx, &user_id, &account_id, row, &synced_at) {
                Ok(r) => {
                    if r.inserted {
                        inserted += 1;
                    } else {
                        updated += 1;
                    }
                    // Only a thread the SERVER still has in Triage is offered to
                    // the rules engine. Anything already placed — by the user, by
                    // Atlas, or by an earlier rule — has been decided, and a rule
                    // re-deciding it on the next refresh would undo that move
                    // every few minutes.
                    if row["status"].as_str().unwrap_or("triage") == "triage" {
                        if let Some(c) = RuleCandidate::new(&r.id, &account_id, &mailbox, row) {
                            candidates.push(c);
                        }
                    }
                }
                Err(reason) => *skipped.entry(reason).or_insert(0) += 1,
            }
        }

        for (reason, count) in &skipped {
            warnings.push(format!("{count} thread(s) skipped: {reason}"));
        }

        audit(
            &tx,
            &user_id,
            None,
            "atlas",
            "sync",
            &format!("{} threads, 0 new messages", rows.len()),
            None,
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        primary
    };

    // Rules run AFTER the commit, never inside it: applying one calls the worker,
    // and the sync transaction must not be held open across the network. A rule
    // failure is reported as a warning — the threads themselves are already
    // stored, and losing the whole sync over one unreachable status call would
    // be a worse outcome than an unapplied rule.
    // Degrade to a warning rather than `?`. The threads above are already
    // committed; propagating here returned Err AFTER that commit and BEFORE the
    // `db:changed` emits below, so a single rule failure made the UI report a
    // failed sync and skip its refresh while the mail was in fact safely stored.
    // That is the exact outcome the paragraph above says we do not want.
    let rules = match apply_rules(&state, &token, &user_id, &candidates) {
        Ok(outcome) => outcome,
        Err(e) => RuleOutcome {
            applied: 0,
            warnings: vec![format!("Rules were not applied: {e}")],
        },
    };
    warnings.extend(rules.warnings);

    for table in ["mail_accounts", "mail_threads", "mail_audit_events"] {
        let _ = app.emit("db:changed", json!({ "table": table, "op": "upsert" }));
    }

    Ok(json!({
        "accountId": primary_account_id,
        "mailbox": primary_mailbox,
        "threadsSeen": rows.len(),
        "threadsInserted": inserted,
        "threadsUpdated": updated,
        "messagesInserted": 0,
        "rulesApplied": rules.applied,
        "lastSyncedAt": synced_at,
        "warnings": warnings,
    }))
}

/// Resolve the local `mail_threads.id` the frontend works in to the worker's
/// thread uuid. Everything crossing the network uses the provider id; nothing
/// in the UI ever sees it.
fn resolve_thread(conn: &Connection, user_id: &str, thread_id: &str) -> Result<(String, String), String> {
    conn.query_row(
        "SELECT provider_thread_id, account_id FROM mail_threads WHERE id = ?1 AND user_id = ?2",
        rusqlite::params![thread_id, user_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "That thread is not in the local store — sync first.".to_string())
}

/// Fetch one thread's messages and upsert them locally.
///
/// Attachments have no local table and the worker has no byte-fetch route, so
/// their metadata is folded into the owning message's `extracted` JSON and the
/// UI shows name/type/size with nothing clickable.
#[tauri::command]
pub fn mail_thread_fetch(
    app: AppHandle,
    state: State<'_, DbState>,
    token: String,
    user_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let (provider_thread_id, account_id) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        resolve_thread(&conn, &user_id, &thread_id)?
    };

    let detail = get_json(&token, &format!("/api/threads/{provider_thread_id}"))?;
    let messages = detail["messages"].as_array().cloned().unwrap_or_default();
    let attachment_rows = detail["attachments"].as_array().cloned().unwrap_or_default();

    let mut by_message: HashMap<String, Vec<Value>> = HashMap::new();
    for a in &attachment_rows {
        let Some(mid) = a["message_id"].as_str() else { continue };
        by_message.entry(mid.to_string()).or_default().push(json!({
            "filename": a["filename"].clone(),
            "mime_type": a["mime_type"].clone(),
            "size_bytes": a["size_bytes"].clone(),
        }));
    }

    let now = now_iso();
    let mut inserted = 0usize;
    let mut updated = 0usize;

    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

        // The detail response is SELECT *, so it is the only place the local
        // handled_at column can be refreshed from the authoritative side.
        //
        // snoozed_until is deliberately NOT refreshed from it. Nothing ever
        // sends a snooze time to the worker — it has no route that writes one,
        // only /read, /status and /reply — so that column is permanently NULL on
        // the server. Copying it back wiped the local wake time the moment the
        // user opened a snoozed thread, and a thread in 'snooze' with no
        // snoozed_until never wakes: it sits in Snoozed forever. The local value
        // is authoritative for this column until a server route exists to own it.
        let thread = &detail["thread"];
        if let Some(status) = thread["status"].as_str() {
            if THREAD_STATUSES.contains(&status) {
                tx.execute(
                    "UPDATE mail_threads
                        SET status = ?1, unread_count = ?2, last_message_at = ?3,
                            handled_at = ?4, updated_at = ?5
                      WHERE id = ?6",
                    rusqlite::params![
                        status,
                        thread["unread_count"].as_i64().unwrap_or(0),
                        as_opt_str(&thread["last_message_at"]),
                        as_opt_str(&thread["handled_at"]),
                        now,
                        thread_id,
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
        }

        for m in &messages {
            let Some(provider_message_id) = m["id"].as_str() else { continue };
            let attachments = by_message.get(provider_message_id).cloned().unwrap_or_default();
            let has_attachments = i64::from(!attachments.is_empty());
            let body_text = as_opt_str(&m["body_text"]);
            let snippet = snippet_of(body_text);
            // Everything the reading pane needs that has no dedicated column.
            let mut extracted = json!({
                "direction": m["direction"].clone(),
                "to_address": m["to_address"].clone(),
                "body_text": m["body_text"].clone(),
                "body_html": m["body_html"].clone(),
                "message_id": m["message_id"].clone(),
                "attachments": attachments,
            });
            // The worker's OWN column names, which are what the detail route
            // actually SELECTs (atlas-mail schema.sql): `body_truncated` and
            // `raw_size`. Reading a `truncated` key the worker never sends is
            // what made the size cap invisible — the flag was never stored, so
            // the reading pane's "this is not the full message" line could not
            // render and Atlas presented a capped body as a whole one.
            //
            // Both are still written under the key names the UI reads. Each is
            // written only when the worker reported it: absent means "this
            // deploy predates the size cap", which is not the same as "known to
            // be complete", and the UI relies on that distinction.
            if let Some(t) = m["body_truncated"].as_i64() {
                extracted["truncated"] = json!(t != 0);
            }
            if let Some(bytes) = m["raw_size"].as_i64() {
                extracted["raw_size_bytes"] = json!(bytes);
            }
            let extracted = extracted.to_string();

            // category and importance are left at their defaults on purpose:
            // nothing classifies mail yet, and a guessed category reads as a
            // decision Atlas made.
            let existing: Option<String> = tx
                .query_row(
                    "SELECT id FROM mail_messages WHERE account_id = ?1 AND provider_message_id = ?2",
                    rusqlite::params![account_id, provider_message_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;

            match existing {
                Some(id) => {
                    tx.execute(
                        "UPDATE mail_messages
                            SET thread_id = ?1, from_address = ?2, subject = ?3, snippet = ?4,
                                received_at = ?5, extracted = ?6, has_attachments = ?7
                          WHERE id = ?8",
                        rusqlite::params![
                            thread_id,
                            as_opt_str(&m["from_address"]),
                            as_opt_str(&m["subject"]),
                            snippet,
                            as_opt_str(&m["sent_at"]),
                            extracted,
                            has_attachments,
                            id,
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                    updated += 1;
                }
                None => {
                    tx.execute(
                        "INSERT INTO mail_messages
                           (id, user_id, account_id, thread_id, provider_message_id, from_address,
                            subject, snippet, received_at, extracted, has_attachments)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                        rusqlite::params![
                            uuid::Uuid::new_v4().to_string(),
                            user_id,
                            account_id,
                            thread_id,
                            provider_message_id,
                            as_opt_str(&m["from_address"]),
                            as_opt_str(&m["subject"]),
                            snippet,
                            as_opt_str(&m["sent_at"]),
                            extracted,
                            has_attachments,
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                    inserted += 1;
                }
            }
        }

        tx.commit().map_err(|e| e.to_string())?;
    }

    for table in ["mail_threads", "mail_messages"] {
        let _ = app.emit("db:changed", json!({ "table": table, "op": "upsert" }));
    }

    let attachments: Vec<Value> = attachment_rows
        .iter()
        .map(|a| {
            json!({
                "messageId": a["message_id"].clone(),
                "filename": a["filename"].clone(),
                "mimeType": a["mime_type"].clone(),
                "sizeBytes": a["size_bytes"].clone(),
            })
        })
        .collect();

    Ok(json!({
        "threadId": thread_id,
        "messagesInserted": inserted,
        "messagesUpdated": updated,
        "attachments": attachments,
    }))
}

/// Clear the unread badge. The worker is told first: an unread count the server
/// does not agree with is overwritten by the next sync, and the user would
/// watch their own action undo itself minutes later.
#[tauri::command]
pub fn mail_mark_read(
    app: AppHandle,
    state: State<'_, DbState>,
    token: String,
    user_id: String,
    thread_id: String,
) -> Result<Value, String> {
    let (provider_thread_id, _) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        resolve_thread(&conn, &user_id, &thread_id)?
    };
    post_json(&token, &format!("/api/threads/{provider_thread_id}/read"), json!({}))?;

    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE mail_threads SET unread_count = 0, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now_iso(), thread_id],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = app.emit("db:changed", json!({ "table": "mail_threads", "op": "update" }));
    Ok(json!({ "ok": true }))
}

/// Move a thread between views. Same server-first ordering as mark_read, for
/// the same reason.
#[tauri::command]
pub fn mail_set_status(
    app: AppHandle,
    state: State<'_, DbState>,
    token: String,
    user_id: String,
    thread_id: String,
    status: String,
) -> Result<Value, String> {
    if !THREAD_STATUSES.contains(&status.as_str()) {
        return Err(format!("'{status}' is not a mail status Atlas knows."));
    }
    let (provider_thread_id, _) = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        resolve_thread(&conn, &user_id, &thread_id)?
    };
    post_json(
        &token,
        &format!("/api/threads/{provider_thread_id}/status"),
        json!({ "status": status }),
    )?;

    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        // handled_at is stamped only on the transition into 'handled', matching
        // what the worker does to its own row.
        conn.execute(
            "UPDATE mail_threads
                SET status = ?1,
                    handled_at = CASE WHEN ?1 = 'handled' THEN ?2 ELSE handled_at END,
                    updated_at = ?2
              WHERE id = ?3",
            rusqlite::params![status, now_iso(), thread_id],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = app.emit("db:changed", json!({ "table": "mail_threads", "op": "update" }));
    Ok(json!({ "ok": true, "status": status }))
}

/// The approve-and-send path's last hop. It is fully wired from the UI down to
/// here and stops exactly here.
#[tauri::command]
#[allow(unused_variables)]
pub fn mail_send_reply(
    app: AppHandle,
    state: State<'_, DbState>,
    token: String,
    user_id: String,
    thread_id: String,
    text: String,
    html: Option<String>,
) -> Result<Value, String> {
    // Cloudflare Email Sending needs the Workers Paid plan, which is not
    // purchased. Calling the worker's /reply route here would hit an unguarded
    // env.EMAIL.send and come back as an opaque 500 — a legible refusal is the
    // honest failure mode until the plan is bought.
    if let Ok(conn) = state.conn.lock() {
        // Best-effort: the refusal must reach the user even if the local log
        // cannot be written, but a send attempt that leaves no trace is worse
        // than a noisy one, so failures are printed rather than swallowed.
        if let Err(e) = audit(
            &conn,
            &user_id,
            Some(&thread_id),
            "atlas",
            "send_blocked",
            "Workers Paid plan not active",
            None,
        ) {
            eprintln!("[mail] send_blocked audit row not written: {e}");
        }
    }
    let _ = app.emit("db:changed", json!({ "table": "mail_audit_events", "op": "insert" }));
    Err("Sending requires the Workers Paid plan".into())
}

/// Messages the worker could not store. Read-only passthrough — these rows live
/// on the server side and have no local mirror.
#[tauri::command]
pub fn mail_ingest_errors(token: String) -> Result<Value, String> {
    let payload = get_json(&token, "/api/ingest-errors")?;
    Ok(json!({ "errors": payload["errors"].clone() }))
}
