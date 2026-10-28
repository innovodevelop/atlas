// The bank store's Rust half, behind the Beta Money screen (rows 31–32 of
// docs/design-sync/2026-10-28-left-out-features.md).
//
// Two ways transactions reach this Mac, and both end in the same tables of
// db_schema.sql ("MONEY — the bank store"):
//
// 1. A netbank CSV export. The webview reads and parses the file
//    (src/lib/bankCsv.ts) and hands the rows here. The generic `db_insert`
//    cannot take them: it is a plain INSERT, so a re-import of an overlapping
//    export would fail on the first row it already holds. `bank_store_
//    transactions` is INSERT OR IGNORE against the row id the parser derived,
//    which is what makes a re-import add only what is new.
//
// 2. An optional, read-only GoCardless Bank Account Data link (PSD2 AIS). The
//    user brings their own GoCardless secret_id / secret_key; both go to the
//    consolidated atlas-core Keychain item through `secrets::set_core_key` and
//    never reach the database, the webview or a log. The flow is GoCardless's
//    own: an end-user agreement, then a requisition whose link the webview
//    opens in the browser, where the bank asks for consent. Atlas then reads
//    accounts, balances and transactions on demand and once a day, and keeps
//    them here. Nothing is ever written to the bank: there is no payment
//    endpoint in this file, and none in the access scope Atlas asks for.
//
// Every command is `#[tauri::command(async)]`: they do HTTP and SQLite work
// and must stay off the main thread (see the incident note in http.rs). Network
// calls are never made while the database lock is held.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::DbState;
use crate::secrets;

const GC_BASE: &str = "https://bankaccountdata.gocardless.com/api/v2";
/// atlas-core accounts holding the user's own GoCardless credentials.
const KEY_ID: &str = "gocardless_secret_id";
const KEY_SECRET: &str = "gocardless_secret_key";
/// Where the bank sends the browser after consent. The atlas:// scheme brings
/// the app forward; nothing rides on the URL (oauth::parse_callback ignores
/// it), the screen re-reads the requisition when it regains focus.
pub const LINK_REDIRECT: &str = "atlas://bank/linked";
/// How long a consent lasts. 90 days is what every Danish bank accepts.
const ACCESS_DAYS: i64 = 90;
/// GoCardless caps the history a bank gives at 730 days.
const MAX_HISTORY_DAYS: i64 = 730;
const SYNC_EVERY_SECS: i64 = 24 * 60 * 60;
/// A claim older than this belonged to a sync that died; it may be retaken.
const CLAIM_TTL_SECS: i64 = 30 * 60;
const AUTO_SYNC_STARTUP_DELAY: Duration = Duration::from_secs(90);
const AUTO_SYNC_TICK: Duration = Duration::from_secs(60 * 60);
/// Re-read a few days before the newest booked row: banks book late.
const OVERLAP_DAYS: i64 = 7;

fn user_or_refuse(user_id: &str) -> Result<(), String> {
    if user_id.trim().is_empty() {
        return Err(
            "this request carries no user identity, so there is no bank data to read".into(),
        );
    }
    Ok(())
}

