// Outlook / Microsoft 365 mailbox sync — local-only (Mail Stage 6e,
// docs/mail-setup.md).
//
// Same shape as gmail.rs: OAuth on-device, token in the Keychain, metadata-only
// inbox sync, nothing mail-related in the cloud. Scope is Mail.Read (plus
// User.Read for the mailbox address and offline_access for a refresh token):
// Atlas cannot send, move, flag or delete mail.
//
// The sign-in is RFC 8252 PKCE with a LOOPBACK redirect (oauth::Loopback), as
// for Gmail. Atlas's Microsoft app registration is a public client ("Mobile
// and desktop applications" platform, redirect http://127.0.0.1, any port), so
// there is no client secret at all; the client id sits in the atlas-core
// Keychain blob. The authority is /common, so both personal Outlook.com and
// work or school (Microsoft 365) accounts can sign in. Outlook.com no longer
// accepts IMAP passwords, which is why it has its own connector.
//
// Sign-ins share GmailState's registry of in-flight flows, so the existing
// mail-oauth-cancel command cancels either provider's sign-in. Outcomes are
// reported on `outlook:status`.
//
// Sync is Graph's delta query on the inbox. The first sync asks only for mail
// received in the last FIRST_SYNC_DAYS, so older mail is not backfilled. The
// cursor is the deltaLink (or, mid-round, the nextLink) Graph hands back.
//
// Microsoft ROTATES refresh tokens: every refresh may return a new one, and
// the old one eventually stops working. Each refresh stores the new token
// before the access token is used.
//
// The DB mutex is never held across a network call.

use std::cell::Cell;
use std::time::Instant;

use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::DbState;
use crate::gmail::{form, GmailOAuthPending, GmailState, SyncGuard};
use crate::oauth;

const SCOPES: &str = "offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";
const ID_PREFIX: &str = "outlook:";
const DELTA_PREFIX: &str = "d:";
const NEXT_PREFIX: &str = "n:";
/// The first sync takes this much recent mail rather than the whole inbox.
const FIRST_SYNC_DAYS: i64 = 14;
/// Delta pages one sync reads; a round with more resumes from its nextLink.
const MAX_PAGES_PER_SYNC: usize = 10;
const PAGE_SIZE: u32 = 50;
const FIELDS: &str = "from,subject,receivedDateTime,hasAttachments,bodyPreview,internetMessageId";

const NO_REFRESH_TOKEN: &str = "Outlook not connected — no refresh token found. Reconnect the mailbox.";
const NOT_SET_UP: &str = "Outlook isn't set up yet: no Microsoft app (client) ID in the Keychain. See docs/mail-setup.md.";
/// Graph answered 410 Gone: the delta token expired and the round restarts.
const DELTA_EXPIRED: &str = "Outlook: delta token expired.";

pub struct OutlookState {
    syncing: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl OutlookState {
    pub fn new() -> Self {
        Self { syncing: std::sync::Mutex::new(Default::default()) }
    }
}

fn now_iso() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

struct MicrosoftClient {
    id: String,
    tenant: String,
}

fn microsoft_client() -> Result<MicrosoftClient, String> {
    let get = |key: &str| crate::secrets::core_key(key).filter(|v| !v.trim().is_empty());
    let id = get("microsoft_oauth_client_id").ok_or(NOT_SET_UP)?;
    // "common" accepts personal and work accounts; a single-tenant
    // registration can set its tenant id instead.
    let tenant = get("microsoft_oauth_tenant").unwrap_or_else(|| "common".to_string());
    Ok(MicrosoftClient { id, tenant })
}

fn authority(client: &MicrosoftClient) -> String {
    format!("https://login.microsoftonline.com/{}/oauth2/v2.0", client.tenant)
}

fn build_authorize_url(client: &MicrosoftClient, redirect_uri: &str, challenge: &str, state: &str) -> String {
    format!(
        "{}/authorize?{}",
        authority(client),
        form(&[
            ("client_id", &client.id),
            ("response_type", "code"),
            ("response_mode", "query"),
            ("redirect_uri", redirect_uri),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge),
            ("state", state),
            ("scope", SCOPES),
            ("prompt", "select_account"),
        ])
    )
}

