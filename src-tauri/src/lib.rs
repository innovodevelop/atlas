use std::fs;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::Manager;

mod secrets;
mod snaptrade;
mod portfolio_db;
mod portfolio;
mod oauth;
mod music;
mod music_engine;
mod db;
mod datafetch;

const BUNDLE_ID: &str = "com.magnuspilegaard.atlas";

// ---------------------------------------------------------------------------
// Voice gateway sidecar (WS-B): a compiled Bun server running the duplex
// voice loop on 127.0.0.1. Spawned per app launch with a random session
// token; the webview fetches {port, token} via voice_gateway_info and must
// present the token in its WS hello — no other local process can connect.

const VOICE_GATEWAY_PORT: u16 = 4820;

struct VoiceGateway {
    child: Mutex<Option<Child>>,
    token: String,
}

fn spawn_voice_gateway(token: &str) -> Option<Child> {
    // externalBin lands next to the app executable (Contents/MacOS/).
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bin = dir.join("atlas-voice-gateway");
    if !bin.exists() {
        eprintln!(
            "[atlas] voice gateway binary not found ({}) — dev mode? run `bun run dev` in services/voice-gateway",
            bin.display()
        );
        return None;
    }
    let mut cmd = Command::new(&bin);
    cmd.env("SIDECAR_TOKEN", token)
        .env("VOICE_GATEWAY_PORT", VOICE_GATEWAY_PORT.to_string())
        // Voice delegates chat turns to the brain sidecar (same token).
        .env("ATLAS_BRAIN_PORT", ATLAS_BRAIN_PORT.to_string());
    // ElevenLabs key from the Keychain: voice runs directly against ElevenLabs
    // (TTS + scribe-token). Never in env files or git.
    if let Some(k) = secrets::core_key("elevenlabs_api_key") {
        cmd.env("ELEVENLABS_API_KEY", k);
    }
    match cmd.spawn() {
        Ok(child) => {
            eprintln!("[atlas] voice gateway spawned (pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[atlas] voice gateway spawn failed: {e}");
            None
        }
    }
}

#[tauri::command]
fn voice_gateway_info(state: tauri::State<VoiceGateway>) -> serde_json::Value {
    let running = state.child.lock().ok().map(|g| g.is_some()).unwrap_or(false);
    serde_json::json!({
        "port": VOICE_GATEWAY_PORT,
        "token": state.token,
        "running": running,
    })
}

// ---------------------------------------------------------------------------
// Brain sidecar (Supabase migration, Phase 2): a compiled Bun HTTP server that
// runs the chat/AI orchestrator locally (replacing the chat + chat-with-memory
// edge functions). Same trust model as the voice gateway — 127.0.0.1 only,
// guarded by the shared SIDECAR_TOKEN. AI keys come from the Keychain.

const ATLAS_BRAIN_PORT: u16 = 4830;

struct AtlasBrain {
    child: Mutex<Option<Child>>,
    token: String,
}

fn spawn_atlas_brain(token: &str) -> Option<Child> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bin = dir.join("atlas-brain");
    if !bin.exists() {
        eprintln!(
            "[atlas] brain sidecar binary not found ({}) — dev mode? run `bun run dev` in services/atlas-brain",
            bin.display()
        );
        return None;
    }
    let mut cmd = Command::new(&bin);
    cmd.env("SIDECAR_TOKEN", token)
        .env("ATLAS_BRAIN_PORT", ATLAS_BRAIN_PORT.to_string());
    // AI keys from the Keychain (never in env files / git).
    if let Some(k) = secrets::core_key("gemini_api_key") { cmd.env("GEMINI_API_KEY", k); }
    if let Some(k) = secrets::core_key("perplexity_api_key") { cmd.env("PERPLEXITY_API_KEY", k); }
    match cmd.spawn() {
        Ok(child) => {
            eprintln!("[atlas] brain sidecar spawned (pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[atlas] brain sidecar spawn failed: {e}");
            None
        }
    }
}

#[tauri::command]
fn atlas_brain_info(state: tauri::State<AtlasBrain>) -> serde_json::Value {
    let running = state.child.lock().ok().map(|g| g.is_some()).unwrap_or(false);
    serde_json::json!({
        "port": ATLAS_BRAIN_PORT,
        "token": state.token,
        "running": running,
    })
}

