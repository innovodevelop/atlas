// Custom IMAP mailbox sync — local-only (Mail Stage 6e, docs/mail-setup.md).
//
// For any mailbox that speaks IMAP (iCloud, Fastmail, Yahoo, a work or hosting
// provider's server). Read-only, like gmail.rs: the inbox is opened with
// EXAMINE, never SELECT, so the server cannot even mark a message seen, and
// only envelope metadata (sender, subject, date, Message-ID) is fetched.
//
// The server settings and password live in ONE Keychain item per mailbox
// (service `atlas-imap`), never in atlas.db or the JS layer. Only implicit TLS
// (port 993 by convention) is supported: no STARTTLS and no plaintext, so a
// password can never cross the network unencrypted.
//
// Sync is incremental by UID. The cursor is "u:<UIDVALIDITY>:<last UID>"; a
// first sync, or one after the server reset UIDVALIDITY, takes the newest
// messages only and does not backfill older mail, as Gmail's first sync does.
//
// provider 'imap' is shared with the admin mailbox mail.rs syncs from the
// atlas-mail worker (ids "cfmail:…" or a bare address). Rows this module owns
// are told apart by their id prefix, and every write here is guarded by it, so
// nothing in this file can sync into, or delete, the admin mailbox.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::Duration;

use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::DbState;

const ID_PREFIX: &str = "imap:";
const CURSOR_PREFIX: &str = "u:";
const KEYCHAIN_SERVICE: &str = "atlas-imap";
/// Messages one sync stores at most; the rest are left for the next sync,
/// which background sync runs straight away while there is more.
const MAX_FETCH_PER_SYNC: usize = 200;
const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);

/// Prefix of every error the user has to fix before a retry can work. Anything
/// else (DNS, a dropped connection, a server hiccup) is retried by background
/// sync. See record_sync_failure.
const NEEDS_USER: &str = "IMAP:";
const NO_CREDENTIALS: &str =
    "IMAP: this mailbox's server settings are missing from the Keychain. Reconnect it.";

pub struct ImapState {
    syncing: Mutex<HashSet<String>>,
}

impl ImapState {
    pub fn new() -> Self {
        Self { syncing: Mutex::new(HashSet::new()) }
    }
}

fn now_iso() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ---------------------------------------------------------------------------
// Server settings (Keychain)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
struct ServerSettings {
    host: String,
    port: u16,
    username: String,
    password: String,
}

/// Through keyring rather than secrets::set_permissive: that one passes the
/// value to `/usr/bin/security` as an argument, where any process of the same
/// user can read it from the process list, which is fine for an OAuth refresh
/// token Google can revoke but not for a mailbox password.
fn keychain_entry(account_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account_id).map_err(|e| e.to_string())
}

fn load_settings(account_id: &str) -> Option<ServerSettings> {
    let raw = keychain_entry(account_id).ok()?.get_password().ok()?;
    serde_json::from_str(&raw).ok()
}

fn store_settings(account_id: &str, s: &ServerSettings) -> Result<(), String> {
    let raw = serde_json::to_string(s).map_err(|e| e.to_string())?;
    keychain_entry(account_id)?
        .set_password(&raw)
        .map_err(|e| format!("Could not save the mailbox to the Keychain: {e}"))
}