/// The token pair a grant or refresh returns. `refresh` is None when
/// Microsoft didn't rotate it.
struct Tokens {
    access: String,
    refresh: Option<String>,
}

fn post_token(client: &MicrosoftClient, pairs: &[(&str, &str)]) -> Result<Tokens, String> {
    let body = form(pairs);
    let v: Value = match crate::http::agent()
        .post(&format!("{}/token", authority(client)))
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(&body)
    {
        Ok(r) => r.into_json().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(code, r)) => {
            // The body is an OAuth error object (error, error_description);
            // it never carries mail content.
            let v: Value = r.into_json().unwrap_or_default();
            return Err(format!(
                "Microsoft token endpoint ({code}): {} {}",
                v["error"].as_str().unwrap_or("unknown_error"),
                v["error_description"].as_str().unwrap_or("").lines().next().unwrap_or("")
            ));
        }
        Err(e) => return Err(format!("Could not reach Microsoft: {e}")),
    };
    Ok(Tokens {
        access: v["access_token"].as_str().ok_or("Microsoft did not return an access token")?.to_string(),
        refresh: v["refresh_token"].as_str().map(str::to_string),
    })
}

fn exchange_code(code: &str, verifier: &str, redirect_uri: &str) -> Result<Tokens, String> {
    let client = microsoft_client()?;
    post_token(&client, &[
        ("client_id", &client.id),
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
        ("scope", SCOPES),
    ])
}

/// A fresh access token, storing the rotated refresh token first.
fn access_token(account_id: &str) -> Result<String, String> {
    let refresh = crate::secrets::outlook_refresh_token(account_id).ok_or(NO_REFRESH_TOKEN)?;
    let client = microsoft_client()?;
    let t = post_token(&client, &[
        ("client_id", &client.id),
        ("grant_type", "refresh_token"),
        ("refresh_token", &refresh),
        ("scope", SCOPES),
    ])?;
    if let Some(new) = t.refresh.as_deref().filter(|n| *n != refresh) {
        crate::secrets::set_outlook_refresh_token(account_id, new)?;
    }
    Ok(t.access)
}

/// GET a Graph URL (absolute, as nextLink/deltaLink are). Immutable ids keep a
/// message's id stable if it is later moved out of the inbox and back.
fn graph_get(token: &str, url: &str) -> Result<Value, String> {
    match crate::http::agent()
        .get(url)
        .set("Authorization", &format!("Bearer {token}"))
        .set("Prefer", &format!("odata.maxpagesize={PAGE_SIZE}, IdType=\"ImmutableId\""))
        .call()
    {
        Ok(r) => r.into_json().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(410, _)) => Err(DELTA_EXPIRED.to_string()),
        Err(ureq::Error::Status(401, _)) => Err("Outlook access token rejected (401).".to_string()),
        Err(ureq::Error::Status(code, _)) => Err(format!("Microsoft Graph error ({code}).")),
        Err(e) => Err(format!("Could not reach Microsoft Graph: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Begin an Outlook sign-in. Returns the consent URL and the flow id; the
/// outcome arrives on `outlook:status`. Cancel with mail-oauth-cancel.
#[tauri::command(async)]
pub fn outlook_connect(app: AppHandle, state: State<'_, GmailState>, user_id: String) -> Result<Value, String> {
    let client = microsoft_client()?;
    let loopback = oauth::Loopback::bind().map_err(|e| format!("Couldn't start the local sign-in listener: {e}"))?;
    let redirect_uri = loopback.redirect_uri();
    let (verifier, challenge) = oauth::generate_pkce();
    let flow = uuid::Uuid::new_v4().simple().to_string();
    let url = build_authorize_url(&client, &redirect_uri, &challenge, &flow);

    state.register(&flow, GmailOAuthPending { verifier, user_id, redirect_uri, started: Instant::now() });

    let thread_flow = flow.clone();
    let spawned = std::thread::Builder::new()
        .name("outlook-oauth-loopback".into())
        .spawn(move || await_redirect(app, loopback, thread_flow));
    if let Err(e) = spawned {
        state.retire(&flow);
        return Err(format!("Couldn't start the local sign-in listener: {e}"));
    }
    Ok(json!({ "authUrl": url, "flow": flow }))
}

/// Remove an Outlook mailbox with everything synced from it, and its token.
/// Microsoft has no per-app token revocation for a public client; the user can
/// remove Atlas at account.live.com/consent or myapps.microsoft.com.
#[tauri::command(async)]
pub fn outlook_disconnect(app: AppHandle, db: State<'_, DbState>, account_id: String, user_id: String) -> Result<Value, String> {
    {
        let conn = db.conn.lock().unwrap();
        own_account(&conn, &account_id, &user_id)?;
        delete_account(&conn, &account_id).map_err(|e| e.to_string())?;
    }
    crate::secrets::clear_outlook_refresh_token(&account_id)?;
    let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "DELETE"}));
    let _ = app.emit("db:changed", json!({"table": "mail_messages", "op": "DELETE"}));
    let _ = app.emit("db:changed", json!({"table": "mail_alerts", "op": "DELETE"}));
    Ok(json!({ "ok": true }))
}

