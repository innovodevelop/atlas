use std::fs;
use std::path::Path;

mod secrets;
mod snaptrade;
mod portfolio_db;
mod portfolio;

const BUNDLE_ID: &str = "com.magnuspilegaard.atlas";
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
  tauri::Builder::default()
    // Mail alerts -> macOS notifications; opener launches the OAuth consent
    // in the system browser (where the user's Google session lives).
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_opener::init())
    .invoke_handler(tauri::generate_handler![
      portfolio::portfolio_status,
      portfolio::portfolio_connect_url,
      portfolio::portfolio_sync,
      portfolio::portfolio_summary,
      portfolio::portfolio_holdings,
      portfolio::portfolio_history,
      portfolio::portfolio_allocation,
      portfolio::portfolio_disconnect,
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
