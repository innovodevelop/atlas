// Secure local credential store (macOS Keychain via the `keyring` crate).
// App-level SnapTrade credentials (client id + consumer key) are provisioned
// once under the "atlas-snaptrade" service. The per-user SnapTrade identity
// (userId + userSecret, returned at registration) is stored the same way so
// brokerage secrets never live in the DB, in git, or in the JS layer.

const SERVICE: &str = "atlas-snaptrade";

fn entry(account: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, account)
}

/// (client_id, consumer_key) — the SnapTrade developer credentials.
pub fn app_credentials() -> Result<(String, String), String> {
    let client_id = entry("client_id")
        .and_then(|e| e.get_password())
        .map_err(|_| "SnapTrade client_id not found in Keychain (service 'atlas-snaptrade'). See docs/portfolio-setup.md".to_string())?;
    let consumer_key = entry("consumer_key")
        .and_then(|e| e.get_password())
        .map_err(|_| "SnapTrade consumer_key not found in Keychain".to_string())?;
    Ok((client_id, consumer_key))
}

pub fn has_app_credentials() -> bool {
    app_credentials().is_ok()
}

/// (user_id, user_secret) once the SnapTrade user has been registered.
pub fn snaptrade_user() -> Option<(String, String)> {
    let user_id = entry("user_id").ok()?.get_password().ok()?;
    let user_secret = entry("user_secret").ok()?.get_password().ok()?;
    Some((user_id, user_secret))
}

pub fn set_snaptrade_user(user_id: &str, user_secret: &str) -> Result<(), String> {
    entry("user_id").and_then(|e| e.set_password(user_id)).map_err(|e| e.to_string())?;
    entry("user_secret").and_then(|e| e.set_password(user_secret)).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn clear_snaptrade_user() -> Result<(), String> {
    if let Ok(e) = entry("user_id") { let _ = e.delete_password(); }
    if let Ok(e) = entry("user_secret") { let _ = e.delete_password(); }
    Ok(())
}

// --- Music (Spotify) ----------------------------------------------------
// The Spotify OAuth *refresh token* lives under its own Keychain service.
// It's the only long-lived music secret; the Spotify Client ID is public and
// hardcoded, and the PKCE flow uses no client secret. The refresh token never
// touches the DB, git, or the JS layer.

const MUSIC_SERVICE: &str = "atlas-music";

fn music_entry(account: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(MUSIC_SERVICE, account)
}

pub fn music_refresh_token() -> Option<String> {
    music_entry("spotify_refresh_token").ok()?.get_password().ok()
}

pub fn set_music_refresh_token(token: &str) -> Result<(), String> {
    music_entry("spotify_refresh_token")
        .and_then(|e| e.set_password(token))
        .map_err(|e| e.to_string())
}

pub fn clear_music_refresh_token() -> Result<(), String> {
    if let Ok(e) = music_entry("spotify_refresh_token") { let _ = e.delete_password(); }
    Ok(())
}

// --- Brain sidecar / AI provider keys -----------------------------------
// The brain sidecar's AI keys (Gemini required for completions + embeddings;
// Perplexity optional for web-search tools) live under the "atlas-core"
// service and are injected into the sidecar's env at spawn — never in the DB,
// git, or the JS layer (Supabase-migration local-first model).

const CORE_SERVICE: &str = "atlas-core";

fn core_entry(account: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(CORE_SERVICE, account)
}

/// Read an atlas-core secret (e.g. "gemini_api_key", "perplexity_api_key").
pub fn core_key(account: &str) -> Option<String> {
    core_entry(account).ok()?.get_password().ok()
}

pub fn set_core_key(account: &str, value: &str) -> Result<(), String> {
    core_entry(account)
        .and_then(|e| e.set_password(value))
        .map_err(|e| e.to_string())
}

pub fn clear_core_key(account: &str) -> Result<(), String> {
    if let Ok(e) = core_entry(account) { let _ = e.delete_password(); }
    Ok(())
}