/// Map a provider slug to its Keychain account (service `atlas-core`). Covers
/// the AI keys (brain sidecar) and the external-provider keys the local
/// data-fetch / voice paths need (Supabase-removal Phase 5).
fn core_account(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "gemini" => "gemini_api_key",
        "perplexity" => "perplexity_api_key",
        "openweather" => "openweather_api_key",
        "finnhub" => "finnhub_api_key",
        "news" => "news_api_key",
        "elevenlabs" => "elevenlabs_api_key",
        _ => return None,
    })
}

/// Store a provider key in the Keychain (atlas-core). Takes effect on the next
/// app launch (sidecars/commands read keys at spawn/call). Empty value clears it.
#[tauri::command]
fn brain_set_ai_key(provider: String, key: String) -> Result<(), String> {
    let account = core_account(&provider).ok_or_else(|| format!("unknown provider: {provider}"))?;
    if key.trim().is_empty() {
        return secrets::clear_core_key(account);
    }
    secrets::set_core_key(account, key.trim())
}

/// Which provider keys are present in the Keychain (never returns the values).
#[tauri::command]
fn brain_ai_status() -> serde_json::Value {
    let present = |a: &str| secrets::core_key(a).is_some();
    serde_json::json!({
        "gemini": present("gemini_api_key"),
        "perplexity": present("perplexity_api_key"),
        "openweather": present("openweather_api_key"),
        "finnhub": present("finnhub_api_key"),
        "news": present("news_api_key"),
        "elevenlabs": present("elevenlabs_api_key"),
    })
}
const CACHE_PURGE_THRESHOLD_BYTES: u64 = 200 * 1024 * 1024; // 200 MB

fn dir_size(path: &Path) -> u64 {
    let mut size = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    size += dir_size(&entry.path());
                } else {
                    size += meta.len();
                }
            }
        }
    }
    size
}

fn webkit_cache_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(Path::new(&home).join(format!("Library/Caches/{}/WebKit", BUNDLE_ID)))
}

