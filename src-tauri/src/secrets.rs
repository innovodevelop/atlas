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
// All atlas-core secrets live in ONE Keychain item ("atlas-core" / "secrets")
// holding a JSON object, instead of one item per key.
//
// WHY ONE ITEM: macOS authorises Keychain access PER ITEM. With ~10 separate
// items the user was clicking through ~10 permission dialogs — and because
// several of them were created from Terminal (the `security` CLI), Atlas was
// never in their ACLs at all, so the dialogs came back on every launch and
// every dashboard refresh. An item that Atlas itself CREATES lists Atlas in
// its ACL from birth, so reading it back never prompts — zero dialogs on
// every subsequent launch, across rebuilds too (the app's cert-based code
// signature keeps its identity stable; see the ship pipeline).
//
// MIGRATION: on first read, if the blob item does not exist yet, each legacy
// per-key item is read (this is the one final round of prompts), folded into
// the blob, and deleted only after the blob write succeeds. A legacy item
// whose read is denied stays put and is retried on the next launch.
//
// The parsed blob is cached in-process, so a launch performs at most one
// Keychain read no matter how many keys the spawns and data-fetch timers ask
// for. Writers update the cache and the item together.

use std::collections::HashMap;
use std::sync::Mutex;

const CORE_SERVICE: &str = "atlas-core";
const CORE_BLOB_ACCOUNT: &str = "secrets";
/// Staging item for scripted, promptless secret injection — see load_or_migrate.
const CORE_IMPORT_ACCOUNT: &str = "secrets-import";

/// Every account name ever written as its own atlas-core item. Used only by
/// the one-time migration; extend it if a new legacy name ever existed.
const LEGACY_CORE_ACCOUNTS: &[&str] = &[
    "gemini_api_key",
    "perplexity_api_key",
    "openweather_api_key",
    "finnhub_api_key",
    "news_api_key",
    "elevenlabs_api_key",
    "anthropic_api_key",
    "aws_access_key_id",
    "aws_secret_access_key",
    "aws_region",
    "atlas_ai_provider",
];

static CORE_CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn core_entry(account: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(CORE_SERVICE, account)
}

fn write_blob(map: &HashMap<String, String>) -> Result<(), String> {
    let raw = serde_json::to_string(map).map_err(|e| e.to_string())?;
    core_entry(CORE_BLOB_ACCOUNT)
        .and_then(|e| e.set_password(&raw))
        .map_err(|e| e.to_string())
}

/// Load the blob, folding in any legacy per-key items still present.
///
/// RESUMABLE BY DESIGN: a migration round can end partially done — the user
/// answers some Keychain dialogs and dismisses others, or the app is killed
/// mid-round. So this does not treat "blob exists" as "migration finished":
/// every load also sweeps the legacy account list, and any item that can be
/// read (silently if its ACL already allows Atlas, else via one dialog) is
/// folded in and deleted. A denied item stays put and is simply retried on
/// the next launch — the dialogs stop exactly when none are left.
fn load_or_migrate() -> HashMap<String, String> {
    let mut map: HashMap<String, String> = match core_entry(CORE_BLOB_ACCOUNT)
        .ok()
        .and_then(|e| e.get_password().ok())
    {
        Some(raw) => match serde_json::from_str(&raw) {
            Ok(m) => m,
            Err(_) => {
                // A corrupt blob is unrecoverable data — do not overwrite it silently.
                eprintln!("[secrets] atlas-core blob exists but is not valid JSON; treating as empty (item preserved)");
                return HashMap::new();
            }
        },
        None => HashMap::new(),
    };

    // Sweep stragglers. The blob value wins on a name collision (it is the
    // store of record once a key has been written through the app).
    let mut migrated: Vec<&str> = Vec::new();
    for account in LEGACY_CORE_ACCOUNTS {
        if let Ok(entry) = core_entry(account) {
            if let Ok(value) = entry.get_password() {
                map.entry((*account).to_string()).or_insert(value);
                migrated.push(account);
            }
        }
    }

    // The zero-dialog hand-off: tooling can stage secrets in a "secrets-import"
    // item created with `security add-generic-password -T <Atlas binary>`, which
    // puts Atlas in the item's ACL at creation — so this read never prompts.
    // The item is a JSON object like the blob; it merges (blob wins) and is
    // deleted once absorbed. This is how the CLI-created legacy keys were moved
    // without a single dialog, and it remains the sanctioned way to inject
    // secrets from scripts without re-triggering Keychain consent UI.
    if let Ok(entry) = core_entry(CORE_IMPORT_ACCOUNT) {
        if let Ok(raw) = entry.get_password() {
            match serde_json::from_str::<HashMap<String, String>>(&raw) {
                Ok(imported) => {
                    for (k, v) in imported {
                        map.entry(k).or_insert(v);
                    }
                    migrated.push(CORE_IMPORT_ACCOUNT);
                }
                Err(_) => eprintln!("[secrets] secrets-import exists but is not valid JSON; leaving it in place"),
            }
        }
    }

    if migrated.is_empty() {
        // Nothing legacy readable. Still ensure the blob item exists so it is
        // Atlas-owned (promptless) before any key is ever stored through the app.
        if core_entry(CORE_BLOB_ACCOUNT).ok().and_then(|e| e.get_password().ok()).is_none() {
            let _ = write_blob(&map);
        }
        return map;
    }

    // Delete legacy items only after the blob write succeeded — a failed write
    // must not lose the only copy of a secret.
    match write_blob(&map) {
        Ok(()) => {
            for account in &migrated {
                if let Ok(entry) = core_entry(account) {
                    let _ = entry.delete_password();
                }
            }
            eprintln!(
                "[secrets] migrated {} legacy Keychain item(s) into the consolidated atlas-core blob",
                migrated.len()
            );
        }
        Err(e) => eprintln!("[secrets] blob write failed; legacy items left in place: {e}"),
    }
    map
}

fn with_core_map<R>(f: impl FnOnce(&mut HashMap<String, String>) -> R) -> R {
    let mut guard = CORE_CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        *guard = Some(load_or_migrate());
    }
    f(guard.as_mut().expect("cache initialised above"))
}

/// Read an atlas-core secret (e.g. "gemini_api_key", "aws_access_key_id").
pub fn core_key(account: &str) -> Option<String> {
    with_core_map(|m| m.get(account).cloned())
}

pub fn set_core_key(account: &str, value: &str) -> Result<(), String> {
    with_core_map(|m| {
        m.insert(account.to_string(), value.to_string());
        write_blob(m)
    })
}

pub fn clear_core_key(account: &str) -> Result<(), String> {
    with_core_map(|m| {
        m.remove(account);
        write_blob(m)
    })
}
