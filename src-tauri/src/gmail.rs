// Consumer Gmail sync — local-only (Phase 7b, docs/mail-setup.md).
//
// OAuth, token storage, sync and analysis all happen on-device. Nothing
// mail-related touches Cloudflare or any cloud service. Scope is gmail.readonly:
// Atlas cannot send, delete, label or modify mail.
//
// The OAuth flow is RFC 8252 (native app): PKCE plus a LOOPBACK redirect
// (oauth::Loopback, http://127.0.0.1:<random port>), not the atlas:// deep
// link Spotify uses. Google's "Desktop app" client type accepts only loopback
// redirects, and it requires the client's secret on the token exchange even
// with PKCE. Google documents that secret as not confidential for installed
// apps; it still lives in the Keychain blob next to the client id, never in
// the repo. gmail_connect starts a listener thread per sign-in; the browser's
// redirect lands there, the code is exchanged in Rust, and the browser tab is
// answered with the real outcome.
//
// Sync is incremental through Gmail's history API (sync_cursor holds a
// historyId). The first sync, or one whose history Gmail has expired, takes the
// newest page only: older mail is not backfilled.
//
// The DB mutex is never held across a network call: every other DB command in
// the app waits on it. Network first, then short locked sections.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::DbState;
use crate::oauth;

const GMAIL_SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const GMAIL_API: &str = "https://gmail.googleapis.com/gmail/v1/users/me";

/// gmail_get's error for HTTP 404, so callers can tell "gone" from "failed":
/// a message deleted since it was listed, or history Gmail no longer keeps.
const NOT_FOUND: &str = "Gmail: not found (404).";

/// Safety bound on history pages read in one sync (500 records each). Every
/// page is read normally; only a mailbox with more history than this since
/// the last sync falls back to the newest page, the same as expired history.
const MAX_HISTORY_PAGES: usize = 200;

/// Messages stored per sync, one request each. When more are new, the rest
/// come on the next sync: the cursor isn't advanced, the history is re-read,
/// and stored ids are skipped, so each sync makes progress.
const MAX_FETCH_PER_SYNC: usize = 200;

/// Hard bound on message requests per sync, counting ones that fail for good.
/// Only a backlog with more permanently unreadable messages than this at its
/// front could still stall (until Gmail expires the history and sync restarts
/// from the newest page).
const MAX_REQUESTS_PER_SYNC: usize = 1000;

/// sync_cursor format: "h:<historyId>". The prefix keeps a value an earlier
/// build stored there (an all-digit messages.list page token) from being
/// mistaken for a historyId.
const CURSOR_PREFIX: &str = "h:";

/// Sign-ins that may be in flight at once. Starting another evicts the oldest,
/// whose listener then retires and reports it. Only reachable by clicking
/// Connect repeatedly; it bounds the listener threads and ports.
const MAX_PENDING_SIGN_INS: usize = 4;

/// One in-flight sign-in: the PKCE verifier, who started it, and the loopback
/// redirect_uri the token exchange must repeat. Keyed by its OAuth state (the
/// "flow" id) in GmailState.pending.
#[derive(Clone)]
pub struct GmailOAuthPending {
    pub verifier: String,
    pub user_id: String,
    pub redirect_uri: String,
    pub started: Instant,
}

pub struct GmailState {
    /// In-flight sign-ins by flow id. Independent of each other: a second
    /// Connect doesn't retire the first, so two hook instances (or two
    /// gmail_connect commands finishing out of order) can't cancel each other.
    /// A flow leaves the map when it completes, is cancelled, or times out.
    pub pending: Mutex<HashMap<String, GmailOAuthPending>>,
    /// Accounts with a sync running, so a double-clicked Scan (or Settings and
    /// the Mail view at once) doesn't fetch every message twice.
    syncing: Mutex<HashSet<String>>,
}

impl GmailState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            syncing: Mutex::new(HashSet::new()),
        }
    }

    /// Add a sign-in, first evicting the oldest ones beyond
    /// MAX_PENDING_SIGN_INS (their listeners retire and report it).
    fn register(&self, flow: &str, sign_in: GmailOAuthPending) {
        let mut pending = self.pending.lock().unwrap();
        while pending.len() >= MAX_PENDING_SIGN_INS {
            let Some(oldest) = pending.iter().min_by_key(|(_, p)| p.started).map(|(id, _)| id.clone())
            else {
                break;
            };
            pending.remove(&oldest);
        }
        pending.insert(flow.to_string(), sign_in);
    }

    fn is_pending(&self, flow: &str) -> bool {
        self.pending.lock().unwrap().contains_key(flow)
    }

    /// Remove a flow; Some if it was still in flight.
    fn retire(&self, flow: &str) -> Option<GmailOAuthPending> {
        self.pending.lock().unwrap().remove(flow)
    }
}

/// Marks an account as syncing for as long as it lives.
struct SyncGuard<'a> {
    set: &'a Mutex<HashSet<String>>,
    account_id: String,
}

impl<'a> SyncGuard<'a> {
    fn acquire(set: &'a Mutex<HashSet<String>>, account_id: &str) -> Option<Self> {
        set.lock()
            .unwrap()
            .insert(account_id.to_string())
            .then(|| Self { set, account_id: account_id.to_string() })
    }
}

impl Drop for SyncGuard<'_> {
    fn drop(&mut self) {
        self.set.lock().unwrap().remove(&self.account_id);
    }
}

fn now_iso() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

/// The Google OAuth client (a "Desktop app" client), from the atlas-core
/// Keychain blob, where the user puts it per docs/mail-setup.md.
struct GoogleClient {
    id: String,
    secret: String,
}

fn google_client() -> Result<GoogleClient, String> {
    let get = |key: &str| crate::secrets::core_key(key).filter(|v| !v.trim().is_empty());
    match (get("google_oauth_client_id"), get("google_oauth_client_secret")) {
        (Some(id), Some(secret)) => Ok(GoogleClient { id, secret }),
        (None, _) => Err("Gmail isn't set up yet: no Google OAuth client ID in the Keychain. See docs/mail-setup.md.".to_string()),
        (_, None) => Err("Gmail isn't set up yet: no Google OAuth client secret in the Keychain. See docs/mail-setup.md.".to_string()),
    }
}

fn build_authorize_url(client: &GoogleClient, redirect_uri: &str, challenge: &str, state: &str) -> String {
    format!(
        "{GOOGLE_AUTH_URL}?{}",
        form(&[
            ("client_id", &client.id),
            ("response_type", "code"),
            ("redirect_uri", redirect_uri),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge),
            ("state", state),
            ("scope", GMAIL_SCOPE),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ])
    )
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding(k), urlencoding(v)))
        .collect::<Vec<_>>()
        .join("&")
}

fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

