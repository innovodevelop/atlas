// Consumer Gmail sync — local-only (Phase 7b, docs/mail-setup.md).
//
// OAuth, token storage, sync and analysis all happen on-device. Nothing
// mail-related touches Cloudflare or any cloud service. Scope is gmail.readonly:
// Atlas cannot send, delete, label or modify mail.
//
// The OAuth flow uses RFC 8252 (native app): PKCE + deep-link redirect capture.
// The redirect is the same `atlas://oauth/callback` used by music.rs (Spotify).
// Every callback is handed to BOTH handlers; each one only acts on a state it
// issued. Known gap: each handler take()s its pending flow before comparing
// state, so a Spotify and a Gmail flow in flight at once cancel each other.

use std::sync::Mutex;

use chrono::Utc;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

use crate::db::DbState;
use crate::oauth;

const GMAIL_SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const GMAIL_API: &str = "https://gmail.googleapis.com/gmail/v1/users/me";

/// In-flight OAuth state (the PKCE verifier + CSRF token). Cleared once the
/// callback completes or the flow times out.
pub struct GmailOAuthPending {
    pub verifier: String,
    pub csrf_state: String,
    pub user_id: String,
}

pub struct GmailState {
    pub pending: Mutex<Option<GmailOAuthPending>>,
}

impl GmailState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(None),
        }
    }
}

fn now_iso() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

/// Read Google OAuth Client ID from Keychain (stored by the user per mail-setup.md).
fn google_client_id() -> Result<String, String> {
    crate::secrets::core_key("google_oauth_client_id")
        .ok_or_else(|| "Google OAuth Client ID not found in Keychain. See docs/mail-setup.md step 5.".to_string())
}

fn build_authorize_url(challenge: &str, state: &str) -> Result<String, String> {
    let client_id = google_client_id()?;
    Ok(format!(
        "{GOOGLE_AUTH_URL}?{}",
        form(&[
            ("client_id", &client_id),
            ("response_type", "code"),
            ("redirect_uri", oauth::REDIRECT_URI),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge),
            ("state", state),
            ("scope", GMAIL_SCOPE),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ])
    ))
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
fn exchange_code(code: &str, verifier: &str) -> Result<(String, String), String> {
    let client_id = google_client_id()?;
    let body = form(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", oauth::REDIRECT_URI),
        ("client_id", &client_id),
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
    let client_id = google_client_id()?;
    let body = form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", &client_id),
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
        Err(ureq::Error::Status(code, _)) => {
            Err(format!("Gmail API error ({code})."))
        }
        Err(e) => Err(format!("Could not reach Gmail API: {e}")),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Begin the Gmail OAuth flow: generate PKCE, stash state, return the consent URL.
/// JS calls with `{ provider: 'gmail', userId: '<id>' }`.
#[tauri::command(async)]
pub fn gmail_connect(
    state: State<'_, GmailState>,
    user_id: String,
    provider: Option<String>,
) -> Result<Value, String> {
    let _ = provider;
    let (verifier, challenge) = oauth::generate_pkce();
    let csrf = uuid::Uuid::new_v4().simple().to_string();
    let url = build_authorize_url(&challenge, &csrf)?;
    *state.pending.lock().unwrap() = Some(GmailOAuthPending {
        verifier,
        csrf_state: csrf,
        user_id,
    });
    Ok(json!({ "authUrl": url }))
}

/// Disconnect a Gmail account: revoke the token, delete account + messages locally.
#[tauri::command(async)]
pub fn gmail_disconnect(
    app: AppHandle,
    db: State<'_, DbState>,
    account_id: String,
) -> Result<Value, String> {
    // Revoke the token with Google (best-effort; proceed even if it fails).
    if let Some(token) = crate::secrets::gmail_refresh_token(&account_id) {
        let _ = crate::http::agent()
            .post(GOOGLE_REVOKE_URL)
            .set("Content-Type", "application/x-www-form-urlencoded")
            .send_string(&format!("token={}", urlencoding(&token)));
    }
    crate::secrets::clear_gmail_refresh_token(&account_id)?;

    let conn = db.conn.lock().unwrap();
    // CASCADE deletes mail_messages, mail_alerts tied to this account.
    conn.execute("DELETE FROM mail_accounts WHERE id = ?1", [&account_id])
        .map_err(|e| e.to_string())?;

    let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "DELETE"}));
    let _ = app.emit("db:changed", json!({"table": "mail_messages", "op": "DELETE"}));
    let _ = app.emit("db:changed", json!({"table": "mail_alerts", "op": "DELETE"}));
    Ok(json!({ "ok": true }))
}