#[tauri::command(async)]
pub fn outlook_sync(
    app: AppHandle,
    db: State<'_, DbState>,
    outlook: State<'_, OutlookState>,
    account_id: String,
    user_id: String,
) -> Result<Value, String> {
    {
        let conn = db.conn.lock().unwrap();
        if own_account(&conn, &account_id, &user_id)?.is_none() {
            return Err("No such Outlook mailbox.".to_string());
        }
    }
    sync_and_record(&app, &db, &outlook, &account_id, &user_id)
}

// ---------------------------------------------------------------------------
// Sign-in completion
// ---------------------------------------------------------------------------

fn await_redirect(app: AppHandle, loopback: oauth::Loopback, flow: String) {
    let registry = app.state::<GmailState>();
    let report = |msg: &str| emit_status(&app, &flow, false, Some(msg));
    let reported_retired = Cell::new(false);
    let keep_waiting = || {
        let live = registry.is_pending(&flow);
        if !live && !reported_retired.replace(true) {
            report("This Microsoft sign-in was cancelled. Connect again if you still want to.");
        }
        live
    };

    match loopback.wait(&flow, Instant::now() + oauth::FLOW_TTL, keep_waiting) {
        oauth::LoopbackOutcome::Redirect(cb, browser) => {
            let db = app.state::<DbState>();
            let result = finish_sign_in(&app, registry.inner(), db.inner(), &flow, &cb);
            registry.retire(&flow);
            match &result {
                Ok(email) => {
                    emit_status(&app, &flow, true, None);
                    browser.send(true, "Outlook is connected", &format!("Atlas can now read {email}. You can close this tab and return to Atlas."));
                }
                Err(e) => {
                    emit_status(&app, &flow, false, Some(e));
                    browser.send(false, "Outlook was not connected", &format!("{e} You can close this tab and try again from Atlas."));
                }
            }
        }
        oauth::LoopbackOutcome::TimedOut => {
            if registry.retire(&flow).is_some() {
                report("The Microsoft sign-in took too long. Please connect again.");
            }
        }
        oauth::LoopbackOutcome::Failed(e) => {
            if registry.retire(&flow).is_some() {
                report(&format!("The local sign-in listener stopped ({e}). Please connect again."));
            }
        }
    }
}

