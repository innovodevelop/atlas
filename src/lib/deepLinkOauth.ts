// Frontend seam for native deep-link OAuth (RFC 8252).
//
// The Rust side (src-tauri/src/oauth.rs) captures the atlas://oauth/callback
// redirect, parses it, and re-emits it as a plain `oauth-callback` Tauri event.
// The authorization code is exchanged for tokens *in Rust* and never reaches
// this layer — the webview only listens so the UI can react (e.g. flip a
// "Connect Spotify" button to "Connected" once the flow completes).
//
// This is the stable contract the music player hook (and any future provider)
// builds on; it is unaffected by whether the redirect is the custom scheme or,
// later, the branded universal link.

const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Mirrors the Rust `OauthCallback` struct emitted on `oauth-callback`. */
export interface OauthCallback {
  /** Logical provider, e.g. "spotify". */
  provider: string;
  code: string | null;
  state: string | null;
  error: string | null;
}

/**
 * Subscribe to captured OAuth redirects. Returns an unlisten function; call it
 * on cleanup. No-op (returns a noop unlisten) outside the desktop app.
 */
export async function onOauthCallback(
  handler: (cb: OauthCallback) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<OauthCallback>('oauth-callback', (e) => handler(e.payload));
}

/**
 * Resolve on the next OAuth redirect for `provider`, or reject on timeout /
 * an `error` in the redirect. Handy for a connect button that awaits the round
 * trip through the system browser. Default timeout 3 min (user has to consent).
 */
export function waitForOauthCallback(
  provider: string,
  timeoutMs = 180_000,
): Promise<OauthCallback> {
  return new Promise((resolve, reject) => {
    let unlisten: (() => void) | null = null;
    let settled = false;

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      unlisten?.();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      reject(new Error(`Timed out waiting for ${provider} OAuth redirect`));
    }, timeoutMs);

    onOauthCallback((cb) => {
      if (settled || cb.provider !== provider) return;
      cleanup();
      if (cb.error) reject(new Error(`${provider} OAuth failed: ${cb.error}`));
      else resolve(cb);
    }).then((fn) => {
      unlisten = fn;
      // If the callback already fired and settled us before listen resolved,
      // detach immediately.
      if (settled) fn();
    });
  });
}