/// Exchange the authorization code for tokens. Returns (access_token, refresh_token).
fn exchange_code(code: &str, verifier: &str, redirect_uri: &str) -> Result<(String, String), String> {
    let client = google_client()?;
    let body = form(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", &client.id),
        ("client_secret", &client.secret),
        ("code_verifier", verifier),
    ]);
    let v = post_token(&body)?;
    let access = v["access_token"]
        .as_str()
        .ok_or("Google did not return an access token")?
        .to_string();
    let refresh = v["refresh_token"]
        .as_str()
        .ok_or("Google did not return a refresh token")?
        .to_string();
    Ok((access, refresh))
}

/// Refresh the access token using the stored refresh token.
fn refresh_access_token(refresh_token: &str) -> Result<String, String> {
    let client = google_client()?;
    let body = form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", &client.id),
        ("client_secret", &client.secret),
    ]);
    let v = post_token(&body)?;
    v["access_token"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Google token refresh failed: no access_token in response".to_string())
}

fn post_token(body: &str) -> Result<Value, String> {
    match crate::http::agent()
        .post(GOOGLE_TOKEN_URL)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(body)
    {
        Ok(r) => r.into_json().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            Err(format!("Google token endpoint ({code}): {text}"))
        }
        Err(e) => Err(format!("Could not reach Google: {e}")),
    }
}

fn gmail_get(token: &str, path: &str) -> Result<Value, String> {
    match crate::http::agent()
        .get(&format!("{GMAIL_API}{path}"))
        .set("Authorization", &format!("Bearer {token}"))
        .call()
    {
        Ok(r) => r.into_json().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(401, _)) => {
            Err("Gmail access token expired or revoked.".to_string())
        }
        Err(ureq::Error::Status(403, _)) => {
            Err("Gmail API access denied — check the OAuth scope.".to_string())
        }
        Err(ureq::Error::Status(404, _)) => Err(NOT_FOUND.to_string()),
        Err(ureq::Error::Status(code, _)) => {
            Err(format!("Gmail API error ({code})."))
        }
        Err(e) => Err(format!("Could not reach Gmail API: {e}")),
    }
}

/// Best-effort revoke of a refresh token at Google.
fn revoke(token: &str) {
    let _ = crate::http::agent()
        .post(GOOGLE_REVOKE_URL)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(&format!("token={}", urlencoding(token)));
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Begin a Gmail sign-in: bind a loopback listener, generate PKCE, register
/// the flow, start the thread that waits for Google's redirect, and return the
/// consent URL plus the flow id (the OAuth state, which is in the URL anyway).
/// Every gmail:status event carries the flow it is about, so a hook instance
/// only reacts to the flow it started.
/// JS calls with `{ provider: 'gmail', userId: '<id>' }`.
#[tauri::command(async)]
pub fn gmail_connect(
    app: AppHandle,
    state: State<'_, GmailState>,
    user_id: String,
    provider: Option<String>,
) -> Result<Value, String> {
    let _ = provider;
    let client = google_client()?;
    let loopback = oauth::Loopback::bind()
        .map_err(|e| format!("Couldn't start the local sign-in listener: {e}"))?;
    let redirect_uri = loopback.redirect_uri();
    let (verifier, challenge) = oauth::generate_pkce();
    let flow = uuid::Uuid::new_v4().simple().to_string();
    let url = build_authorize_url(&client, &redirect_uri, &challenge, &flow);

    state.register(&flow, GmailOAuthPending { verifier, user_id, redirect_uri, started: Instant::now() });

    let thread_flow = flow.clone();
    let spawned = std::thread::Builder::new()
        .name("gmail-oauth-loopback".into())
        .spawn(move || await_redirect(app, loopback, thread_flow));
    if let Err(e) = spawned {
        // No listener means nothing would ever finish or expire this flow.
        state.retire(&flow);
        return Err(format!("Couldn't start the local sign-in listener: {e}"));
    }

    Ok(json!({ "authUrl": url, "flow": flow }))
}

/// The listener thread for one sign-in: wait for the redirect, finish the
/// sign-in, answer the browser tab with the outcome. Every way it ends that
/// the webview didn't cause itself is reported over gmail:status, so no
/// "Waiting for Google…" is left spinning.
fn await_redirect(app: AppHandle, loopback: oauth::Loopback, flow: String) {
    let gmail = app.state::<GmailState>();
    let report = |msg: &str| emit_gmail_status(&app, Some(&flow), false, Some(msg));

    // Retired (cancelled, or evicted by too many sign-ins): say so once.
    // After the hook's own Cancel nobody is listening, which is harmless.
    let reported_retired = Cell::new(false);
    let keep_waiting = || {
        let live = gmail.is_pending(&flow);
        if !live && !reported_retired.replace(true) {
            report("This Google sign-in was cancelled. Connect again if you still want to.");
        }
        live
    };

    match loopback.wait(&flow, Instant::now() + oauth::FLOW_TTL, keep_waiting) {
        oauth::LoopbackOutcome::Redirect(cb, browser) => {
            let db = app.state::<DbState>();
            match complete_oauth(&app, gmail.inner(), db.inner(), &flow, &cb) {
                Ok(email) => browser.send(
                    true,
                    "Gmail is connected",
                    &format!("Atlas can now read {email}. You can close this tab and return to Atlas."),
                ),
                Err(e) => browser.send(
                    false,
                    "Gmail was not connected",
                    &format!("{e} You can close this tab and try again from Atlas."),
                ),
            }
        }
        // Only a flow still in flight is reported here; a retired one was
        // reported when it retired.
        oauth::LoopbackOutcome::TimedOut => {
            if gmail.retire(&flow).is_some() {
                report("The Google sign-in took too long. Please connect again.");
            }
        }
        oauth::LoopbackOutcome::Failed(e) => {
            if gmail.retire(&flow).is_some() {
                report(&format!("The local sign-in listener stopped ({e}). Please connect again."));
            }
        }
    }
}

/// Account ids are per Atlas user AND mailbox. Two local Atlas users can
/// connect the same Gmail address; a bare "gmail:<email>" id would make the
/// second reactivate the first user's row and overwrite their Keychain token.
fn account_id_for(user_id: &str, email: &str) -> String {
    format!("gmail:{user_id}:{email}")
}

/// Create the account row, or reactivate it on reconnect.
///
/// An upsert, never INSERT OR REPLACE: REPLACE deletes the old row first, and
/// with foreign_keys on that cascades away every message, thread and alert for
/// the mailbox and resets its autonomy settings and colour.
fn upsert_gmail_account(
    conn: &rusqlite::Connection,
    id: &str,
    user_id: &str,
    email: &str,
    now: &str,
) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO mail_accounts (id, user_id, provider, email_address, status, last_synced_at, created_at)
         VALUES (?1, ?2, 'gmail', ?3, 'active', NULL, ?4)
         ON CONFLICT(id) DO UPDATE SET status = 'active', last_error = NULL",
        rusqlite::params![id, user_id, email, now],
    )
}