// After an app UPDATE, WKWebView can keep serving the previous build's cached
// JS/CSS bundle (making the new UI look like the old one — missing dock, stale
// visuals). Detect updates by stamping the running binary's mtime; when it
// changes, purge the whole WebKit HTTP/code cache so the fresh embedded assets
// load. localStorage/auth (WebsiteData, a separate dir) is untouched.
fn purge_webview_cache_on_update() {
    let Some(cache) = webkit_cache_dir() else { return };
    let Some(marker_parent) = cache.parent().map(|p| p.to_path_buf()) else { return };
    let marker = marker_parent.join(".atlas-build-stamp");

    let current = std::env::current_exe().ok()
        .and_then(|p| fs::metadata(&p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs().to_string())
        .unwrap_or_default();
    let previous = fs::read_to_string(&marker).unwrap_or_default();

    if current != previous && !current.is_empty() {
        if cache.is_dir() {
            match fs::remove_dir_all(&cache) {
                Ok(()) => eprintln!("[atlas] app updated — purged WebKit cache so fresh assets load"),
                Err(e) => eprintln!("[atlas] cache purge (update) failed: {e}"),
            }
        }
        let _ = fs::create_dir_all(&marker_parent);
        let _ = fs::write(&marker, &current);
    } else {
        // Not an update: still trim the network cache if it grew unbounded
        // (the original 5GB-Networking-process fix).
        for sub in ["NetworkCache", "MediaCache"] {
            let dir = cache.join(sub);
            if dir.is_dir() && dir_size(&dir) > CACHE_PURGE_THRESHOLD_BYTES {
                let _ = fs::remove_dir_all(&dir);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  purge_webview_cache_on_update();

  let gateway_token = uuid::Uuid::new_v4().to_string();
  // Both sidecars share one per-launch token (127.0.0.1-only, token-gated).
  let brain = AtlasBrain {
    child: Mutex::new(spawn_atlas_brain(&gateway_token)),
    token: gateway_token.clone(),
  };
  let gateway = VoiceGateway {
    child: Mutex::new(spawn_voice_gateway(&gateway_token)),
    token: gateway_token,
  };

  tauri::Builder::default()
    // Mail alerts -> macOS notifications; opener launches the OAuth consent
    // in the system browser (where the user's Google session lives).
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_opener::init())
    // Native OAuth redirect capture (RFC 8252): the OS routes atlas://oauth/…
    // back into this process; we parse it and hand the code to the webview.
    .plugin(tauri_plugin_deep_link::init())
    .manage(gateway)
    .manage(brain)
    .manage(music::MusicState::new())
    .invoke_handler(tauri::generate_handler![
      voice_gateway_info,
      atlas_brain_info,
      brain_set_ai_key,
      brain_ai_status,
      portfolio::portfolio_status,
      portfolio::portfolio_connect_url,
      portfolio::portfolio_sync,
      portfolio::portfolio_summary,
      portfolio::portfolio_holdings,
      portfolio::portfolio_history,
      portfolio::portfolio_allocation,
      portfolio::portfolio_disconnect,
      music::music_status,
      music::music_connect,
      music::music_disconnect,
      music::music_search,
      music::music_library_tracks,
      music::music_playlists,
      music::music_playlist_tracks,
      music::music_now_playing,
      music::music_play,
      music::music_pause,
      music::music_next,
      music::music_prev,
      music::music_seek,
      music::music_load,
      music::music_volume,
      db::db_info,
      db::db_select,
      db::db_insert,
      db::db_update,
      db::db_delete,
      db::memory_recall,
      db::memory_upsert_vector,
      datafetch::fetch_weather,
      datafetch::fetch_stocks,
      datafetch::fetch_news,
    ])
    .setup(|app| {
      // Local app database (Supabase migration). Open once at startup under the
      // app-data dir; register the WAL connection for all db commands.
      {
        let dir = app.path().app_data_dir()?;
        std::fs::create_dir_all(&dir)?;
        let db_path = dir.join("atlas.db");
        app.manage(db::DbState::open(&db_path)?);
        log::info!("[db] local SQLite opened at {}", db_path.display());
      }

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Deep-link OAuth capture. In dev the scheme isn't in the app bundle's
      // Info.plist, so register it at runtime; packaged macOS builds get it
      // from tauri.conf.json's plugins.deep-link config.
      {
        use tauri::Emitter;
        use tauri_plugin_deep_link::DeepLinkExt;

        #[cfg(debug_assertions)]
        let _ = app.deep_link().register_all();

        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
          for u in event.urls() {
            if let Some(cb) = oauth::parse_callback(u.as_str()) {
              log::info!("[oauth] captured redirect (has_code={})", cb.code.is_some());
              // Exchange the code in Rust so it never enters the webview; the
              // provider owner (music.rs) validates CSRF state and emits its own
              // status event. Dispatch to each provider that could be in flight.
              if let Some(state) = handle.try_state::<music::MusicState>() {
                music::complete_oauth(&handle, state.inner(), &cb);
              }
              // Sanitized signal for the generic seam (src/lib/deepLinkOauth.ts):
              // no auth code crosses the boundary.
              let _ = handle.emit(
                "oauth-callback",
                serde_json::json!({
                  "provider": cb.provider,
                  "state": cb.state,
                  "error": cb.error,
                }),
              );
            }
          }
        });
      }

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      // Kill the sidecars when the app exits — never leave orphans.
      if let tauri::RunEvent::Exit = event {
        if let Some(gw) = app_handle.try_state::<VoiceGateway>() {
          if let Ok(mut guard) = gw.child.lock() {
            if let Some(mut child) = guard.take() {
              let _ = child.kill();
              let _ = child.wait();
              eprintln!("[atlas] voice gateway stopped");
            }
          }
        }
        if let Some(br) = app_handle.try_state::<AtlasBrain>() {
          if let Ok(mut guard) = br.child.lock() {
            if let Some(mut child) = guard.take() {
              let _ = child.kill();
              let _ = child.wait();
              eprintln!("[atlas] brain sidecar stopped");
            }
          }
        }
      }
    });
}