fn finish_sign_in(
    app: &AppHandle,
    registry: &GmailState,
    db: &DbState,
    flow: &str,
    cb: &oauth::OauthCallback,
) -> Result<String, String> {
    const CANCELLED: &str = "This sign-in was cancelled in Atlas.";
    let pending = registry.pending.lock().unwrap().get(flow).cloned().ok_or(CANCELLED)?;
    if let Some(err) = &cb.error {
        return Err(match err.as_str() {
            "access_denied" => "Access to Outlook wasn't granted.".to_string(),
            other => format!("Microsoft reported an error ({other})."),
        });
    }
    let code = cb.code.as_deref().ok_or("No authorization code in the redirect.")?;
    let tokens = exchange_code(code, &pending.verifier, &pending.redirect_uri)?;
    let refresh = tokens.refresh.ok_or("Microsoft did not return a refresh token (is offline_access granted?).")?;

    let me = graph_get(&tokens.access, &format!("{GRAPH}/me?$select=mail,userPrincipalName"))?;
    let email = mailbox_address(&me).ok_or("Microsoft did not return the mailbox address.")?;

    registry.retire(flow).ok_or(CANCELLED)?;

    let account_id = {
        let conn = db.conn.lock().unwrap();
        reconnect_or_create(&conn, &pending.user_id, &email, &now_iso()).map_err(|e| format!("Failed to create the account: {e}"))?
    };
    let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "INSERT"}));

    if let Err(e) = crate::secrets::set_outlook_refresh_token(&account_id, &refresh) {
        let msg = format!("Failed to store the token in the Keychain: {e}");
        {
            let conn = db.conn.lock().unwrap();
            let _ = conn.execute(
                "UPDATE mail_accounts SET status = 'error', last_error = ?1 WHERE id = ?2",
                rusqlite::params![msg, account_id],
            );
        }
        let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "UPDATE"}));
        return Err(msg);
    }
    Ok(email)
}

/// `mail` is the SMTP address; personal accounts sometimes leave it null and
/// only the sign-in name (userPrincipalName) carries the address.
fn mailbox_address(me: &Value) -> Option<String> {
    ["mail", "userPrincipalName"]
        .iter()
        .filter_map(|k| me[*k].as_str())
        .find(|s| s.contains('@'))
        .map(|s| s.to_lowercase())
}

fn emit_status(app: &AppHandle, flow: &str, connected: bool, error: Option<&str>) {
    let _ = app.emit("outlook:status", json!({ "flow": flow, "connected": connected, "error": error }));
}

// ---------------------------------------------------------------------------
// Account rows
// ---------------------------------------------------------------------------

fn account_id_for(user_id: &str, email: &str) -> String {
    format!("{ID_PREFIX}{user_id}:{email}")
}

/// Create the row or reactivate it; an upsert, never INSERT OR REPLACE (see
/// gmail::upsert_gmail_account). The cursor is kept: a reconnect of the same
/// mailbox resumes where it left off.
fn reconnect_or_create(conn: &rusqlite::Connection, user_id: &str, email: &str, now: &str) -> rusqlite::Result<String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM mail_accounts WHERE user_id = ?1 AND provider = 'outlook' AND email_address = ?2",
            rusqlite::params![user_id, email],
            |r| r.get(0),
        )
        .optional()?;
    let id = existing.unwrap_or_else(|| account_id_for(user_id, email));
    conn.execute(
        "INSERT INTO mail_accounts (id, user_id, provider, email_address, status, last_synced_at, created_at)
         VALUES (?1, ?2, 'outlook', ?3, 'active', NULL, ?4)
         ON CONFLICT(id) DO UPDATE SET status = 'active', last_error = NULL",
        rusqlite::params![id, user_id, email, now],
    )?;
    Ok(id)
}

