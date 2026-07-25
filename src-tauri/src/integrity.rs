//! Sidecar binary integrity (ship substrate).
//!
//! Invariant: the app must never exec a sidecar it cannot verify. Both
//! `atlas-brain` and `atlas-voice-gateway` live as plain Mach-O files inside
//! the .app bundle and run with full user privileges plus the Keychain-injected
//! API keys — anything with user-level write access to /Applications could swap
//! one and the app would previously run it silently.
//!
//! Defense: `scripts/gen-sidecar-manifest.ts` records each sidecar's SHA-256 +
//! size right after it is compiled (chained onto `build:sidecar`/`build:brain`,
//! which `tauri build`'s beforeBuildCommand always runs). `build.rs` bakes that
//! manifest into THIS binary at compile time (`include_str!` from OUT_DIR), so
//! the expected digests live inside the main executable rather than in a
//! sibling file an attacker could rewrite alongside the sidecar.
//!
//! HONEST LIMITS — what this does and does not buy today:
//! - It raises the bar from "drop in a new sidecar" to "patch the main
//!   executable too". That is the whole guarantee **until Apple signing +
//!   notarization ship**: `tauri.conf.json` sets `signingIdentity: null`, so
//!   Atlas is at best ad-hoc signed and the same user-level writer named above
//!   can edit the embedded manifest bytes in `Contents/MacOS/Atlas` and
//!   re-sign with `codesign -f -s -`. Only a Developer ID signature +
//!   notarization makes the embedded digests actually tamper-evident.
//! - TOCTOU: [`gate`] hashes the file at a path and `lib.rs` then spawns that
//!   same path, so a concurrent user-level writer can swap the binary between
//!   the hash and the exec (hashing the brain takes ~0.6 s). macOS has no
//!   `fexecve`, so this is not closable here; it is a known residual within the
//!   stated threat model, and it shrinks to irrelevance once the attacker also
//!   has to defeat a notarized signature.
//!
//! Policy (see [`verify_with_manifest`]):
//! - digest mismatch  -> REFUSE to spawn, always (dev and packaged builds);
//! - manifest missing -> dev (debug_assertions) builds: warn loudly but allow,
//!   because `bun run tauri dev` has no bundled sidecars/manifest;
//!   packaged (release) builds: REFUSE — verification is never skipped
//!   silently in a build that ships.
//!
//! The dev/packaged distinction is `cfg!(debug_assertions)`: packaged apps are
//! release cargo builds (`tauri build`), dev runs are debug (`tauri dev`).

use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

/// Manifest baked in at compile time. build.rs copies
/// `src-tauri/binaries/manifest.json` into OUT_DIR, substituting `{}` when the
/// file does not exist (dev checkouts where the sidecars aren't compiled).
const EMBEDDED_MANIFEST: &str = include_str!(concat!(env!("OUT_DIR"), "/sidecar-manifest.json"));

/// Expected identity of one sidecar, parsed from the manifest.
#[derive(Debug, PartialEq)]
pub struct Expected {
    pub sha256: String,
    pub size: Option<u64>,
}

/// The spawn gate's answer for one sidecar.
#[derive(Debug, PartialEq)]
pub enum SpawnDecision {
    /// Digest verified against the embedded manifest.
    Allow,
    /// Verification impossible (no manifest entry) in a DEV build — spawn, but
    /// log the contained warning loudly.
    AllowUnverifiedDev(String),
    /// Do not spawn. The string is a user-presentable reason (also logged).
    Refuse(String),
}

/// Streamed SHA-256 of a file (the sidecars are ~100–370 MB; never read whole).
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 4 * 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|b| format!("{b:02x}")).collect())
}

/// Look up a sidecar's expected identity in a manifest JSON string.
pub fn expected_for(manifest_raw: &str, name: &str) -> Option<Expected> {
    let v: serde_json::Value = serde_json::from_str(manifest_raw).ok()?;
    let entry = v.get(name)?;
    Some(Expected {
        sha256: entry.get("sha256")?.as_str()?.to_ascii_lowercase(),
        size: entry.get("size").and_then(|s| s.as_u64()),
    })
}

/// Core verification, fully parameterised so it is unit-testable (the embedded
/// manifest and `cfg!(debug_assertions)` are fixed inside a test binary).
pub fn verify_with_manifest(
    manifest_raw: &str,
    name: &str,
    path: &Path,
    packaged: bool,
) -> SpawnDecision {
    let Some(expected) = expected_for(manifest_raw, name) else {
        let msg = format!(
            "no integrity manifest entry for sidecar '{name}' — cannot verify {}",
            path.display()
        );
        if packaged {
            return SpawnDecision::Refuse(format!(
                "{msg}. Packaged builds must embed sidecar digests (scripts/gen-sidecar-manifest.ts); refusing to run an unverified binary."
            ));
        }
        return SpawnDecision::AllowUnverifiedDev(format!(
            "{msg} (dev build — spawning anyway; packaged builds refuse)"
        ));
    };

    // Cheap fast-fail before hashing hundreds of MB: a size difference already
    // proves the binary is not the one we shipped.
    if let Some(expected_size) = expected.size {
        match std::fs::metadata(path) {
            Ok(meta) if meta.len() != expected_size => {
                return SpawnDecision::Refuse(format!(
                    "sidecar '{name}' size mismatch: expected {expected_size} bytes, found {} — binary was modified or replaced; refusing to spawn",
                    meta.len()
                ));
            }
            Ok(_) => {}
            Err(e) => {
                return SpawnDecision::Refuse(format!(
                    "sidecar '{name}' unreadable ({e}) — refusing to spawn"
                ));
            }
        }
    }

    let started = std::time::Instant::now();
    let actual = match sha256_file(path) {
        Ok(d) => d,
        Err(e) => {
            return SpawnDecision::Refuse(format!(
                "sidecar '{name}' could not be hashed ({e}) — refusing to spawn"
            ));
        }
    };
    let ms = started.elapsed().as_millis();

    if actual == expected.sha256 {
        eprintln!("[atlas] sidecar '{name}' integrity verified (sha256 ok, {ms}ms)");
        SpawnDecision::Allow
    } else {
        SpawnDecision::Refuse(format!(
            "sidecar '{name}' SHA-256 mismatch: expected {}, found {} — binary was modified or replaced; refusing to spawn",
            expected.sha256, actual
        ))
    }
}