/// The account id for this user's mailbox: an existing row's id when there is
/// one (a reconnect, or a legacy row whose id predates account_id_for, which
/// UNIQUE(user_id, provider, email_address) would otherwise reject), else a
/// new per-user id. The row is created or reactivated either way. DB errors
/// propagate; they are never mistaken for "no existing row".
fn reconnect_or_create(
    conn: &rusqlite::Connection,
    user_id: &str,
    email: &str,
    now: &str,
) -> rusqlite::Result<String> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM mail_accounts WHERE user_id = ?1 AND provider = 'gmail' AND email_address = ?2",
            rusqlite::params![user_id, email],
            |r| r.get(0),
        )
        .optional()?;
    let id = existing.unwrap_or_else(|| account_id_for(user_id, email));
    upsert_gmail_account(conn, &id, user_id, email, now)?;
    Ok(id)
}

/// Delete a Gmail account row (CASCADE removes its messages and alerts). The
/// provider guard sits in the write itself, so no caller can reach the admin
/// IMAP mailbox through it. Returns rows deleted.
fn delete_gmail_account(conn: &rusqlite::Connection, id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM mail_accounts WHERE id = ?1 AND provider = 'gmail'",
        [id],
    )
}

/// Check that `account_id` is a Gmail mailbox owned by `user_id`, returning its
/// address, or None if the row doesn't exist. Ownership is checked here because
/// nothing upstream scopes mail_accounts by user: without it one local Atlas
/// user could sync another's mailbox into their own rows, or disconnect it.
fn own_gmail_account(db: &DbState, account_id: &str, user_id: &str) -> Result<Option<String>, String> {
    let row: Option<(String, String, String)> = {
        let conn = db.conn.lock().unwrap();
        conn.query_row(
            "SELECT provider, user_id, email_address FROM mail_accounts WHERE id = ?1",
            [account_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
    };
    match row {
        None => Ok(None),
        Some((provider, _, _)) if provider != "gmail" => {
            Err("Only Gmail mailboxes can be managed here.".to_string())
        }
        Some((_, owner, _)) if owner != user_id => {
            Err("That mailbox belongs to another Atlas user.".to_string())
        }
        Some((_, _, email)) => Ok(Some(email)),
    }
}

/// Whether another row holds the same Gmail mailbox (another local Atlas user
/// connected it too). Google issues one grant per app and Google account, and
/// revoking any of its refresh tokens revokes the grant, so revoking here would
/// silently break that other user's connection.
fn mailbox_shared(conn: &rusqlite::Connection, account_id: &str, email: &str) -> rusqlite::Result<bool> {
    conn.prepare(
        "SELECT 1 FROM mail_accounts WHERE provider = 'gmail' AND email_address = ?1 AND id != ?2",
    )?
    .exists(rusqlite::params![email, account_id])
}

/// Disconnect a Gmail account: revoke the grant (unless another local user
/// shares the mailbox), clear the token, delete account + messages locally.
///
/// Refuses any account that isn't provider 'gmail'. The Settings list also
/// shows the admin IMAP mailbox (mail.rs), and deleting that row would cascade
/// away all of its messages, threads and alerts.
#[tauri::command(async)]
pub fn gmail_disconnect(
    app: AppHandle,
    db: State<'_, DbState>,
    account_id: String,
    user_id: String,
) -> Result<Value, String> {
    let email = own_gmail_account(&db, &account_id, &user_id)?;

    // Revoke at Google (best-effort). Skipped when the row is already gone
    // (its mailbox is unknown, so sharing can't be ruled out) or when another
    // row shares the mailbox.
    let revoke_ok = match &email {
        Some(email) => {
            let conn = db.conn.lock().unwrap();
            !mailbox_shared(&conn, &account_id, email).map_err(|e| e.to_string())?
        }
        None => false,
    };
    if let Some(token) = crate::secrets::gmail_refresh_token(&account_id) {
        if revoke_ok {
            revoke(&token);
        }
    }
    crate::secrets::clear_gmail_refresh_token(&account_id)?;

    let conn = db.conn.lock().unwrap();
    delete_gmail_account(&conn, &account_id).map_err(|e| e.to_string())?;

    let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "DELETE"}));
    let _ = app.emit("db:changed", json!({"table": "mail_messages", "op": "DELETE"}));
    let _ = app.emit("db:changed", json!({"table": "mail_alerts", "op": "DELETE"}));
    Ok(json!({ "ok": true }))
}

/// Abandon the Gmail sign-in `flow` (the id gmail_connect returned), so a
/// Google tab finished after Cancel connects nothing, including one whose
/// token exchange is already under way (finish_sign_in re-checks before it
/// writes anything). A no-op if the flow already ended.
#[tauri::command(async)]
pub fn gmail_cancel_connect(state: State<'_, GmailState>, flow: String) -> Result<Value, String> {
    Ok(json!({ "cancelled": state.retire(&flow).is_some() }))
}

/// Sync messages from Gmail into mail_messages (inbox only, metadata only).
#[tauri::command(async)]
pub fn gmail_sync(
    app: AppHandle,
    db: State<'_, DbState>,
    gmail: State<'_, GmailState>,
    account_id: String,
    user_id: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    if own_gmail_account(&db, &account_id, &user_id)?.is_none() {
        return Err("No such Gmail mailbox.".to_string());
    }
    sync_and_record(&app, &db, &gmail, &account_id, &user_id, limit)
}

/// Run one sync and, when it fails, write why onto the mailbox row, so a
/// background sync that fails is visible in the UI rather than only in a log.
/// See SyncFailure for which failures stop background sync.
fn sync_and_record(
    app: &AppHandle,
    db: &DbState,
    gmail: &GmailState,
    account_id: &str,
    user_id: &str,
    limit: Option<u32>,
) -> Result<Value, String> {
    let result = sync_account(app, db, gmail, account_id, user_id, limit);
    if let Err(e) = &result {
        {
            let conn = db.conn.lock().unwrap();
            let _ = record_sync_failure(&conn, account_id, e);
        }
        let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "UPDATE"}));
    }
    result
}

