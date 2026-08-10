// HAP — a HomeKit Accessory Protocol CONTROLLER, spoken directly over the LAN.
//
// THIS IS NOT THE THING ADR 008 SAYS IS IMPOSSIBLE, and the distinction is the
// whole reason this directory exists. `companion.rs` is about Apple's HomeKit
// FRAMEWORK (HMHomeManager), which is documented Mac Catalyst only — Atlas is
// AppKit + WKWebView, so there is no entry point to call, whatever the
// entitlements say. That wall is real, it is recorded in
// docs/decisions/008-healthkit-homekit-platform-wall.md, and nothing here
// touches it: no HomeKit framework symbol is referenced anywhere in this
// module. What this module does instead is speak the ACCESSORY protocol
// ourselves — pair with an accessory over TCP the way an iPhone does. Those
// are different mechanisms, and the second one is not blocked by the first.
//
// The two bridge rows will coexist on the Setup screen and must not read as
// contradicting each other: the companion row keeps saying Apple's HomeKit
// app/framework is unavailable, and this one says Atlas can talk to HomeKit
// accessories over the network.
//
// WHAT CAN AND CANNOT BE VERIFIED HERE. Apple's HomeKit Accessory Simulator is
// NOT installed on this machine — it ships in "Additional Tools for Xcode" and
// needs an Apple ID download. So nothing in this module has ever exchanged a
// byte with a real accessory, and the tests are honest about which layer they
// prove:
//   LAYER 1  published RFC / Wycheproof vectors — the crypto is really crypto
//   LAYER 2  constants pinned as bytes with ADK provenance — nothing mistyped
//   LAYER 3  loopback against a test accessory — internal consistency ONLY
// Layer 3 passes identically if every salt string is wrong, because both sides
// use the same wrong string. It is written that way on purpose and says so.
// The first genuine interop test is the first Simulator run.
//
// PROVENANCE OF EVERY CONSTANT. The HAP specification PDF needs an Apple ID.
// The source used instead is `apple/HomeKitADK` (Apache-2.0) — Apple's own
// ACCESSORY-side implementation of this exact protocol — read at byte level
// with file and line recorded next to each value. That is a mirror-image
// derivation: what the accessory verifies is precisely what this controller
// must produce.
//
// THE FEATURE GATE. Everything under `home/hap/` is compiled only into the
// Lighthouse build. The gate lives at the DECLARATION in `home/mod.rs`
// (`#[cfg(feature = "homekit")] pub mod hap;`) rather than being repeated on
// every item here, because the control port is a registry rather than a
// webview: whatever is registered is reachable by the model in both editions,
// so a frontend gate would leave the capability in Atlas.app.

// `home` is a PRIVATE module of the lib crate (lib.rs:30 `mod home;`), so
// rustc's reachability analysis treats every `pub` item down here as dead
// until something inside the crate calls it. This module is a protocol
// library whose only consumer — the `HomeAdapter` implementation that will
// drive pair-verify and /characteristics — is a later file that does not
// exist yet, so without this every constant and every function reports
// "never used" and buries the two warnings the rest of the crate has.
//
// DELETE THIS LINE when the adapter lands. It is scoped to `hap` on purpose:
// it must never grow to cover code that has a consumer and is genuinely dead.
#![allow(dead_code)]

pub mod discovery;
pub mod http;
pub mod pairing;
pub mod session;
pub mod srp;
pub mod tlv;
pub mod verify;

use hmac::{Hmac, Mac};
use sha2::Sha512;

// ---------------------------------------------------------------------------
// Constant-time comparison
// ---------------------------------------------------------------------------

/// Equality that does not short-circuit on the first differing byte.
///
/// Same construction as `control/auth.rs::ct_eq`, and here for the same
/// reason: this compares SRP proofs, Poly1305-adjacent material and long-term
/// public keys, all of which an attacker would love to search a byte at a time
/// by watching how long we take to say no. Length is not secret — an SRP proof
/// is always 64 bytes — so an early return on a length mismatch leaks nothing.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---------------------------------------------------------------------------
// HKDF
// ---------------------------------------------------------------------------

