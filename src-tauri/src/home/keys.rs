// The home bridge credential: one Keychain item, under its own service.
//
// WHY A DEDICATED SERVICE AND NOT THE atlas-core BLOB
// `secrets.rs` holds AI/provider keys in ONE consolidated "atlas-core" item
// because there were ten of them and each was its own consent dialog. That
// argument does not apply to an INTEGRATION credential, and the file already
// shows the other convention twice: SnapTrade under "atlas-snaptrade"
// (secrets.rs:7) and the Spotify refresh token under "atlas-music"
// (secrets.rs:76-93). A per-integration item is what lets unlinking a bridge
// delete exactly that credential and nothing else — which `home_unlink` does.
//
// WHY THE PERMISSIVE ACL (`security add-generic-password -A`)
// Verbatim the reasoning in secrets.rs' `write_blob`: the default SecItemAdd
// ACL trusts exactly the binary that created the item, every rebuild is a
// different binary, and this project is rebuilt constantly — so the default
// produces a Keychain dialog on every launch, forever. `-A` is the only ACL
// that survives a rebuild. The threat model is stated there and is unchanged
// here: any process running as this user can read it, which is already true of
// the SQLite file holding the user's mail and memories.
//
// NOTHING IN THIS FILE EVER RETURNS A TOKEN TO THE WEBVIEW, writes one to the
// database, or puts one in a log line or an error message.

const SERVICE: &str = "atlas-homekit";
const HA_TOKEN: &str = "home_assistant_token";

/// Write with an ACL that does not interrogate which binary is asking.
/// Falls back to the `keyring` crate if the CLI is unavailable, which trades
/// the re-prompt back for still having stored the credential.
fn set_permissive(account: &str, value: &str) -> Result<(), String> {
    let out = std::process::Command::new("/usr/bin/security")
        .args(["add-generic-password", "-s", SERVICE, "-a", account, "-w", value, "-A", "-U"])
        .output()
        .map_err(|e| format!("security add-generic-password failed to run: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    // The stderr is printed, the VALUE never is.
    eprintln!(
        "[home] permissive-ACL write failed for {SERVICE}/{account} ({}), falling back to keyring",
        String::from_utf8_lossy(&out.stderr).trim()
    );
    keyring::Entry::new(SERVICE, account)
        .and_then(|e| e.set_password(value))
        .map_err(|e| e.to_string())
}

fn entry(account: &str) -> keyring::Result<keyring::Entry> {
    keyring::Entry::new(SERVICE, account)
}

/// The Home Assistant long-lived access token, if one has been stored.
pub fn ha_token() -> Option<String> {
    entry(HA_TOKEN).ok()?.get_password().ok()
}

pub fn set_ha_token(token: &str) -> Result<(), String> {
    if token.trim().is_empty() {
        return Err("refusing to store an empty bridge token".into());
    }
    set_permissive(HA_TOKEN, token.trim())
}

/// Forget the credential. Missing is success: unlinking a bridge that was never
/// fully linked must not fail.
pub fn clear_ha_token() -> Result<(), String> {
    if let Ok(e) = entry(HA_TOKEN) {
        let _ = e.delete_password();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These do NOT touch the real Keychain: a unit test that wrote to the
    /// developer's login keychain would leave a credential behind on a machine
    /// that never linked a bridge, and on CI it would prompt or fail. What is
    /// checkable without a Keychain is the part that has been wrong before —
    /// the service and account names, which unlinking deletes by literal, and
    /// the refusal to store nothing.
    #[test]
    fn the_service_name_is_the_per_integration_one_and_not_the_core_blob() {
        assert_eq!(SERVICE, "atlas-homekit");
        assert_ne!(SERVICE, "atlas-core", "an integration credential is not a provider key");
        assert!(!HA_TOKEN.is_empty());
    }

    #[test]
    fn an_empty_token_is_refused_before_it_reaches_the_keychain() {
        assert!(set_ha_token("").is_err());
        assert!(set_ha_token("   ").is_err());
    }
}
