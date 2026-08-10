// Pair-verify M1..M4 — the controller half.
//
// Pair-setup (pairing.rs) runs ONCE per accessory and leaves a long-term
// Ed25519 pairing behind. THIS exchange runs on EVERY connection, every time:
// it is how a fresh TCP socket becomes an authenticated, encrypted session. It
// proves — mutually, with Ed25519 signatures over the two ephemeral Curve25519
// public keys — that both ends still hold the long-term keys they agreed at
// pairing time, and it produces the two directional keys `session.rs` frames
// with.
//
// EVERY CONSTANT BELOW WAS READ OUT OF APPLE'S OWN ACCESSORY IMPLEMENTATION,
// `apple/HomeKitADK` (Apache-2.0), file and line recorded. Same reason as
// pairing.rs: a wrong HKDF info string produces code that compiles, passes
// every local test, and fails only against a real accessory — and no real
// accessory exists on this machine (the HomeKit Accessory Simulator ships in
// "Additional Tools for Xcode" and is not installed).
//
// THE THREE ASYMMETRIES THAT WILL BREAK THIS, each of which looks like a typo
// and is not:
//   1. The two signed infos are MIRRORS, not copies. M2 signs
//      AccessoryCvPK ‖ AccessoryPairingID ‖ iOSDeviceCvPK; M3 signs
//      iOSDeviceCvPK ‖ iOSDevicePairingID ‖ AccessoryCvPK.
//   2. The `Control-*` keys are derived from the RAW X25519 shared secret, NOT
//      from the pair-verify SessionKey that the same secret also produces.
//   3. The key names are from the CONTROLLER's point of view. The accessory's
//      outbound channel is keyed with "Control-Read-Encryption-Key" because
//      that is what the controller reads. So: we decrypt with Read, encrypt
//      with Write.
//
// TRANSPORT, for http.rs: POST /pair-verify, Content-Type
// `application/pairing+tlv8`, UNENCRYPTED, on a connection that has no session
// yet. The moment M4 comes back without an Error the SAME socket switches to
// the encrypted framing in `session.rs`, in both directions, with no further
// handshake bytes.

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, KeyInit, Nonce};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
// The bare `x25519` function rather than `StaticSecret`/`EphemeralSecret`.
// Two reasons, in order: `StaticSecret` is behind x25519-dalek's
// `static_secrets` feature, which this crate's manifest does not enable and
// which is not this change's to add; and `EphemeralSecret` cannot be built
// from fixed bytes, so using it would cost the deterministic seam the loopback
// test needs. The free function clamps its scalar exactly as RFC 7748's
// decodeScalar25519 requires, so nothing is lost but the wrapper.
use x25519_dalek::{x25519, X25519_BASEPOINT_BYTES};

use super::keystore::PairingRecord;
use super::pairing::{accessory_error, message_nonce};
use super::tlv::{self, Tlv, TlvError};
use super::hkdf_sha512_32;

// ---------------------------------------------------------------------------
// The strings — Layer 2 of the verification strategy
// ---------------------------------------------------------------------------
//
// Every one of these is a C string literal used with `sizeof - 1`, i.e.
// WITHOUT its terminating NUL. Passing `sizeof` instead is the classic form of
// this bug and silently changes every derived key, which is why
// `the_pair_verify_strings_are_the_adk_strings_with_no_trailing_nul` pins the
// lengths as well as the bytes.

/// adk_HAPPairingPairVerify.c:495-496. Keys the M2/M3 sub-TLVs only.
pub const VERIFY_ENCRYPT_SALT: &[u8] = b"Pair-Verify-Encrypt-Salt";
pub const VERIFY_ENCRYPT_INFO: &[u8] = b"Pair-Verify-Encrypt-Info";

/// adk_HAPPairingPairVerify.c:40. One salt, two infos.
pub const CONTROL_SALT: &[u8] = b"Control-Salt";
/// adk_HAPPairingPairVerify.c:42 — the accessory's OUTBOUND channel, so from
/// here it is the key we READ with.
pub const CONTROL_READ_INFO: &[u8] = b"Control-Read-Encryption-Key";
/// adk_HAPPairingPairVerify.c:59 — the accessory's INBOUND channel, so from
/// here it is the key we WRITE with.
pub const CONTROL_WRITE_INFO: &[u8] = b"Control-Write-Encryption-Key";

/// adk_HAPPairingPairVerify.c:516 and :772.
pub const NONCE_MSG02: &[u8; 8] = b"PV-Msg02";
pub const NONCE_MSG03: &[u8; 8] = b"PV-Msg03";

/// NOT IMPLEMENTED, listed so nobody wires them up by accident. Pair Resume
/// (`kTLVType_SessionID`, the `Pair-Verify-ResumeSessionID-*` derivations) and
/// broadcast encryption are BLE-side optimisations; over IP we always run the
/// full four-message verify.
pub const RESUME_NOT_IMPLEMENTED: &[&str] =
    &["Pair-Verify-ResumeSessionID-Salt", "Pair-Verify-ResumeSessionID-Info"];

const STATE_M1: u8 = 0x01;
const STATE_M2: u8 = 0x02;
const STATE_M3: u8 = 0x03;
const STATE_M4: u8 = 0x04;

/// X25519 public keys and shared secrets are 32 bytes; Ed25519 signatures 64.
const X25519_BYTES: usize = 32;
const ED25519_SIG_BYTES: usize = 64;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Pair-verify has its own error type rather than reusing `PairError`, because
/// its failures answer a different question. `PairError` is about a setup code
/// a human typed; these are about a pairing that already exists and a peer that
/// may not be the one we paired with. In particular `WrongAccessory` has no
/// pair-setup analogue and must not be flattened into "malformed".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// The accessory answered with a `kTLVType_Error`.
    Accessory(u8),
    Tlv(TlvError),
    /// The reply parsed but did not say what the protocol requires.
    Protocol(String),
    /// The accessory named a different pairing id than the one we hold a key
    /// for. Not a transport fault: a different identity is a different device,
    /// whatever the IP address says.
    WrongAccessory { expected: String, got: String },
    /// The Ed25519 signature over `AccessoryInfo` did not verify under the
    /// long-term public key we stored at pairing time.
    SignatureInvalid,
    /// AEAD failure — wrong key, wrong nonce, or a tampered ciphertext.
    /// Deliberately undifferentiated: the tag check cannot tell us which.
    Decrypt,
    /// The X25519 exchange produced the all-zero shared secret, which means the
    /// peer sent a small-order point (RFC 7748 §6.1). Continuing would key the
    /// session with a value the peer chose unilaterally.
    WeakKey,
    /// A method was called out of order.
    OutOfOrder,
    /// The OS would not provide randomness. Nothing may proceed without it.
    NoEntropy,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::Accessory(c) => match *c {
                accessory_error::AUTHENTICATION => write!(
                    f,
                    "the accessory no longer recognises this pairing — it has probably been reset \
                     or paired with something else"
                ),
                accessory_error::MAX_PEERS => {
                    write!(f, "the accessory has no room for another session")
                }
                accessory_error::BUSY => write!(f, "the accessory is busy with another controller"),
                accessory_error::UNAVAILABLE => write!(f, "the accessory refused a new session"),
                other => write!(f, "the accessory refused the connection (code {other})"),
            },
            VerifyError::Tlv(e) => write!(f, "the accessory's reply was not valid TLV8: {e}"),
            VerifyError::Protocol(m) => write!(f, "the accessory's reply did not make sense: {m}"),
            VerifyError::WrongAccessory { expected, got } => write!(
                f,
                "that is not the accessory Atlas paired with — expected {expected}, it said {got}"
            ),
            VerifyError::SignatureInvalid => write!(
                f,
                "the accessory could not prove it still holds the key Atlas paired with"
            ),
            VerifyError::Decrypt => {
                write!(f, "the accessory's encrypted reply could not be decrypted")
            }
            VerifyError::WeakKey => {
                write!(f, "the accessory offered a key exchange value Atlas will not use")
            }
            VerifyError::OutOfOrder => write!(f, "pair-verify steps were run out of order"),
            VerifyError::NoEntropy => write!(f, "the system would not provide secure randomness"),
        }
    }
}