fn clear_settings(account_id: &str) {
    if let Ok(e) = keychain_entry(account_id) {
        let _ = e.delete_password();
    }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

type Session = imap::Session<native_tls::TlsStream<TcpStream>>;

/// Open a TLS session and log in. Built by hand rather than with imap::connect
/// so every step has a timeout: an unreachable server must not hang a sync
/// thread (and with it background sync) forever.
fn open_session(s: &ServerSettings) -> Result<Session, String> {
    let unreachable = |e: &dyn std::fmt::Display| format!("Could not reach {}:{} ({e}).", s.host, s.port);
    let addr = (s.host.as_str(), s.port)
        .to_socket_addrs()
        .map_err(|e| unreachable(&e))?
        .next()
        .ok_or_else(|| unreachable(&"no address"))?;
    let tcp = TcpStream::connect_timeout(&addr, NETWORK_TIMEOUT).map_err(|e| unreachable(&e))?;
    tcp.set_read_timeout(Some(NETWORK_TIMEOUT)).map_err(|e| e.to_string())?;
    tcp.set_write_timeout(Some(NETWORK_TIMEOUT)).map_err(|e| e.to_string())?;

    let tls = native_tls::TlsConnector::new().map_err(|e| e.to_string())?;
    let stream = tls.connect(&s.host, tcp).map_err(|e| {
        // A certificate that doesn't verify won't verify on the next tick either.
        format!("{NEEDS_USER} the TLS connection to {} failed ({e}). Check the server name and that it accepts TLS on port {}.", s.host, s.port)
    })?;

    let mut client = imap::Client::new(stream);
    client.read_greeting().map_err(|e| format!("{} did not greet as an IMAP server: {e}", s.host))?;
    client.login(&s.username, &s.password).map_err(|(e, _)| login_error(e))
}

fn login_error(e: imap::Error) -> String {
    match e {
        imap::Error::No(_) | imap::Error::Bad(_) | imap::Error::Validate(_) => format!(
            "{NEEDS_USER} the server rejected the username or password. Many providers (iCloud, Yahoo, Fastmail) need an app-specific password here."
        ),
        other => format!("IMAP login failed: {other}"),
    }
}

fn logout<T: Read + Write>(mut session: imap::Session<T>) {
    let _ = session.logout();
}

// ---------------------------------------------------------------------------
// Account rows
// ---------------------------------------------------------------------------

fn account_id_for(user_id: &str, email: &str) -> String {
    format!("{ID_PREFIX}{user_id}:{email}")
}

/// Create the row or reactivate it on reconnect. An upsert, never INSERT OR
/// REPLACE, for the reason upsert_gmail_account gives: REPLACE cascades the
/// mailbox's messages away. The cursor is reset, since the server or login may
/// have changed and an old UID means nothing on a different server.
fn upsert_account(conn: &rusqlite::Connection, id: &str, user_id: &str, email: &str, now: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "INSERT INTO mail_accounts (id, user_id, provider, email_address, status, last_synced_at, created_at)
         VALUES (?1, ?2, 'imap', ?3, 'active', NULL, ?4)
         ON CONFLICT(id) DO UPDATE SET status = 'active', last_error = NULL, sync_cursor = NULL",
        rusqlite::params![id, user_id, email, now],
    )
}

/// The address of `account_id` if it is one of this module's mailboxes owned
/// by `user_id`, None if the row is gone, Err if it belongs to someone else or
/// is not ours (the admin mailbox, or Gmail).
fn own_account(conn: &rusqlite::Connection, account_id: &str, user_id: &str) -> Result<Option<String>, String> {
    if !account_id.starts_with(ID_PREFIX) {
        return Err("Not an IMAP mailbox Atlas connected.".to_string());
    }
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
        Some((owner, provider, email)) if owner == user_id && provider == "imap" => Ok(Some(email)),
        Some(_) => Err("Not your IMAP mailbox.".to_string()),
    }
}

fn delete_account(conn: &rusqlite::Connection, id: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM mail_accounts WHERE id = ?1 AND provider = 'imap' AND id LIKE 'imap:%'",
        [id],
    )
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Connect a mailbox: log in once to prove the settings work, then save them
/// and create the row. Nothing is saved when the login fails.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn imap_connect(
    app: AppHandle,
    db: State<'_, DbState>,
    user_id: String,
    email: String,
    host: String,
    port: Option<u16>,
    username: Option<String>,
    password: String,
) -> Result<Value, String> {
    let email = email.trim().to_lowercase();
    let host = host.trim().to_lowercase();
    if !email.contains('@') {
        return Err("Enter the mailbox's email address.".to_string());
    }
    if host.is_empty() || host.contains(char::is_whitespace) || host.contains('/') {
        return Err("Enter the IMAP server name, e.g. imap.mail.me.com.".to_string());
    }
    if password.is_empty() {
        return Err("Enter the mailbox password.".to_string());
    }
    let settings = ServerSettings {
        host,
        port: port.unwrap_or(993),
        username: username.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).unwrap_or_else(|| email.clone()),
        password,
    };

    let mut session = open_session(&settings)?;
    let checked = session.examine("INBOX").map(|_| ()).map_err(|e| format!("Logged in, but the inbox could not be opened: {e}"));
    logout(session);
    checked?;

    let id = account_id_for(&user_id, &email);
    store_settings(&id, &settings)?;
    {
        let conn = db.conn.lock().unwrap();
        upsert_account(&conn, &id, &user_id, &email, &now_iso()).map_err(|e| e.to_string())?;
    }
    let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "INSERT"}));
    Ok(json!({ "accountId": id, "email": email }))
}

