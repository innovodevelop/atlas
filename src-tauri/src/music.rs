// Music player backend (Spotify first; provider-neutral command names).
//
// Split of responsibilities (see docs/decisions/006-music-librespot.md +
// 007-oauth-deep-link.md):
//   • OAuth  — Authorization Code + PKCE, redirect captured via the atlas://
//     deep link (oauth.rs). The auth code is exchanged HERE, in Rust; only a
//     long-lived refresh token is persisted (macOS Keychain, service
//     "atlas-music"). No client secret is used or stored — PKCE public client.
//   • Catalog/library/search/state — Spotify Web API over ureq (this file).
//   • Audio output — librespot, added in the next increment. Transport commands
//     currently return AUDIO_PENDING; everything they need (tokens, state) is
//     already in place, so wiring the engine is additive.
//
// The Spotify Client ID is public-safe (it ships in every native client and
// appears in the authorize URL), so it's a constant. The client SECRET is
// deliberately absent.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::oauth;
use crate::secrets;

const PROVIDER: &str = "spotify";
const CLIENT_ID: &str = "29af1118819f4086a68dfc21b2359625"; // public-safe
const AUTH_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const API: &str = "https://api.spotify.com/v1";
const SCOPES: &str = "streaming user-read-playback-state user-modify-playback-state \
user-read-currently-playing user-library-read playlist-read-private \
playlist-read-collaborative user-read-email user-read-private";

/// Placeholder returned by transport commands until the librespot audio engine
/// lands. The catalog/OAuth half is fully live; only sound output is pending.
const AUDIO_PENDING: &str =
    "Atlas audio playback is not wired yet — the librespot engine is the next step.";

// ---------------------------------------------------------------------------
// State

pub struct MusicState {
    /// In-flight PKCE flow (verifier + CSRF state), set by `music_connect` and
    /// consumed when the deep-link redirect arrives.
    pending: Mutex<Option<PendingAuth>>,
    /// Cached bearer token; refreshed from the Keychain refresh token on expiry.
    access: Mutex<Option<AccessToken>>,
}

struct PendingAuth {
    verifier: String,
    state: String,
}

#[derive(Clone)]
struct AccessToken {
    token: String,
    /// Unix seconds; refreshed slightly before the real expiry.
    expires_at: u64,
}

impl MusicState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(None),
            access: Mutex::new(None),
        }
    }
}

// ---------------------------------------------------------------------------
// Small helpers

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// application/x-www-form-urlencoded (also valid for query strings; space -> +).
fn enc(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// The Spotify consent URL for a given PKCE challenge + CSRF state. Factored out
/// so it can be unit-tested without a running app.
fn build_authorize_url(challenge: &str, state: &str) -> String {
    format!(
        "{AUTH_URL}?{}",
        form(&[
            ("client_id", CLIENT_ID),
            ("response_type", "code"),
            ("redirect_uri", oauth::REDIRECT_URI),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge),
            ("state", state),
            ("scope", SCOPES),
        ])
    )
}

// ---------------------------------------------------------------------------
// Token management

/// Exchange the one-time auth code for tokens; returns the refresh token.
fn exchange_code(code: &str, verifier: &str) -> Result<String, String> {
    let body = form(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", oauth::REDIRECT_URI),
        ("client_id", CLIENT_ID),
        ("code_verifier", verifier),
    ]);
    let v = post_token(&body)?;
    v["refresh_token"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "Spotify did not return a refresh token".to_string())
}

/// Swap the stored refresh token for a fresh access token (PKCE refresh — no
/// client secret). Spotify may rotate the refresh token; persist it if so.
fn refresh_access_token() -> Result<AccessToken, String> {
    let refresh = secrets::music_refresh_token().ok_or("Spotify not connected")?;
    let body = form(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", &refresh),
        ("client_id", CLIENT_ID),
    ]);
    let v = post_token(&body)?;
    if let Some(rotated) = v["refresh_token"].as_str() {
        let _ = secrets::set_music_refresh_token(rotated);
    }
    let token = v["access_token"]
        .as_str()
        .ok_or("no access_token in refresh response")?
        .to_string();
    let ttl = v["expires_in"].as_u64().unwrap_or(3600);
    Ok(AccessToken {
        token,
        expires_at: now() + ttl.saturating_sub(60),
    })
}