/// HAP derives every key with HKDF-SHA512, so production only ever needs
/// `HkdfSha512`. The trait exists so the RFC 5869 test vectors — which are
/// SHA-256 and SHA-1 ONLY; the RFC publishes no SHA-512 case — can be run
/// against the same code path that HAP uses. Without it, the extract-then-
/// expand structure would be verifiable against nothing.
pub trait HkdfHash {
    const LEN: usize;
    fn hmac(key: &[u8], parts: &[&[u8]]) -> Vec<u8>;
}

pub struct HkdfSha512;

impl HkdfHash for HkdfSha512 {
    const LEN: usize = 64;
    fn hmac(key: &[u8], parts: &[&[u8]]) -> Vec<u8> {
        // HMAC accepts a key of any length, so this cannot fail — but it is
        // written as a fallback rather than an unwrap because this crate does
        // not panic on data paths.
        let mut mac = match Hmac::<Sha512>::new_from_slice(key) {
            Ok(m) => m,
            Err(_) => return Vec::new(),
        };
        for p in parts {
            mac.update(p);
        }
        mac.finalize().into_bytes().to_vec()
    }
}

/// RFC 5869 extract-then-expand.
///
/// `None` when `out_len` exceeds 255·HashLen, which RFC 5869 §2.3 forbids —
/// HAP never asks for more than 32, but returning an Option is what keeps the
/// counter loop from wrapping instead of failing.
pub fn hkdf<H: HkdfHash>(salt: &[u8], ikm: &[u8], info: &[u8], out_len: usize) -> Option<Vec<u8>> {
    if out_len > 255 * H::LEN {
        return None;
    }
    // "if not provided, [salt] is set to a string of HashLen zeros" — §2.2.
    let zeros = vec![0u8; H::LEN];
    let salt = if salt.is_empty() { &zeros[..] } else { salt };
    let prk = H::hmac(salt, &[ikm]);

    let mut out: Vec<u8> = Vec::with_capacity(out_len);
    let mut t: Vec<u8> = Vec::new();
    let mut counter: u8 = 1;
    while out.len() < out_len {
        t = H::hmac(&prk, &[&t, info, &[counter]]);
        // A ZERO-LENGTH BLOCK MUST END THIS LOOP, not spin it. `HkdfHash::hmac`
        // returns `Vec::new()` on its (unreachable-today) error path rather
        // than unwrapping, and with an empty `t` the line below copies nothing,
        // `out` never grows, and the loop never exits — a hung thread instead
        // of an error. The trait is public, so the next implementor is who this
        // guard is for.
        if t.is_empty() {
            return None;
        }
        let take = (out_len - out.len()).min(t.len());
        out.extend_from_slice(&t[..take]);
        counter = counter.wrapping_add(1);
    }
    Some(out)
}

/// The only shape HAP ever asks for: 32 bytes out of HKDF-SHA512.
///
/// L = 32 for EVERY derived key in this protocol, including `iOSDeviceX` and
/// `AccessoryX` — `const size_t XLength = 32;` at adk_pairsetup.c:963, not the
/// 64 that the surrounding SHA-512 sizes make you expect.
pub fn hkdf_sha512_32(salt: &[u8], ikm: &[u8], info: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    // 32 <= 255*64, so `hkdf` cannot return None here; the fallback keeps this
    // total rather than adding an unwrap.
    if let Some(v) = hkdf::<HkdfSha512>(salt, ikm, info, 32) {
        out.copy_from_slice(&v);
    }
    out
}

// ---------------------------------------------------------------------------
// Wiping
// ---------------------------------------------------------------------------