/// Remove a mailbox Atlas connected over IMAP, with everything synced from it,
/// and its Keychain item. The server is not contacted: there is no grant to
/// revoke, the user changes the password at their provider if they want to.
#[tauri::command(async)]
pub fn imap_disconnect(
    app: AppHandle,
    db: State<'_, DbState>,
    account_id: String,
    user_id: String,
) -> Result<Value, String> {
    {
        let conn = db.conn.lock().unwrap();
        own_account(&conn, &account_id, &user_id)?;
        delete_account(&conn, &account_id).map_err(|e| e.to_string())?;
    }
    clear_settings(&account_id);
    let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "DELETE"}));
    let _ = app.emit("db:changed", json!({"table": "mail_messages", "op": "DELETE"}));
    let _ = app.emit("db:changed", json!({"table": "mail_alerts", "op": "DELETE"}));
    Ok(json!({ "ok": true }))
}

#[tauri::command(async)]
pub fn imap_sync(
    app: AppHandle,
    db: State<'_, DbState>,
    imap: State<'_, ImapState>,
    account_id: String,
    user_id: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    {
        let conn = db.conn.lock().unwrap();
        if own_account(&conn, &account_id, &user_id)?.is_none() {
            return Err("No such IMAP mailbox.".to_string());
        }
    }
    sync_and_record(&app, &db, &imap, &account_id, &user_id, limit)
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

fn sync_and_record(
    app: &AppHandle,
    db: &DbState,
    imap: &ImapState,
    account_id: &str,
    user_id: &str,
    limit: Option<u32>,
) -> Result<Value, String> {
    let since = crate::mail_flags::mark();
    let result = sync_account(app, db, imap, account_id, user_id, limit);
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

/// Same policy as gmail::record_sync_failure: an error only the user can fix
/// parks the mailbox as 'error' (background sync skips it until a reconnect
/// or a successful Scan), anything else is noted and retried.
fn record_sync_failure(conn: &rusqlite::Connection, account_id: &str, err: &str) -> rusqlite::Result<usize> {
    if err.starts_with(NEEDS_USER) {
        conn.execute(
            "UPDATE mail_accounts SET status = 'error', last_error = ?1 WHERE id = ?2",
            rusqlite::params![err, account_id],
        )
    } else {
        conn.execute(
            "UPDATE mail_accounts SET last_error = ?1 WHERE id = ?2",
            rusqlite::params![format!("Last scan failed: {err}"), account_id],
        )
    }
}

/// Which UIDs this sync fetches, and the cursor to store once they're in.
#[derive(Debug, PartialEq)]
struct Plan {
    fetch: Vec<u32>,
    next_cursor: String,
    has_more: bool,
}

fn parse_cursor(stored: &str) -> Option<(u32, u32)> {
    let (validity, last) = stored.strip_prefix(CURSOR_PREFIX)?.split_once(':')?;
    Some((validity.parse().ok()?, last.parse().ok()?))
}

/// Decide what to fetch from the UIDs in the inbox.
///
/// With a cursor for the same UIDVALIDITY: every UID above the last one stored,
/// oldest first, at most MAX_FETCH_PER_SYNC; the cursor advances only as far as
/// what was taken, so nothing is skipped. Otherwise (first sync, or the server
/// renumbered the mailbox): the newest `first_sync` messages, and the cursor
/// jumps to the newest UID so older mail is not backfilled.
fn plan_sync(uids: &HashSet<u32>, uid_validity: u32, cursor: Option<(u32, u32)>, first_sync: usize) -> Plan {
    let mut sorted: Vec<u32> = uids.iter().copied().collect();
    sorted.sort_unstable();
    match cursor {
        Some((validity, last)) if validity == uid_validity => {
            let newer: Vec<u32> = sorted.into_iter().filter(|u| *u > last).collect();
            let has_more = newer.len() > MAX_FETCH_PER_SYNC;
            let fetch: Vec<u32> = newer.into_iter().take(MAX_FETCH_PER_SYNC).collect();
            let upto = fetch.last().copied().unwrap_or(last);
            Plan { next_cursor: format!("{CURSOR_PREFIX}{uid_validity}:{upto}"), fetch, has_more }
        }
        _ => {
            let newest = sorted.last().copied().unwrap_or(0);
            let fetch = sorted[sorted.len().saturating_sub(first_sync)..].to_vec();
            Plan { next_cursor: format!("{CURSOR_PREFIX}{uid_validity}:{newest}"), fetch, has_more: false }
        }
    }
}

#[derive(Debug)]
struct ParsedMessage {
    provider_id: String,
    from_address: Option<String>,
    subject: Option<String>,
    received_at: Option<String>,
    message_id: Option<String>,
}

fn sync_account(
    app: &AppHandle,
    db: &DbState,
    imap: &ImapState,
    account_id: &str,
    user_id: &str,
    limit: Option<u32>,
) -> Result<Value, String> {
    let Some(_guard) = crate::gmail::SyncGuard::acquire(&imap.syncing, account_id) else {
        return Ok(json!({ "accountId": account_id, "alreadyRunning": true }));
    };
    let settings = load_settings(account_id).ok_or(NO_CREDENTIALS)?;
    let first_sync = limit.unwrap_or(50).clamp(1, 100) as usize;

    let cursor = {
        let conn = db.conn.lock().unwrap();
        let stored: Option<String> = conn
            .query_row("SELECT sync_cursor FROM mail_accounts WHERE id = ?1", [account_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .flatten();
        stored.as_deref().and_then(parse_cursor)
    };

    // Network first, with the DB lock released, as in gmail.rs.
    let mut session = open_session(&settings)?;
    let fetched = fetch_new(&mut session, cursor, first_sync);
    logout(session);
    let (plan, rows) = fetched?;

    let now = now_iso();
    let inserted = {
        let mut conn = db.conn.lock().unwrap();
        // Disconnected while the fetch ran: nothing to write into.
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
            rusqlite::params![plan.next_cursor, now, account_id],
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
        "hasMore": plan.has_more,
        "lastSyncedAt": now,
    }))
}

fn fetch_new(session: &mut Session, cursor: Option<(u32, u32)>, first_sync: usize) -> Result<(Plan, Vec<ParsedMessage>), String> {
    let inbox = session.examine("INBOX").map_err(|e| format!("Could not open the inbox: {e}"))?;
    let validity = inbox.uid_validity.ok_or(
        "IMAP: this server doesn't report UIDVALIDITY, which Atlas needs to sync without duplicates.",
    )?;
    let uids = match cursor {
        // "n:*" always matches the newest message even when its UID is below n;
        // plan_sync drops anything at or below the cursor.
        Some((v, last)) if v == validity => session.uid_search(format!("UID {}:*", last.saturating_add(1))),
        _ => session.uid_search("ALL"),
    }
    .map_err(|e| format!("Could not list the inbox: {e}"))?;
    let plan = plan_sync(&uids, validity, cursor, first_sync);
    if plan.fetch.is_empty() {
        return Ok((plan, Vec::new()));
    }

    let set = plan.fetch.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let fetches = session
        .uid_fetch(set, "(UID INTERNALDATE ENVELOPE)")
        .map_err(|e| format!("Could not read the new messages: {e}"))?;
    let rows = fetches
        .iter()
        .filter_map(|f| {
            let uid = f.uid?;
            let env = f.envelope();
            let from = env.and_then(|e| e.from.as_ref()).and_then(|a| a.first());
            Some(ParsedMessage {
                provider_id: format!("{validity}:{uid}"),
                from_address: from.and_then(|a| format_address(a.name, a.mailbox, a.host)),
                subject: env.and_then(|e| e.subject).map(decode_header).filter(|s| !s.is_empty()),
                received_at: f.internal_date().map(|d| {
                    d.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
                }),
                message_id: env.and_then(|e| e.message_id).map(|m| String::from_utf8_lossy(m).into_owned()),
            })
        })
        .collect();
    Ok((plan, rows))
}

fn store_messages(conn: &rusqlite::Connection, user_id: &str, account_id: &str, rows: &[ParsedMessage]) -> rusqlite::Result<usize> {
    let mut n = 0;
    for m in rows {
        n += conn.execute(
            "INSERT OR IGNORE INTO mail_messages (id, user_id, account_id, provider_message_id, from_address, subject, snippet, received_at, has_attachments, extracted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, 0, ?8)",
            rusqlite::params![
                uuid::Uuid::new_v4().to_string(),
                user_id,
                account_id,
                m.provider_id,
                m.from_address,
                m.subject,
                m.received_at,
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
// Envelope decoding
// ---------------------------------------------------------------------------

/// "Name <mailbox@host>", or the bare address when there is no display name,
/// matching the raw From header Gmail stores.
fn format_address(name: Option<&[u8]>, mailbox: Option<&[u8]>, host: Option<&[u8]>) -> Option<String> {
    let addr = match (mailbox, host) {
        (Some(m), Some(h)) => format!("{}@{}", String::from_utf8_lossy(m), String::from_utf8_lossy(h)),
        (Some(m), None) => String::from_utf8_lossy(m).into_owned(),
        _ => return None,
    };
    match name.map(decode_header).filter(|n| !n.is_empty()) {
        Some(n) => Some(format!("{n} <{addr}>")),
        None => Some(addr),
    }
}

/// Decode RFC 2047 encoded-words ("=?UTF-8?B?…?=", "=?iso-8859-1?Q?…?=") in a
/// header value. UTF-8, US-ASCII and Latin-1 are decoded; an encoded-word in
/// any other charset, or one that is malformed, is kept as written rather than
/// guessed at. Whitespace between two adjacent encoded-words is dropped, as
/// the RFC requires.
fn decode_header(raw: &[u8]) -> String {
    let s = String::from_utf8_lossy(raw);
    let mut out = String::new();
    let mut rest: &str = &s;
    let mut last_was_word = false;
    while let Some(start) = rest.find("=?") {
        let (before, candidate) = rest.split_at(start);
        match decode_word(candidate) {
            Some((text, used)) => {
                if !(last_was_word && before.trim().is_empty()) {
                    out.push_str(before);
                }
                out.push_str(&text);
                rest = &candidate[used..];
                last_was_word = true;
            }
            None => {
                out.push_str(before);
                out.push_str("=?");
                rest = &candidate[2..];
                last_was_word = false;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// One encoded-word at the start of `s`: its text and how many bytes it used.
fn decode_word(s: &str) -> Option<(String, usize)> {
    let body = s.strip_prefix("=?")?;
    let (charset, body) = body.split_once('?')?;
    let (encoding, body) = body.split_once('?')?;
    let end = body.find("?=")?;
    let payload = &body[..end];
    let used = 2 + charset.len() + 1 + encoding.len() + 1 + end + 2;
    let bytes = match encoding {
        "B" | "b" => {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.decode(payload).ok()?
        }
        "Q" | "q" => decode_q(payload)?,
        _ => return None,
    };
    // RFC 2231 allows "charset*language"; the language tag is irrelevant here.
    let charset = charset.split('*').next().unwrap_or("").to_ascii_lowercase();
    let text = match charset.as_str() {
        "utf-8" | "utf8" | "us-ascii" => String::from_utf8(bytes).ok()?,
        "iso-8859-1" | "latin1" | "windows-1252" => bytes.iter().map(|&b| b as char).collect(),
        _ => return None,
    };
    Some((text, used))
}

fn decode_q(payload: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut bytes = payload.bytes();
    while let Some(b) = bytes.next() {
        match b {
            b'_' => out.push(b' '),
            b'=' => {
                let hex = [bytes.next()?, bytes.next()?];
                out.push(u8::from_str_radix(std::str::from_utf8(&hex).ok()?, 16).ok()?);
            }
            other => out.push(other),
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Background sync
// ---------------------------------------------------------------------------

fn background_sync_targets(conn: &rusqlite::Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, user_id FROM mail_accounts
         WHERE provider = 'imap' AND id LIKE 'imap:%' AND status = 'active' ORDER BY created_at",
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

/// Called on gmail::GmailAutoSync's timer, so all consumer mailboxes share one
/// thread and one owner-instance check.
pub fn auto_sync_once(app: &AppHandle, catch_up_rounds: usize) {
    let (Some(db), Some(imap)) = (app.try_state::<DbState>(), app.try_state::<ImapState>()) else {
        return;
    };
    let targets = {
        let conn = db.conn.lock().unwrap();
        match background_sync_targets(&conn) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("[atlas] imap auto-sync: could not list mailboxes: {e}");
                return;
            }
        }
    };
    for (account_id, user_id) in targets {
        for _ in 0..catch_up_rounds {
            match sync_and_record(app, &db, &imap, &account_id, &user_id, None) {
                Ok(v) if v["hasMore"].as_bool() == Some(true) => continue,
                Ok(_) => break,
                Err(e) => {
                    eprintln!("[atlas] imap auto-sync of {account_id} failed: {e}");
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

    fn uids(v: &[u32]) -> HashSet<u32> {
        v.iter().copied().collect()
    }

    #[test]
    fn a_first_sync_takes_the_newest_messages_and_does_not_backfill() {
        let p = plan_sync(&uids(&[3, 9, 1, 7, 5]), 42, None, 2);
        assert_eq!(p.fetch, vec![7, 9]);
        assert_eq!(p.next_cursor, "u:42:9");
        assert!(!p.has_more);
    }

    #[test]
    fn an_incremental_sync_takes_only_newer_uids_oldest_first() {
        // UID SEARCH n:* also returns the newest message when nothing is newer.
        let p = plan_sync(&uids(&[10]), 42, Some((42, 10)), 50);
        assert!(p.fetch.is_empty());
        assert_eq!(p.next_cursor, "u:42:10");

        let p = plan_sync(&uids(&[12, 11, 10]), 42, Some((42, 10)), 50);
        assert_eq!(p.fetch, vec![11, 12]);
        assert_eq!(p.next_cursor, "u:42:12");
    }

    #[test]
    fn a_backlog_advances_the_cursor_only_past_what_was_taken() {
        let all: Vec<u32> = (1..=MAX_FETCH_PER_SYNC as u32 + 5).collect();
        let p = plan_sync(&uids(&all), 7, Some((7, 0)), 50);
        assert_eq!(p.fetch.len(), MAX_FETCH_PER_SYNC);
        assert!(p.has_more);
        assert_eq!(p.next_cursor, format!("u:7:{MAX_FETCH_PER_SYNC}"));
    }

    #[test]
    fn a_new_uidvalidity_starts_over_from_the_newest_messages() {
        let p = plan_sync(&uids(&[1, 2, 3]), 99, Some((42, 500)), 2);
        assert_eq!(p.fetch, vec![2, 3]);
        assert_eq!(p.next_cursor, "u:99:3");
    }

    #[test]
    fn cursors_round_trip_and_junk_is_ignored() {
        assert_eq!(parse_cursor("u:42:10"), Some((42, 10)));
        assert_eq!(parse_cursor("h:123"), None);
        assert_eq!(parse_cursor("u:x:1"), None);
    }

    #[test]
    fn encoded_headers_are_decoded() {
        assert_eq!(decode_header(b"=?UTF-8?B?RmFrdHVyYSBmcmEgw5hyc3RlZA==?="), "Faktura fra Ørsted");
        assert_eq!(decode_header(b"=?iso-8859-1?Q?K=F8benhavn_Energi?="), "København Energi");
        assert_eq!(decode_header(b"=?UTF-8?Q?a?= =?UTF-8?Q?b?= c"), "ab c");
        assert_eq!(decode_header(b"Plain subject"), "Plain subject");
        // Unknown charsets and broken words are left as written.
        assert_eq!(decode_header(b"=?koi8-r?B?xMnS?="), "=?koi8-r?B?xMnS?=");
        assert_eq!(decode_header(b"50% off =? today"), "50% off =? today");
    }

    #[test]
    fn senders_read_like_a_from_header() {
        assert_eq!(
            format_address(Some(b"=?UTF-8?Q?S=C3=B8ren?="), Some(b"soren"), Some(b"example.dk")).as_deref(),
            Some("Søren <soren@example.dk>")
        );
        assert_eq!(format_address(None, Some(b"a"), Some(b"b.c")).as_deref(), Some("a@b.c"));
        assert_eq!(format_address(Some(b"x"), None, None), None);
    }

    #[test]
    fn nothing_here_can_reach_the_admin_mailbox() {
        let conn = db();
        conn.execute(
            "INSERT INTO mail_accounts (id, user_id, provider, email_address, status) VALUES ('cfmail:u1:contact@x.dk', 'u1', 'imap', 'contact@x.dk', 'active')",
            [],
        )
        .unwrap();
        upsert_account(&conn, "imap:u1:me@icloud.com", "u1", "me@icloud.com", "2026-10-23T00:00:00.000Z").unwrap();

        assert!(own_account(&conn, "cfmail:u1:contact@x.dk", "u1").is_err());
        assert_eq!(delete_account(&conn, "cfmail:u1:contact@x.dk").unwrap(), 0);
        let targets = background_sync_targets(&conn).unwrap();
        assert_eq!(targets, vec![("imap:u1:me@icloud.com".to_string(), "u1".to_string())]);
    }

    #[test]
    fn another_users_mailbox_is_refused() {
        let conn = db();
        upsert_account(&conn, "imap:A:a@x.com", "A", "a@x.com", "2026-10-23T00:00:00.000Z").unwrap();
        assert_eq!(own_account(&conn, "imap:A:a@x.com", "A").unwrap().as_deref(), Some("a@x.com"));
        assert!(own_account(&conn, "imap:A:a@x.com", "B").is_err());
        assert_eq!(own_account(&conn, "imap:A:gone@x.com", "A").unwrap(), None);
    }

    #[test]
    fn a_resync_does_not_duplicate_and_a_reconnect_resets_the_cursor() {
        let conn = db();
        let id = "imap:u1:me@x.com";
        upsert_account(&conn, id, "u1", "me@x.com", "2026-10-23T00:00:00.000Z").unwrap();
        let rows = vec![ParsedMessage {
            provider_id: "42:7".into(),
            from_address: Some("a@b.c".into()),
            subject: Some("Hi".into()),
            received_at: Some("2026-10-23T08:00:00.000Z".into()),
            message_id: None,
        }];
        assert_eq!(store_messages(&conn, "u1", id, &rows).unwrap(), 1);
        assert_eq!(store_messages(&conn, "u1", id, &rows).unwrap(), 0);

        conn.execute("UPDATE mail_accounts SET sync_cursor = 'u:42:7', status = 'error' WHERE id = ?1", [id]).unwrap();
        upsert_account(&conn, id, "u1", "me@x.com", "2026-10-24T00:00:00.000Z").unwrap();
        let (status, cursor): (String, Option<String>) = conn
            .query_row("SELECT status, sync_cursor FROM mail_accounts WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((status.as_str(), cursor), ("active", None));
        let kept: i64 = conn.query_row("SELECT COUNT(*) FROM mail_messages WHERE account_id = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1, "a reconnect keeps the mail already synced");
    }

    #[test]
    fn a_failure_the_user_must_fix_parks_the_mailbox_and_others_do_not() {
        let conn = db();
        let id = "imap:u1:me@x.com";
        upsert_account(&conn, id, "u1", "me@x.com", "2026-10-23T00:00:00.000Z").unwrap();

        record_sync_failure(&conn, id, "Could not reach imap.x.com:993 (timed out).").unwrap();
        let status: String = conn.query_row("SELECT status FROM mail_accounts WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(status, "active");

        record_sync_failure(&conn, id, &login_error(imap::Error::No("AUTHENTICATIONFAILED".into()))).unwrap();
        assert!(background_sync_targets(&conn).unwrap().is_empty());
    }
}