impl From<TlvError> for VerifyError {
    fn from(e: TlvError) -> VerifyError {
        VerifyError::Tlv(e)
    }
}

/// Chosen by WHICH FIX APPLIES, the rule `home/mod.rs` states. A wrong
/// accessory or a failed signature needs the user to re-pair, which is an
/// authorisation problem; a busy accessory needs a wait.
impl From<VerifyError> for crate::home::HomeError {
    fn from(e: VerifyError) -> crate::home::HomeError {
        use crate::home::HomeError as H;
        let msg = e.to_string();
        match e {
            VerifyError::OutOfOrder | VerifyError::NoEntropy | VerifyError::WeakKey => {
                H::Refused(msg)
            }
            VerifyError::SignatureInvalid
            | VerifyError::WrongAccessory { .. }
            | VerifyError::Accessory(accessory_error::AUTHENTICATION) => H::Unauthorised(msg),
            VerifyError::Accessory(_) => H::Unreachable(msg),
            VerifyError::Tlv(_) | VerifyError::Protocol(_) | VerifyError::Decrypt => {
                H::Malformed(msg)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The session keys
// ---------------------------------------------------------------------------

/// The output of a successful pair-verify: one key per direction.
///
/// NAMED FROM THE CONTROLLER'S SIDE, matching the ADK's info strings. Swapping
/// them produces a session where every single frame fails its tag check, which
/// is at least a loud failure — but it looks exactly like a wrong long-term key,
/// so the names are worth being pedantic about.
#[derive(Clone, PartialEq, Eq)]
pub struct SessionKeys {
    /// Decrypts accessory → controller frames.
    pub read: [u8; 32],
    /// Encrypts controller → accessory frames.
    pub write: [u8; 32],
}

/// Both keys are wiped when this value dies. `HapSession` copies them into
/// itself and wipes its own copies the same way; the point is that neither
/// copy is left in freed memory.
impl Drop for SessionKeys {
    fn drop(&mut self) {
        super::wipe(&mut self.read);
        super::wipe(&mut self.write);
    }
}

/// Hand-written so a stray `{:?}` in a log line cannot print session keys. The
/// same rule `keys.rs` states for the long-term secret applies to these: they
/// never reach the webview, SQLite, a log line or an error message.
impl std::fmt::Debug for SessionKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionKeys(redacted)")
    }
}

impl SessionKeys {
    /// Both keys, from the RAW X25519 shared secret. NOT from the pair-verify
    /// `SessionKey` — that is a different HKDF over the same ikm, and using it
    /// here is a mistake that no local test can catch.
    /// adk_HAPPairingPairVerify.c:38-77.
    pub fn derive(shared_secret: &[u8; 32]) -> SessionKeys {
        SessionKeys {
            read: hkdf_sha512_32(CONTROL_SALT, shared_secret, CONTROL_READ_INFO),
            write: hkdf_sha512_32(CONTROL_SALT, shared_secret, CONTROL_WRITE_INFO),
        }
    }
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Fresh,
    AwaitingM2,
    AwaitingM4,
    Done,
    Failed,
}

pub struct PairVerify {
    /// What pair-setup persisted: who the accessory is and its long-term
    /// public key, plus the identity we must keep presenting.
    record: PairingRecord,
    ltsk: SigningKey,
    /// Our ephemeral Curve25519 secret. FRESH PER CONNECTION — minted in `new`
    /// and never stored, reused or returned. It is held as raw bytes because
    /// `x25519` takes them that way; see the import comment.
    cv_sk: [u8; 32],
    cv_pk: [u8; 32],
    stage: Stage,

    accessory_cv_pk: [u8; 32],
    shared: [u8; 32],
    /// HKDF output that encrypts M3 and decrypts M2. Distinct from the two
    /// control keys, which come from the same ikm under different info.
    session_key: [u8; 32],
}

/// Everything secret in a pair-verify dies with it. `ltsk` is an
/// `ed25519_dalek::SigningKey`, which is already `ZeroizeOnDrop`; the three
/// raw arrays below were not, and one of them — `shared` — is the ikm both
/// directional session keys are derived from.
impl Drop for PairVerify {
    fn drop(&mut self) {
        super::wipe(&mut self.cv_sk);
        super::wipe(&mut self.shared);
        super::wipe(&mut self.session_key);
    }
}

impl PairVerify {
    /// `ltsk` is the controller's long-term Ed25519 secret, loaded from the
    /// Keychain by the caller. It never leaves this process.
    pub fn new(record: &PairingRecord, ltsk: &[u8; 32]) -> Result<PairVerify, VerifyError> {
        let mut seed = [0u8; 32];
        getrandom::getrandom(&mut seed).map_err(|_| VerifyError::NoEntropy)?;
        PairVerify::with_ephemeral(record, ltsk, seed)
    }

    /// The deterministic seam. Production always goes through `new`; this
    /// exists so the loopback test can pin both ephemerals and so a future
    /// transcript replay is possible at all.
    pub fn with_ephemeral(
        record: &PairingRecord,
        ltsk: &[u8; 32],
        ephemeral: [u8; 32],
    ) -> Result<PairVerify, VerifyError> {
        if record.controller_pairing_id.is_empty() || record.controller_pairing_id.len() > 255 {
            return Err(VerifyError::Protocol(
                "the controller pairing id must be 1..=255 bytes".into(),
            ));
        }
        if record.accessory_pairing_id.is_empty() {
            return Err(VerifyError::Protocol("the pairing has no accessory id".into()));
        }
        // Rejected here rather than at M2: a stored public key that is not a
        // valid Ed25519 point can never verify anything, and finding that out
        // after two round trips would blame the accessory for our own record.
        if VerifyingKey::from_bytes(&record.accessory_ltpk).is_err() {
            return Err(VerifyError::Protocol(
                "the stored accessory key is not a valid Ed25519 public key".into(),
            ));
        }
        let cv_pk = x25519(ephemeral, X25519_BASEPOINT_BYTES);
        Ok(PairVerify {
            record: record.clone(),
            ltsk: SigningKey::from_bytes(ltsk),
            cv_sk: ephemeral,
            cv_pk,
            stage: Stage::Fresh,
            accessory_cv_pk: [0u8; 32],
            shared: [0u8; 32],
            session_key: [0u8; 32],
        })
    }

    /// M1: `State = 1` and our ephemeral public key.
    ///
    /// The `Method` TLV is OMITTED — deliberately. The ADK defaults an absent
    /// Method to PairVerify and REJECTS any present Method that is not
    /// PairResume (adk_HAPPairingPairVerify.c:183-196), so helpfully sending
    /// `Method = 0x02` would get the message refused. This is the exact
    /// opposite of pair-setup M1, where Method is required.
    pub fn start(&mut self) -> Result<Vec<u8>, VerifyError> {
        if self.stage != Stage::Fresh {
            return Err(VerifyError::OutOfOrder);
        }
        let body = tlv::encode(&[
            Tlv::byte(tlv::TYPE_STATE, STATE_M1),
            Tlv::new(tlv::TYPE_PUBLIC_KEY, self.cv_pk.to_vec()),
        ])?;
        self.stage = Stage::AwaitingM2;
        Ok(body)
    }

    /// M2 in, M3 out.
    ///
    /// M2 is where the accessory proves itself. Skipping the signature check
    /// would leave us running an authenticated-looking session with whatever
    /// answered the socket — the ECDH alone is unauthenticated and gives a
    /// man in the middle a perfectly good shared secret.
    pub fn handle_m2(&mut self, body: &[u8]) -> Result<Vec<u8>, VerifyError> {
        self.expect(Stage::AwaitingM2)?;
        let items = self.parse(body, STATE_M2)?;

        let their_pk = tlv::get(&items, tlv::TYPE_PUBLIC_KEY)
            .ok_or_else(|| self.fail(VerifyError::Protocol("M2 has no public key".into())))?;
        let their_pk: [u8; X25519_BYTES] = their_pk.try_into().map_err(|_| {
            self.fail(VerifyError::Protocol(format!(
                "M2's public key is {} bytes, expected 32",
                tlv::get(&items, tlv::TYPE_PUBLIC_KEY).map(|v| v.len()).unwrap_or(0)
            )))
        })?;

        let shared = x25519(self.cv_sk, their_pk);
        // RFC 7748 §6.1: an all-zero result means the peer sent a small-order
        // point, so IT chose the secret rather than the exchange producing one.
        // This is what `SharedSecret::was_contributory` checks in the wrapper
        // types we cannot use here; the check is the whole of it.
        if shared == [0u8; 32] {
            return Err(self.fail(VerifyError::WeakKey));
        }
        let session_key = hkdf_sha512_32(VERIFY_ENCRYPT_SALT, &shared, VERIFY_ENCRYPT_INFO);

        let sealed = tlv::get(&items, tlv::TYPE_ENCRYPTED_DATA)
            .ok_or_else(|| self.fail(VerifyError::Protocol("M2 has no encrypted data".into())))?;
        let plain = match open(&session_key, NONCE_MSG02, sealed) {
            Some(p) => p,
            None => return Err(self.fail(VerifyError::Decrypt)),
        };
        let sub = match tlv::decode(&plain) {
            Ok(s) => s,
            Err(e) => return Err(self.fail(VerifyError::Tlv(e))),
        };

        let id = tlv::get(&sub, tlv::TYPE_IDENTIFIER)
            .ok_or_else(|| self.fail(VerifyError::Protocol("M2 has no accessory id".into())))?
            .to_vec();
        let id = String::from_utf8(id).map_err(|_| {
            self.fail(VerifyError::Protocol("M2's accessory id is not UTF-8".into()))
        })?;
        // Identity first, signature second. A signature that verifies under
        // OUR stored key while naming a different accessory would mean the
        // pairing table and the peer disagree, and there is no reading of that
        // which should produce a session.
        if id != self.record.accessory_pairing_id {
            return Err(self.fail(VerifyError::WrongAccessory {
                expected: self.record.accessory_pairing_id.clone(),
                got: id,
            }));
        }

        let sig = tlv::get(&sub, tlv::TYPE_SIGNATURE)
            .ok_or_else(|| self.fail(VerifyError::Protocol("M2 has no signature".into())))?;
        let sig: [u8; ED25519_SIG_BYTES] = sig.try_into().map_err(|_| {
            self.fail(VerifyError::Protocol(format!(
                "M2's signature is {} bytes, expected 64",
                tlv::get(&sub, tlv::TYPE_SIGNATURE).map(|v| v.len()).unwrap_or(0)
            )))
        })?;

        // AccessoryInfo = AccessoryCvPK ‖ AccessoryPairingID ‖ iOSDeviceCvPK.
        // adk_HAPPairingPairVerify.c:466-476. Note the order: THEIR curve key,
        // THEIR id, OUR curve key. M3 below is the mirror, not a copy.
        let info = concat_info(&their_pk, id.as_bytes(), &self.cv_pk);
        let key = match VerifyingKey::from_bytes(&self.record.accessory_ltpk) {
            Ok(k) => k,
            Err(_) => return Err(self.fail(VerifyError::SignatureInvalid)),
        };
        // `verify_strict` rather than `verify`: it rejects small-order and
        // non-canonical keys, which is the difference between "a signature
        // verified" and "a signature only one party could have produced".
        if key.verify_strict(&info, &Signature::from_bytes(&sig)).is_err() {
            return Err(self.fail(VerifyError::SignatureInvalid));
        }

        // iOSDeviceInfo = iOSDeviceCvPK ‖ iOSDevicePairingID ‖ AccessoryCvPK.
        // adk_HAPPairingPairVerify.c:860-870 — OUR curve key, OUR id, THEIR
        // curve key. Mirrored from the one above; writing it as a copy is the
        // single easiest way to break this file.
        let our_info =
            concat_info(&self.cv_pk, self.record.controller_pairing_id.as_bytes(), &their_pk);
        let signature: Signature = self.ltsk.sign(&our_info);

        let inner = tlv::encode(&[
            Tlv::new(tlv::TYPE_IDENTIFIER, self.record.controller_pairing_id.as_bytes().to_vec()),
            Tlv::new(tlv::TYPE_SIGNATURE, signature.to_bytes().to_vec()),
        ])?;
        let sealed = match seal(&session_key, NONCE_MSG03, &inner) {
            Some(c) => c,
            None => return Err(self.fail(VerifyError::Decrypt)),
        };
        let out = tlv::encode(&[
            Tlv::byte(tlv::TYPE_STATE, STATE_M3),
            Tlv::new(tlv::TYPE_ENCRYPTED_DATA, sealed),
        ])?;

        self.accessory_cv_pk = their_pk;
        self.shared = shared;
        self.session_key = session_key;
        self.stage = Stage::AwaitingM4;
        Ok(out)
    }

    /// M4 in, the session keys out.
    ///
    /// M4 carries `State = 4` and, on success, NOTHING else — there is no
    /// payload to check, so the whole content of "it worked" is the absence of
    /// a `kTLVType_Error`. That is why `parse` surfaces an Error TLV before it
    /// looks at anything else.
    pub fn handle_m4(&mut self, body: &[u8]) -> Result<SessionKeys, VerifyError> {
        self.expect(Stage::AwaitingM4)?;
        let _ = self.parse(body, STATE_M4)?;
        self.stage = Stage::Done;
        Ok(SessionKeys::derive(&self.shared))
    }

    /// Our ephemeral public key, for tests and for a caller that wants to log
    /// the exchange. Public by construction — it goes out in M1 in the clear.
    pub fn controller_cv_pk(&self) -> [u8; 32] {
        self.cv_pk
    }

    fn expect(&mut self, want: Stage) -> Result<(), VerifyError> {
        if self.stage != want {
            self.stage = Stage::Failed;
            return Err(VerifyError::OutOfOrder);
        }
        Ok(())
    }

    /// Any failure poisons the exchange. Resuming a half-failed verify would
    /// let a replayed M2 have a second attempt against the same ephemeral.
    fn fail(&mut self, e: VerifyError) -> VerifyError {
        self.stage = Stage::Failed;
        e
    }

    fn parse(&mut self, body: &[u8], want_state: u8) -> Result<Vec<Tlv>, VerifyError> {
        let items = match tlv::decode(body) {
            Ok(i) => i,
            Err(e) => return Err(self.fail(VerifyError::Tlv(e))),
        };
        if let Some(code) = tlv::get_byte(&items, tlv::TYPE_ERROR) {
            return Err(self.fail(VerifyError::Accessory(code)));
        }
        match tlv::get_byte(&items, tlv::TYPE_STATE) {
            Some(s) if s == want_state => Ok(items),
            Some(s) => Err(self.fail(VerifyError::Protocol(format!(
                "expected state {want_state}, got {s}"
            )))),
            None => Err(self.fail(VerifyError::Protocol("the reply carries no state".into()))),
        }
    }
}

/// The signed infos are raw concatenation — no separators, no length prefixes.
/// Factored out so the two call sites cannot drift apart in FORM while staying
/// deliberately different in ORDER.
fn concat_info(first_key: &[u8; 32], id: &[u8], second_key: &[u8; 32]) -> Vec<u8> {
    let mut v = Vec::with_capacity(64 + id.len());
    v.extend_from_slice(first_key);
    v.extend_from_slice(id);
    v.extend_from_slice(second_key);
    v
}

// ---------------------------------------------------------------------------
// AEAD for the two pair-verify messages
// ---------------------------------------------------------------------------

/// ChaCha20-Poly1305 with an EMPTY AAD and the right-aligned 8-byte message
/// tag as nonce, exactly as pair-setup uses. (The encrypted SESSION frames in
/// `session.rs` use a counter nonce and the 2-byte length prefix as AAD — a
/// different layer with different rules; do not merge these.)
fn seal(key: &[u8; 32], tag: &[u8; 8], plaintext: &[u8]) -> Option<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = message_nonce(tag);
    cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: &[] }).ok()
}

