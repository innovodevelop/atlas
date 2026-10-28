// Music player backend (Spotify first; provider-neutral command names).
//
// Split of responsibilities (see docs/decisions/006-music-librespot.md +
// 007-oauth-deep-link.md):
//   • OAuth  — Authorization Code + PKCE, redirect captured via the atlas://
//     deep link (oauth.rs). The auth code is exchanged HERE, in Rust; only a
//     long-lived refresh token is persisted (macOS Keychain, service
//     "atlas-music"). No client secret is used or stored — PKCE public client.
//   • Catalog/library/search/state — Spotify Web API over ureq (this file).
//   • Audio output — librespot (music_engine.rs), driven directly rather than
//     as a Spotify Connect device.
//   • Rooms — the user's OTHER Spotify Connect devices, through the Web API
//     player endpoints. Atlas's own engine is not among them (it is not a
//     Connect device), so the webview lists "This Mac" itself.
//   • Lyrics — LRCLIB (lrclib.net, no key), cached in SQLite so a track is
//     asked for once.
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

use crate::music_engine::{self, EngineCmd, EngineHandle};

/// Also the name this provider registers its OAuth states under (oauth::FlowRegistry).
pub const OAUTH_PROVIDER: &str = "spotify";
pub(crate) const CLIENT_ID: &str = "29af1118819f4086a68dfc21b2359625"; // public-safe
const AUTH_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const API: &str = "https://api.spotify.com/v1";
/// What Atlas asks Spotify for. `user-library-modify` (Like) and
/// `user-read-playback-position` (podcast resume points) were added in the
/// Beta: a grant made before that keeps working for everything else, and the
/// webview reads the grant's own scope list (`MusicStatus::scopes`) to offer a
/// reconnect only where a feature needs one the grant lacks.
const SCOPES: &str = "streaming user-read-playback-state user-modify-playback-state \
user-read-currently-playing user-library-read user-library-modify \
user-read-playback-position playlist-read-private playlist-read-collaborative \
user-read-email user-read-private";
/// LRCLIB's lookup. Open, keyless; it asks clients to name themselves.
const LRCLIB_GET: &str = "https://lrclib.net/api/get";
const LRCLIB_AGENT: &str = "Atlas (https://helloatlas.dk)";
/// How long "LRCLIB has no lyrics for this" is believed before asking again.
const LYRICS_MISS_TTL_SECS: u64 = 7 * 24 * 3600;

// ---------------------------------------------------------------------------
// State

pub struct MusicState {
    /// In-flight PKCE flow (verifier + CSRF state), set by `music_connect` and
    /// consumed when the deep-link redirect arrives.
    pending: Mutex<Option<PendingAuth>>,
    /// Cached bearer token; refreshed from the Keychain refresh token on expiry.
    access: Mutex<Option<AccessToken>>,
    /// The librespot audio engine, started lazily on first playback.
    engine: Mutex<Option<EngineHandle>>,
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
    /// The scopes the stored grant actually carries, as Spotify reported them
    /// on the last refresh. A grant made before a scope was added to `SCOPES`
    /// keeps its old list until the user reconnects.
    scope: Option<String>,
}

impl MusicState {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(None),
            access: Mutex::new(None),
            engine: Mutex::new(None),
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
        scope: v["scope"].as_str().map(str::to_string),
    })
}