/// Overwrite a buffer with zeros in a way the optimiser may not remove.
///
/// WHY THIS EXISTS AND WHY IT IS NOT A CRATE. Every secret this module handles
/// — the controller's long-term Ed25519 seed, the SRP session key K, the two
/// pair-setup/pair-verify AEAD keys, the X25519 secret and its shared secret,
/// and both directional session keys — otherwise leaves plaintext copies in
/// freed heap and on the stack. `ed25519_dalek::SigningKey` already wipes
/// itself on drop; nothing else here did. The `zeroize` crate would be the
/// obvious answer and it is already in Cargo.lock transitively, but the rule
/// for this tree is that a manifest edit must be justified and its lockfile
/// diff re-inspected, and this is eleven lines.
///
/// `write_volatile` is what stops dead-store elimination: the compiler is not
/// allowed to reason that nobody reads the zeros back. The fence keeps the
/// writes from being sunk past the end of the function.
pub fn wipe(buf: &mut [u8]) {
    for b in buf.iter_mut() {
        // SAFETY: `b` comes from a live `&mut [u8]`, so it is aligned,
        // dereferenceable and uniquely borrowed for this write.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

/// `wipe` for a `String` whose bytes are secret. Wipes in place and then
/// clears, so the allocation is zero before it is freed.
pub fn wipe_string(s: &mut String) {
    // SAFETY: zeros are valid UTF-8, so the String is still well-formed at
    // every point, and it is cleared immediately afterwards regardless.
    unsafe { wipe(s.as_bytes_mut()) };
    s.clear();
}

// ---------------------------------------------------------------------------
// Key storage
// ---------------------------------------------------------------------------

/// The pairing secrets, in the Keychain, under the per-integration service —
/// the convention `secrets.rs:76-93` set for the Spotify refresh token and
/// `home/keys.rs` already uses for the Home Assistant token. NOT the
/// consolidated "atlas-core" blob: that exists because ten provider keys meant
/// ten consent dialogs, and an integration credential wants the opposite
/// property — unlinking one accessory must delete exactly one item.
///
/// NOTHING IN THIS SECTION RETURNS A PRIVATE KEY TO THE WEBVIEW, writes one to
/// SQLite, or puts one in a log line or an error message. There is no
/// `#[tauri::command]` anywhere in this module, which is what makes that
/// structural rather than a promise.
pub mod keystore {
    use base64::Engine as _;

    /// Shared with `home/keys.rs` on purpose: one service, one consent
    /// decision, several accounts.
    const SERVICE: &str = "atlas-homekit";
    /// The controller's long-term Ed25519 signing key. One per installation,
    /// shared by every accessory we pair with — that is what an
    /// `iOSDevicePairingID` means.
    const LTSK: &str = "hap_ltsk";
    /// Our `iOSDevicePairingID`. Stable forever once minted: it is inside the
    /// signature the accessory stored at pairing time, so changing it orphans
    /// every existing pairing.
    const CONTROLLER_ID: &str = "hap_controller_id";
    const PAIRING_PREFIX: &str = "hap_pairing_";

    /// What survives a successful pair-setup. Everything needed to run
    /// pair-verify later, and nothing else.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct PairingRecord {
        /// The accessory's `id` — the 17-character `XX:XX:XX:XX:XX:XX` from
        /// the Bonjour TXT record, which is its stable identity. Pairings are
        /// matched on this and never on IP or instance name.
        pub accessory_pairing_id: String,
        /// The accessory's long-term Ed25519 PUBLIC key.
        pub accessory_ltpk: [u8; 32],
        /// The identity we presented, so pair-verify signs as the same peer.
        pub controller_pairing_id: String,
    }

    fn account_for(accessory_pairing_id: &str) -> String {
        format!("{PAIRING_PREFIX}{accessory_pairing_id}")
    }

    /// Verbatim the reasoning in `secrets.rs::write_blob` and `keys.rs`: the
    /// default SecItemAdd ACL trusts exactly the binary that created the item,
    /// every rebuild is a different binary, and this project is rebuilt
    /// constantly — so the default produces a Keychain dialog on every launch,
    /// forever. `-A` is the only ACL that survives a rebuild. The threat model
    /// is unchanged from there: any process running as this user can read it,
    /// which is already true of the SQLite file holding the user's mail.
    /// THE VALUE GOES ON STDIN, NOT IN ARGV. `secrets.rs` and `home/keys.rs`
    /// both pass `-w <value>`, and on macOS any process running as this user
    /// can read another's argument vector (KERN_PROCARGS2) for as long as the
    /// child lives. That was defensible for an API token under the same-user
    /// threat model above; this is the first PRIVATE SIGNING KEY to go through
    /// it — the one key that authenticates Atlas to every paired accessory —
    /// and a fourth disclosure channel the header's list does not name.
    ///
    /// With `-w` LAST and no value, `security` prompts on stdin and asks for
    /// the value twice ("password data for new item: / retype password for new
    /// item:"), so it is written twice. Verified by hand against
    /// /usr/bin/security on macOS 26.3. The same change is worth making in
    /// `secrets.rs` and `home/keys.rs`; neither is this module's file.
    fn set_permissive(account: &str, value: &str) -> Result<(), String> {
        use std::io::Write as _;
        use std::process::{Command, Stdio};

        let mut child = Command::new("/usr/bin/security")
            .args(["add-generic-password", "-s", SERVICE, "-a", account, "-A", "-U", "-w"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("security add-generic-password failed to run: {e}"))?;
        {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| "security add-generic-password gave no stdin".to_string())?;
            let mut fed = format!("{value}\n{value}\n");
            let write = stdin.write_all(fed.as_bytes()).and_then(|()| stdin.flush());
            // The prompt copy is gone from this process before anything else
            // happens, whether or not the write succeeded.
            super::wipe_string(&mut fed);
            drop(stdin);
            write.map_err(|e| format!("could not hand the value to security: {e}"))?;
        }
        let out = child
            .wait_with_output()
            .map_err(|e| format!("security add-generic-password did not finish: {e}"))?;
        if out.status.success() {
            return Ok(());
        }
        // The stderr is printed, the VALUE never is.
        eprintln!(
            "[hap] permissive-ACL write failed for {SERVICE}/{account} ({}), falling back to \
             keyring",
            String::from_utf8_lossy(&out.stderr).trim()
        );
        keyring::Entry::new(SERVICE, account)
            .and_then(|e| e.set_password(value))
            .map_err(|e| e.to_string())
    }

    fn read(account: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, account).ok()?.get_password().ok()
    }

    /// The controller's long-term secret key, if one has been minted.
    /// Returned as raw bytes to the pairing code and to nowhere else.
    ///
    /// BOTH INTERMEDIATE COPIES ARE WIPED. The base64 string and the decoded
    /// Vec are as much the private key as the array is, and dropping them
    /// un-wiped leaves the signing key in freed heap for the rest of the
    /// process' life.
    pub fn ltsk() -> Option<[u8; 32]> {
        let mut encoded = read(LTSK)?;
        let decoded = base64::engine::general_purpose::STANDARD.decode(&encoded);
        super::wipe_string(&mut encoded);
        let mut raw = decoded.ok()?;
        let out: Option<[u8; 32]> = raw.as_slice().try_into().ok();
        super::wipe(&mut raw);
        out
    }

    pub fn set_ltsk(secret: &[u8; 32]) -> Result<(), String> {
        let mut encoded = base64::engine::general_purpose::STANDARD.encode(secret);
        let r = set_permissive(LTSK, &encoded);
        super::wipe_string(&mut encoded);
        r
    }

    pub fn controller_id() -> Option<String> {
        read(CONTROLLER_ID).filter(|s| !s.trim().is_empty())
    }

    pub fn set_controller_id(id: &str) -> Result<(), String> {
        if id.trim().is_empty() {
            return Err("refusing to store an empty controller pairing id".into());
        }
        set_permissive(CONTROLLER_ID, id.trim())
    }

    /// Serialised as two base64 fields separated by a space: the record must
    /// round-trip through a Keychain password (a UTF-8 string), and keeping it
    /// in ONE item is what lets `forget_pairing` delete exactly one thing.
    pub fn encode_record(r: &PairingRecord) -> String {
        let e = base64::engine::general_purpose::STANDARD;
        format!("{} {}", e.encode(r.accessory_ltpk), e.encode(r.controller_pairing_id.as_bytes()))
    }

    pub fn decode_record(accessory_pairing_id: &str, stored: &str) -> Option<PairingRecord> {
        let e = base64::engine::general_purpose::STANDARD;
        let (ltpk_b64, id_b64) = stored.split_once(' ')?;
        let ltpk: [u8; 32] = e.decode(ltpk_b64).ok()?.try_into().ok()?;
        let id = String::from_utf8(e.decode(id_b64).ok()?).ok()?;
        Some(PairingRecord {
            accessory_pairing_id: accessory_pairing_id.to_string(),
            accessory_ltpk: ltpk,
            controller_pairing_id: id,
        })
    }

    pub fn set_pairing(r: &PairingRecord) -> Result<(), String> {
        if r.accessory_pairing_id.trim().is_empty() {
            return Err("refusing to store a pairing with no accessory id".into());
        }
        set_permissive(&account_for(&r.accessory_pairing_id), &encode_record(r))
    }

    pub fn pairing(accessory_pairing_id: &str) -> Option<PairingRecord> {
        decode_record(accessory_pairing_id, &read(&account_for(accessory_pairing_id))?)
    }

    /// Missing is success: unlinking an accessory that never finished pairing
    /// must not fail.
    pub fn forget_pairing(accessory_pairing_id: &str) -> Result<(), String> {
        if let Ok(e) = keyring::Entry::new(SERVICE, &account_for(accessory_pairing_id)) {
            let _ = e.delete_password();
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// These do NOT touch the real Keychain — same reasoning as
        /// `keys.rs`: a unit test that wrote to the developer's login keychain
        /// would leave a credential on a machine that never paired anything,
        /// and on CI it would prompt or fail. What IS checkable without one is
        /// the part that has been wrong before: the account names that
        /// unlinking deletes by literal, and the record round-trip.
        #[test]
        fn the_service_is_the_per_integration_one_and_never_the_core_blob() {
            assert_eq!(SERVICE, "atlas-homekit");
            assert_ne!(SERVICE, "atlas-core");
            assert_eq!(account_for("AA:BB:CC:DD:EE:FF"), "hap_pairing_AA:BB:CC:DD:EE:FF");
            assert_eq!(LTSK, "hap_ltsk");
            assert_eq!(CONTROLLER_ID, "hap_controller_id");
        }

        #[test]
        fn an_empty_controller_id_is_refused_before_the_keychain() {
            assert!(set_controller_id("").is_err());
            assert!(set_controller_id("   ").is_err());
        }

        #[test]
        fn a_pairing_record_survives_the_round_trip_through_one_keychain_string() {
            let r = PairingRecord {
                accessory_pairing_id: "AA:BB:CC:DD:EE:FF".into(),
                accessory_ltpk: [7u8; 32],
                controller_pairing_id: "b0c1d2e3-0000-4000-8000-000000000001".into(),
            };
            let s = encode_record(&r);
            assert!(!s.contains('\n'));
            assert_eq!(decode_record("AA:BB:CC:DD:EE:FF", &s), Some(r));
        }

        #[test]
        fn a_corrupt_stored_record_is_none_rather_than_a_panic() {
            for junk in ["", " ", "notbase64 notbase64", "AAAA", "AAAA BBBB", "\u{0}"] {
                assert_eq!(decode_record("x", junk), None, "{junk:?}");
            }
        }

        #[test]
        fn a_pairing_with_no_accessory_id_is_refused_before_the_keychain() {
            let r = PairingRecord {
                accessory_pairing_id: "  ".into(),
                accessory_ltpk: [0u8; 32],
                controller_pairing_id: "x".into(),
            };
            assert!(set_pairing(&r).is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Sha256;

    struct HkdfSha256;
    impl HkdfHash for HkdfSha256 {
        const LEN: usize = 32;
        fn hmac(key: &[u8], parts: &[&[u8]]) -> Vec<u8> {
            let mut mac = Hmac::<Sha256>::new_from_slice(key).unwrap();
            for p in parts {
                mac.update(p);
            }
            mac.finalize().into_bytes().to_vec()
        }
    }

    fn hx(s: &str) -> Vec<u8> {
        srp::unhex(s).expect("test hex")
    }

    /// `wipe` and `wipe_string` do what they say, on the buffer they were
    /// given. WHAT THIS CANNOT PROVE, and the reason it is one small test
    /// rather than a suite: nothing in safe Rust can observe whether a FREED
    /// allocation was zeroed first, so the `Drop` impls on `PairSetup`,
    /// `PairVerify`, `SessionKeys`, `HapSession` and `Paired` are verified by
    /// reading them, not by asserting on them. This pins the primitive those
    /// impls all call.
    #[test]
    fn wiping_leaves_zeros_and_nothing_else() {
        let mut buf = [0xABu8; 32];
        wipe(&mut buf);
        assert_eq!(buf, [0u8; 32]);

        let mut s = String::from("hunter2");
        let ptr = s.as_ptr();
        let cap = s.capacity();
        wipe_string(&mut s);
        assert!(s.is_empty());
        // The allocation itself, not just the length: `clear()` alone would
        // leave the bytes sitting in it.
        // SAFETY: `s` still owns that allocation — `clear` changes the length,
        // never the buffer — so reading `cap` bytes from it is in bounds.
        let raw = unsafe { std::slice::from_raw_parts(ptr, cap) };
        assert!(raw.iter().all(|b| *b == 0), "the String's buffer still holds {raw:?}");
    }

    /// A hash that fails the way `HkdfSha512::hmac`'s error arm does: an empty
    /// vector rather than a panic. Unreachable through `HkdfSha512` today —
    /// HMAC takes a key of any length — but `HkdfHash` is a public trait, so
    /// the next implementor decides that, not this file.
    struct HkdfAlwaysEmpty;
    impl HkdfHash for HkdfAlwaysEmpty {
        const LEN: usize = 64;
        fn hmac(_key: &[u8], _parts: &[&[u8]]) -> Vec<u8> {
            Vec::new()
        }
    }

    /// A ZERO-LENGTH BLOCK ENDS THE EXPAND LOOP INSTEAD OF SPINNING IT.
    ///
    /// With an empty `t`, `take` is 0, `out` never grows and `out.len() <
    /// out_len` stays true forever. Note the failure signal if the guard is
    /// removed: this test HANGS rather than going red, because a hung thread
    /// is precisely the bug. That is worth writing down, so nobody reads a CI
    /// timeout here as flake.
    #[test]
    fn an_hmac_that_returns_nothing_fails_rather_than_looping_forever() {
        assert_eq!(hkdf::<HkdfAlwaysEmpty>(b"salt", b"ikm", b"info", 32), None);
        // Zero bytes out needs no block at all, so it still succeeds.
        assert_eq!(hkdf::<HkdfAlwaysEmpty>(b"salt", b"ikm", b"info", 0), Some(Vec::new()));
    }

    // -- LAYER 1: published vectors ---------------------------------------

    /// RFC 5869 Appendix A.1, verbatim from
    /// https://www.rfc-editor.org/rfc/rfc5869.txt (lines 516-530). SHA-256 —
    /// the RFC publishes SHA-256 and SHA-1 only, and HAP uses SHA-512
    /// exclusively, so this vector proves the extract-then-expand STRUCTURE
    /// and the multi-block expand counter, not the hash HAP uses. The
    /// SHA-512 coverage comes from Wycheproof below.
    #[test]
    fn rfc_5869_a1_sha256_with_salt_and_info() {
        let okm = hkdf::<HkdfSha256>(
            &hx("000102030405060708090a0b0c"),
            &hx("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"),
            &hx("f0f1f2f3f4f5f6f7f8f9"),
            42,
        )
        .unwrap();
        assert_eq!(
            okm,
            hx("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
        );
    }

    /// RFC 5869 Appendix A.3 (lines 598-612): zero-length salt AND info. This
    /// is the case that catches an implementation that forgets "if not
    /// provided, salt is set to a string of HashLen zeros".
    #[test]
    fn rfc_5869_a3_sha256_with_empty_salt_and_info() {
        let okm = hkdf::<HkdfSha256>(
            &[],
            &hx("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"),
            &[],
            42,
        )
        .unwrap();
        assert_eq!(
            okm,
            hx("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8")
        );
    }

    /// Project Wycheproof `testvectors_v1/hkdf_sha512_test.json`
    /// ("algorithm": "HKDF-SHA-512", 83 tests), tcIds 1, 2, 10 and 71 copied
    /// verbatim. HARDCODED rather than fetched: a gate that needs the network
    /// is not a gate.
    ///
    /// tcId 10 is the one that matters — non-empty salt AND info, the only
    /// shape HAP ever uses. tcId 71 is 120 bytes out, which is the only case
    /// here that runs the expand counter past T(1).
    #[test]
    fn wycheproof_hkdf_sha512_cases_1_2_10_and_71() {
        let cases: [(&str, &str, &str, usize, &str); 4] = [
            ("24aeff2645e3e0f5494a9a102778c43a", "", "", 20, "dd2599840b09699c6200b5cba79002b3aa75c61b"),
            (
                "a23632e18ec76b59b1c87008da3f8a7e",
                "",
                "",
                42,
                "c4af93d4bae9ca2b45f590cd3d2f539ff5749d7b0864fbe44a438d38a2f8e5afe01641145e389c989766",
            ),
            (
                "c360e16084cfd13cb44b0dc02d8665de",
                "685ac7df93701d6c78babd847861bb3c",
                "e0ddfaaaa7afb53f59a007a205c7149b5b5a72be",
                20,
                "17408c6f8dd7eb8423758ce39a91b59020f7debe",
            ),
            (
                "c132ac861d00e8aa82470baf3be3851c9f77f96b19cc2c3eb5558c20915ad16c\
                 b45c50db9b230c5279bf7b38fbf50ce68b60d7b230530f3a5f4016883f217168",
                "4c3582c867fab84ca075da5aef6b78b8db982ee4fe33fb4500294659aad63dd7\
                 677f2f256bf719c6796ea8fdf12c46863064875a529aeef9318f344335610f82",
                "7573b95f1d8ee5d0",
                120,
                "d93663825963a4a2328a6e56ee7d108de95b7c981c3e62dc8df40105e4995137\
                 ca8cfa91cbffb447ffd80b0b901578aaabc6c56b3aa66734fbe98b95c1125990\
                 e14533e13d049f025880fb2834c8e5e2bbc8719deb3b207429397c19beb0160f\
                 46441f95f8b11ab2ead32c64c12d9f46d6aaa58f9e685771",
            ),
        ];
        for (ikm, salt, info, size, okm) in cases {
            assert_eq!(
                hkdf::<HkdfSha512>(&hx(salt), &hx(ikm), &hx(info), size).unwrap(),
                hx(okm),
                "wycheproof case ikm={ikm}"
            );
        }
    }

    /// L = 32 is the ONLY length HAP asks for, and the wrapper must agree with
    /// the general function rather than being a second implementation.
    #[test]
    fn the_32_byte_wrapper_agrees_with_the_general_function() {
        let got = hkdf_sha512_32(b"Pair-Setup-Encrypt-Salt", &[9u8; 64], b"Pair-Setup-Encrypt-Info");
        let want = hkdf::<HkdfSha512>(
            b"Pair-Setup-Encrypt-Salt",
            &[9u8; 64],
            b"Pair-Setup-Encrypt-Info",
            32,
        )
        .unwrap();
        assert_eq!(&got[..], &want[..]);
    }

    /// RFC 5869 §2.3 caps L at 255·HashLen. Wrapping the counter instead of
    /// refusing would emit a key that silently repeats.
    #[test]
    fn an_over_long_expansion_is_refused_rather_than_wrapping_the_counter() {
        assert!(hkdf::<HkdfSha512>(b"s", b"k", b"i", 255 * 64).is_some());
        assert!(hkdf::<HkdfSha512>(b"s", b"k", b"i", 255 * 64 + 1).is_none());
    }

    // -- constant-time compare --------------------------------------------

    #[test]
    fn ct_eq_agrees_with_equality_including_a_first_byte_difference() {
        assert!(ct_eq(b"", b""));
        assert!(ct_eq(&[1u8; 64], &[1u8; 64]));
        let mut a = [1u8; 64];
        let mut b = [1u8; 64];
        b[0] = 2;
        assert!(!ct_eq(&a, &b));
        a[63] = 3;
        assert!(!ct_eq(&a, &[1u8; 64]));
        assert!(!ct_eq(b"abc", b"abcd"));
    }

    /// The property that matters is that no input makes it return early. It
    /// cannot be measured in a unit test, so what IS pinned is the shape:
    /// a fold over the whole slice. This test fails if someone rewrites it as
    /// `a == b` or adds a `.take_while`, because those would stop caring about
    /// bytes after the first difference — demonstrated by two inputs that
    /// differ ONLY in the last byte and two that differ only in the first.
    #[test]
    fn ct_eq_looks_at_every_byte_not_just_the_first_difference() {
        let base = [0u8; 32];
        for i in 0..32 {
            let mut other = base;
            other[i] = 1;
            assert!(!ct_eq(&base, &other), "byte {i} ignored");
        }
    }
}