fn own_account(conn: &rusqlite::Connection, account_id: &str, user_id: &str) -> Result<Option<String>, String> {
    let row: Option<(String, String, String)> = conn
        .query_row(
            "SELECT user_id, provider, email_address FROM mail_accounts WHERE id = ?1",
            [account_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        None => Ok(None),
        Some((owner, provider, email)) if owner == user_id && provider == "outlook" => Ok(Some(email)),
        Some(_) => Err("Not your Outlook mailbox.".to_string()),
    }
}

fn delete_account(conn: &rusqlite::Connection, id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM mail_accounts WHERE id = ?1 AND provider = 'outlook'", [id])
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

fn sync_and_record(app: &AppHandle, db: &DbState, outlook: &OutlookState, account_id: &str, user_id: &str) -> Result<Value, String> {
    let since = crate::mail_flags::mark();
    let result = sync_account(app, db, outlook, account_id, user_id);
    // Bills and deadlines in what this sync brought in (Settings → Mail → Alerts).
    if result.is_ok() {
        crate::mail_flags::after_sync(app, db, user_id, account_id, &since);
    }
    if let Err(e) = &result {
        {
            let conn = db.conn.lock().unwrap();
            let _ = record_sync_failure(&conn, account_id, e);
        }
        let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "UPDATE"}));
    }
    result
}

/// Failures retrying can't fix: the grant is gone (revoked, expired after
/// 90 days unused, password reset) or the app isn't set up.
fn needs_user(err: &str) -> Option<String> {
    if err.starts_with("Microsoft token endpoint") && (err.contains("invalid_grant") || err.contains("interaction_required")) {
        return Some("Microsoft no longer accepts Atlas's access to this mailbox (revoked, expired or password changed). Reconnect it.".to_string());
    }
    if err.starts_with("Microsoft token endpoint") && (err.contains("invalid_client") || err.contains("unauthorized_client")) {
        return Some("Microsoft rejected Atlas's app registration. Check the client ID in the Keychain and the redirect URI (docs/mail-setup.md).".to_string());
    }
    if err == NO_REFRESH_TOKEN || err == NOT_SET_UP {
        return Some(err.to_string());
    }
    None
}

fn record_sync_failure(conn: &rusqlite::Connection, account_id: &str, err: &str) -> rusqlite::Result<usize> {
    match needs_user(err) {
        Some(msg) => conn.execute(
            "UPDATE mail_accounts SET status = 'error', last_error = ?1 WHERE id = ?2",
            rusqlite::params![msg, account_id],
        ),
        None => conn.execute(
            "UPDATE mail_accounts SET last_error = ?1 WHERE id = ?2",
            rusqlite::params![format!("Last scan failed: {err}"), account_id],
        ),
    }
}

/// Where a sync starts: the stored delta/next link, or a fresh round limited
/// to recent mail. Only Graph URLs are followed, so a corrupted cursor can't
/// send the bearer token anywhere else.
fn start_url(stored: Option<&str>, since: chrono::DateTime<Utc>) -> String {
    let link = stored
        .and_then(|s| s.strip_prefix(DELTA_PREFIX).or_else(|| s.strip_prefix(NEXT_PREFIX)))
        .filter(|l| l.starts_with(&format!("{GRAPH}/")));
    match link {
        Some(l) => l.to_string(),
        None => fresh_round_url(since),
    }
}

fn fresh_round_url(since: chrono::DateTime<Utc>) -> String {
    let filter = format!("receivedDateTime ge {}", since.format("%Y-%m-%dT%H:%M:%SZ"));
    format!(
        "{GRAPH}/me/mailFolders/inbox/messages/delta?{}",
        form(&[("$select", FIELDS), ("$filter", &filter)])
    )
}

#[derive(Debug, PartialEq)]
struct ParsedMessage {
    provider_id: String,
    from_address: Option<String>,
    subject: Option<String>,
    snippet: String,
    received_at: Option<String>,
    has_attachments: bool,
    message_id: Option<String>,
}

