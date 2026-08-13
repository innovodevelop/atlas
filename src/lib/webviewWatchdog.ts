// Detects a dead WKWebView content process and forces a reload.
//
// On macOS, a Tauri webview's underlying WKWebView can have its web content
// process terminated by the system under memory pressure during extended idle.
// The visible symptom is a white/blank window. Normally the hosting app observes
// `webViewWebContentProcessDidTerminate:` and reloads — but Tauri v2 does not
// expose that delegate method to plugins or Rust. If the content process dies,
// JS stops running entirely, so a JS-only heartbeat cannot detect it.
//
// What this module CAN catch (and does):
// 1. The canvas render loop dying (`!el.isConnected` exit in wxAtmosphere.ts)
//    after React remounts. On refocus we check whether any rAF callback ran in
//    the last 2s; if not, and the window is visible, reload.
// 2. A React render tree that crashed past the error boundary, leaving a blank
//    root. On refocus we check whether #root has zero children.
//
// The hard case (WKWebView process termination) will need a Rust-side watchdog
// that calls `webview.eval("1")` on a timer and reloads on failure. This file
// is the JS half; the Rust half is tracked as #48's proper fix.

const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let lastRafTs = 0;

function heartbeat(ts: number) {
  lastRafTs = ts;
  requestAnimationFrame(heartbeat);
}

function checkHealth() {
  const root = document.getElementById('root');
  if (!root) return;

  const rootEmpty = root.children.length === 0;
  const rafStale = performance.now() - lastRafTs > 2000;

  if (rootEmpty || rafStale) {
    console.warn(
      `[watchdog] Blank window detected (root empty: ${rootEmpty}, rAF stale: ${rafStale}). Reloading.`,
    );
    window.location.reload();
  }
}

export function startWebviewWatchdog(): void {
  if (typeof window === 'undefined') return;

  requestAnimationFrame(heartbeat);

  if (isTauri) {
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => {
        getCurrentWindow().onFocusChanged(({ payload: focused }) => {
          if (focused) {
            setTimeout(checkHealth, 200);
          }
        });
      })
      .catch(() => {});
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      setTimeout(checkHealth, 200);
    }
  });
}