/// The sync itself, for a mailbox whose ownership the caller has checked.
fn sync_account(
    app: &AppHandle,
    db: &DbState,
    gmail: &GmailState,
    account_id: &str,
    user_id: &str,
    limit: Option<u32>,
) -> Result<Value, String> {
    let Some(_guard) = SyncGuard::acquire(&gmail.syncing, account_id) else {
        return Ok(json!({ "accountId": account_id, "alreadyRunning": true }));
    };
    let refresh_token = crate::secrets::gmail_refresh_token(account_id)
        .ok_or(NO_REFRESH_TOKEN)?;
    let access_token = refresh_access_token(&refresh_token)?;

    let max_results = limit.unwrap_or(50).clamp(1, 100);

    let cursor: Option<String> = {
        let conn = db.conn.lock().unwrap();
        let stored: Option<String> = conn
            .query_row("SELECT sync_cursor FROM mail_accounts WHERE id = ?1", [account_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        stored.as_deref().and_then(history_id_from_cursor).map(str::to_string)
    };

    // Incremental: every inbox message added since the cursor, via history. A
    // first sync, or one whose history Gmail has expired (404) or that has more
    // history than MAX_HISTORY_PAGES, takes the newest page instead. A pageToken
    // is never stored as the cursor: pages walk BACKWARDS into older mail, so
    // that skipped new mail until the whole mailbox had been paged.
    let (listed, next_history_id) = match cursor.as_deref() {
        Some(start) => match history_since(&access_token, start)? {
            Some(found) => found,
            None => newest_page(&access_token, max_results)?,
        },
        None => newest_page(&access_token, max_results)?,
    };

    let new_ids: Vec<String> = {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT 1 FROM mail_messages WHERE account_id = ?1 AND provider_message_id = ?2")
            .map_err(|e| e.to_string())?;
        let mut fresh = Vec::new();
        for id in &listed {
            if !stmt
                .exists(rusqlite::params![account_id, id])
                .map_err(|e| e.to_string())?
            {
                fresh.push(id.clone());
            }
        }
        fresh
    };
    let already_stored = listed.len() - new_ids.len();

    // One request per new message, in sequence, oldest first. Fine for the
    // handful history returns between scans; a first sync of 100 is slow (the
    // batch endpoint is a possible later improvement).
    //
    // MAX_FETCH_PER_SYNC counts only messages that land. One that fails the same
    // way every time (gone, malformed) doesn't use it, so a run of deleted
    // messages at the front of the queue can't stall it on every sync;
    // MAX_REQUESTS_PER_SYNC bounds the requests regardless. Any other failure
    // (network down, rate limited, token rejected) would hit every remaining
    // request the same way, so the loop stops there rather than wait out a
    // timeout per message.
    let mut rows = Vec::new();
    let mut unreadable = 0u32;
    let mut retry_error: Option<String> = None;
    let mut processed = 0usize;
    for id in &new_ids {
        if rows.len() >= MAX_FETCH_PER_SYNC || processed >= MAX_REQUESTS_PER_SYNC {
            break;
        }
        match gmail_get(
            &access_token,
            &format!(
                "/messages/{id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject\
                 &metadataHeaders=Date&metadataHeaders=Message-ID"
            ),
        ) {
            Ok(detail) => rows.push(parse_message(id, &detail)),
            Err(e) if is_permanent_failure(&e) => unreadable += 1,
            Err(e) => {
                retry_error = Some(e);
                break;
            }
        }
        processed += 1;
    }
    if rows.is_empty() {
        if let Some(e) = retry_error {
            return Err(e);
        }
    }
    let has_more = processed < new_ids.len();

    // Advance the cursor only when this sync took in everything new. Otherwise
    // keep the old one: the next sync re-reads the same history and skips
    // stored ids, so it retries the failure and fetches the rest.
    let cursor_to_store = if !has_more {
        Some(format!("{CURSOR_PREFIX}{next_history_id}"))
    } else {
        cursor.map(|h| format!("{CURSOR_PREFIX}{h}"))
    };

    let now = now_iso();
    let inserted = {
        let mut conn = db.conn.lock().unwrap();
        // The mailbox may have been disconnected while this sync was fetching
        // (the sync guard doesn't block a disconnect). Checked under the same
        // lock the disconnect's delete takes, so the answer can't go stale:
        // without it the inserts fail on the deleted account's foreign key.
        let still_connected = conn
            .prepare("SELECT 1 FROM mail_accounts WHERE id = ?1")
            .and_then(|mut s| s.exists([account_id]))
            .map_err(|e| e.to_string())?;
        if !still_connected {
            return Ok(json!({ "accountId": account_id, "disconnected": true }));
        }
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut n = 0usize;
        for m in &rows {
            n += tx
                .execute(
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
                        m.extracted.to_string(),
                    ],
                )
                .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "UPDATE mail_accounts SET sync_cursor = ?1, last_synced_at = ?2, status = 'active', last_error = NULL WHERE id = ?3",
            rusqlite::params![cursor_to_store, now, account_id],
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
        "messagesSkipped": already_stored,
        "retryError": retry_error,
        "messagesUnreadable": unreadable,
        "hasMore": has_more,
        "lastSyncedAt": now,
    }))
}

// ---------------------------------------------------------------------------
// Background sync
// ---------------------------------------------------------------------------

/// Why a sync failed, as far as background sync cares: whether trying again
/// later can help, or the user has to act first.
#[derive(Debug, PartialEq)]
enum SyncFailure {
    /// Network down, Google unavailable, rate limited: the next tick retries.
    Transient,
    /// The grant was revoked or expired, the token is missing, or the OAuth
    /// client isn't in the Keychain. Retrying would fail the same way every
    /// tick, so the mailbox is marked 'error' and background sync leaves it
    /// alone until a reconnect or a successful Scan sets it 'active' again.
    NeedsUser(String),
}

fn classify_sync_error(err: &str) -> SyncFailure {
    if err.starts_with("Google token endpoint") && err.contains("invalid_grant") {
        return SyncFailure::NeedsUser(
            "Google no longer accepts Atlas's access to this mailbox (revoked, expired or password changed). Reconnect it."
                .to_string(),
        );
    }
    if err.starts_with("Google token endpoint") && err.contains("invalid_client") {
        return SyncFailure::NeedsUser(
            "Google rejected Atlas's OAuth client. Check the client ID and secret in the Keychain (docs/mail-setup.md)."
                .to_string(),
        );
    }
    if err == NO_REFRESH_TOKEN || err.starts_with("Gmail isn't set up yet") {
        return SyncFailure::NeedsUser(err.to_string());
    }
    SyncFailure::Transient
}

const NO_REFRESH_TOKEN: &str = "Gmail not connected — no refresh token found. Reconnect the mailbox.";

/// Write a failed sync onto the mailbox row. A failure the user must fix sets
/// status 'error'; a transient one only notes the error and leaves the status,
/// so one dropped connection doesn't paint a working mailbox red. A later
/// successful sync clears both (see the UPDATE at the end of sync_account).
fn record_sync_failure(conn: &rusqlite::Connection, account_id: &str, err: &str) -> rusqlite::Result<usize> {
    match classify_sync_error(err) {
        SyncFailure::NeedsUser(msg) => conn.execute(
            "UPDATE mail_accounts SET status = 'error', last_error = ?1 WHERE id = ?2",
            rusqlite::params![msg, account_id],
        ),
        SyncFailure::Transient => conn.execute(
            "UPDATE mail_accounts SET last_error = ?1 WHERE id = ?2",
            rusqlite::params![format!("Last scan failed: {err}"), account_id],
        ),
    }
}