/// The messages on one delta page. Removals ("@removed") and change records
/// without a sender or date are skipped: Atlas only adds mail.
fn parse_page(page: &Value) -> Vec<ParsedMessage> {
    page["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m.get("@removed").is_none())
        .filter_map(|m| {
            let id = m["id"].as_str()?;
            let from = &m["from"]["emailAddress"];
            let addr = from["address"].as_str();
            let from_address = match (from["name"].as_str().filter(|n| !n.is_empty() && Some(*n) != addr), addr) {
                (Some(name), Some(addr)) => Some(format!("{name} <{addr}>")),
                (None, Some(addr)) => Some(addr.to_string()),
                _ => None,
            };
            let received = m["receivedDateTime"].as_str()?;
            Some(ParsedMessage {
                provider_id: id.to_string(),
                from_address,
                subject: m["subject"].as_str().map(str::to_string),
                snippet: m["bodyPreview"].as_str().unwrap_or("").to_string(),
                received_at: received_iso(received),
                has_attachments: m["hasAttachments"].as_bool().unwrap_or(false),
                message_id: m["internetMessageId"].as_str().map(str::to_string),
            })
        })
        .collect()
}

/// Graph's "2026-10-23T08:01:02Z" in the millisecond format the other mail
/// writers use, so received_at sorts consistently.
fn received_iso(s: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// Walk delta pages from `url`. Returns the messages and the cursor to store:
/// the deltaLink when the round finished, else the nextLink to resume from.
fn walk_delta(token: &str, url: String) -> Result<(Vec<ParsedMessage>, String, bool), String> {
    let mut rows = Vec::new();
    let mut url = url;
    for _ in 0..MAX_PAGES_PER_SYNC {
        let page = graph_get(token, &url)?;
        rows.extend(parse_page(&page));
        if let Some(delta) = page["@odata.deltaLink"].as_str() {
            return Ok((rows, format!("{DELTA_PREFIX}{delta}"), false));
        }
        match page["@odata.nextLink"].as_str() {
            Some(next) => url = next.to_string(),
            None => return Err("Microsoft Graph returned a delta page without a next or delta link.".to_string()),
        }
    }
    Ok((rows, format!("{NEXT_PREFIX}{url}"), true))
}

fn sync_account(app: &AppHandle, db: &DbState, outlook: &OutlookState, account_id: &str, user_id: &str) -> Result<Value, String> {
    let Some(_guard) = SyncGuard::acquire(&outlook.syncing, account_id) else {
        return Ok(json!({ "accountId": account_id, "alreadyRunning": true }));
    };
    let token = access_token(account_id)?;
    let stored: Option<String> = {
        let conn = db.conn.lock().unwrap();
        conn.query_row("SELECT sync_cursor FROM mail_accounts WHERE id = ?1", [account_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .flatten()
    };
    let since = Utc::now() - chrono::Duration::days(FIRST_SYNC_DAYS);
    let (rows, cursor, has_more) = match walk_delta(&token, start_url(stored.as_deref(), since)) {
        // An expired delta token restarts the round; stored ids de-duplicate.
        Err(e) if e == DELTA_EXPIRED => walk_delta(&token, fresh_round_url(since))?,
        other => other?,
    };

    let now = now_iso();
    let inserted = {
        let mut conn = db.conn.lock().unwrap();
        let still_connected = conn
            .prepare("SELECT 1 FROM mail_accounts WHERE id = ?1")
            .and_then(|mut s| s.exists([account_id]))
            .map_err(|e| e.to_string())?;
        if !still_connected {
            return Ok(json!({ "accountId": account_id, "disconnected": true }));
        }
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let n = store_messages(&tx, user_id, account_id, &rows).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE mail_accounts SET sync_cursor = ?1, last_synced_at = ?2, status = 'active', last_error = NULL WHERE id = ?3",
            rusqlite::params![cursor, now, account_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        n
    };

    let _ = app.emit("db:changed", json!({"table": "mail_messages", "op": "INSERT"}));
    let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "UPDATE"}));
    Ok(json!({
        "accountId": account_id,
        "messagesInserted": inserted,
        "messagesSkipped": rows.len() - inserted,
        "hasMore": has_more,
        "lastSyncedAt": now,
    }))
}

fn store_messages(conn: &rusqlite::Connection, user_id: &str, account_id: &str, rows: &[ParsedMessage]) -> rusqlite::Result<usize> {
    let mut n = 0;
    for m in rows {
        n += conn.execute(
            "INSERT OR IGNORE INTO mail_messages (id, user_id, account_id, provider_message_id, from_address, subject, snippet, received_at, has_attachments, extracted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                user_id,
                account_id,
                m.provider_id,
                m.from_address,
                m.subject,
                m.snippet,
                m.received_at,
                m.has_attachments as i32,
                json!({
                    "direction": "inbound",
                    "to_address": null,
                    "body_text": null,
                    "body_html": null,
                    "message_id": m.message_id,
                })
                .to_string(),
            ],
        )?;
    }
    Ok(n)
}

// ---------------------------------------------------------------------------
// Background sync
// ---------------------------------------------------------------------------

fn background_sync_targets(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id FROM mail_accounts WHERE provider = 'outlook' AND status = 'active' ORDER BY created_at",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Called on gmail::GmailAutoSync's timer, like mail_imap::auto_sync_once.
pub fn auto_sync_once(app: &AppHandle, catch_up_rounds: usize) {
    let (Some(db), Some(outlook)) = (app.try_state::<DbState>(), app.try_state::<OutlookState>()) else {
        return;
    };
    let targets = {
        let conn = db.conn.lock().unwrap();
        match background_sync_targets(&conn) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[atlas] outlook auto-sync: could not list mailboxes: {e}");
                return;
            }
        }
    };
    for (account_id, user_id) in targets {
        for _ in 0..catch_up_rounds {
            match sync_and_record(app, &db, &outlook, &account_id, &user_id) {
                Ok(v) if v["hasMore"].as_bool() == Some(true) => continue,
                Ok(_) => break,
                Err(e) => {
                    eprintln!("[atlas] outlook auto-sync of {account_id} failed: {e}");
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn.execute_batch(include_str!("db_schema.sql")).unwrap();
        conn
    }

    fn since() -> chrono::DateTime<Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-10-09T00:00:00Z").unwrap().with_timezone(&Utc)
    }

    #[test]
    fn the_authorize_url_asks_for_read_only_mail_with_pkce() {
        let c = MicrosoftClient { id: "abc".into(), tenant: "common".into() };
        let url = build_authorize_url(&c, "http://127.0.0.1:5555", "CH", "ST");
        assert!(url.starts_with("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?"));
        assert!(url.contains("code_challenge=CH") && url.contains("code_challenge_method=S256"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A5555"));
        assert!(url.contains("Mail.Read") && !url.contains("Mail.ReadWrite") && !url.contains("Mail.Send"));
        assert!(url.contains("offline_access"));
    }

    #[test]
    fn a_first_round_only_asks_for_recent_inbox_mail() {
        let url = start_url(None, since());
        assert!(url.starts_with("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?"));
        assert!(url.contains("receivedDateTime%20ge%202026-10-09T00%3A00%3A00Z"));
    }

    #[test]
    fn stored_links_resume_and_foreign_urls_are_never_followed() {
        let delta = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=x";
        assert_eq!(start_url(Some(&format!("d:{delta}")), since()), delta);
        assert_eq!(start_url(Some(&format!("n:{delta}")), since()), delta);
        // A cursor pointing elsewhere would carry the bearer token off-site.
        assert!(start_url(Some("d:https://evil.example/steal"), since()).contains("receivedDateTime"));
        assert!(start_url(Some("h:123"), since()).contains("receivedDateTime"));
    }

    #[test]
    fn delta_pages_parse_to_metadata_and_skip_removals() {
        let page = json!({
            "value": [
                {
                    "id": "AAMk1",
                    "subject": "Faktura 1042",
                    "bodyPreview": "Beløb 499 kr",
                    "receivedDateTime": "2026-10-23T08:01:02Z",
                    "hasAttachments": true,
                    "internetMessageId": "<x@y>",
                    "from": { "emailAddress": { "name": "Ørsted", "address": "faktura@orsted.dk" } }
                },
                { "id": "AAMk2", "@removed": { "reason": "deleted" } },
                {
                    "id": "AAMk3",
                    "receivedDateTime": "2026-10-23T09:00:00Z",
                    "from": { "emailAddress": { "name": "a@b.c", "address": "a@b.c" } }
                },
                { "id": "AAMk4", "isRead": true }
            ]
        });
        let rows = parse_page(&page);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], ParsedMessage {
            provider_id: "AAMk1".into(),
            from_address: Some("Ørsted <faktura@orsted.dk>".into()),
            subject: Some("Faktura 1042".into()),
            snippet: "Beløb 499 kr".into(),
            received_at: Some("2026-10-23T08:01:02.000Z".into()),
            has_attachments: true,
            message_id: Some("<x@y>".into()),
        });
        assert_eq!(rows[1].from_address.as_deref(), Some("a@b.c"));
    }

    #[test]
    fn the_mailbox_address_falls_back_to_the_sign_in_name() {
        assert_eq!(mailbox_address(&json!({"mail": "Me@Contoso.com"})).as_deref(), Some("me@contoso.com"));
        assert_eq!(mailbox_address(&json!({"mail": null, "userPrincipalName": "me@outlook.com"})).as_deref(), Some("me@outlook.com"));
        assert_eq!(mailbox_address(&json!({"userPrincipalName": "live.com#me"})), None);
    }

    #[test]
    fn a_revoked_grant_parks_the_mailbox_and_a_network_error_does_not() {
        let conn = db();
        let id = reconnect_or_create(&conn, "u1", "me@outlook.com", "2026-10-23T00:00:00.000Z").unwrap();
        assert_eq!(id, "outlook:u1:me@outlook.com");

        record_sync_failure(&conn, &id, "Could not reach Microsoft Graph: timed out").unwrap();
        assert_eq!(background_sync_targets(&conn).unwrap().len(), 1);

        record_sync_failure(&conn, &id, "Microsoft token endpoint (400): invalid_grant AADSTS70000").unwrap();
        assert!(background_sync_targets(&conn).unwrap().is_empty());

        // Reconnecting reactivates the same row.
        assert_eq!(reconnect_or_create(&conn, "u1", "me@outlook.com", "2026-10-24T00:00:00.000Z").unwrap(), id);
        assert_eq!(background_sync_targets(&conn).unwrap().len(), 1);
    }

    #[test]
    fn other_providers_and_other_users_are_out_of_reach() {
        let conn = db();
        conn.execute(
            "INSERT INTO mail_accounts (id, user_id, provider, email_address) VALUES ('cfmail:u1:contact@x.dk', 'u1', 'imap', 'contact@x.dk')",
            [],
        )
        .unwrap();
        let id = reconnect_or_create(&conn, "A", "a@outlook.com", "2026-10-23T00:00:00.000Z").unwrap();
        assert!(own_account(&conn, "cfmail:u1:contact@x.dk", "u1").is_err());
        assert_eq!(delete_account(&conn, "cfmail:u1:contact@x.dk").unwrap(), 0);
        assert!(own_account(&conn, &id, "B").is_err());
        assert_eq!(own_account(&conn, &id, "A").unwrap().as_deref(), Some("a@outlook.com"));
    }

    #[test]
    fn a_resync_does_not_duplicate() {
        let conn = db();
        let id = reconnect_or_create(&conn, "u1", "me@outlook.com", "2026-10-23T00:00:00.000Z").unwrap();
        let rows = parse_page(&json!({"value": [{"id": "AAMk1", "receivedDateTime": "2026-10-23T08:01:02Z"}]}));
        assert_eq!(store_messages(&conn, "u1", &id, &rows).unwrap(), 1);
        assert_eq!(store_messages(&conn, "u1", &id, &rows).unwrap(), 0);
    }
}