/// Sync messages from Gmail. Fetches the latest messages and upserts them locally.
#[tauri::command(async)]
pub fn gmail_sync(
    app: AppHandle,
    db: State<'_, DbState>,
    account_id: String,
    user_id: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let refresh_token = crate::secrets::gmail_refresh_token(&account_id)
        .ok_or("Gmail not connected — no refresh token found.")?;
    let access_token = refresh_access_token(&refresh_token)?;

    let max_results = limit.unwrap_or(50).min(100);
    let conn = db.conn.lock().unwrap();

    // Get sync cursor (pageToken from last sync) for incremental fetches.
    let cursor: Option<String> = conn
        .query_row(
            "SELECT sync_cursor FROM mail_accounts WHERE id = ?1",
            [&account_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();

    // List messages from Gmail API.
    let list_path = if let Some(ref token) = cursor {
        format!(
            "/messages?maxResults={max_results}&pageToken={token}"
        )
    } else {
        format!("/messages?maxResults={max_results}")
    };

    let list_res = gmail_get(&access_token, &list_path)?;
    let messages = list_res["messages"].as_array();
    let next_page_token = list_res["nextPageToken"].as_str().map(str::to_string);

    let mut inserted = 0u32;
    let mut skipped = 0u32;

    if let Some(msgs) = messages {
        for msg_ref in msgs {
            let msg_id = match msg_ref["id"].as_str() {
                Some(id) => id,
                None => { skipped += 1; continue; }
            };

            // Check if we already have this message.
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM mail_messages WHERE account_id = ?1 AND provider_message_id = ?2",
                    rusqlite::params![&account_id, msg_id],
                    |_| Ok(true),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .unwrap_or(false);

            if exists {
                skipped += 1;
                continue;
            }

            // Fetch the full message metadata.
            let detail = match gmail_get(
                &access_token,
                &format!("/messages/{msg_id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date"),
            ) {
                Ok(d) => d,
                Err(_) => { skipped += 1; continue; }
            };

            let headers = detail["payload"]["headers"].as_array();
            let mut from_addr: Option<String> = None;
            let mut subject: Option<String> = None;
            let mut date: Option<String> = None;

            if let Some(hdrs) = headers {
                for h in hdrs {
                    match h["name"].as_str().unwrap_or("") {
                        "From" => from_addr = h["value"].as_str().map(str::to_string),
                        "Subject" => subject = h["value"].as_str().map(str::to_string),
                        "Date" => date = h["value"].as_str().map(str::to_string),
                        _ => {}
                    }
                }
            }

            let snippet = detail["snippet"].as_str().unwrap_or("").to_string();
            let has_attachments = detail["payload"]["parts"]
                .as_array()
                .map(|parts| parts.iter().any(|p| {
                    p["filename"].as_str().unwrap_or("").len() > 0
                }))
                .unwrap_or(false);

            let local_id = uuid::Uuid::new_v4().to_string();
            let extracted = json!({
                "direction": "inbound",
                "to_address": null,
                "body_text": null,
                "body_html": null,
                "message_id": detail["payload"]["headers"].as_array()
                    .and_then(|h| h.iter().find(|x| x["name"].as_str() == Some("Message-ID")))
                    .and_then(|x| x["value"].as_str()),
            });

            conn.execute(
                "INSERT OR IGNORE INTO mail_messages (id, user_id, account_id, provider_message_id, from_address, subject, snippet, received_at, has_attachments, extracted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                rusqlite::params![
                    local_id,
                    user_id,
                    account_id,
                    msg_id,
                    from_addr,
                    subject,
                    snippet,
                    date,
                    has_attachments as i32,
                    extracted.to_string(),
                ],
            ).map_err(|e| e.to_string())?;

            inserted += 1;
        }
    }

    // Update sync cursor and last_synced_at.
    let now = now_iso();
    if let Some(ref token) = next_page_token {
        conn.execute(
            "UPDATE mail_accounts SET sync_cursor = ?1, last_synced_at = ?2, status = 'active', last_error = NULL WHERE id = ?3",
            rusqlite::params![token, now, account_id],
        ).map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "UPDATE mail_accounts SET sync_cursor = NULL, last_synced_at = ?1, status = 'active', last_error = NULL WHERE id = ?2",
            rusqlite::params![now, account_id],
        ).map_err(|e| e.to_string())?;
    }

    let _ = app.emit("db:changed", json!({"table": "mail_messages", "op": "INSERT"}));
    let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "UPDATE"}));

    Ok(json!({
        "accountId": account_id,
        "messagesInserted": inserted,
        "messagesSkipped": skipped,
        "lastSyncedAt": now,
        "hasMore": next_page_token.is_some(),
    }))
}

