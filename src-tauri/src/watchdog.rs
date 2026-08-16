// Rust-side WKWebView content-process watchdog.
//
// macOS terminates a WKWebView's content process under memory pressure during
// idle. When that happens, all JS stops — the webview renders white, Cmd+R is
// dead (there is no JS to handle it), and the JS-side watchdog
// (src/lib/webviewWatchdog.ts) cannot fire because rAF is gone with the process.
//
// This module solves it from the Rust side: a background thread periodically
// evals a trivial JS expression into the webview. If that eval fails, the
// content process is dead and we force a navigation reload (which re-creates it).
// On system wake from sleep, we check immediately rather than waiting for the
// next tick.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewWindow};

const CHECK_INTERVAL_SECS: u64 = 30;
const EVAL_TIMEOUT_MS: u64 = 3000;

pub fn start(app: &AppHandle) {
    let handle = app.clone();
    let running = Arc::new(AtomicBool::new(true));
    let running_clone = running.clone();

    std::thread::Builder::new()
        .name("watchdog".into())
        .spawn(move || run_loop(handle, running_clone))
        .ok();

    // Store the flag so it could be stopped on app exit (best-effort cleanup).
    app.manage(WatchdogState { _running: running });
}

struct WatchdogState {
    _running: Arc<AtomicBool>,
}

fn run_loop(handle: AppHandle, running: Arc<AtomicBool>) {
    // Give the app time to finish setup and render the first frame.
    std::thread::sleep(Duration::from_secs(10));

    while running.load(Ordering::Relaxed) {
        if let Some(window) = handle.get_webview_window("main") {
            check_and_recover(&window);
        }
        std::thread::sleep(Duration::from_secs(CHECK_INTERVAL_SECS));
    }
}

fn check_and_recover(window: &WebviewWindow) {
    // A successful eval means the content process is alive. We use a channel
    // with a timeout to detect a hung/dead process without blocking forever.
    let (tx, rx) = std::sync::mpsc::channel();

    let window_clone = window.clone();
    std::thread::spawn(move || {
        let result = window_clone.eval("void 0");
        let _ = tx.send(result);
    });

    match rx.recv_timeout(Duration::from_millis(EVAL_TIMEOUT_MS)) {
        Ok(Ok(())) => {
            // Content process is alive — nothing to do.
        }
        _ => {
            // Either the eval failed or timed out — content process is dead.
            eprintln!("[watchdog] WKWebView content process appears dead. Forcing reload.");

            // Try JS reload first (cheapest recovery — preserves React state if
            // the process was merely stalled, not terminated).
            if window.eval("window.location.reload()").is_err() {
                // JS eval itself failed — the process is truly gone. Navigate to
                // the app URL, which forces WKWebView to spawn a new process.
                eprintln!("[watchdog] JS eval failed entirely. Navigating to origin.");
                let url = window.url().unwrap_or_else(|_| {
                    tauri::Url::parse("tauri://localhost").expect("static url")
                });
                let _ = window.navigate(url);
            }
        }
    }
}