/// Gate a sidecar spawn against the compile-time-embedded manifest.
/// `name` is the runtime binary name next to the app executable
/// (e.g. "atlas-brain"), `path` its full location.
pub fn gate(name: &str, path: &Path) -> SpawnDecision {
    verify_with_manifest(EMBEDDED_MANIFEST, name, path, !cfg!(debug_assertions))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Unique temp file holding `content`; removed on drop.
    struct TempFile(std::path::PathBuf);
    impl TempFile {
        fn new(tag: &str, content: &[u8]) -> Self {
            let p = std::env::temp_dir().join(format!(
                "atlas-integrity-test-{tag}-{}",
                std::process::id()
            ));
            let mut f = std::fs::File::create(&p).unwrap();
            f.write_all(content).unwrap();
            TempFile(p)
        }
    }
    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    // SHA-256("abc") — FIPS 180-2 test vector.
    const ABC_SHA256: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

    fn manifest(name: &str, sha256: &str, size: u64) -> String {
        format!(r#"{{"{name}": {{"sha256": "{sha256}", "size": {size}}}}}"#)
    }

    #[test]
    fn sha256_file_matches_known_vector() {
        let f = TempFile::new("vector", b"abc");
        assert_eq!(sha256_file(&f.0).unwrap(), ABC_SHA256);
    }

    #[test]
    fn expected_for_parses_entry_and_misses_absent() {
        let m = manifest("atlas-brain", ABC_SHA256, 3);
        let e = expected_for(&m, "atlas-brain").unwrap();
        assert_eq!(e.sha256, ABC_SHA256);
        assert_eq!(e.size, Some(3));
        assert!(expected_for(&m, "atlas-voice-gateway").is_none());
        assert!(expected_for("{}", "atlas-brain").is_none());
        assert!(expected_for("not json", "atlas-brain").is_none());
    }

    #[test]
    fn matching_digest_allows() {
        let f = TempFile::new("match", b"abc");
        let m = manifest("atlas-brain", ABC_SHA256, 3);
        assert_eq!(
            verify_with_manifest(&m, "atlas-brain", &f.0, true),
            SpawnDecision::Allow
        );
    }

    #[test]
    fn digest_mismatch_refuses_in_both_build_types() {
        let f = TempFile::new("tampered", b"xyz"); // same size, different bytes
        let m = manifest("atlas-brain", ABC_SHA256, 3);
        for packaged in [true, false] {
            match verify_with_manifest(&m, "atlas-brain", &f.0, packaged) {
                SpawnDecision::Refuse(msg) => assert!(msg.contains("mismatch")),
                other => panic!("tampered binary must be refused, got {other:?}"),
            }
        }
    }

    #[test]
    fn size_mismatch_fast_fails_without_hashing() {
        let f = TempFile::new("resized", b"abcd"); // 4 bytes, manifest says 3
        let m = manifest("atlas-brain", ABC_SHA256, 3);
        match verify_with_manifest(&m, "atlas-brain", &f.0, true) {
            SpawnDecision::Refuse(msg) => assert!(msg.contains("size mismatch")),
            other => panic!("resized binary must be refused, got {other:?}"),
        }
    }

    #[test]
    fn missing_manifest_entry_refuses_when_packaged_allows_in_dev() {
        let f = TempFile::new("nomanifest", b"abc");
        match verify_with_manifest("{}", "atlas-brain", &f.0, true) {
            SpawnDecision::Refuse(msg) => assert!(msg.contains("unverified")),
            other => panic!("packaged build without manifest must refuse, got {other:?}"),
        }
        match verify_with_manifest("{}", "atlas-brain", &f.0, false) {
            SpawnDecision::AllowUnverifiedDev(msg) => assert!(msg.contains("dev build")),
            other => panic!("dev build without manifest should warn+allow, got {other:?}"),
        }
    }

    #[test]
    fn unreadable_binary_refuses() {
        let m = manifest("atlas-brain", ABC_SHA256, 3);
        let ghost = std::env::temp_dir().join("atlas-integrity-test-does-not-exist");
        match verify_with_manifest(&m, "atlas-brain", &ghost, true) {
            SpawnDecision::Refuse(_) => {}
            other => panic!("unreadable binary must be refused, got {other:?}"),
        }
    }
}