fn open(key: &[u8; 32], tag: &[u8; 8], sealed: &[u8]) -> Option<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = message_nonce(tag);
    cipher.decrypt(Nonce::from_slice(&nonce), Payload { msg: sealed, aad: &[] }).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::home::hap::srp::unhex;

    fn hx(s: &str) -> Vec<u8> {
        unhex(s).expect("test hex")
    }

    fn a32(s: &str) -> [u8; 32] {
        hx(s).try_into().expect("32 bytes")
    }

    // =======================================================================
    // LAYER 1 — published vectors. These prove the primitives really are the
    // primitives, independently of anything transcribed from the ADK.
    // =======================================================================

    /// RFC 7748 §5.2, both vectors, verbatim from
    /// https://www.rfc-editor.org/rfc/rfc7748.txt (lines 575-601).
    ///
    /// These drive the bare X25519 function — a scalar and an arbitrary
    /// u-coordinate — which is the layer under `diffie_hellman`. The §5.2
    /// inputs are the inputs to X25519() as the RFC defines it, i.e. including
    /// decodeScalar25519's clamping, which is what `x25519_dalek::x25519` does.
    #[test]
    fn rfc_7748_section_5_2_scalar_multiplication() {
        let cases = [
            (
                "a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4",
                "e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c",
                "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
            ),
            (
                "4b66e9d4d1b4673c5ad22691957d6af5c11b6421e0ea01d42ca4169e7918ba0d",
                "e5210f12786811d3f4b7959d0538ae2c31dbe7106fc03c3efc4cd549c715a493",
                "95cbde9476e8907d7aade45cb4b873f88b595a68799fa152e6f8f7647aac7957",
            ),
        ];
        for (k, u, want) in cases {
            assert_eq!(x25519(a32(k), a32(u)), a32(want), "scalar {k}");
        }
    }

    /// RFC 7748 §6.1 (lines 766-777) — the full ECDH, which is the exact shape
    /// pair-verify runs: each side derives a public key from a private one and
    /// both reach the same 32-byte secret. This vector is the reason the
    /// key-agreement half needs no accessory to be believed.
    #[test]
    fn rfc_7748_section_6_1_full_diffie_hellman() {
        let alice_sk = a32("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
        let bob_sk = a32("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
        // The public key is the scalar times the basepoint — the exact
        // derivation `with_ephemeral` performs.
        let alice_pk = x25519(alice_sk, X25519_BASEPOINT_BYTES);
        let bob_pk = x25519(bob_sk, X25519_BASEPOINT_BYTES);
        assert_eq!(
            alice_pk,
            a32("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
        );
        assert_eq!(
            bob_pk,
            a32("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
        );

        let want = a32("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
        assert_eq!(x25519(alice_sk, bob_pk), want);
        assert_eq!(x25519(bob_sk, alice_pk), want);
        assert_ne!(want, [0u8; 32]);
    }

    /// RFC 8032 §7.1 TEST 3 (lines 1301-1371), verbatim. pairing.rs already
    /// runs all three; this one is repeated here because pair-verify's whole
    /// authentication is Ed25519 over a concatenation, and a file whose only
    /// signature evidence lives in a sibling module is one refactor away from
    /// having none. It also pins the key-derivation direction: the public key
    /// in the vector must fall out of the secret.
    #[test]
    fn rfc_8032_ed25519_test_3() {
        let sk = SigningKey::from_bytes(&a32(
            "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
        ));
        assert_eq!(
            sk.verifying_key().to_bytes(),
            a32("fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025")
        );
        let sig = sk.sign(&hx("af82"));
        assert_eq!(
            sig.to_bytes().to_vec(),
            hx("6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac\
                18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a")
        );
        assert!(sk.verifying_key().verify_strict(&hx("af82"), &sig).is_ok());
    }

    /// The all-zero shared secret is what a small-order peer key produces, and
    /// it is the one X25519 output that must never key a session. RFC 7748 §6.1
    /// names exactly this check.
    ///
    /// Driven through the real state machine, not just the primitive: an
    /// accessory offering a small-order public key must be REFUSED at M2, and
    /// no session may come out of it.
    #[test]
    fn a_small_order_peer_key_is_refused_rather_than_keyed_with() {
        // The canonical low-order u-coordinates: 0, 1, the two order-8 points,
        // and p-1, p, p+1 (the field-order aliases of 0 and 1). Every one of
        // them takes any scalar to zero.
        let small_order = [
            a32("0000000000000000000000000000000000000000000000000000000000000000"),
            a32("0100000000000000000000000000000000000000000000000000000000000000"),
            a32("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
            a32("5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157"),
            a32("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
            a32("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
            a32("eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f"),
        ];
        for pk in small_order {
            assert_eq!(x25519([9u8; 32], pk), [0u8; 32], "point {pk:?} was not small order");
        }

        let (_, acc) = paired();
        let mut pv =
            PairVerify::with_ephemeral(&record(acc.ltpk()), &controller_ltsk(), [0x44u8; 32])
                .unwrap();
        let _ = pv.start().unwrap();
        let m2 = tlv::encode(&[
            Tlv::byte(tlv::TYPE_STATE, 2),
            Tlv::new(tlv::TYPE_PUBLIC_KEY, vec![0u8; 32]),
            Tlv::new(tlv::TYPE_ENCRYPTED_DATA, vec![0u8; 48]),
        ])
        .unwrap();
        assert_eq!(pv.handle_m2(&m2), Err(VerifyError::WeakKey));
    }

    // =======================================================================
    // LAYER 2 — the HAP composition, pinned as bytes. This proves nothing was
    // MISTYPED. It cannot prove the transcription from the ADK was right; the
    // mitigation for that is that every line number above is re-checkable.
    // =======================================================================

    /// `sizeof salt - 1` at every ADK call site, i.e. no terminating NUL. The
    /// lengths are asserted as well as the bytes because a stray NUL is
    /// invisible in a diff and changes every derived key.
    #[test]
    fn the_pair_verify_strings_are_the_adk_strings_with_no_trailing_nul() {
        for (s, want, len) in [
            (VERIFY_ENCRYPT_SALT, "Pair-Verify-Encrypt-Salt", 24),
            (VERIFY_ENCRYPT_INFO, "Pair-Verify-Encrypt-Info", 24),
            (CONTROL_SALT, "Control-Salt", 12),
            (CONTROL_READ_INFO, "Control-Read-Encryption-Key", 27),
            (CONTROL_WRITE_INFO, "Control-Write-Encryption-Key", 28),
        ] {
            assert_eq!(s, want.as_bytes(), "{want}");
            assert_eq!(s.len(), len, "{want} length");
            assert!(!s.contains(&0), "{want} has a NUL");
        }
        assert_eq!(NONCE_MSG02, b"PV-Msg02");
        assert_eq!(NONCE_MSG03, b"PV-Msg03");
        assert_eq!(NONCE_MSG02.len(), 8);
        assert_eq!(NONCE_MSG03.len(), 8);
    }

    /// The nonces are the 8 ASCII bytes RIGHT-ALIGNED in a zeroed 12-byte
    /// buffer (HAPMbedTLS.c:539-546). Left-aligning is a silent total failure,
    /// so the exact bytes are pinned here as well as in pairing.rs.
    #[test]
    fn the_pair_verify_nonces_are_four_zero_bytes_then_the_tag() {
        assert_eq!(message_nonce(NONCE_MSG02).to_vec(), hx("0000000050562d4d73673032"));
        assert_eq!(message_nonce(NONCE_MSG03).to_vec(), hx("0000000050562d4d73673033"));
    }

    /// The two control keys must differ from each other AND from the
    /// pair-verify SessionKey derived from the same shared secret. All three
    /// come from one ikm, so a copy-pasted info string produces a key that is
    /// silently the wrong one — this is the test that catches it.
    #[test]
    fn the_two_control_keys_and_the_message_key_are_three_different_keys() {
        let shared = [0x5Au8; 32];
        let keys = SessionKeys::derive(&shared);
        let msg_key = hkdf_sha512_32(VERIFY_ENCRYPT_SALT, &shared, VERIFY_ENCRYPT_INFO);
        assert_ne!(keys.read, keys.write);
        assert_ne!(keys.read, msg_key);
        assert_ne!(keys.write, msg_key);
        // And the derivation is the raw secret, not a hash of it: deriving from
        // SHA-512(shared) — an easy and plausible slip — must give something
        // else entirely.
        let wrong = SessionKeys::derive(&hkdf_sha512_32(CONTROL_SALT, &shared, CONTROL_SALT));
        assert_ne!(wrong.read, keys.read);
    }

    /// `Debug` must not print key material. A `{:?}` on a struct holding a
    /// session is the most likely accidental disclosure path there is.
    #[test]
    fn session_keys_do_not_print_themselves() {
        let s = SessionKeys { read: [0xABu8; 32], write: [0xCDu8; 32] };
        let shown = format!("{s:?}");
        assert_eq!(shown, "SessionKeys(redacted)");
        assert!(!shown.contains("ab") && !shown.contains("171"));
    }

    /// M1 must NOT carry a Method TLV — the accessory rejects any Method that
    /// is not PairResume (adk_HAPPairingPairVerify.c:183-196). This is the
    /// opposite of pair-setup M1, and it is exactly the kind of symmetry a
    /// later edit "tidies up".
    #[test]
    fn m1_omits_the_method_tlv_and_carries_the_ephemeral_public_key() {
        let mut pv = fresh_verify();
        let m1 = pv.start().unwrap();
        let items = tlv::decode(&m1).unwrap();
        assert_eq!(tlv::get_byte(&items, tlv::TYPE_STATE), Some(1));
        assert_eq!(tlv::get(&items, tlv::TYPE_METHOD), None, "M1 must not name a method");
        assert_eq!(tlv::get(&items, tlv::TYPE_PUBLIC_KEY).unwrap().len(), 32);
        assert_eq!(tlv::get(&items, tlv::TYPE_PUBLIC_KEY).unwrap(), &pv.controller_cv_pk());
    }

    /// The two signed infos are mirrors. Asserted structurally so that writing
    /// M3's info as a copy of M2's — which no loopback test can catch, because
    /// a wrong-but-consistent order verifies fine against itself — fails here.
    #[test]
    fn the_two_signed_infos_are_mirrors_and_not_copies() {
        let ours = [1u8; 32];
        let theirs = [2u8; 32];
        let accessory_info = concat_info(&theirs, b"AA:BB", &ours);
        let controller_info = concat_info(&ours, b"ctrl-id", &theirs);
        assert_eq!(&accessory_info[..32], &theirs[..]);
        assert_eq!(&accessory_info[accessory_info.len() - 32..], &ours[..]);
        assert_eq!(&controller_info[..32], &ours[..]);
        assert_eq!(&controller_info[controller_info.len() - 32..], &theirs[..]);
        // No separators and no length prefixes.
        assert_eq!(accessory_info.len(), 32 + 5 + 32);
    }

    // =======================================================================
    // LAYER 3 — loopback.
    //
    // READ THIS BEFORE TRUSTING ANYTHING BELOW. These tests prove INTERNAL
    // CONSISTENCY ONLY. They pass identically if every salt and info string in
    // this file is wrong, because `FakeAccessory` would be wrong in the same
    // way. What they do catch is state-machine order, TLV shapes, the mirror
    // asymmetry, and the identity checks — and they catch those only because
    // FakeAccessory is written from the ADK's ACCESSORY path and shares no
    // helper with `PairVerify` beyond `tlv`, `hkdf_sha512_32` and the AEAD.
    // The first genuine interop test is the first Simulator run.
    // =======================================================================

    const ACCESSORY_ID: &str = "AA:BB:CC:DD:EE:FF";
    const CONTROLLER_ID: &str = "b0c1d2e3-0000-4000-8000-000000000001";

    struct FakeAccessory {
        ltsk: SigningKey,
        cv_sk: [u8; 32],
        cv_pk: [u8; 32],
        id: String,
        /// The controller LTPK this accessory believes it is paired with.
        controller_ltpk: [u8; 32],
        session_key: [u8; 32],
        shared: [u8; 32],
        controller_cv_pk: [u8; 32],
        /// Send this signature in M2 instead of a real one. Only the
        /// small-order forgery test sets it.
        forge: Option<[u8; 64]>,
    }

    impl FakeAccessory {
        fn new(controller_ltpk: [u8; 32]) -> FakeAccessory {
            let ltsk = SigningKey::from_bytes(&[0x11u8; 32]);
            let cv_sk = [0x22u8; 32];
            let cv_pk = x25519(cv_sk, X25519_BASEPOINT_BYTES);
            FakeAccessory {
                ltsk,
                cv_sk,
                cv_pk,
                id: ACCESSORY_ID.to_string(),
                controller_ltpk,
                session_key: [0u8; 32],
                shared: [0u8; 32],
                controller_cv_pk: [0u8; 32],
                forge: None,
            }
        }

        fn ltpk(&self) -> [u8; 32] {
            self.ltsk.verifying_key().to_bytes()
        }

        /// M1 in, M2 out — written against adk_HAPPairingPairVerify.c's own
        /// M1/M2 handlers, not against `PairVerify`.
        fn m2(&mut self, m1: &[u8]) -> Vec<u8> {
            let items = tlv::decode(m1).unwrap();
            assert_eq!(tlv::get_byte(&items, tlv::TYPE_STATE), Some(1));
            let their_pk: [u8; 32] =
                tlv::get(&items, tlv::TYPE_PUBLIC_KEY).unwrap().try_into().unwrap();
            self.controller_cv_pk = their_pk;
            self.shared = x25519(self.cv_sk, their_pk);
            self.session_key =
                hkdf_sha512_32(b"Pair-Verify-Encrypt-Salt", &self.shared, b"Pair-Verify-Encrypt-Info");

            let mut info = Vec::new();
            info.extend_from_slice(&self.cv_pk);
            info.extend_from_slice(self.id.as_bytes());
            info.extend_from_slice(&their_pk);
            let sig_bytes = match self.forge {
                Some(f) => f,
                None => self.ltsk.sign(&info).to_bytes(),
            };

            let sub = tlv::encode(&[
                Tlv::new(tlv::TYPE_IDENTIFIER, self.id.as_bytes().to_vec()),
                Tlv::new(tlv::TYPE_SIGNATURE, sig_bytes.to_vec()),
            ])
            .unwrap();
            let sealed = seal(&self.session_key, b"PV-Msg02", &sub).unwrap();
            tlv::encode(&[
                Tlv::byte(tlv::TYPE_STATE, 2),
                Tlv::new(tlv::TYPE_PUBLIC_KEY, self.cv_pk.to_vec()),
                Tlv::new(tlv::TYPE_ENCRYPTED_DATA, sealed),
            ])
            .unwrap()
        }

        /// M3 in, M4 out. Returns an Error TLV rather than a success when the
        /// controller's signature does not verify, which is what the ADK does
        /// (`session->state.pairVerify.error = kHAPPairingError_Authentication`).
        fn m4(&mut self, m3: &[u8]) -> Vec<u8> {
            let items = tlv::decode(m3).unwrap();
            assert_eq!(tlv::get_byte(&items, tlv::TYPE_STATE), Some(3));
            let sealed = tlv::get(&items, tlv::TYPE_ENCRYPTED_DATA).unwrap();
            let plain = match open(&self.session_key, b"PV-Msg03", sealed) {
                Some(p) => p,
                None => {
                    return tlv::encode(&[
                        Tlv::byte(tlv::TYPE_STATE, 4),
                        Tlv::byte(tlv::TYPE_ERROR, accessory_error::AUTHENTICATION),
                    ])
                    .unwrap()
                }
            };
            let sub = tlv::decode(&plain).unwrap();
            let id = tlv::get(&sub, tlv::TYPE_IDENTIFIER).unwrap().to_vec();
            let sig: [u8; 64] = tlv::get(&sub, tlv::TYPE_SIGNATURE).unwrap().try_into().unwrap();

            let mut info = Vec::new();
            info.extend_from_slice(&self.controller_cv_pk);
            info.extend_from_slice(&id);
            info.extend_from_slice(&self.cv_pk);

            let key = VerifyingKey::from_bytes(&self.controller_ltpk).unwrap();
            if key.verify_strict(&info, &Signature::from_bytes(&sig)).is_err() {
                return tlv::encode(&[
                    Tlv::byte(tlv::TYPE_STATE, 4),
                    Tlv::byte(tlv::TYPE_ERROR, accessory_error::AUTHENTICATION),
                ])
                .unwrap();
            }
            tlv::encode(&[Tlv::byte(tlv::TYPE_STATE, 4)]).unwrap()
        }

        /// The accessory's own view of the two directional keys. Derived here
        /// with the ADK's channel names — accessoryToController uses
        /// "Control-Read-Encryption-Key" — so the loopback would notice if
        /// `SessionKeys::derive` swapped them.
        fn keys(&self) -> SessionKeys {
            SessionKeys {
                read: hkdf_sha512_32(b"Control-Salt", &self.shared, b"Control-Read-Encryption-Key"),
                write: hkdf_sha512_32(
                    b"Control-Salt",
                    &self.shared,
                    b"Control-Write-Encryption-Key",
                ),
            }
        }
    }

    fn controller_ltsk() -> [u8; 32] {
        [0x33u8; 32]
    }

    fn record(accessory_ltpk: [u8; 32]) -> PairingRecord {
        PairingRecord {
            accessory_pairing_id: ACCESSORY_ID.into(),
            accessory_ltpk,
            controller_pairing_id: CONTROLLER_ID.into(),
        }
    }

    /// A `PairVerify` against a placeholder accessory key, for the tests that
    /// only look at M1.
    fn fresh_verify() -> PairVerify {
        let ltpk = SigningKey::from_bytes(&[0x11u8; 32]).verifying_key().to_bytes();
        PairVerify::with_ephemeral(&record(ltpk), &controller_ltsk(), [0x44u8; 32]).unwrap()
    }

    fn paired() -> (PairVerify, FakeAccessory) {
        let controller_ltpk =
            SigningKey::from_bytes(&controller_ltsk()).verifying_key().to_bytes();
        let acc = FakeAccessory::new(controller_ltpk);
        let pv =
            PairVerify::with_ephemeral(&record(acc.ltpk()), &controller_ltsk(), [0x44u8; 32])
                .unwrap();
        (pv, acc)
    }

    #[test]
    fn a_full_pair_verify_completes_and_both_sides_agree_on_both_keys() {
        let (mut pv, mut acc) = paired();
        let m1 = pv.start().unwrap();
        let m2 = acc.m2(&m1);
        let m3 = pv.handle_m2(&m2).unwrap();
        let m4 = acc.m4(&m3);
        let keys = pv.handle_m4(&m4).unwrap();

        let theirs = acc.keys();
        assert_eq!(keys.read, theirs.read);
        assert_eq!(keys.write, theirs.write);
        assert_ne!(keys.read, keys.write);
    }

    /// The pairing table and the peer must agree on WHO. A signature that
    /// verifies under our stored key while naming someone else is still a
    /// refusal.
    #[test]
    fn an_accessory_that_names_a_different_pairing_id_is_refused() {
        let (_, mut acc) = paired();
        acc.id = "11:22:33:44:55:66".into();
        let mut pv =
            PairVerify::with_ephemeral(&record(acc.ltpk()), &controller_ltsk(), [0x44u8; 32])
                .unwrap();
        let m1 = pv.start().unwrap();
        let m2 = acc.m2(&m1);
        assert_eq!(
            pv.handle_m2(&m2),
            Err(VerifyError::WrongAccessory {
                expected: ACCESSORY_ID.into(),
                got: "11:22:33:44:55:66".into(),
            })
        );
    }

    /// The accessory we stored a key for was replaced by one holding a
    /// different long-term key. The identity string still matches, so ONLY the
    /// signature check stands between us and a session with a stranger.
    #[test]
    fn an_accessory_with_the_right_id_but_a_different_long_term_key_is_refused() {
        let controller_ltpk =
            SigningKey::from_bytes(&controller_ltsk()).verifying_key().to_bytes();
        let mut acc = FakeAccessory::new(controller_ltpk);
        acc.ltsk = SigningKey::from_bytes(&[0x99u8; 32]);
        // The record still holds the ORIGINAL accessory's public key.
        let original = SigningKey::from_bytes(&[0x11u8; 32]).verifying_key().to_bytes();
        let mut pv =
            PairVerify::with_ephemeral(&record(original), &controller_ltsk(), [0x44u8; 32])
                .unwrap();
        let m1 = pv.start().unwrap();
        let m2 = acc.m2(&m1);
        assert_eq!(pv.handle_m2(&m2), Err(VerifyError::SignatureInvalid));
    }

    /// WHY `verify_strict` AND NOT `verify`, demonstrated rather than asserted.
    ///
    /// The Ed25519 identity point is a valid encoding — `from_bytes` accepts
    /// it — and it has small order, so `[k]A` is the identity for every `k`.
    /// The verification equation therefore collapses to `R == [s]B`, and the
    /// pair `R = identity, s = 0` satisfies it for EVERY message with no
    /// secret at all. That is a universal forgery against non-strict
    /// verification, and the only thing that refuses it is `verify_strict`'s
    /// small-order check (ed25519-dalek verifying.rs:370).
    ///
    /// This test proves the forgery is real by checking that the ordinary
    /// `verify` accepts the very same bytes, and then that `handle_m2` refuses
    /// them. Without the first half it would be a test that could pass
    /// vacuously.
    #[test]
    fn a_forged_signature_under_a_small_order_key_is_refused_by_the_strict_check() {
        use ed25519_dalek::Verifier;

        // y = 1, sign bit clear: the identity element.
        let identity = a32("0100000000000000000000000000000000000000000000000000000000000000");
        let weak_key = VerifyingKey::from_bytes(&identity)
            .expect("the identity point IS a valid encoding — from_bytes is not the gate");
        assert!(weak_key.is_weak(), "the identity point must be small order");

        // R = identity, s = 0.
        let mut forged = [0u8; 64];
        forged[..32].copy_from_slice(&identity);

        let controller_ltpk =
            SigningKey::from_bytes(&controller_ltsk()).verifying_key().to_bytes();
        let mut acc = FakeAccessory::new(controller_ltpk);
        acc.forge = Some(forged);
        // The pairing we stored claims the accessory's key IS the weak one.
        let mut pv =
            PairVerify::with_ephemeral(&record(identity), &controller_ltsk(), [0x44u8; 32])
                .unwrap();
        let m1 = pv.start().unwrap();
        let m2 = acc.m2(&m1);

        // The forgery really does satisfy the non-strict equation over the
        // exact AccessoryInfo this exchange produces.
        let info = concat_info(&acc.cv_pk, ACCESSORY_ID.as_bytes(), &pv.controller_cv_pk());
        assert!(
            weak_key.verify(&info, &Signature::from_bytes(&forged)).is_ok(),
            "the forgery must be accepted by non-strict verify, or this test proves nothing"
        );

        assert_eq!(pv.handle_m2(&m2), Err(VerifyError::SignatureInvalid));
    }

    /// If the accessory does not accept OUR proof it answers M4 with an Error,
    /// and no session keys may come out of that.
    #[test]
    fn an_accessory_that_rejects_our_signature_yields_no_session() {
        let (mut pv, mut acc) = paired();
        // The accessory thinks it is paired with a different controller.
        acc.controller_ltpk = SigningKey::from_bytes(&[0x77u8; 32]).verifying_key().to_bytes();
        let m1 = pv.start().unwrap();
        let m2 = acc.m2(&m1);
        let m3 = pv.handle_m2(&m2).unwrap();
        let m4 = acc.m4(&m3);
        assert_eq!(
            pv.handle_m4(&m4),
            Err(VerifyError::Accessory(accessory_error::AUTHENTICATION))
        );
    }

    #[test]
    fn a_tampered_m2_ciphertext_fails_the_tag_check() {
        let (mut pv, mut acc) = paired();
        let m1 = pv.start().unwrap();
        let mut m2 = acc.m2(&m1);
        let last = m2.len() - 1;
        m2[last] ^= 0x01;
        assert_eq!(pv.handle_m2(&m2), Err(VerifyError::Decrypt));
    }

    #[test]
    fn steps_taken_out_of_order_are_refused_rather_than_half_run() {
        let (mut pv, mut acc) = paired();
        assert_eq!(pv.handle_m4(&[]), Err(VerifyError::OutOfOrder));

        let (mut pv2, _) = paired();
        let m1 = pv2.start().unwrap();
        assert_eq!(pv2.start(), Err(VerifyError::OutOfOrder));

        let m2 = acc.m2(&m1);
        // A second M2 after a failure must not restart the exchange.
        let (mut pv3, _) = paired();
        let _ = pv3.start().unwrap();
        assert!(pv3.handle_m2(&[0xFF]).is_err());
        assert_eq!(pv3.handle_m2(&m2), Err(VerifyError::OutOfOrder));
    }

    #[test]
    fn every_accessory_error_code_reaches_the_caller_intact() {
        for code in [0x01u8, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x42] {
            let (mut pv, _) = paired();
            let _ = pv.start().unwrap();
            let body = tlv::encode(&[
                Tlv::byte(tlv::TYPE_STATE, 2),
                Tlv::byte(tlv::TYPE_ERROR, code),
            ])
            .unwrap();
            assert_eq!(pv.handle_m2(&body), Err(VerifyError::Accessory(code)));
        }
    }

    /// Every reply we accept came off the LAN before anything was
    /// authenticated. None of these may unwind.
    #[test]
    fn hostile_replies_produce_errors_and_never_a_panic() {
        let (mut pv, mut acc) = paired();
        let m1 = pv.start().unwrap();
        let good = acc.m2(&m1);

        // Every truncation.
        for cut in 0..good.len() {
            let (mut p, _) = paired();
            let _ = p.start().unwrap();
            let _ = p.handle_m2(&good[..cut]);
        }
        // Every single-byte corruption of the first 64 bytes.
        for i in 0..good.len().min(64) {
            let mut bad = good.clone();
            bad[i] ^= 0xFF;
            let (mut p, _) = paired();
            let _ = p.start().unwrap();
            let _ = p.handle_m2(&bad);
        }
        // Structurally valid TLV that says nothing useful.
        for body in [
            tlv::encode(&[Tlv::byte(tlv::TYPE_STATE, 2)]).unwrap(),
            tlv::encode(&[
                Tlv::byte(tlv::TYPE_STATE, 2),
                Tlv::new(tlv::TYPE_PUBLIC_KEY, vec![0u8; 31]),
            ])
            .unwrap(),
            tlv::encode(&[
                Tlv::byte(tlv::TYPE_STATE, 2),
                Tlv::new(tlv::TYPE_PUBLIC_KEY, vec![0u8; 32]),
            ])
            .unwrap(),
            tlv::encode(&[Tlv::byte(tlv::TYPE_STATE, 9)]).unwrap(),
            vec![],
            vec![0xFF],
        ] {
            let (mut p, _) = paired();
            let _ = p.start().unwrap();
            assert!(p.handle_m2(&body).is_err());
        }
    }

    /// A stored accessory key that is not a valid Ed25519 point is our record's
    /// problem, and must be caught before we put a packet on the wire rather
    /// than blamed on the accessory two round trips later.
    #[test]
    fn a_corrupt_stored_pairing_is_refused_before_any_bytes_go_out() {
        // y = 2 is the smallest y for which (y²-1)/(dy²+1) is a non-residue on
        // Ed25519, so this 32-byte string is not the encoding of any curve
        // point and `VerifyingKey::from_bytes` must reject it. Chosen by
        // computing the residue rather than assumed: most "obviously corrupt"
        // strings — all-ones, all-zeros — DO decompress.
        let bad = record(a32("0200000000000000000000000000000000000000000000000000000000000000"));
        assert!(matches!(
            PairVerify::with_ephemeral(&bad, &controller_ltsk(), [0x44u8; 32]),
            Err(VerifyError::Protocol(_))
        ));
        let mut empty = record([0u8; 32]);
        empty.accessory_pairing_id = String::new();
        assert!(PairVerify::with_ephemeral(&empty, &controller_ltsk(), [0x44u8; 32]).is_err());
        let mut no_ctrl = record(SigningKey::from_bytes(&[0x11u8; 32]).verifying_key().to_bytes());
        no_ctrl.controller_pairing_id = String::new();
        assert!(PairVerify::with_ephemeral(&no_ctrl, &controller_ltsk(), [0x44u8; 32]).is_err());
    }

    #[test]
    fn verify_errors_map_onto_the_home_error_that_names_the_right_fix() {
        use crate::home::HomeError as H;
        let cases: Vec<(VerifyError, &str)> = vec![
            (VerifyError::SignatureInvalid, "unauthorised"),
            (
                VerifyError::WrongAccessory { expected: "a".into(), got: "b".into() },
                "unauthorised",
            ),
            (VerifyError::Accessory(accessory_error::AUTHENTICATION), "unauthorised"),
            (VerifyError::Accessory(accessory_error::BUSY), "unreachable"),
            (VerifyError::Decrypt, "malformed"),
            (VerifyError::Protocol("x".into()), "malformed"),
            (VerifyError::WeakKey, "refused"),
            (VerifyError::OutOfOrder, "refused"),
            (VerifyError::NoEntropy, "refused"),
        ];
        for (e, want) in cases {
            let got = match H::from(e.clone()) {
                H::Unauthorised(_) => "unauthorised",
                H::Unreachable(_) => "unreachable",
                H::Malformed(_) => "malformed",
                H::Refused(_) => "refused",
                H::Store(_) => "store",
                H::Unavailable(_) => "unavailable",
            };
            assert_eq!(got, want, "{e:?}");
        }
    }

    /// Listed so nobody wires them up by accident, and never referenced by the
    /// code. If this ever fails, Pair Resume crept in.
    #[test]
    fn the_resume_strings_are_listed_but_never_used() {
        assert_eq!(RESUME_NOT_IMPLEMENTED.len(), 2);
        let src = include_str!("verify.rs");
        for s in RESUME_NOT_IMPLEMENTED {
            // Twice: the constant and this assertion. Never in a derivation.
            assert_eq!(src.matches(s).count(), 1, "{s} appears outside the not-implemented list");
        }
    }
}
