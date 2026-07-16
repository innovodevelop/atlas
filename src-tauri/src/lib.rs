use std::fs;
use std::path::Path;

mod secrets;
mod snaptrade;
mod portfolio_db;
mod portfolio;

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

// WKWebView's URL cache is unbounded and lives in the "Atlas Networking"
// helper process — once it grows to gigabytes, that process burns CPU
// thrashing cache lookups/eviction (and bloats memory). Purging oversized
// cache directories BEFORE the webview starts keeps it slim; WebKit
// recreates them cleanly. localStorage/auth (WebsiteData) is untouched.
fn purge_oversized_webview_caches() {
    let Some(home) = std::env::var_os("HOME") else { return };
    let webkit_caches = Path::new(&home)
        .join("Library/Caches/com.magnuspilegaard.atlas/WebKit");
    for cache_dir in ["NetworkCache", "MediaCache"] {
        let dir = webkit_caches.join(cache_dir);
        if !dir.is_dir() {
            continue;
        }
        let size = dir_size(&dir);
        if size > CACHE_PURGE_THRESHOLD_BYTES {
            match fs::remove_dir_all(&dir) {
                Ok(()) => eprintln!(
                    "[atlas] purged {} ({} MB) — WebKit recreates it bounded-fresh",
                    cache_dir,
                    size / (1024 * 1024)
                ),
                Err(e) => eprintln!("[atlas] cache purge failed for {cache_dir}: {e}"),
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  purge_oversized_webview_caches();
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