fn post_token(body: &str) -> Result<Value, String> {
    match ureq::post(TOKEN_URL)
        .set("Content-Type", "application/x-www-form-urlencoded")
        .send_string(body)
    {
        Ok(r) => r.into_json().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => Err(format!(
            "Spotify token endpoint {code}: {}",
            r.into_string().unwrap_or_default()
        )),
        Err(e) => Err(e.to_string()),
    }
}

/// A valid bearer token, refreshing through the Keychain if the cache is stale.
fn valid_token(state: &MusicState) -> Result<String, String> {
    if let Some(a) = state.access.lock().unwrap().as_ref() {
        if a.expires_at > now() {
            return Ok(a.token.clone());
        }
    }
    let fresh = refresh_access_token()?;
    let token = fresh.token.clone();
    *state.access.lock().unwrap() = Some(fresh);
    Ok(token)
}

// ---------------------------------------------------------------------------
// Spotify Web API

fn api_get(token: &str, path_and_query: &str) -> Result<Value, String> {
    match ureq::get(&format!("{API}{path_and_query}"))
        .set("Authorization", &format!("Bearer {token}"))
        .call()
    {
        Ok(r) => {
            // /me/player returns 204 (no content) when nothing is active.
            if r.status() == 204 {
                return Ok(Value::Null);
            }
            r.into_json().map_err(|e| e.to_string())
        }
        Err(ureq::Error::Status(code, r)) => Err(format!(
            "Spotify API {code}: {}",
            r.into_string().unwrap_or_default()
        )),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Commands — connection

#[derive(Serialize)]
pub struct MusicStatus {
    /// Always true in the desktop backend; the hook gates on isTauri.
    available: bool,
    provider: &'static str,
    /// A refresh token exists in the Keychain.
    connected: bool,
    /// Account has Spotify Premium (required for streaming). Only checked when
    /// connected.
    premium: bool,
    /// The librespot playback device is up (audio can come out of Atlas).
    audio_ready: bool,
    device_name: &'static str,
}

#[tauri::command]
pub fn music_status(state: State<'_, MusicState>) -> MusicStatus {
    let connected = secrets::music_refresh_token().is_some();
    let premium = connected
        && valid_token(&state)
            .and_then(|t| api_get(&t, "/me"))
            .ok()
            .and_then(|v| v["product"].as_str().map(|p| p == "premium"))
            .unwrap_or(false);
    MusicStatus {
        available: true,
        provider: PROVIDER,
        connected,
        premium,
        audio_ready: false, // set true once librespot is connected
        device_name: "Atlas",
    }
}

/// Begin the OAuth flow: stash a fresh PKCE pair + CSRF state and return the
/// Spotify consent URL for the webview to open in the system browser. The
/// redirect comes back through the atlas:// deep link into `complete_oauth`.
#[tauri::command]
pub fn music_connect(state: State<'_, MusicState>) -> Result<String, String> {
    let (verifier, challenge) = oauth::generate_pkce();
    let csrf = uuid::Uuid::new_v4().simple().to_string();
    let url = build_authorize_url(&challenge, &csrf);
    *state.pending.lock().unwrap() = Some(PendingAuth {
        verifier,
        state: csrf,
    });
    Ok(url)
}

#[tauri::command]
pub fn music_disconnect(state: State<'_, MusicState>) -> Result<(), String> {
    secrets::clear_music_refresh_token()?;
    *state.access.lock().unwrap() = None;
    *state.pending.lock().unwrap() = None;
    Ok(())
}

/// Completes the OAuth flow from the deep-link handler (lib.rs). Validates the
/// CSRF state, exchanges the code in Rust, persists the refresh token, and
/// emits `music:status` so the UI updates. The auth code never reaches the JS
/// layer.
pub fn complete_oauth(app: &AppHandle, state: &MusicState, cb: &oauth::OauthCallback) {
    let Some(pending) = state.pending.lock().unwrap().take() else {
        return; // no flow in progress — not ours
    };
    if cb.state.as_deref() != Some(pending.state.as_str()) {
        emit_status(app, false, Some("OAuth state mismatch (possible CSRF) — please retry"));
        return;
    }
    if let Some(err) = &cb.error {
        emit_status(app, false, Some(err));
        return;
    }
    let Some(code) = &cb.code else {
        emit_status(app, false, Some("No authorization code in redirect"));
        return;
    };
    match exchange_code(code, &pending.verifier) {
        Ok(refresh) => {
            let _ = secrets::set_music_refresh_token(&refresh);
            *state.access.lock().unwrap() = None; // force a fresh token next call
            emit_status(app, true, None);
        }
        Err(e) => emit_status(app, false, Some(&e)),
    }
}

fn emit_status(app: &AppHandle, connected: bool, error: Option<&str>) {
    let _ = app.emit(
        "music:status",
        serde_json::json!({ "connected": connected, "error": error }),
    );
}

// ---------------------------------------------------------------------------
// Commands — catalog / library / search / state (live)
//
// These return Spotify's raw JSON; the webview models only the fields it uses
// (avoids mirroring Spotify's large schema in Rust).

#[tauri::command]
pub fn music_search(
    state: State<'_, MusicState>,
    query: String,
    limit: Option<u32>,
) -> Result<Value, String> {
    let token = valid_token(&state)?;
    let limit = limit.unwrap_or(20).min(50);
    api_get(
        &token,
        &format!(
            "/search?q={}&type=track,album,artist,playlist&limit={limit}",
            enc(&query)
        ),
    )
}

#[tauri::command]
pub fn music_library_tracks(
    state: State<'_, MusicState>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let token = valid_token(&state)?;
    let (o, l) = (offset.unwrap_or(0), limit.unwrap_or(50).min(50));
    api_get(&token, &format!("/me/tracks?offset={o}&limit={l}"))
}

#[tauri::command]
pub fn music_playlists(
    state: State<'_, MusicState>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let token = valid_token(&state)?;
    let (o, l) = (offset.unwrap_or(0), limit.unwrap_or(50).min(50));
    api_get(&token, &format!("/me/playlists?offset={o}&limit={l}"))
}

#[tauri::command]
pub fn music_playlist_tracks(
    state: State<'_, MusicState>,
    playlist_id: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let token = valid_token(&state)?;
    let (o, l) = (offset.unwrap_or(0), limit.unwrap_or(100).min(100));
    api_get(
        &token,
        &format!("/playlists/{}/tracks?offset={o}&limit={l}", enc(&playlist_id)),
    )
}

/// Current playback snapshot from Spotify (`/me/player`); `Null` when idle.
#[tauri::command]
pub fn music_now_playing(state: State<'_, MusicState>) -> Result<Value, String> {
    let token = valid_token(&state)?;
    api_get(&token, "/me/player")
}

// ---------------------------------------------------------------------------
// Commands — transport (audio engine pending: librespot next increment)
//
// Signatures are final so the hook + UI can be built against them now; each
// returns AUDIO_PENDING until the librespot device is wired in.

#[tauri::command]
pub fn music_play(_state: State<'_, MusicState>) -> Result<(), String> {
    Err(AUDIO_PENDING.into())
}

#[tauri::command]
pub fn music_pause(_state: State<'_, MusicState>) -> Result<(), String> {
    Err(AUDIO_PENDING.into())
}

#[tauri::command]
pub fn music_next(_state: State<'_, MusicState>) -> Result<(), String> {
    Err(AUDIO_PENDING.into())
}

#[tauri::command]
pub fn music_prev(_state: State<'_, MusicState>) -> Result<(), String> {
    Err(AUDIO_PENDING.into())
}

#[tauri::command]
pub fn music_seek(_state: State<'_, MusicState>, _position_ms: u32) -> Result<(), String> {
    Err(AUDIO_PENDING.into())
}

#[tauri::command]
pub fn music_load(_state: State<'_, MusicState>, _uri: String) -> Result<(), String> {
    Err(AUDIO_PENDING.into())
}

#[tauri::command]
pub fn music_volume(_state: State<'_, MusicState>, _volume: f32) -> Result<(), String> {
    Err(AUDIO_PENDING.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_url_is_well_formed() {
        let url = build_authorize_url("CHAL-123", "STATE-456");
        assert!(url.starts_with("https://accounts.spotify.com/authorize?"));
        assert!(url.contains("client_id=29af1118819f4086a68dfc21b2359625"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("code_challenge=CHAL-123"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=STATE-456"));
        // Deep-link redirect, url-encoded (atlas://oauth/callback).
        assert!(url.contains("redirect_uri=atlas%3A%2F%2Foauth%2Fcallback"));
        // Streaming + library scopes present (spaces encoded as '+').
        assert!(url.contains("scope=streaming"));
        assert!(url.contains("user-library-read"));
    }

    #[test]
    fn form_encodes_pairs() {
        assert_eq!(form(&[("a", "b c"), ("x", "y")]), "a=b+c&x=y");
    }
}