/// Mailboxes background sync should scan: active Gmail rows, with their owner.
/// 'error' rows are skipped (see SyncFailure::NeedsUser); other providers sync
/// elsewhere (the admin IMAP mailbox through mail.rs).
fn background_sync_targets(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id FROM mail_accounts WHERE provider = 'gmail' AND status = 'active' ORDER BY created_at",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// First background sync waits for app startup to settle (the Keychain read
/// and the sidecar spawns), like the proactive scheduler's first tick.
const AUTO_SYNC_STARTUP_DELAY: Duration = Duration::from_secs(90);
/// How stale the inbox may get while Atlas runs. One history request per
/// mailbox when nothing is new, so this is cheap against Gmail's quota.
const AUTO_SYNC_INTERVAL: Duration = Duration::from_secs(15 * 60);
/// Extra syncs in one tick while a sync reports more to fetch (a first sync
/// after a long time offline), so a backlog lands in one tick rather than one
/// MAX_FETCH_PER_SYNC slice per interval.
const AUTO_SYNC_CATCH_UP_ROUNDS: usize = 5;

/// Scans every active Gmail mailbox on a timer while Atlas runs, the same
/// sync as Scan now. Mail is local-only, so there is no sync while the app is
/// closed (docs/mail-setup.md).
///
/// A plain thread with an mpsc `recv_timeout` as an interruptible sleep, like
/// scheduler.rs. It is started only by the instance that owns the sidecars,
/// so two running bundles sharing one atlas.db don't both sync it; the
/// per-process SyncGuard would not stop the other process.
pub struct GmailAutoSync {
    stop_tx: Mutex<Option<Sender<()>>>,
}

impl GmailAutoSync {
    pub fn spawn(app: AppHandle) -> Self {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let spawned = std::thread::Builder::new()
            .name("gmail-auto-sync".into())
            .spawn(move || {
                let mut wait = AUTO_SYNC_STARTUP_DELAY;
                loop {
                    match stop_rx.recv_timeout(wait) {
                        Ok(()) | Err(RecvTimeoutError::Disconnected) => return,
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                    wait = AUTO_SYNC_INTERVAL;
                    auto_sync_once(&app);
                }
            });
        if let Err(e) = spawned {
            eprintln!("[atlas] gmail auto-sync not started: {e}");
        }
        Self { stop_tx: Mutex::new(Some(stop_tx)) }
    }

    /// Wake the thread so it exits. A sync in flight is not waited for: the
    /// process teardown reaps it, as with the proactive scheduler.
    pub fn stop(&self) {
        if let Ok(mut tx) = self.stop_tx.lock() {
            tx.take();
        }
    }
}

fn auto_sync_once(app: &AppHandle) {
    let (Some(db), Some(gmail)) = (app.try_state::<DbState>(), app.try_state::<GmailState>()) else {
        return;
    };
    let targets = {
        let conn = db.conn.lock().unwrap();
        match background_sync_targets(&conn) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[atlas] gmail auto-sync: could not list mailboxes: {e}");
                return;
            }
        }
    };
    for (account_id, user_id) in targets {
        for _ in 0..AUTO_SYNC_CATCH_UP_ROUNDS {
            match sync_and_record(app, &db, &gmail, &account_id, &user_id, None) {
                Ok(v) if v["hasMore"].as_bool() == Some(true) => continue,
                Ok(_) => break,
                Err(e) => {
                    eprintln!("[atlas] gmail auto-sync of {account_id} failed: {e}");
                    break;
                }
            }
        }
    }
}

/// The historyId in a stored sync_cursor, or None for anything that isn't one
/// of ours (NULL, or a page token an earlier build stored without the prefix).
fn history_id_from_cursor(stored: &str) -> Option<&str> {
    stored
        .strip_prefix(CURSOR_PREFIX)
        .filter(|h| !h.is_empty() && h.bytes().all(|b| b.is_ascii_digit()))
}

/// A per-message failure that will fail the same way next time: the message is
/// gone, or Gmail rejects the request for it (4xx other than auth and rate
/// limiting, which have their own messages or are worth retrying).
fn is_permanent_failure(err: &str) -> bool {
    err == NOT_FOUND || (err.starts_with("Gmail API error (4") && !err.contains("(429)"))
}

/// The newest inbox page of message ids, plus the mailbox's current historyId
/// to resume from. The historyId is read FIRST, so mail arriving while the page
/// is listed is picked up by the next sync's history read rather than missed.
fn newest_page(token: &str, max_results: u32) -> Result<(Vec<String>, String), String> {
    let profile = gmail_get(token, "/profile")?;
    let history_id = profile["historyId"]
        .as_str()
        .map(str::to_string)
        .ok_or("Gmail profile returned no historyId")?;
    // INBOX only: drafts, sent mail and archived mail aren't inbound mail.
    let list = gmail_get(token, &format!("/messages?maxResults={max_results}&labelIds=INBOX"))?;
    Ok((ids_from_list(&list), history_id))
}

