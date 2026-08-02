use std::fs;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::Manager;

mod http;
mod secrets;
mod snaptrade;
mod portfolio_db;
mod portfolio;
mod oauth;
mod music;
mod music_engine;
mod db;
mod datafetch;
mod mail;
mod scheduler;
mod integrity;

/// Outcome of a sidecar spawn attempt. `integrity_error` is set when the
/// binary failed integrity verification (and was therefore NOT spawned) — it
/// is surfaced to the webview via the `*_info` commands so the UI can tell the
/// user why voice/chat is unavailable instead of failing silently.
struct SidecarSpawn {
    child: Option<Child>,
    integrity_error: Option<String>,
}

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
    /// Set when the bundled binary failed integrity verification (not spawned).
    /// Mutex because the spawn now happens on a background thread AFTER the
    /// window is up, so this is filled in later (see `run`).
    integrity_error: Mutex<Option<String>>,
}

fn spawn_voice_gateway(token: &str) -> SidecarSpawn {
    let none = SidecarSpawn { child: None, integrity_error: None };
    // externalBin lands next to the app executable (Contents/MacOS/).
    let Some(exe) = std::env::current_exe().ok() else { return none };
    let Some(dir) = exe.parent() else { return none };
    let bin = dir.join("atlas-voice-gateway");
    if !bin.exists() {
        eprintln!(
            "[atlas] voice gateway binary not found ({}) — dev mode? run `bun run dev` in services/voice-gateway",
            bin.display()
        );
        return none;
    }
    // NEVER exec an unverified sidecar: check it against the SHA-256 manifest
    // baked into this binary at compile time (see integrity.rs for the policy).
    match integrity::gate("atlas-voice-gateway", &bin) {
        integrity::SpawnDecision::Allow => {}
        integrity::SpawnDecision::AllowUnverifiedDev(warn) => {
            eprintln!("[atlas] WARNING: {warn}");
        }
        integrity::SpawnDecision::Refuse(reason) => {
            eprintln!("[atlas] SECURITY: {reason}");
            return SidecarSpawn { child: None, integrity_error: Some(reason) };
        }
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
            SidecarSpawn { child: Some(child), integrity_error: None }
        }
        Err(e) => {
            eprintln!("[atlas] voice gateway spawn failed: {e}");
            SidecarSpawn { child: None, integrity_error: None }
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
        "integrity_error": state.integrity_error.lock().ok().and_then(|g| g.clone()),
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
    /// Set when the bundled binary failed integrity verification (not spawned).
    /// Mutex: filled in by the background spawn thread (see `run`).
    integrity_error: Mutex<Option<String>>,
}

fn spawn_atlas_brain(token: &str) -> SidecarSpawn {
    let none = SidecarSpawn { child: None, integrity_error: None };
    let Some(exe) = std::env::current_exe().ok() else { return none };
    let Some(dir) = exe.parent() else { return none };
    let bin = dir.join("atlas-brain");
    if !bin.exists() {
        eprintln!(
            "[atlas] brain sidecar binary not found ({}) — dev mode? run `bun run dev` in services/atlas-brain",
            bin.display()
        );
        return none;
    }
    // NEVER exec an unverified sidecar (see integrity.rs). The brain gets the
    // Keychain-injected Anthropic key — running a swapped binary here would
    // hand that key to the attacker.
    match integrity::gate("atlas-brain", &bin) {
        integrity::SpawnDecision::Allow => {}
        integrity::SpawnDecision::AllowUnverifiedDev(warn) => {
            eprintln!("[atlas] WARNING: {warn}");
        }
        integrity::SpawnDecision::Refuse(reason) => {
            eprintln!("[atlas] SECURITY: {reason}");
            return SidecarSpawn { child: None, integrity_error: Some(reason) };
        }
    }
    let mut cmd = Command::new(&bin);
    cmd.env("SIDECAR_TOKEN", token)
        .env("ATLAS_BRAIN_PORT", ATLAS_BRAIN_PORT.to_string());
    // AI key from the Keychain (never in env files / git). Anthropic is the
    // only chat provider on the app path — the Gemini key is deliberately NOT
    // injected: a silent fallback would send prompts (which embed the user's
    // stored memories) to a processor the privacy policy does not disclose.
    if let Some(k) = secrets::core_key("anthropic_api_key") { cmd.env("ANTHROPIC_API_KEY", k); }

    // Amazon Bedrock (background inference on AWS Activate credits).
    // Both halves of the AWS credential must be present or neither is injected:
    // a half-configured pair makes aiGateway fail closed with a confusing "no AI
    // key configured" instead of an obvious missing-credential error.
    if let (Some(id), Some(secret)) = (
        secrets::core_key("aws_access_key_id"),
        secrets::core_key("aws_secret_access_key"),
    ) {
        cmd.env("AWS_ACCESS_KEY_ID", id).env("AWS_SECRET_ACCESS_KEY", secret);
        // eu-central-1 is where the eu.anthropic.* inference profiles live, and
        // it stays the default even now that non-EEA profiles are permitted: a
        // `global.` profile is invoked through a regional endpoint and routes
        // from there, so the region governs where the request ENTERS AWS, not
        // where the model runs.
        cmd.env(
            "AWS_REGION",
            secrets::core_key("aws_region").unwrap_or_else(|| "eu-central-1".to_string()),
        );
        // Per-tier model overrides. Without these, `BEDROCK_MODEL_*` was a
        // dev/CI-only lever — a Finder-launched .app inherits no shell env, so a
        // shipped build could never reach a non-default profile (which is how
        // Fable 5 stayed unreachable regardless of what the guard allowed).
        // Forwarding them from the Keychain makes model choice a config change.
        for (account, var) in [
            ("bedrock_model_haiku", "BEDROCK_MODEL_HAIKU"),
            ("bedrock_model_sonnet", "BEDROCK_MODEL_SONNET"),
            ("bedrock_model_opus", "BEDROCK_MODEL_OPUS"),
            ("bedrock_model_opus_5", "BEDROCK_MODEL_OPUS_5"),
            ("bedrock_model_fable_5", "BEDROCK_MODEL_FABLE_5"),
        ] {
            if let Some(v) = secrets::core_key(account) {
                cmd.env(var, v);
            }
        }
        // Opt-in EEA confinement. Absent = the shipped default, which permits
        // non-EEA inference profiles and is what the published privacy policy
        // (§4.3/§6/§7, 2 Aug 2026) describes.
        if let Some(v) = secrets::core_key("atlas_bedrock_eea_only") {
            cmd.env("ATLAS_BEDROCK_EEA_ONLY", v);
        }
        // Switching providers stays EXPLICIT: having AWS keys in the Keychain
        // must not silently redirect inference away from Anthropic. Only the
        // stored atlas_ai_provider preference flips it.
        if let Some(p) = secrets::core_key("atlas_ai_provider") {
            cmd.env("ATLAS_AI_PROVIDER", p);
        }
    }
    match cmd.spawn() {
        Ok(child) => {
            eprintln!("[atlas] brain sidecar spawned (pid {})", child.id());
            SidecarSpawn { child: Some(child), integrity_error: None }
        }
        Err(e) => {
            eprintln!("[atlas] brain sidecar spawn failed: {e}");
            SidecarSpawn { child: None, integrity_error: None }
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
        "integrity_error": state.integrity_error.lock().ok().and_then(|g| g.clone()),
    })
}

/// Map a provider slug to its Keychain account (service `atlas-core`). Covers
/// the AI keys (brain sidecar) and the external-provider keys the local
/// data-fetch / voice paths need (Supabase-removal Phase 5).
fn core_account(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "anthropic" => "anthropic_api_key",
        // AWS credential pair + region/provider for the Bedrock background tier.
        "aws_access_key_id" => "aws_access_key_id",
        "aws_secret_access_key" => "aws_secret_access_key",
        "aws_region" => "aws_region",
        "atlas_ai_provider" => "atlas_ai_provider",
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
        "anthropic": present("anthropic_api_key"),
        // Bedrock needs BOTH halves; report the pair, not each half, so the UI
        // cannot show "configured" for a credential that will not authenticate.
        "bedrock": present("aws_access_key_id") && present("aws_secret_access_key"),
        "ai_provider": secrets::core_key("atlas_ai_provider").unwrap_or_else(|| "anthropic".to_string()),
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
  //
  // NOTHING BLOCKING HAPPENS HERE. Sidecar startup used to run to completion
  // before `tauri::Builder` was even constructed, which meant the window could
  // not render until it finished: ~0.6s hashing the 372MB brain + ~0.2s for the
  // gateway (integrity verification against the compile-time manifest), plus a
  // Keychain read that blocks INDEFINITELY whenever macOS decides to show a
  // consent dialog. The user-visible symptom was a blank, unclickable window
  // with a spinner until the dialog was answered.
  //
  // Now the states are managed empty and filled in by a background thread once
  // the app is up, so the UI is interactive immediately and a slow (or stuck)
  // sidecar degrades one feature instead of freezing the whole app. The
  // frontend already polls *_info and handles the not-running case.
  let brain = AtlasBrain {
    child: Mutex::new(None),
    token: gateway_token.clone(),
    integrity_error: Mutex::new(None),
  };
  let gateway = VoiceGateway {
    child: Mutex::new(None),
    token: gateway_token.clone(),
    integrity_error: Mutex::new(None),
  };
  // Local proactive scheduler (Phase 4): periodically kicks the brain's
  // /proactive/cycle. All judgement lives brain-side; this only ticks.
  let proactive = scheduler::ProactiveScheduler::spawn(gateway_token.clone(), ATLAS_BRAIN_PORT);

  tauri::Builder::default()
    // Mail alerts -> macOS notifications; opener launches the OAuth consent
    // in the system browser (where the user's Google session lives).
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_opener::init())
    // Signed-update channel (minisign): the updater verifies every artifact
    // against the pubkey in tauri.conf.json before install — the app itself
    // never modifies its own binary. (Registration per agent-A contract.)
    .plugin(tauri_plugin_updater::Builder::new().build())
    // Native OAuth redirect capture (RFC 8252): the OS routes atlas://oauth/…
    // back into this process; we parse it and hand the code to the webview.
    .plugin(tauri_plugin_deep_link::init())
    .manage(gateway)
    .manage(brain)
    .manage(proactive)
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
      mail::mail_sync,
      mail::mail_thread_fetch,
      mail::mail_mark_read,
      mail::mail_set_status,
      mail::mail_send_reply,
      mail::mail_ingest_errors,
    ])
    .setup(|app| {
      // Sidecars come up in the BACKGROUND so the window is interactive at
      // once. Integrity hashing (~0.8s for both binaries) and the Keychain read
      // used to run before the Tauri builder existed, which is what made the
      // app open blank and unclickable until a consent dialog was answered.
      // Both sidecars are verified+spawned in parallel here; each writes its
      // own result into the managed state, and the frontend's *_info polling
      // picks them up whenever they land.
      {
        let handle = app.handle().clone();
        std::thread::spawn(move || {
          let token = handle.state::<AtlasBrain>().token.clone();
          let brain_token = token.clone();
          let brain_thread = std::thread::spawn(move || spawn_atlas_brain(&brain_token));

          let gw = spawn_voice_gateway(&token);
          {
            // `.map` (not `if let`) so each lock guard is consumed within its
            // own statement — an `if let` guard would outlive the State borrow.
            let gw_state = handle.state::<VoiceGateway>();
            let _ = gw_state.child.lock().map(|mut c| *c = gw.child);
            let _ = gw_state.integrity_error.lock().map(|mut e| *e = gw.integrity_error);
          }

          let brain = brain_thread.join().unwrap_or(SidecarSpawn {
            child: None,
            integrity_error: Some("brain sidecar spawn thread panicked".to_string()),
          });
          {
            let brain_state = handle.state::<AtlasBrain>();
            let _ = brain_state.child.lock().map(|mut c| *c = brain.child);
            let _ = brain_state.integrity_error.lock().map(|mut e| *e = brain.integrity_error);
          }
        });
      }

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
        if let Some(sched) = app_handle.try_state::<scheduler::ProactiveScheduler>() {
          sched.stop();
        }
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