// ---------------------------------------------------------------------------
// Deep-link callback handler (called from lib.rs when provider == "gmail")
// ---------------------------------------------------------------------------

/// Complete the Gmail OAuth flow: validate CSRF, exchange the code, persist the
/// refresh token in Keychain, and create the mail_accounts row.
pub fn complete_oauth(app: &AppHandle, state: &GmailState, db: &DbState, cb: &oauth::OauthCallback) {
    let Some(pending) = state.pending.lock().unwrap().take() else {
        return; // no gmail flow in progress
    };
    if cb.state.as_deref() != Some(pending.csrf_state.as_str()) {
        emit_gmail_status(app, false, Some("OAuth state mismatch — please retry"));
        return;
    }
    if let Some(err) = &cb.error {
        emit_gmail_status(app, false, Some(err));
        return;
    }
    let Some(code) = &cb.code else {
        emit_gmail_status(app, false, Some("No authorization code in redirect"));
        return;
    };

    match exchange_code(code, &pending.verifier) {
        Ok((access_token, refresh_token)) => {
            // Fetch the user's email address from Gmail profile.
            let email = match gmail_get(&access_token, "/profile") {
                Ok(profile) => profile["emailAddress"]
                    .as_str()
                    .unwrap_or("unknown@gmail.com")
                    .to_string(),
                Err(_) => "unknown@gmail.com".to_string(),
            };

            let account_id = format!("gmail:{}", email);

            // Store refresh token in Keychain.
            if let Err(e) = crate::secrets::set_gmail_refresh_token(&account_id, &refresh_token) {
                emit_gmail_status(app, false, Some(&format!("Failed to store token: {e}")));
                return;
            }

            // Create the mail_accounts row.
            let conn = db.conn.lock().unwrap();
            let now = now_iso();
            let res = conn.execute(
                "INSERT OR REPLACE INTO mail_accounts (id, user_id, provider, email_address, status, last_synced_at, created_at)
                 VALUES (?1, ?2, 'gmail', ?3, 'active', NULL, ?4)",
                rusqlite::params![account_id, pending.user_id, email, now],
            );

            if let Err(e) = res {
                emit_gmail_status(app, false, Some(&format!("Failed to create account: {e}")));
                return;
            }

            let _ = app.emit("db:changed", json!({"table": "mail_accounts", "op": "INSERT"}));
            emit_gmail_status(app, true, None);
        }
        Err(e) => emit_gmail_status(app, false, Some(&e)),
    }
}

fn emit_gmail_status(app: &AppHandle, connected: bool, error: Option<&str>) {
    let _ = app.emit(
        "gmail:status",
        json!({ "connected": connected, "error": error }),
    );
}