fn post_token(body: &str) -> Result<Value, String> {
    match crate::http::agent().post(TOKEN_URL)
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
    match crate::http::agent().get(&format!("{API}{path_and_query}"))
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

/// A write to the Web API (PUT/DELETE/POST). The player and library endpoints
/// answer 200 with an empty body, 202 or 204, so an empty body is `Null`
/// rather than a parse error. A PUT with no JSON still sends an empty body:
/// Spotify refuses a bodiless PUT with 411.
fn api_send(token: &str, method: &str, path_and_query: &str, body: Option<&Value>) -> Result<Value, String> {
    let req = crate::http::agent()
        .request(method, &format!("{API}{path_and_query}"))
        .set("Authorization", &format!("Bearer {token}"));
    let res = match body {
        Some(b) => req.send_json(b.clone()),
        None => req.send_string(""),
    };
    match res {
        Ok(r) => {
            let text = r.into_string().map_err(|e| e.to_string())?;
            if text.trim().is_empty() {
                return Ok(Value::Null);
            }
            Ok(serde_json::from_str(&text).unwrap_or(Value::Null))
        }
        Err(ureq::Error::Status(code, r)) => Err(format!(
            "Spotify API {code}: {}",
            r.into_string().unwrap_or_default()
        )),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Input checks. Everything below reaches a URL, so ids are checked against the
// shapes Spotify issues instead of being trusted to `enc`.

/// A Spotify base-62 id (tracks, episodes, shows): 22 characters.
fn is_base62_id(s: &str) -> bool {
    s.len() == 22 && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// A Connect device id: Spotify issues 40 hex characters today; allow any
/// short alphanumeric token so a format change does not break Rooms.
fn is_device_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A track or an episode URI — the only things Atlas hands a speaker.
fn is_playable_uri(s: &str) -> bool {
    let mut parts = s.splitn(3, ':');
    matches!(
        (parts.next(), parts.next(), parts.next()),
        (Some("spotify"), Some("track" | "episode"), Some(id)) if is_base62_id(id)
    )
}

fn check_ids(ids: &[String], max: usize) -> Result<String, String> {
    if ids.is_empty() || ids.len() > max {
        return Err(format!("between 1 and {max} ids are needed"));
    }
    if let Some(bad) = ids.iter().find(|id| !is_base62_id(id)) {
        return Err(format!("not a Spotify id: {bad}"));
    }
    Ok(ids.join(","))
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
    /// The scopes the stored grant carries; `None` when not connected or when
    /// Spotify did not say. The webview offers a reconnect from this.
    scopes: Option<Vec<String>>,
}

#[tauri::command(async)]
pub fn music_status(state: State<'_, MusicState>) -> MusicStatus {
    let connected = secrets::music_refresh_token().is_some();
    let premium = connected
        && valid_token(&state)
            .and_then(|t| api_get(&t, "/me"))
            .ok()
            .and_then(|v| v["product"].as_str().map(|p| p == "premium"))
            .unwrap_or(false);
    let audio_ready = state.engine.lock().unwrap().is_some();
    let scopes = if connected {
        state
            .access
            .lock()
            .unwrap()
            .as_ref()
            .and_then(|a| a.scope.as_deref().map(split_scopes))
    } else {
        None
    };
    MusicStatus {
        available: true,
        provider: OAUTH_PROVIDER,
        connected,
        premium,
        audio_ready,
        device_name: "Atlas",
        scopes,
    }
}

fn split_scopes(s: &str) -> Vec<String> {
    s.split_whitespace().map(str::to_string).collect()
}

/// Lazily start the librespot audio engine (connects the Atlas playback device
/// on first play), returning a command sender. Idempotent.
fn ensure_engine(
    app: &AppHandle,
    state: &MusicState,
) -> Result<tokio::sync::mpsc::UnboundedSender<EngineCmd>, String> {
    if let Some(h) = state.engine.lock().unwrap().as_ref() {
        return Ok(h.tx.clone());
    }
    let token = valid_token(state)?;
    let handle = music_engine::spawn(app.clone(), token)?;
    let tx = handle.tx.clone();
    *state.engine.lock().unwrap() = Some(handle);
    let _ = app.emit(
        "music:status",
        serde_json::json!({ "connected": true, "audio_ready": true }),
    );
    Ok(tx)
}

fn send_cmd(app: &AppHandle, state: &MusicState, cmd: EngineCmd) -> Result<(), String> {
    ensure_engine(app, state)?
        .send(cmd)
        .map_err(|_| "audio engine is not running".to_string())
}

/// Begin the OAuth flow: stash a fresh PKCE pair + CSRF state and return the
/// Spotify consent URL for the webview to open in the system browser. The
/// redirect comes back through the atlas:// deep link into `complete_oauth`.
#[tauri::command(async)]
pub fn music_connect(
    state: State<'_, MusicState>,
    flows: State<'_, oauth::FlowRegistry>,
) -> Result<String, String> {
    let (verifier, challenge) = oauth::generate_pkce();
    let csrf = uuid::Uuid::new_v4().simple().to_string();
    let url = build_authorize_url(&challenge, &csrf);
    flows.issue(OAUTH_PROVIDER, &csrf);
    *state.pending.lock().unwrap() = Some(PendingAuth {
        verifier,
        state: csrf,
    });
    Ok(url)
}

#[tauri::command(async)]
pub fn music_disconnect(state: State<'_, MusicState>) -> Result<(), String> {
    if let Some(engine) = state.engine.lock().unwrap().take() {
        engine.shutdown();
    }
    secrets::clear_music_refresh_token()?;
    *state.access.lock().unwrap() = None;
    *state.pending.lock().unwrap() = None;
    Ok(())
}

/// Completes the OAuth flow from the deep-link handler (lib.rs). Validates the
/// CSRF state, exchanges the code in Rust, persists the refresh token, and
/// emits `music:status` so the UI updates. The auth code never reaches the JS
/// layer.
///
/// lib.rs only calls this for a state the flow registry says Spotify issued.
/// Failures of the flow in progress are reported, because the connect UI has
/// no timeout and would otherwise wait forever: a callback after
/// oauth::FLOW_TTL (`fresh` false), a denied consent, a failed code exchange.
/// A callback for a flow a newer Connect click replaced is ignored: the newer
/// flow is either still pending (its own result will end the wait) or already
/// done, and Spotify events carry no flow id, so an error here would land on
/// whichever attempt the UI is showing.
///
/// Failures go out as `music:oauth-error`, NOT `music:status {connected:false}`.
/// A failed or stale sign-in attempt says nothing about the connection the user
/// may already have: reporting it as a status flipped a working player to "Not
/// connected" and cleared the track on screen.
pub fn complete_oauth(app: &AppHandle, state: &MusicState, cb: &oauth::OauthCallback, fresh: bool) {
    let Some(pending) = oauth::take_matching(&state.pending, cb.state.as_deref(), |p| p.state.as_str())
    else {
        log::info!("[music] callback for a replaced Spotify sign-in — ignored");
        return;
    };
    if !fresh {
        emit_sign_in_error(app, "The Spotify sign-in took too long. Please connect again.");
        return;
    }
    if let Some(err) = &cb.error {
        emit_sign_in_error(app, err);
        return;
    }
    let Some(code) = &cb.code else {
        emit_sign_in_error(app, "No authorization code in redirect");
        return;
    };
    match exchange_code(code, &pending.verifier) {
        Ok(refresh) => {
            let _ = secrets::set_music_refresh_token(&refresh);
            *state.access.lock().unwrap() = None; // force a fresh token next call
            emit_status(app, true, None);
        }
        Err(e) => emit_sign_in_error(app, &e),
    }
}

fn emit_sign_in_error(app: &AppHandle, error: &str) {
    let _ = app.emit("music:oauth-error", serde_json::json!({ "error": error }));
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

#[tauri::command(async)]
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

#[tauri::command(async)]
pub fn music_library_tracks(
    state: State<'_, MusicState>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let token = valid_token(&state)?;
    let (o, l) = (offset.unwrap_or(0), limit.unwrap_or(50).min(50));
    api_get(&token, &format!("/me/tracks?offset={o}&limit={l}"))
}

#[tauri::command(async)]
pub fn music_playlists(
    state: State<'_, MusicState>,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<Value, String> {
    let token = valid_token(&state)?;
    let (o, l) = (offset.unwrap_or(0), limit.unwrap_or(50).min(50));
    api_get(&token, &format!("/me/playlists?offset={o}&limit={l}"))
}

#[tauri::command(async)]
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
#[tauri::command(async)]
pub fn music_now_playing(state: State<'_, MusicState>) -> Result<Value, String> {
    let token = valid_token(&state)?;
    api_get(&token, "/me/player")
}

// ---------------------------------------------------------------------------
// Commands — transport. Each ensures the librespot engine is running (connects
// the Atlas playback device on first use) then forwards the command.

/// Load a track or an episode into the engine and start it, at `position_ms`
/// when given (a podcast's resume point, a room handing playback back to this
/// Mac), else from the top.
#[tauri::command(async)]
pub fn music_load(
    app: AppHandle,
    state: State<'_, MusicState>,
    uri: String,
    position_ms: Option<u32>,
) -> Result<(), String> {
    send_cmd(&app, &state, EngineCmd::Load(uri, position_ms.unwrap_or(0)))
}

#[tauri::command(async)]
pub fn music_play(app: AppHandle, state: State<'_, MusicState>) -> Result<(), String> {
    send_cmd(&app, &state, EngineCmd::Play)
}

#[tauri::command(async)]
pub fn music_pause(app: AppHandle, state: State<'_, MusicState>) -> Result<(), String> {
    send_cmd(&app, &state, EngineCmd::Pause)
}

#[tauri::command(async)]
pub fn music_next(app: AppHandle, state: State<'_, MusicState>) -> Result<(), String> {
    send_cmd(&app, &state, EngineCmd::Next)
}

#[tauri::command(async)]
pub fn music_prev(app: AppHandle, state: State<'_, MusicState>) -> Result<(), String> {
    send_cmd(&app, &state, EngineCmd::Prev)
}

#[tauri::command(async)]
pub fn music_seek(
    app: AppHandle,
    state: State<'_, MusicState>,
    position_ms: u32,
) -> Result<(), String> {
    send_cmd(&app, &state, EngineCmd::Seek(position_ms))
}

#[tauri::command(async)]
pub fn music_volume(
    app: AppHandle,
    state: State<'_, MusicState>,
    volume: f32,
) -> Result<(), String> {
    send_cmd(&app, &state, EngineCmd::Volume(volume))
}

// ---------------------------------------------------------------------------
// Commands — Like (needs `user-library-modify`; the contains check only needs
// `user-library-read`, which every grant has).

/// Which of `ids` (up to 50 tracks) are in the user's Liked Songs, in order.
#[tauri::command(async)]
pub fn music_saved_contains(state: State<'_, MusicState>, ids: Vec<String>) -> Result<Value, String> {
    let list = check_ids(&ids, 50)?;
    let token = valid_token(&state)?;
    api_get(&token, &format!("/me/tracks/contains?ids={list}"))
}

/// Save (`save` true) or remove tracks from the user's Liked Songs.
#[tauri::command(async)]
pub fn music_save_tracks(state: State<'_, MusicState>, ids: Vec<String>, save: bool) -> Result<(), String> {
    let list = check_ids(&ids, 50)?;
    let token = valid_token(&state)?;
    let method = if save { "PUT" } else { "DELETE" };
    api_send(&token, method, &format!("/me/tracks?ids={list}"), None).map(|_| ())
}

// ---------------------------------------------------------------------------
// Commands — Rooms: the user's Spotify Connect devices. Reads need
// `user-read-playback-state`, writes `user-modify-playback-state`.

#[tauri::command(async)]
pub fn music_devices(state: State<'_, MusicState>) -> Result<Value, String> {
    let token = valid_token(&state)?;
    api_get(&token, "/me/player/devices")
}

/// Move the Connect session to `device_id`, playing when `play` is true.
#[tauri::command(async)]
pub fn music_transfer(state: State<'_, MusicState>, device_id: String, play: bool) -> Result<(), String> {
    if !is_device_id(&device_id) {
        return Err("not a Spotify device id".into());
    }
    let token = valid_token(&state)?;
    let body = serde_json::json!({ "device_ids": [device_id], "play": play });
    api_send(&token, "PUT", "/me/player", Some(&body)).map(|_| ())
}

/// Start `uris` on a Connect device at `position_ms` — how a record playing in
/// Atlas's own engine moves to a speaker (the engine is not a Connect device,
/// so there is no session to transfer from it).
#[tauri::command(async)]
pub fn music_play_on(
    state: State<'_, MusicState>,
    device_id: String,
    uris: Vec<String>,
    position_ms: Option<u32>,
) -> Result<(), String> {
    if !is_device_id(&device_id) {
        return Err("not a Spotify device id".into());
    }
    if uris.is_empty() || uris.len() > 100 {
        return Err("between 1 and 100 tracks are needed".into());
    }
    if let Some(bad) = uris.iter().find(|u| !is_playable_uri(u)) {
        return Err(format!("not a track or episode: {bad}"));
    }
    let token = valid_token(&state)?;
    let body = serde_json::json!({ "uris": uris, "position_ms": position_ms.unwrap_or(0) });
    api_send(&token, "PUT", &format!("/me/player/play?device_id={}", enc(&device_id)), Some(&body)).map(|_| ())
}

/// Pause the Connect session (the device that is playing, or `device_id`).
/// Used when a room hands playback back to this Mac, so two do not play.
#[tauri::command(async)]
pub fn music_remote_pause(state: State<'_, MusicState>, device_id: Option<String>) -> Result<(), String> {
    let path = match device_id {
        Some(id) if is_device_id(&id) => format!("/me/player/pause?device_id={}", enc(&id)),
        Some(_) => return Err("not a Spotify device id".into()),
        None => "/me/player/pause".to_string(),
    };
    let token = valid_token(&state)?;
    api_send(&token, "PUT", &path, None).map(|_| ())
}

#[tauri::command(async)]
pub fn music_device_volume(state: State<'_, MusicState>, device_id: String, percent: u8) -> Result<(), String> {
    if !is_device_id(&device_id) {
        return Err("not a Spotify device id".into());
    }
    let token = valid_token(&state)?;
    let p = percent.min(100);
    api_send(
        &token,
        "PUT",
        &format!("/me/player/volume?volume_percent={p}&device_id={}", enc(&device_id)),
        None,
    )
    .map(|_| ())
}

// ---------------------------------------------------------------------------
// Commands — podcasts. Saved shows need `user-library-read`; an episode's
// `resume_point` is only filled in with `user-read-playback-position`.

#[tauri::command(async)]
pub fn music_shows(state: State<'_, MusicState>, offset: Option<u32>, limit: Option<u32>) -> Result<Value, String> {
    let token = valid_token(&state)?;
    let (o, l) = (offset.unwrap_or(0), limit.unwrap_or(50).min(50));
    api_get(&token, &format!("/me/shows?offset={o}&limit={l}"))
}

#[tauri::command(async)]
pub fn music_show_episodes(
    state: State<'_, MusicState>,
    show_id: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<Value, String> {
    if !is_base62_id(&show_id) {
        return Err("not a Spotify show id".into());
    }
    let token = valid_token(&state)?;
    let (o, l) = (offset.unwrap_or(0), limit.unwrap_or(20).min(50));
    api_get(&token, &format!("/shows/{show_id}/episodes?offset={o}&limit={l}"))
}

/// Where Atlas itself stopped in an episode (or any record). Spotify's own
/// resume point only moves for Connect playback; Atlas drives librespot
/// directly, so it keeps its own, on this Mac, in `music_resume`.
#[tauri::command(async)]
pub fn music_resume_get(db: State<'_, crate::db::DbState>, ids: Vec<String>) -> Result<Value, String> {
    if ids.len() > 200 || ids.iter().any(|id| !is_base62_id(id)) {
        return Err("up to 200 Spotify ids are accepted".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT position_ms, duration_ms, updated_at FROM music_resume WHERE item_id = ?1")
        .map_err(|e| e.to_string())?;
    let mut out = serde_json::Map::new();
    for id in &ids {
        let row = stmt.query_row([id], |r| {
            Ok(serde_json::json!({
                "position_ms": r.get::<_, i64>(0)?,
                "duration_ms": r.get::<_, i64>(1)?,
                "updated_at": r.get::<_, String>(2)?,
            }))
        });
        if let Ok(v) = row {
            out.insert(id.clone(), v);
        }
    }
    Ok(Value::Object(out))
}

/// Record where Atlas is in `item_id`. `meta` is the webview's own record of
/// the episode (title, show, artwork) so Home can offer to resume it without
/// asking Spotify; it is stored as given, capped in size.
#[tauri::command(async)]
pub fn music_resume_set(
    db: State<'_, crate::db::DbState>,
    item_id: String,
    uri: String,
    position_ms: u32,
    duration_ms: u32,
    meta: Value,
) -> Result<(), String> {
    if !is_base62_id(&item_id) || !is_playable_uri(&uri) {
        return Err("not a Spotify track or episode".into());
    }
    let meta_text = meta.to_string();
    if meta_text.len() > 4096 {
        return Err("resume record too large".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO music_resume (item_id, uri, position_ms, duration_ms, meta, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(item_id) DO UPDATE SET uri = excluded.uri, position_ms = excluded.position_ms,
           duration_ms = excluded.duration_ms, meta = excluded.meta, updated_at = excluded.updated_at",
        rusqlite::params![item_id, uri, position_ms as i64, duration_ms as i64, meta_text],
    )
    .map_err(|e| e.to_string())?;
    // Keep the table small: it is a bookmark list, not a history.
    let _ = conn.execute(
        "DELETE FROM music_resume WHERE item_id NOT IN
           (SELECT item_id FROM music_resume ORDER BY updated_at DESC LIMIT 300)",
        [],
    );
    Ok(())
}

/// The records Atlas most recently kept a place in, newest first.
#[tauri::command(async)]
pub fn music_resume_recent(db: State<'_, crate::db::DbState>, limit: Option<u32>) -> Result<Value, String> {
    let n = limit.unwrap_or(5).clamp(1, 50) as i64;
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT item_id, uri, position_ms, duration_ms, meta, updated_at FROM music_resume
             ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([n], |r| {
            let meta: String = r.get(4)?;
            Ok(serde_json::json!({
                "item_id": r.get::<_, String>(0)?,
                "uri": r.get::<_, String>(1)?,
                "position_ms": r.get::<_, i64>(2)?,
                "duration_ms": r.get::<_, i64>(3)?,
                "meta": serde_json::from_str::<Value>(&meta).unwrap_or(Value::Null),
                "updated_at": r.get::<_, String>(5)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    Ok(Value::Array(rows.filter_map(Result::ok).collect()))
}

// ---------------------------------------------------------------------------
// Commands — lyrics, from LRCLIB.
//
// What leaves the Mac: the track's title, artist, album and length, to
// lrclib.net, once per track. The answer (or "none") is cached in SQLite, and
// a miss is believed for a week before LRCLIB is asked again.

#[derive(Serialize)]
pub struct Lyrics {
    found: bool,
    instrumental: bool,
    /// LRC text (`[mm:ss.xx] line`), when LRCLIB has timed lyrics.
    synced: Option<String>,
    plain: Option<String>,
    /// True when this came from the cache on this Mac, not from LRCLIB now.
    cached: bool,
}

/// The cache key: what LRCLIB matches on, lower-cased and trimmed.
fn lyrics_key(track: &str, artist: &str, album: &str, duration_s: u32) -> String {
    let norm = |s: &str| s.trim().to_lowercase();
    format!("{}\u{1f}{}\u{1f}{}\u{1f}{duration_s}", norm(artist), norm(track), norm(album))
}

fn lrclib_url(track: &str, artist: &str, album: &str, duration_s: u32) -> String {
    format!(
        "{LRCLIB_GET}?{}",
        form(&[
            ("track_name", track),
            ("artist_name", artist),
            ("album_name", album),
            ("duration", &duration_s.to_string()),
        ])
    )
}

fn non_empty(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

#[tauri::command(async)]
pub fn music_lyrics(
    db: State<'_, crate::db::DbState>,
    track: String,
    artist: String,
    album: String,
    duration_s: u32,
) -> Result<Lyrics, String> {
    let (track, artist, album) = (track.trim().to_string(), artist.trim().to_string(), album.trim().to_string());
    if track.is_empty() || artist.is_empty() || track.len() > 300 || artist.len() > 300 || album.len() > 300 {
        return Err("a title and an artist are needed".into());
    }
    if duration_s == 0 || duration_s > 4 * 3600 {
        return Err("the track length is out of range".into());
    }
    let key = lyrics_key(&track, &artist, &album, duration_s);

    // The cache first. The lock is released before any network call.
    {
        let conn = db.conn.lock().map_err(|e| e.to_string())?;
        let hit = conn.query_row(
            "SELECT found, instrumental, synced, plain,
                    CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', fetched_at) AS INTEGER)
             FROM music_lyrics_cache WHERE cache_key = ?1",
            [&key],
            |r| {
                Ok((
                    r.get::<_, i64>(0)? != 0,
                    r.get::<_, i64>(1)? != 0,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            },
        );
        if let Ok((found, instrumental, synced, plain, age)) = hit {
            if found || instrumental || (age >= 0 && (age as u64) < LYRICS_MISS_TTL_SECS) {
                return Ok(Lyrics { found, instrumental, synced, plain, cached: true });
            }
        }
    }

    let res = crate::http::agent()
        .get(&lrclib_url(&track, &artist, &album, duration_s))
        .set("User-Agent", LRCLIB_AGENT)
        .call();
    let lyrics = match res {
        Ok(r) => {
            let v: Value = r.into_json().map_err(|e| e.to_string())?;
            let synced = non_empty(&v["syncedLyrics"]);
            let plain = non_empty(&v["plainLyrics"]);
            let instrumental = v["instrumental"].as_bool().unwrap_or(false);
            Lyrics { found: synced.is_some() || plain.is_some(), instrumental, synced, plain, cached: false }
        }
        Err(ureq::Error::Status(404, _)) => {
            Lyrics { found: false, instrumental: false, synced: None, plain: None, cached: false }
        }
        Err(ureq::Error::Status(code, _)) => return Err(format!("LRCLIB answered {code}")),
        Err(e) => return Err(format!("LRCLIB could not be reached: {e}")),
    };

    if let Ok(conn) = db.conn.lock() {
        let _ = conn.execute(
            "INSERT INTO music_lyrics_cache (cache_key, found, instrumental, synced, plain, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
             ON CONFLICT(cache_key) DO UPDATE SET found = excluded.found, instrumental = excluded.instrumental,
               synced = excluded.synced, plain = excluded.plain, fetched_at = excluded.fetched_at",
            rusqlite::params![key, lyrics.found as i64, lyrics.instrumental as i64, lyrics.synced, lyrics.plain],
        );
    }
    Ok(lyrics)
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
        // Like and podcast resume points.
        assert!(url.contains("user-library-modify"));
        assert!(url.contains("user-read-playback-position"));
    }

    #[test]
    fn ids_and_uris_are_checked_before_they_reach_a_url() {
        assert!(is_base62_id("4uLU6hMCjMI75M1A2tKUQC"));
        assert!(!is_base62_id("4uLU6hMCjMI75M1A2tKUQ"));
        assert!(!is_base62_id("4uLU6hMCjMI75M1A2tKU/C"));
        assert!(is_playable_uri("spotify:track:4uLU6hMCjMI75M1A2tKUQC"));
        assert!(is_playable_uri("spotify:episode:4uLU6hMCjMI75M1A2tKUQC"));
        assert!(!is_playable_uri("spotify:playlist:4uLU6hMCjMI75M1A2tKUQC"));
        assert!(!is_playable_uri("spotify:track:4uLU6hMCjMI75M1A2tKUQC:x"));
        assert!(is_device_id("0d1841b0976bae2a3a310dd74c0f3df354899bc8"));
        assert!(!is_device_id(""));
        assert!(!is_device_id("abc&volume_percent=100"));
        assert!(check_ids(&[], 50).is_err());
        assert_eq!(
            check_ids(&["4uLU6hMCjMI75M1A2tKUQC".into(), "7ouMYWpwJ422jRcDASZB7P".into()], 50).unwrap(),
            "4uLU6hMCjMI75M1A2tKUQC,7ouMYWpwJ422jRcDASZB7P"
        );
        assert!(check_ids(&["nope".into()], 50).is_err());
    }

    #[test]
    fn lyrics_lookup_is_keyed_and_encoded() {
        assert_eq!(
            lyrics_key(" Xtal ", "Aphex Twin", "Selected Ambient Works", 291),
            lyrics_key("xtal", "aphex twin ", "selected ambient works", 291)
        );
        assert_ne!(lyrics_key("Xtal", "Aphex Twin", "A", 291), lyrics_key("Xtal", "Aphex Twin", "A", 292));
        let url = lrclib_url("Tidligt Op", "Gilli", "Single", 214);
        assert!(url.starts_with("https://lrclib.net/api/get?"));
        assert!(url.contains("track_name=Tidligt+Op"));
        assert!(url.contains("artist_name=Gilli"));
        assert!(url.contains("duration=214"));
    }

    #[test]
    fn scopes_split_on_whitespace() {
        assert_eq!(
            split_scopes("streaming  user-library-read\nuser-library-modify"),
            vec!["streaming", "user-library-read", "user-library-modify"]
        );
    }

    #[test]
    fn form_encodes_pairs() {
        assert_eq!(form(&[("a", "b c"), ("x", "y")]), "a=b+c&x=y");
    }
}