/// GoCardless ids (UUIDs) and institution ids (`DANSKEBANK_DABADKKK`) are
/// plain tokens. Anything else is refused before it is put into a URL path.
fn safe_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn now_iso() -> String {
    chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn iso_ago(secs: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::seconds(secs))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn valid_day(s: &str) -> bool {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

fn changed(app: &AppHandle, table: &str) {
    let _ = app.emit("db:changed", json!({ "table": table, "op": "update" }));
}

fn str_of(v: Option<&Value>) -> String {
    v.and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// GoCardless writes amounts as strings ("-129.00"); accept numbers too.
fn amount_of(v: Option<&Value>) -> Option<f64> {
    let v = v?;
    let n = match v {
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }?;
    if n.is_finite() {
        Some(n)
    } else {
        None
    }
}

fn hex16(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/// One transaction as the webview's CSV parser (or the GoCardless reader
/// below) hands it over. `id` is the dedupe key.
#[derive(Deserialize, Clone)]
pub struct TxIn {
    pub id: String,
    pub booked_on: String,
    pub amount: f64,
    pub currency: Option<String>,
    pub text: String,
    pub balance_after: Option<f64>,
}

#[derive(Serialize, Default)]
pub struct StoreResult {
    pub inserted: usize,
    /// Rows already on this Mac, or rows that were not a transaction at all.
    pub skipped: usize,
}

fn store_rows(
    conn: &Connection,
    user_id: &str,
    account_id: &str,
    source: &str,
    rows: &[TxIn],
) -> Result<StoreResult, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut out = StoreResult::default();
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR IGNORE INTO bank_transactions \
                 (id, user_id, account_id, booked_on, amount, currency, text, balance_after, source) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(|e| e.to_string())?;
        for r in rows {
            if r.id.is_empty()
                || r.id.len() > 160
                || !valid_day(&r.booked_on)
                || !r.amount.is_finite()
            {
                out.skipped += 1;
                continue;
            }
            let text: String = r.text.chars().take(300).collect();
            let currency = r
                .currency
                .as_deref()
                .filter(|c| c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()));
            let balance = r.balance_after.filter(|b| b.is_finite());
            let n = stmt
                .execute(params![
                    r.id,
                    user_id,
                    account_id,
                    r.booked_on,
                    r.amount,
                    currency,
                    text,
                    balance,
                    source
                ])
                .map_err(|e| e.to_string())?;
            if n == 1 {
                out.inserted += 1;
            } else {
                out.skipped += 1;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(out)
}

/// Store parsed CSV rows under one of the user's accounts. Rows already here
/// (same id) are skipped, so importing an overlapping export twice is safe.
#[tauri::command(async)]
pub fn bank_store_transactions(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    account_id: String,
    rows: Vec<TxIn>,
) -> Result<StoreResult, String> {
    user_or_refuse(&user_id)?;
    let out = {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        let owner: Option<String> = conn
            .query_row(
                "SELECT user_id FROM bank_accounts WHERE id = ?1",
                [&account_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if owner.as_deref() != Some(user_id.as_str()) {
            return Err("That account is not on this Mac.".into());
        }
        store_rows(&conn, &user_id, &account_id, "csv", &rows)?
    };
    changed(&app, "bank_transactions");
    Ok(out)
}

// ---------------------------------------------------------------------------
// GoCardless Bank Account Data — the client
// ---------------------------------------------------------------------------

static TOKEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);

fn keys() -> Option<(String, String)> {
    Some((secrets::core_key(KEY_ID)?, secrets::core_key(KEY_SECRET)?))
}

fn forget_token() {
    *TOKEN.lock().unwrap_or_else(|p| p.into_inner()) = None;
}

/// GoCardless answers errors as `{summary, detail, status_code}`. Only those
/// two lines are kept: the request body (which for /token/new/ holds the
/// keys) is never echoed into a message.
fn gc_error(code: u16, body: &str) -> String {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let parts: Vec<String> = ["summary", "detail"]
        .iter()
        .filter_map(|k| v.get(*k).and_then(|x| x.as_str()))
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    let msg = if parts.is_empty() {
        format!("the request was refused ({code})")
    } else {
        parts.join(": ").chars().take(300).collect()
    };
    format!("GoCardless {code}: {msg}")
}

fn read(resp: Result<ureq::Response, ureq::Error>) -> Result<Value, String> {
    match resp {
        Ok(r) => {
            let text = r
                .into_string()
                .map_err(|e| format!("GoCardless sent an unreadable reply: {e}"))?;
            if text.trim().is_empty() {
                return Ok(Value::Null);
            }
            serde_json::from_str(&text).map_err(|e| format!("GoCardless sent bad JSON: {e}"))
        }
        Err(ureq::Error::Status(code, r)) => {
            Err(gc_error(code, &r.into_string().unwrap_or_default()))
        }
        Err(e) => Err(format!("GoCardless could not be reached: {}", e.kind())),
    }
}

fn fetch_token(secret_id: &str, secret_key: &str) -> Result<(String, Instant), String> {
    let resp = crate::http::agent()
        .post(&format!("{GC_BASE}/token/new/"))
        .set("Accept", "application/json")
        .send_json(json!({ "secret_id": secret_id, "secret_key": secret_key }));
    let v = read(resp)?;
    let access = v
        .get("access")
        .and_then(|x| x.as_str())
        .ok_or("GoCardless sent no access token")?
        .to_string();
    let secs = v
        .get("access_expires")
        .and_then(|x| x.as_u64())
        .unwrap_or(3600);
    Ok((
        access,
        Instant::now() + Duration::from_secs(secs.saturating_sub(60).max(60)),
    ))
}

fn token() -> Result<String, String> {
    {
        let guard = TOKEN.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((t, expires)) = guard.as_ref() {
            if Instant::now() < *expires {
                return Ok(t.clone());
            }
        }
    }
    let (id, key) = keys().ok_or("Add your GoCardless secret ID and secret key first.")?;
    let (t, expires) = fetch_token(&id, &key)?;
    *TOKEN.lock().unwrap_or_else(|p| p.into_inner()) = Some((t.clone(), expires));
    Ok(t)
}

/// One authenticated call. A 401 means the cached token died early; it is
/// dropped and the call tried once more with a fresh one.
fn gc(method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    let url = format!("{GC_BASE}{path}");
    let mut last = String::new();
    for _ in 0..2 {
        let t = token()?;
        let req = crate::http::agent()
            .request(method, &url)
            .set("Authorization", &format!("Bearer {t}"))
            .set("Accept", "application/json");
        let resp = match &body {
            Some(b) => req.send_json(b.clone()),
            None => req.call(),
        };
        match read(resp) {
            Err(e) if e.starts_with("GoCardless 401") => {
                forget_token();
                last = e;
            }
            other => return other,
        }
    }
    Err(last)
}

// ---------------------------------------------------------------------------
// GoCardless — keys and status
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct GcStatus {
    pub has_keys: bool,
    /// Where the bank sends the browser back to, for the screen to say.
    pub redirect: &'static str,
}

/// Whether the user's GoCardless keys are in the Keychain (never the keys).
#[tauri::command(async)]
pub fn bank_gc_status() -> GcStatus {
    GcStatus {
        has_keys: keys().is_some(),
        redirect: LINK_REDIRECT,
    }
}

/// Keep the user's GoCardless keys in the Keychain, after proving they work:
/// a typo is caught here, not at the first sync.
#[tauri::command(async)]
pub fn bank_gc_set_keys(secret_id: String, secret_key: String) -> Result<(), String> {
    let id = secret_id.trim();
    let key = secret_key.trim();
    if id.is_empty() || key.is_empty() {
        return Err("Both the secret ID and the secret key are needed.".into());
    }
    if id.len() > 200
        || key.len() > 400
        || id.chars().any(char::is_whitespace)
        || key.chars().any(char::is_whitespace)
    {
        return Err("That does not look like a GoCardless secret ID and key.".into());
    }
    let (t, expires) = fetch_token(id, key)?;
    secrets::set_core_key(KEY_ID, id)?;
    secrets::set_core_key(KEY_SECRET, key)?;
    *TOKEN.lock().unwrap_or_else(|p| p.into_inner()) = Some((t, expires));
    Ok(())
}

/// Remove the keys. Linked accounts and their rows stay; they stop syncing.
#[tauri::command(async)]
pub fn bank_gc_clear_keys() -> Result<(), String> {
    forget_token();
    secrets::clear_core_key(KEY_ID)?;
    secrets::clear_core_key(KEY_SECRET)
}

// ---------------------------------------------------------------------------
// GoCardless — institutions and links
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct Institution {
    pub id: String,
    pub name: String,
    pub bic: Option<String>,
    pub logo: Option<String>,
    /// How many days of history the bank gives.
    pub history_days: i64,
}

/// The banks GoCardless can reach in a country (two letters, e.g. "dk").
#[tauri::command(async)]
pub fn bank_gc_institutions(country: String) -> Result<Vec<Institution>, String> {
    let c = country.trim().to_ascii_lowercase();
    if c.len() != 2 || !c.bytes().all(|b| b.is_ascii_lowercase()) {
        return Err("A country is two letters, like DK.".into());
    }
    let v = gc("GET", &format!("/institutions/?country={c}"), None)?;
    let list = v.as_array().cloned().unwrap_or_default();
    Ok(list
        .iter()
        .filter_map(|i| {
            let id = str_of(i.get("id"));
            if !safe_id(&id) {
                return None;
            }
            let history_days = match i.get("transaction_total_days") {
                Some(Value::String(s)) => s.trim().parse::<i64>().unwrap_or(90),
                Some(Value::Number(n)) => n.as_i64().unwrap_or(90),
                _ => 90,
            };
            Some(Institution {
                name: i
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or(&id)
                    .to_string(),
                bic: i.get("bic").and_then(|x| x.as_str()).map(str::to_string),
                logo: i
                    .get("logo")
                    .and_then(|x| x.as_str())
                    .filter(|u| u.starts_with("https://"))
                    .map(str::to_string),
                history_days: history_days.clamp(1, MAX_HISTORY_DAYS),
                id,
            })
        })
        .collect())
}

#[derive(Serialize)]
pub struct LinkStart {
    pub id: String,
    /// The bank's consent page, at GoCardless. The webview opens it in the browser.
    pub link: String,
}

/// Start a bank link: an end-user agreement (read-only scopes), then a
/// requisition. Returns the consent link; nothing is read until the user
/// has given consent at the bank.
#[tauri::command(async)]
pub fn bank_gc_link_start(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    institution_id: String,
    institution_name: Option<String>,
    history_days: Option<i64>,
) -> Result<LinkStart, String> {
    user_or_refuse(&user_id)?;
    if !safe_id(&institution_id) {
        return Err("That is not a bank GoCardless knows.".into());
    }
    let history = history_days.unwrap_or(90).clamp(1, MAX_HISTORY_DAYS);
    let agreement = gc(
        "POST",
        "/agreements/enduser/",
        Some(json!({
            "institution_id": institution_id,
            "max_historical_days": history,
            "access_valid_for_days": ACCESS_DAYS,
            "access_scope": ["balances", "details", "transactions"],
        })),
    )?;
    let agreement_id = str_of(agreement.get("id"));
    if !safe_id(&agreement_id) {
        return Err("GoCardless did not create the agreement.".into());
    }
    let reference = uuid::Uuid::new_v4().to_string();
    let req = gc(
        "POST",
        "/requisitions/",
        Some(json!({
            "redirect": LINK_REDIRECT,
            "institution_id": institution_id,
            "agreement": agreement_id,
            "reference": reference,
            "user_language": "EN",
        })),
    )?;
    let id = str_of(req.get("id"));
    let link = str_of(req.get("link"));
    if !safe_id(&id) || !link.starts_with("https://") {
        return Err("GoCardless did not return a consent link.".into());
    }
    let status = Some(str_of(req.get("status")))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "CR".into());
    let name: Option<String> = institution_name.map(|n| n.chars().take(120).collect());
    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO bank_links (id, user_id, institution_id, institution_name, agreement_id, status, history_days, access_days) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, user_id, institution_id, name, agreement_id, status, history, ACCESS_DAYS],
        )
        .map_err(|e| e.to_string())?;
    }
    changed(&app, "bank_links");
    Ok(LinkStart { id, link })
}

fn link_owner(db: &DbState, user_id: &str, link_id: &str) -> Result<(), String> {
    if !safe_id(link_id) {
        return Err("That bank link is not on this Mac.".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let owner: Option<String> = conn
        .query_row(
            "SELECT user_id FROM bank_links WHERE id = ?1",
            [link_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if owner.as_deref() == Some(user_id) {
        Ok(())
    } else {
        Err("That bank link is not on this Mac.".into())
    }
}

/// Record a requisition's status; the first time it reads LN the consent's
/// dates are set from the agreement's length.
fn record_status(db: &DbState, link_id: &str, status: &str) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let expires = (chrono::Utc::now() + chrono::Duration::days(ACCESS_DAYS))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    conn.execute(
        "UPDATE bank_links SET status = ?1, \
           linked_at = CASE WHEN ?1 = 'LN' AND linked_at IS NULL THEN ?2 ELSE linked_at END, \
           expires_at = CASE WHEN ?1 = 'LN' AND expires_at IS NULL THEN ?3 ELSE expires_at END \
         WHERE id = ?4",
        params![status, now_iso(), expires, link_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn record_error(db: &DbState, link_id: &str, error: &str) {
    if let Ok(conn) = db.conn.lock() {
        let msg: String = error.chars().take(300).collect();
        let _ = conn.execute(
            "UPDATE bank_links SET last_error = ?1, sync_claimed_at = NULL WHERE id = ?2",
            params![msg, link_id],
        );
    }
}

/// Re-read a link's status at GoCardless — after the user comes back from the
/// bank's consent page.
#[tauri::command(async)]
pub fn bank_gc_link_refresh(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    link_id: String,
) -> Result<String, String> {
    user_or_refuse(&user_id)?;
    link_owner(&state, &user_id, &link_id)?;
    let req = gc("GET", &format!("/requisitions/{link_id}/"), None)?;
    let status = str_of(req.get("status"));
    if status.is_empty() {
        return Err("GoCardless did not say how the link stands.".into());
    }
    record_status(&state, &link_id, &status)?;
    changed(&app, "bank_links");
    Ok(status)
}

/// Take the link for one sync. Two open bundles share one database; the
/// claim keeps them from both spending the bank's few daily reads.
fn claim(db: &DbState, link_id: &str) -> Result<bool, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let n = conn
        .execute(
            "UPDATE bank_links SET sync_claimed_at = ?1 \
             WHERE id = ?2 AND (sync_claimed_at IS NULL OR sync_claimed_at < ?3)",
            params![now_iso(), link_id, iso_ago(CLAIM_TTL_SECS)],
        )
        .map_err(|e| e.to_string())?;
    Ok(n == 1)
}

/// The booked balance where the bank gives one, else whatever it gives.
fn pick_balance(v: &Value) -> Option<(f64, Option<String>, Option<String>)> {
    let list = v.get("balances")?.as_array()?;
    const ORDER: [&str; 5] = [
        "interimBooked",
        "closingBooked",
        "expected",
        "interimAvailable",
        "openingBooked",
    ];
    let ranked = |b: &Value| {
        let t = b.get("balanceType").and_then(|x| x.as_str()).unwrap_or("");
        ORDER.iter().position(|o| *o == t).unwrap_or(ORDER.len())
    };
    let best = list.iter().min_by_key(|b| ranked(*b))?;
    let amount = amount_of(best.get("balanceAmount").and_then(|a| a.get("amount")))?;
    let currency = best
        .get("balanceAmount")
        .and_then(|a| a.get("currency"))
        .and_then(|x| x.as_str())
        .map(str::to_string);
    let on = best
        .get("referenceDate")
        .and_then(|x| x.as_str())
        .map(str::to_string);
    Some((amount, currency, on))
}

/// GoCardless's booked transactions as store rows. Ids are the bank's own
/// where it gives one, else a hash of the row, prefixed with the account so
/// two accounts' ids never meet.
fn parse_transactions(account: &str, v: &Value) -> Vec<TxIn> {
    let booked = v
        .get("transactions")
        .and_then(|t| t.get("booked"))
        .and_then(|b| b.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::with_capacity(booked.len());
    for (i, t) in booked.iter().enumerate() {
        let day = Some(str_of(t.get("bookingDate")))
            .filter(|d| valid_day(d))
            .or_else(|| Some(str_of(t.get("valueDate"))).filter(|d| valid_day(d)));
        let Some(day) = day else { continue };
        let Some(amount) = amount_of(t.get("transactionAmount").and_then(|a| a.get("amount")))
        else {
            continue;
        };
        let currency = t
            .get("transactionAmount")
            .and_then(|a| a.get("currency"))
            .and_then(|x| x.as_str())
            .map(str::to_string);
        let counterpart = if amount < 0.0 {
            str_of(t.get("creditorName"))
        } else {
            str_of(t.get("debtorName"))
        };
        let mut parts: Vec<String> = Vec::new();
        for p in [
            counterpart,
            str_of(t.get("remittanceInformationUnstructured")),
            t.get("remittanceInformationUnstructuredArray")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|s| s.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default(),
            str_of(t.get("additionalInformation")),
        ] {
            let p = p.trim().to_string();
            if !p.is_empty() && !parts.iter().any(|q| q.eq_ignore_ascii_case(&p)) {
                parts.push(p);
            }
        }
        let text = if parts.is_empty() {
            "Transaction".to_string()
        } else {
            parts.join(" · ")
        };
        let bank_id = Some(str_of(t.get("transactionId")))
            .filter(|s| !s.is_empty())
            .or_else(|| Some(str_of(t.get("internalTransactionId"))).filter(|s| !s.is_empty()));
        let id = match bank_id {
            Some(b) if b.len() <= 80 && b.bytes().all(|c| c.is_ascii_graphic()) => {
                format!("gc:{account}:{b}")
            }
            Some(b) => format!("gc:{account}:h{}", hex16(&b)),
            None => format!(
                "gc:{account}:h{}",
                hex16(&format!("{day}|{amount}|{text}|{i}"))
            ),
        };
        let balance_after = amount_of(
            t.get("balanceAfterTransaction")
                .and_then(|b| b.get("balanceAmount"))
                .and_then(|a| a.get("amount")),
        );
        out.push(TxIn {
            id,
            booked_on: day,
            amount,
            currency,
            text,
            balance_after,
        });
    }
    out
}

#[derive(Serialize, Default)]
pub struct SyncResult {
    pub accounts: usize,
    pub inserted: usize,
    pub skipped: usize,
}

/// Read one linked bank: its accounts, their balances and new transactions.
/// The caller has claimed the link.
fn sync_link(db: &DbState, user_id: &str, link_id: &str) -> Result<SyncResult, String> {
    let (institution, history_days): (Option<String>, Option<i64>) = {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT institution_name, history_days FROM bank_links WHERE id = ?1 AND user_id = ?2",
            params![link_id, user_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| "That bank link is not on this Mac.".to_string())?
    };
    let req = gc("GET", &format!("/requisitions/{link_id}/"), None)?;
    let status = str_of(req.get("status"));
    record_status(db, link_id, &status)?;
    if status != "LN" {
        return Err(format!(
            "The bank link is not active (GoCardless says {status}). Connect the bank again."
        ));
    }
    let accounts: Vec<String> = req
        .get("accounts")
        .and_then(|a| a.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .filter(|s| safe_id(s))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let mut out = SyncResult::default();
    for acc in accounts {
        let local_id = format!("gc:{acc}");
        let (known, newest): (bool, Option<String>) = {
            let conn = db.conn.lock().map_err(|e| e.to_string())?;
            let known = conn
                .query_row(
                    "SELECT 1 FROM bank_accounts WHERE id = ?1",
                    [&local_id],
                    |_| Ok(true),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .unwrap_or(false);
            let newest: Option<String> = conn
                .query_row(
                    "SELECT MAX(booked_on) FROM bank_transactions WHERE account_id = ?1",
                    [&local_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            (known, newest)
        };
        // Details are read once: the bank allows only a few reads a day.
        let (name, iban_last4, mut currency) = if known {
            (String::new(), None, None)
        } else {
            let d = gc("GET", &format!("/accounts/{acc}/details/"), None).unwrap_or(Value::Null);
            let a = d.get("account").cloned().unwrap_or(Value::Null);
            let name = [
                str_of(a.get("name")),
                str_of(a.get("product")),
                str_of(a.get("ownerName")),
            ]
            .into_iter()
            .find(|s| !s.is_empty())
            .unwrap_or_else(|| institution.clone().unwrap_or_else(|| "Bank account".into()));
            let iban = str_of(a.get("iban"));
            let tail: Vec<char> = iban.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
            let last4 = if tail.len() >= 4 {
                Some(tail[tail.len() - 4..].iter().collect::<String>())
            } else {
                None
            };
            let cur = a
                .get("currency")
                .and_then(|x| x.as_str())
                .map(str::to_string);
            (name, last4, cur)
        };
        let balance = gc("GET", &format!("/accounts/{acc}/balances/"), None)
            .ok()
            .and_then(|b| pick_balance(&b));
        if currency.is_none() {
            currency = balance.as_ref().and_then(|b| b.1.clone());
        }
        let path = match newest
            .as_deref()
            .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        {
            Some(d) => format!(
                "/accounts/{acc}/transactions/?date_from={}",
                (d - chrono::Duration::days(OVERLAP_DAYS)).format("%Y-%m-%d")
            ),
            None => {
                let from = chrono::Utc::now().date_naive()
                    - chrono::Duration::days(history_days.unwrap_or(90).clamp(1, MAX_HISTORY_DAYS));
                format!(
                    "/accounts/{acc}/transactions/?date_from={}",
                    from.format("%Y-%m-%d")
                )
            }
        };
        let txv = gc("GET", &path, None)?;
        let rows = parse_transactions(&acc, &txv);
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO bank_accounts (id, user_id, name, institution, iban_last4, currency, source, link_id, external_id, balance, balance_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?6, 'DKK'), 'gocardless', ?7, ?8, ?9, ?10) \
             ON CONFLICT(id) DO UPDATE SET link_id = excluded.link_id, \
               balance = COALESCE(excluded.balance, bank_accounts.balance), \
               balance_at = COALESCE(excluded.balance_at, bank_accounts.balance_at)",
            params![
                local_id,
                user_id,
                if name.is_empty() { "Bank account".to_string() } else { name.chars().take(120).collect() },
                institution,
                iban_last4,
                currency,
                link_id,
                acc,
                balance.as_ref().map(|b| b.0),
                balance.as_ref().map(|b| b.2.clone().unwrap_or_else(now_iso)),
            ],
        )
        .map_err(|e| e.to_string())?;
        let stored = store_rows(&conn, user_id, &local_id, "gocardless", &rows)?;
        out.accounts += 1;
        out.inserted += stored.inserted;
        out.skipped += stored.skipped;
    }
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE bank_links SET last_synced_at = ?1, last_error = NULL, sync_claimed_at = NULL WHERE id = ?2",
            params![now_iso(), link_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// Read a linked bank now.
#[tauri::command(async)]
pub fn bank_gc_sync(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    link_id: String,
) -> Result<SyncResult, String> {
    user_or_refuse(&user_id)?;
    link_owner(&state, &user_id, &link_id)?;
    if !claim(&state, &link_id)? {
        return Err("This bank is being read already.".into());
    }
    let result = sync_link(&state, &user_id, &link_id);
    if let Err(e) = &result {
        record_error(&state, &link_id, e);
    }
    changed(&app, "bank_transactions");
    result
}

/// End a bank link: the consent is deleted at GoCardless, and the link here.
/// With `forget`, the link's accounts and every transaction read through it
/// are deleted from this Mac too; without it they stay as history.
#[tauri::command(async)]
pub fn bank_gc_unlink(
    app: AppHandle,
    state: State<'_, DbState>,
    user_id: String,
    link_id: String,
    forget: bool,
) -> Result<(), String> {
    user_or_refuse(&user_id)?;
    link_owner(&state, &user_id, &link_id)?;
    if keys().is_some() {
        if let Err(e) = gc("DELETE", &format!("/requisitions/{link_id}/"), None) {
            // Already gone at GoCardless (expired and cleaned up) is fine.
            if !e.starts_with("GoCardless 404") {
                return Err(e);
            }
        }
    }
    {
        let conn = state.conn.lock().map_err(|e| e.to_string())?;
        if forget {
            conn.execute(
                "DELETE FROM bank_accounts WHERE link_id = ?1 AND user_id = ?2",
                params![link_id, user_id],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "UPDATE bank_accounts SET link_id = NULL WHERE link_id = ?1 AND user_id = ?2",
                params![link_id, user_id],
            )
            .map_err(|e| e.to_string())?;
        }
        conn.execute(
            "DELETE FROM bank_links WHERE id = ?1 AND user_id = ?2",
            params![link_id, user_id],
        )
        .map_err(|e| e.to_string())?;
    }
    changed(&app, "bank_links");
    changed(&app, "bank_transactions");
    Ok(())
}

// ---------------------------------------------------------------------------
// Once a day
// ---------------------------------------------------------------------------

fn daily_once(app: &AppHandle) {
    if keys().is_none() {
        return;
    }
    let Some(db) = app.try_state::<DbState>() else {
        return;
    };
    let due: Vec<(String, String)> = {
        let Ok(conn) = db.conn.lock() else { return };
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, user_id FROM bank_links WHERE status = 'LN' AND (last_synced_at IS NULL OR last_synced_at < ?1)",
        ) else {
            return;
        };
        let rows = stmt.query_map([iso_ago(SYNC_EVERY_SECS)], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        });
        // Collected into a local before the block ends, so nothing borrowing
        // the statement outlives it.
        let found: Vec<(String, String)> = match rows {
            Ok(r) => r.filter_map(Result::ok).collect(),
            Err(_) => return,
        };
        found
    };
    for (link_id, user_id) in due {
        match claim(&db, &link_id) {
            Ok(true) => {}
            _ => continue,
        }
        match sync_link(&db, &user_id, &link_id) {
            Ok(_) => changed(app, "bank_transactions"),
            Err(e) => {
                record_error(&db, &link_id, &e);
                changed(app, "bank_links");
                eprintln!("[bank] daily read of a linked bank failed: {e}");
            }
        }
    }
}

/// Read every linked bank once a day while Atlas runs. Spawned by the
/// instance that owns the sidecars, beside the Gmail auto-sync; the claim
/// column covers the moment two instances overlap.
pub fn spawn_daily_sync(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("bank-daily-sync".into())
        .spawn(move || {
            std::thread::sleep(AUTO_SYNC_STARTUP_DELAY);
            loop {
                daily_once(&app);
                std::thread::sleep(AUTO_SYNC_TICK);
            }
        });
    if let Err(e) = spawned {
        eprintln!("[bank] daily sync not started: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_plain_tokens() {
        assert!(safe_id("DANSKEBANK_DABADKKK"));
        assert!(safe_id("3fa85f64-5717-4562-b3fc-2c963f66afa6"));
        assert!(!safe_id("../token/new"));
        assert!(!safe_id(""));
        assert!(!safe_id("a b"));
    }

    #[test]
    fn errors_never_echo_the_request() {
        let e = gc_error(
            401,
            r#"{"summary":"Authentication failed","detail":"No active account found","status_code":401}"#,
        );
        assert_eq!(
            e,
            "GoCardless 401: Authentication failed: No active account found"
        );
        assert_eq!(
            gc_error(500, "<html>"),
            "GoCardless 500: the request was refused (500)"
        );
    }

    #[test]
    fn booked_balance_wins() {
        let v = json!({ "balances": [
            { "balanceType": "interimAvailable", "balanceAmount": { "amount": "900.00", "currency": "DKK" } },
            { "balanceType": "interimBooked", "balanceAmount": { "amount": "812.50", "currency": "DKK" }, "referenceDate": "2026-10-28" }
        ]});
        let (amount, currency, on) = pick_balance(&v).unwrap();
        assert_eq!(amount, 812.5);
        assert_eq!(currency.as_deref(), Some("DKK"));
        assert_eq!(on.as_deref(), Some("2026-10-28"));
    }

    #[test]
    fn transactions_parse_with_stable_ids() {
        let v = json!({ "transactions": { "booked": [
            { "transactionId": "T1", "bookingDate": "2026-10-01", "transactionAmount": { "amount": "-129.00", "currency": "DKK" },
              "creditorName": "Netflix", "remittanceInformationUnstructured": "NETFLIX.COM" },
            { "bookingDate": "2026-10-02", "transactionAmount": { "amount": "25000", "currency": "DKK" }, "debtorName": "Employer" },
            { "bookingDate": "not a date", "transactionAmount": { "amount": "1" } }
        ], "pending": [] }});
        let rows = parse_transactions("acc", &v);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].id, "gc:acc:T1");
        assert_eq!(rows[0].amount, -129.0);
        assert_eq!(rows[0].text, "Netflix · NETFLIX.COM");
        assert!(rows[1].id.starts_with("gc:acc:h"));
        assert_eq!(parse_transactions("acc", &v)[1].id, rows[1].id);
    }

    #[test]
    fn re_imports_add_only_new_rows() {
        let db = DbState::open_in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO bank_accounts (id, user_id, name) VALUES ('a', 'u', 'Everyday')",
            [],
        )
        .unwrap();
        let row = |id: &str| TxIn {
            id: id.into(),
            booked_on: "2026-10-01".into(),
            amount: -10.0,
            currency: Some("DKK".into()),
            text: "Netto".into(),
            balance_after: None,
        };
        let first = store_rows(&conn, "u", "a", "csv", &[row("x"), row("y")]).unwrap();
        assert_eq!((first.inserted, first.skipped), (2, 0));
        let again = store_rows(&conn, "u", "a", "csv", &[row("y"), row("z")]).unwrap();
        assert_eq!((again.inserted, again.skipped), (1, 1));
    }
}