fn ids_from_list(list: &Value) -> Vec<String> {
    list["messages"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// Ids of inbox messages added since `start`, oldest first, de-duplicated, and
/// the historyId to resume from. Reads every history page. Ok(None) means start
/// over from the newest page: Gmail no longer keeps history that far back
/// (404), or there is more of it than MAX_HISTORY_PAGES.
fn history_since(token: &str, start: &str) -> Result<Option<(Vec<String>, String)>, String> {
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    let mut page_token: Option<String> = None;
    let mut latest = start.to_string();
    for _ in 0..MAX_HISTORY_PAGES {
        // labelId=INBOX: an autosaved draft or a sent reply is a messageAdded too.
        let mut path = format!(
            "/history?startHistoryId={start}&historyTypes=messageAdded&labelId=INBOX&maxResults=500"
        );
        if let Some(p) = &page_token {
            path.push_str(&format!("&pageToken={}", urlencoding(p)));
        }
        let page = match gmail_get(token, &path) {
            Ok(v) => v,
            Err(e) if e == NOT_FOUND => return Ok(None),
            Err(e) => return Err(e),
        };
        collect_added_ids(&page, &mut ids, &mut seen);
        if let Some(h) = page["historyId"].as_str() {
            latest = h.to_string();
        }
        page_token = page["nextPageToken"].as_str().map(str::to_string);
        if page_token.is_none() {
            return Ok(Some((ids, latest)));
        }
    }
    Ok(None)
}

fn collect_added_ids(page: &Value, ids: &mut Vec<String>, seen: &mut HashSet<String>) {
    for entry in page["history"].as_array().into_iter().flatten() {
        for added in entry["messagesAdded"].as_array().into_iter().flatten() {
            if let Some(id) = added["message"]["id"].as_str() {
                if seen.insert(id.to_string()) {
                    ids.push(id.to_string());
                }
            }
        }
    }
}

/// One Gmail message, reduced to the mail_messages columns sync writes.
#[derive(Debug)]
struct ParsedMessage {
    provider_id: String,
    from_address: Option<String>,
    subject: Option<String>,
    snippet: String,
    received_at: Option<String>,
    has_attachments: bool,
    extracted: Value,
}

/// Header lookup by name, case-insensitively: Gmail reports e.g. "Message-ID"
/// or "Message-Id" depending on the sender.
fn header(detail: &Value, name: &str) -> Option<String> {
    detail["payload"]["headers"]
        .as_array()?
        .iter()
        .find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
        .and_then(|h| h["value"].as_str())
        .map(str::to_string)
}

fn parse_message(provider_id: &str, detail: &Value) -> ParsedMessage {
    // Only a named part counts. format=metadata usually omits payload.parts, so
    // this is often false when the message does have attachments: an honest
    // "unknown" rather than a guess from the top-level mimeType, which mislabels
    // newsletters and signatures sent as multipart/mixed.
    let has_attachments = detail["payload"]["parts"]
        .as_array()
        .is_some_and(|parts| parts.iter().any(|p| !p["filename"].as_str().unwrap_or("").is_empty()));
    ParsedMessage {
        provider_id: provider_id.to_string(),
        from_address: header(detail, "From"),
        subject: header(detail, "Subject"),
        snippet: detail["snippet"].as_str().unwrap_or("").to_string(),
        received_at: received_at_iso(
            detail["internalDate"].as_str(),
            header(detail, "Date").as_deref(),
        ),
        has_attachments,
        extracted: json!({
            "direction": "inbound",
            "to_address": null,
            "body_text": null,
            "body_html": null,
            "message_id": header(detail, "Message-ID"),
        }),
    }
}

/// received_at as ISO-8601 UTC, the format every other mail_messages writer
/// uses and the UI sorts and date-compares on. Prefers Gmail's internalDate
/// (ms since epoch, as a string); falls back to parsing the RFC 2822 Date
/// header. Never stores the raw header: "Mon, 3 Oct …" sorts alphabetically.
fn received_at_iso(internal_date: Option<&str>, date_header: Option<&str>) -> Option<String> {
    const ISO: &str = "%Y-%m-%dT%H:%M:%S%.3fZ";
    if let Some(dt) = internal_date
        .and_then(|s| s.parse::<i64>().ok())
        .and_then(chrono::DateTime::from_timestamp_millis)
    {
        return Some(dt.format(ISO).to_string());
    }
    date_header
        .and_then(|d| chrono::DateTime::parse_from_rfc2822(d.trim()).ok())
        .map(|dt| dt.with_timezone(&Utc).format(ISO).to_string())
}

// ---------------------------------------------------------------------------
// Deep-link callback handler (lib.rs calls this only for Gmail-issued states)
// ---------------------------------------------------------------------------

/// Finish a sign-in from its loopback redirect, and report the outcome as
/// gmail:status tagged with the flow (the id the webview got from
/// gmail_connect), so only the hook that started this flow reacts. Returns
/// the connected address, or the reason, for the browser tab's answer.
fn complete_oauth(
    app: &AppHandle,
    state: &GmailState,
    db: &DbState,
    flow: &str,
    cb: &oauth::OauthCallback,
) -> Result<String, String> {
    let result = finish_sign_in(app, state, db, flow, cb);
    // Whatever happened, this flow is over.
    state.retire(flow);
    match &result {
        Ok(_) => emit_gmail_status(app, Some(flow), true, None),
        Err(e) => emit_gmail_status(app, Some(flow), false, Some(e)),
    }
    result
}

/// Exchange the code, then create or reactivate the mail_accounts row and
/// persist the refresh token, unless the flow was cancelled meanwhile.
fn finish_sign_in(
    app: &AppHandle,
    state: &GmailState,
    db: &DbState,
    flow: &str,
    cb: &oauth::OauthCallback,
) -> Result<String, String> {
    const CANCELLED: &str = "This sign-in was cancelled in Atlas.";
    // A copy, not a removal: the flow stays cancellable while the token
    // exchange and profile fetch are on the network.
    let pending = state.pending.lock().unwrap().get(flow).cloned().ok_or(CANCELLED)?;
    if let Some(err) = &cb.error {
        return Err(match err.as_str() {
            "access_denied" => "Access to Gmail wasn't granted.".to_string(),
            other => format!("Google reported an error ({other})."),
        });
    }
    let code = cb.code.as_deref().ok_or("No authorization code in the redirect.")?;

    let (access_token, refresh_token) = exchange_code(code, &pending.verifier, &pending.redirect_uri)?;
    // From here on Google has issued a live grant. A failure below deliberately
    // does NOT revoke it: Google keeps one grant per app and Google account, so
    // revoking this token would also kill the stored token of a mailbox already
    // connected (this may be a reconnect, or another local user's mailbox). An
    // unused grant is the lesser harm; it can be removed from the Google
    // account, or by connecting and then disconnecting.

    // The mailbox's address names the account. Without it there is no honest
    // row to create, so fail rather than invent a placeholder.
    let profile = gmail_get(&access_token, "/profile")?;
    let email = profile["emailAddress"]
        .as_str()
        .ok_or("Google did not return the mailbox address.")?
        .to_string();

    // Last chance to honour a Cancel pressed during the network calls above.
    // Removing the flow here claims it, so from this point a Cancel is a no-op
    // and what remains is a few local writes.
    state.retire(flow).ok_or(CANCELLED)?;

    // Row first, token second: a failed token write then leaves a row marked
    // 'error' that the user can see and reconnect.
    let account_id = {
        let conn = db.conn.lock().unwrap();
        reconnect_or_create(&conn, &pending.user_id, &email, &now_iso())
            .map_err(|e| format!("Failed to create the account: {e}"))?
    };
    let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "INSERT"}));

    if let Err(e) = crate::secrets::set_gmail_refresh_token(&account_id, &refresh_token) {
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

fn emit_gmail_status(app: &AppHandle, flow: Option<&str>, connected: bool, error: Option<&str>) {
    let _ = app.emit(
        "gmail:status",
        json!({ "flow": flow, "connected": connected, "error": error }),
    );
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

    fn add_message(conn: &rusqlite::Connection, account: &str) {
        conn.execute(
            "INSERT INTO mail_messages (id, user_id, account_id, provider_message_id) VALUES (?1, 'u1', ?2, ?1)",
            rusqlite::params![format!("m-{account}"), account],
        )
        .unwrap();
    }

    fn count(conn: &rusqlite::Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    fn status_and_error(conn: &rusqlite::Connection, id: &str) -> (String, Option<String>) {
        conn.query_row(
            "SELECT status, last_error FROM mail_accounts WHERE id = ?1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    #[test]
    fn a_revoked_grant_or_missing_setup_needs_the_user_and_everything_else_is_retried() {
        let revoked = r#"Google token endpoint (400): {"error": "invalid_grant", "error_description": "Token has been expired or revoked."}"#;
        assert!(matches!(classify_sync_error(revoked), SyncFailure::NeedsUser(_)));
        assert!(matches!(
            classify_sync_error(r#"Google token endpoint (401): {"error": "invalid_client"}"#),
            SyncFailure::NeedsUser(_)
        ));
        assert!(matches!(classify_sync_error(NO_REFRESH_TOKEN), SyncFailure::NeedsUser(_)));
        assert!(matches!(
            classify_sync_error("Gmail isn't set up yet: no Google OAuth client ID in the Keychain. See docs/mail-setup.md."),
            SyncFailure::NeedsUser(_)
        ));

        for transient in [
            "Could not reach Google: dns error",
            "Google token endpoint (503): unavailable",
            "Could not reach Gmail API: timed out",
            "Gmail API error (429).",
            // Gmail also answers rate limiting with 403, so 403 must not stop sync.
            "Gmail API access denied — check the OAuth scope.",
        ] {
            assert_eq!(classify_sync_error(transient), SyncFailure::Transient, "{transient}");
        }
    }

    #[test]
    fn a_failure_the_user_must_fix_takes_the_mailbox_out_of_background_sync() {
        let conn = db();
        upsert_gmail_account(&conn, "gmail:a@x.com", "u1", "a@x.com", "2026-10-01T00:00:00.000Z").unwrap();
        upsert_gmail_account(&conn, "gmail:b@x.com", "u2", "b@x.com", "2026-10-02T00:00:00.000Z").unwrap();
        assert_eq!(
            background_sync_targets(&conn).unwrap(),
            vec![("gmail:a@x.com".to_string(), "u1".to_string()), ("gmail:b@x.com".to_string(), "u2".to_string())]
        );

        record_sync_failure(&conn, "gmail:a@x.com", r#"Google token endpoint (400): {"error": "invalid_grant"}"#).unwrap();
        let (status, err) = status_and_error(&conn, "gmail:a@x.com");
        assert_eq!(status, "error");
        assert!(err.unwrap().contains("Reconnect"), "the row says what to do, not Google's raw JSON");
        assert_eq!(background_sync_targets(&conn).unwrap(), vec![("gmail:b@x.com".to_string(), "u2".to_string())]);

        // Reconnecting brings it back.
        upsert_gmail_account(&conn, "gmail:a@x.com", "u1", "a@x.com", "2026-10-03T00:00:00.000Z").unwrap();
        assert_eq!(background_sync_targets(&conn).unwrap().len(), 2);
    }

    #[test]
    fn a_transient_failure_is_noted_without_marking_the_mailbox_broken() {
        let conn = db();
        upsert_gmail_account(&conn, "gmail:a@x.com", "u1", "a@x.com", "2026-10-01T00:00:00.000Z").unwrap();
        record_sync_failure(&conn, "gmail:a@x.com", "Could not reach Google: dns error").unwrap();
        let (status, err) = status_and_error(&conn, "gmail:a@x.com");
        assert_eq!(status, "active");
        assert_eq!(err.as_deref(), Some("Last scan failed: Could not reach Google: dns error"));
        assert_eq!(background_sync_targets(&conn).unwrap().len(), 1);
    }

    #[test]
    fn background_sync_never_touches_other_providers() {
        let conn = db();
        conn.execute(
            "INSERT INTO mail_accounts (id, user_id, provider, email_address) VALUES ('imap-1', 'u1', 'imap', 'admin@x.com')",
            [],
        )
        .unwrap();
        assert!(background_sync_targets(&conn).unwrap().is_empty());
    }

    #[test]
    fn reconnecting_keeps_the_mailbox_messages_and_settings() {
        let conn = db();
        upsert_gmail_account(&conn, "gmail:a@x.com", "u1", "a@x.com", "2026-10-01T00:00:00.000Z").unwrap();
        add_message(&conn, "gmail:a@x.com");
        conn.execute(
            "UPDATE mail_accounts SET autonomy_mode = 'autonomous', status = 'error', last_error = 'boom' WHERE id = 'gmail:a@x.com'",
            [],
        )
        .unwrap();

        upsert_gmail_account(&conn, "gmail:a@x.com", "u1", "a@x.com", "2026-10-04T00:00:00.000Z").unwrap();

        assert_eq!(count(&conn, "SELECT count(*) FROM mail_messages"), 1, "reconnect must not cascade-delete mail");
        let (mode, status, err): (String, String, Option<String>) = conn
            .query_row(
                "SELECT autonomy_mode, status, last_error FROM mail_accounts WHERE id = 'gmail:a@x.com'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(mode, "autonomous");
        assert_eq!(status, "active");
        assert_eq!(err, None);
    }

    #[test]
    fn disconnect_cannot_delete_the_imap_mailbox() {
        let conn = db();
        conn.execute(
            "INSERT INTO mail_accounts (id, user_id, provider, email_address) VALUES ('imap-1', 'u1', 'imap', 'admin@x.com')",
            [],
        )
        .unwrap();
        add_message(&conn, "imap-1");

        assert_eq!(delete_gmail_account(&conn, "imap-1").unwrap(), 0);
        assert_eq!(count(&conn, "SELECT count(*) FROM mail_accounts"), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM mail_messages"), 1);
    }

    #[test]
    fn disconnect_removes_a_gmail_mailbox_and_its_mail() {
        let conn = db();
        upsert_gmail_account(&conn, "gmail:a@x.com", "u1", "a@x.com", "2026-10-01T00:00:00.000Z").unwrap();
        add_message(&conn, "gmail:a@x.com");

        assert_eq!(delete_gmail_account(&conn, "gmail:a@x.com").unwrap(), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM mail_messages"), 0);
    }

    #[test]
    fn received_at_prefers_internal_date_as_iso_utc() {
        // 2026-10-03T08:00:00Z in ms.
        assert_eq!(
            received_at_iso(Some("1791014400000"), Some("Mon, 1 Jan 2001 00:00:00 +0000")).as_deref(),
            Some("2026-10-03T08:00:00.000Z")
        );
    }

    #[test]
    fn received_at_falls_back_to_the_date_header_normalised_to_utc() {
        assert_eq!(
            received_at_iso(None, Some("Sat, 3 Oct 2026 10:00:00 +0200")).as_deref(),
            Some("2026-10-03T08:00:00.000Z")
        );
        assert_eq!(received_at_iso(Some("not-a-number"), Some("garbage")), None);
        assert_eq!(received_at_iso(None, None), None);
    }

    #[test]
    fn parse_message_reads_headers_case_insensitively() {
        let detail = json!({
            "snippet": "Your invoice",
            "internalDate": "1791014400000",
            "payload": {
                "mimeType": "multipart/mixed",
                "headers": [
                    { "name": "FROM", "value": "Bank <b@bank.dk>" },
                    { "name": "Subject", "value": "Invoice" },
                    { "name": "Message-Id", "value": "<abc@bank.dk>" }
                ]
            }
        });
        let m = parse_message("g1", &detail);
        assert_eq!(m.provider_id, "g1");
        assert_eq!(m.from_address.as_deref(), Some("Bank <b@bank.dk>"));
        assert_eq!(m.subject.as_deref(), Some("Invoice"));
        assert_eq!(m.received_at.as_deref(), Some("2026-10-03T08:00:00.000Z"));
        assert_eq!(m.extracted["message_id"], "<abc@bank.dk>");
        // multipart/mixed alone is not evidence of an attachment.
        assert!(!m.has_attachments);

        let plain = parse_message("g2", &json!({ "payload": { "mimeType": "text/plain", "headers": [] } }));
        assert!(!plain.has_attachments);
        assert_eq!(plain.extracted["message_id"], Value::Null);
    }

    #[test]
    fn a_named_part_counts_as_an_attachment() {
        let detail = json!({ "payload": { "headers": [], "parts": [
            { "filename": "" },
            { "filename": "invoice.pdf" }
        ] } });
        assert!(parse_message("g3", &detail).has_attachments);
    }

    #[test]
    fn history_ids_are_collected_in_order_without_duplicates() {
        let page = json!({ "history": [
            { "messagesAdded": [ { "message": { "id": "a" } }, { "message": { "id": "b" } } ] },
            { "messagesAdded": [ { "message": { "id": "a" } } ] },
            { "labelsAdded": [ { "message": { "id": "z" } } ] },
            { "messagesAdded": [ { "message": { "id": "c" } } ] }
        ] });
        let (mut ids, mut seen) = (Vec::new(), HashSet::new());
        collect_added_ids(&page, &mut ids, &mut seen);
        collect_added_ids(&json!({}), &mut ids, &mut seen);
        assert_eq!(ids, ["a", "b", "c"]);
    }

    #[test]
    fn only_a_prefixed_history_id_is_a_cursor() {
        assert_eq!(history_id_from_cursor("h:123456"), Some("123456"));
        assert_eq!(history_id_from_cursor("h:"), None);
        assert_eq!(history_id_from_cursor("h:12ab"), None);
        // What an earlier build stored in sync_cursor: an all-digit page token.
        assert_eq!(history_id_from_cursor("13254647386456785960"), None);
    }

    #[test]
    fn a_message_that_will_always_fail_is_not_retried() {
        assert!(is_permanent_failure(NOT_FOUND));
        assert!(is_permanent_failure("Gmail API error (400)."));
        assert!(!is_permanent_failure("Gmail API error (429)."), "rate limiting is worth retrying");
        assert!(!is_permanent_failure("Gmail API error (503)."));
        assert!(!is_permanent_failure("Could not reach Gmail API: timed out"));
        assert!(!is_permanent_failure("Gmail access token expired or revoked."));
    }

    #[test]
    fn a_user_can_only_manage_their_own_gmail_rows() {
        let conn = db();
        upsert_gmail_account(&conn, "gmail:A:a@x.com", "A", "a@x.com", "2026-10-01T00:00:00.000Z").unwrap();
        conn.execute(
            "INSERT INTO mail_accounts (id, user_id, provider, email_address) VALUES ('imap-1', 'A', 'imap', 'admin@x.com')",
            [],
        )
        .unwrap();
        let state = DbState { conn: Mutex::new(conn) };

        assert_eq!(own_gmail_account(&state, "gmail:A:a@x.com", "A").unwrap().as_deref(), Some("a@x.com"));
        assert!(own_gmail_account(&state, "gmail:A:a@x.com", "B").is_err(), "another user's mailbox");
        assert!(own_gmail_account(&state, "imap-1", "A").is_err(), "not a Gmail mailbox");
        assert_eq!(own_gmail_account(&state, "missing", "A").unwrap(), None);
    }

    #[test]
    fn a_mailbox_another_user_also_connected_counts_as_shared() {
        let conn = db();
        let a = reconnect_or_create(&conn, "A", "shared@x.com", "2026-10-01T00:00:00.000Z").unwrap();
        assert!(!mailbox_shared(&conn, &a, "shared@x.com").unwrap(), "only one row: revoking is safe");
        let b = reconnect_or_create(&conn, "B", "shared@x.com", "2026-10-01T00:00:00.000Z").unwrap();
        assert!(mailbox_shared(&conn, &a, "shared@x.com").unwrap(), "revoking A's token would break B");
        assert!(mailbox_shared(&conn, &b, "shared@x.com").unwrap());
    }

    fn sign_in(started: Instant) -> GmailOAuthPending {
        GmailOAuthPending {
            verifier: "v".into(),
            user_id: "u1".into(),
            redirect_uri: "http://127.0.0.1:1".into(),
            started,
        }
    }

    #[test]
    fn a_second_sign_in_does_not_retire_the_first() {
        let state = GmailState::new();
        let t = Instant::now();
        state.register("a", sign_in(t));
        state.register("b", sign_in(t + std::time::Duration::from_secs(1)));
        assert!(state.is_pending("a") && state.is_pending("b"));
        // Cancelling one leaves the other alone, whatever order things ran in.
        assert!(state.retire("a").is_some());
        assert!(state.retire("a").is_none(), "already gone: a no-op");
        assert!(state.is_pending("b"));
    }

    #[test]
    fn too_many_sign_ins_evict_the_oldest() {
        let state = GmailState::new();
        let t = Instant::now();
        for i in 0..MAX_PENDING_SIGN_INS + 1 {
            state.register(&format!("f{i}"), sign_in(t + std::time::Duration::from_secs(i as u64)));
        }
        assert!(!state.is_pending("f0"), "the oldest is evicted");
        assert!((1..=MAX_PENDING_SIGN_INS).all(|i| state.is_pending(&format!("f{i}"))));
        assert_eq!(state.pending.lock().unwrap().len(), MAX_PENDING_SIGN_INS);
    }

    #[test]
    fn a_second_sync_of_the_same_mailbox_is_refused_while_one_runs() {
        let set = Mutex::new(HashSet::new());
        let first = SyncGuard::acquire(&set, "gmail:u1:a@x.com");
        assert!(first.is_some());
        assert!(SyncGuard::acquire(&set, "gmail:u1:a@x.com").is_none());
        assert!(SyncGuard::acquire(&set, "gmail:u1:b@x.com").is_some(), "other mailboxes are independent");
        drop(first);
        assert!(SyncGuard::acquire(&set, "gmail:u1:a@x.com").is_some(), "released on drop");
    }

    #[test]
    fn two_atlas_users_get_separate_rows_for_the_same_mailbox() {
        let conn = db();
        let a = reconnect_or_create(&conn, "userA", "shared@x.com", "2026-10-01T00:00:00.000Z").unwrap();
        let b = reconnect_or_create(&conn, "userB", "shared@x.com", "2026-10-01T00:00:00.000Z").unwrap();
        assert_ne!(a, b, "the Keychain token is keyed by this id");
        let owner_of = |id: &str| -> String {
            conn.query_row("SELECT user_id FROM mail_accounts WHERE id = ?1", [id], |r| r.get(0)).unwrap()
        };
        assert_eq!(owner_of(&a), "userA");
        assert_eq!(owner_of(&b), "userB");
    }

    #[test]
    fn reconnecting_reuses_a_legacy_row_id() {
        let conn = db();
        conn.execute(
            "INSERT INTO mail_accounts (id, user_id, provider, email_address, status) VALUES ('legacy-uuid', 'u1', 'gmail', 'a@x.com', 'error')",
            [],
        )
        .unwrap();
        add_message(&conn, "legacy-uuid");

        let id = reconnect_or_create(&conn, "u1", "a@x.com", "2026-10-04T00:00:00.000Z").unwrap();

        assert_eq!(id, "legacy-uuid");
        assert_eq!(count(&conn, "SELECT count(*) FROM mail_accounts"), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM mail_messages"), 1);
        assert_eq!(count(&conn, "SELECT count(*) FROM mail_accounts WHERE status = 'active'"), 1);
    }
}
