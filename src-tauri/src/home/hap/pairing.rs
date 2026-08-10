// Pair-setup M1..M6 — the controller half.
//
// This is the one-time exchange that turns a setup code printed on an
// accessory into a long-term Ed25519 pairing. It runs ONCE per accessory;
// every later connection runs pair-verify (a different exchange, in a later
// file) using what this one persisted.
//
// EVERY CONSTANT BELOW IS QUOTED FROM APPLE'S OWN ACCESSORY IMPLEMENTATION,
// `apple/HomeKitADK` (Apache-2.0), with file and line. That matters more here
// than anywhere else in the module: a wrong HKDF info string produces code
// that compiles, passes every local test, and fails only against a real
// accessory — and no real accessory exists on this machine (the HomeKit
// Accessory Simulator ships separately in "Additional Tools for Xcode" and is
// not installed). Where a value could not be confirmed from a primary source
// it is called out in capitals rather than guessed quietly. As of this file
// there is exactly one such item and it is in `MFI_NOT_IMPLEMENTED` below.
//
// TRANSPORT, for whoever writes http.rs: POST /pair-setup, Content-Type
// `application/pairing+tlv8`, body = the TLV bytes these methods return,
// UNENCRYPTED. The accessory rejects this endpoint inside a secure session
// (adk_HAPIPAccessoryServer.c:2611). Responses come back 200 OK with the same
// content type and are fed straight into `handle_m2` / `handle_m4` /
// `handle_m6`.

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, KeyInit, Nonce};

use super::keystore::PairingRecord;
use super::srp::{self, Sha512Srp, Srp, SrpError};
use super::tlv::{self, Tlv, TlvError};
use super::{ct_eq, hkdf_sha512_32};

// ---------------------------------------------------------------------------
// The strings — Layer 2 of the verification strategy
// ---------------------------------------------------------------------------
//
// Every one of these is a C string literal in the ADK used with `sizeof - 1`,
// i.e. WITHOUT its terminating NUL. Passing `sizeof` instead is the classic
// form of this bug and changes every derived key; `the_hkdf_strings_are_the_
// adk_strings_with_no_trailing_nul` below pins the lengths for that reason.

/// SRP username `I`. `static const uint8_t userName[] = "Pair-Setup";` used
/// with `sizeof userName - 1` — adk_pairsetup.c:488.
pub const SRP_USER: &[u8] = b"Pair-Setup";

/// adk_pairsetup.c:558-559.
pub const SETUP_ENCRYPT_SALT: &[u8] = b"Pair-Setup-Encrypt-Salt";
pub const SETUP_ENCRYPT_INFO: &[u8] = b"Pair-Setup-Encrypt-Info";

/// adk_pairsetup.c:974-975.
pub const CONTROLLER_SIGN_SALT: &[u8] = b"Pair-Setup-Controller-Sign-Salt";
pub const CONTROLLER_SIGN_INFO: &[u8] = b"Pair-Setup-Controller-Sign-Info";

/// adk_pairsetup.c:1141-1142.
pub const ACCESSORY_SIGN_SALT: &[u8] = b"Pair-Setup-Accessory-Sign-Salt";
pub const ACCESSORY_SIGN_INFO: &[u8] = b"Pair-Setup-Accessory-Sign-Info";

/// adk_pairsetup.c:894 and :1181.
pub const NONCE_MSG05: &[u8; 8] = b"PS-Msg05";
pub const NONCE_MSG06: &[u8; 8] = b"PS-Msg06";

/// NOT IMPLEMENTED, listed so nobody wires it up by accident: `PS-Msg04`
/// (adk_pairsetup.c:716) and the `MFi-Pair-Setup-Salt` / `MFi-Pair-Setup-Info`
/// pair (:641-642) belong to `PairSetupWithAuth`, which needs an Apple
/// authentication coprocessor we do not have. We always send Method 0x00.
pub const MFI_NOT_IMPLEMENTED: &[&str] =
    &["PS-Msg04", "MFi-Pair-Setup-Salt", "MFi-Pair-Setup-Info"];

/// Pair-setup method 0x00 — plain, no MFi coprocessor. `Method` is REQUIRED in
/// M1 and the accessory rejects anything that is not 0x00 or 0x01
/// (adk_pairsetup.c:95-100). Pair-verify M1, by contrast, must OMIT it.
const METHOD_PAIR_SETUP: u8 = 0x00;

const STATE_M1: u8 = 0x01;
const STATE_M2: u8 = 0x02;
const STATE_M3: u8 = 0x03;
const STATE_M4: u8 = 0x04;
const STATE_M5: u8 = 0x05;
const STATE_M6: u8 = 0x06;

/// HAP pairing error codes — adk_HAPPairing.h:91-113. Carried as-is so the
/// surface can say which one happened; `Backoff` in particular is not a
/// failure the user should retry immediately.
pub mod accessory_error {
    pub const UNKNOWN: u8 = 0x01;
    pub const AUTHENTICATION: u8 = 0x02;
    pub const BACKOFF: u8 = 0x03;
    pub const MAX_PEERS: u8 = 0x04;
    pub const MAX_TRIES: u8 = 0x05;
    pub const UNAVAILABLE: u8 = 0x06;
    pub const BUSY: u8 = 0x07;
}

/// The 12-byte AEAD nonce for a pair-setup / pair-verify message.
///
/// The ADK passes the 8 ASCII bytes and the AEAD layer RIGHT-ALIGNS them in a
/// zeroed 12-byte buffer (`memcpy(nonce + sizeof nonce - n_len, n, n_len)`,
/// HAPMbedTLS.c:539-546). Left-aligning is a silent, total failure.
pub fn message_nonce(tag: &[u8; 8]) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(tag);
    n
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairError {
    /// The code the user typed is not the `XXX-XX-XXX` shape. Caught before
    /// any network traffic — a malformed code cannot become a valid password.
    BadSetupCode,
    /// The accessory answered with a `kTLVType_Error`.
    Accessory(u8),
    /// The response did not parse as TLV8.
    Tlv(TlvError),
    /// The response parsed but did not say what the protocol requires.
    Protocol(String),
    Srp(SrpError),
    /// M4's proof did not match the one we computed, i.e. the accessory could
    /// not show it knows the setup code.
    ProofMismatch,
    /// M6's Ed25519 signature did not verify under the key M6 itself carried.
    SignatureInvalid,
    /// AEAD failure — a wrong key, a wrong nonce, or a tampered ciphertext.
    /// Deliberately undifferentiated: the tag check cannot tell us which.
    Decrypt,
    /// A method was called out of order.
    OutOfOrder,
    /// The OS could not give us randomness. Nothing may proceed without it.
    NoEntropy,
}

impl std::fmt::Display for PairError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PairError::BadSetupCode => write!(
                f,
                "that is not a HomeKit setup code — it should look like 123-45-678, eight digits \
                 with the dashes"
            ),
            PairError::Accessory(c) => match *c {
                accessory_error::AUTHENTICATION => {
                    write!(f, "the accessory rejected that setup code")
                }
                accessory_error::BACKOFF => write!(
                    f,
                    "the accessory is refusing attempts for a while after too many wrong codes"
                ),
                accessory_error::MAX_PEERS => {
                    write!(f, "the accessory has no room for another controller")
                }
                accessory_error::MAX_TRIES => {
                    write!(f, "the accessory has locked itself after too many wrong codes")
                }
                accessory_error::UNAVAILABLE => write!(
                    f,
                    "the accessory is already paired with another controller — remove it from \
                     that home first"
                ),
                accessory_error::BUSY => {
                    write!(f, "the accessory is busy pairing with something else")
                }
                other => write!(f, "the accessory refused pairing (code {other})"),
            },
            PairError::Tlv(e) => write!(f, "the accessory's reply was not valid TLV8: {e}"),
            PairError::Protocol(m) => write!(f, "the accessory's reply did not make sense: {m}"),
            PairError::Srp(e) => write!(f, "{e}"),
            PairError::ProofMismatch => write!(
                f,
                "the accessory could not prove it knows the setup code — refusing to pair"
            ),
            PairError::SignatureInvalid => write!(
                f,
                "the accessory's identity signature did not verify — refusing to pair"
            ),
            PairError::Decrypt => {
                write!(f, "the accessory's encrypted reply could not be decrypted")
            }
            PairError::OutOfOrder => write!(f, "pair-setup steps were run out of order"),
            PairError::NoEntropy => write!(f, "the system would not provide secure randomness"),
        }
    }
}

impl From<TlvError> for PairError {
    fn from(e: TlvError) -> PairError {
        PairError::Tlv(e)
    }
}

impl From<SrpError> for PairError {
    fn from(e: SrpError) -> PairError {
        PairError::Srp(e)
    }
}

/// The boundary onto the module's existing error vocabulary. The variants are
/// chosen by WHICH FIX APPLIES, which is the rule `home/mod.rs` states: a
/// rejected code needs a different code, a busy accessory needs a wait.
impl From<PairError> for crate::home::HomeError {
    fn from(e: PairError) -> crate::home::HomeError {
        use crate::home::HomeError as H;
        let msg = e.to_string();
        match e {
            PairError::BadSetupCode | PairError::OutOfOrder | PairError::NoEntropy => {
                H::Refused(msg)
            }
            PairError::ProofMismatch
            | PairError::SignatureInvalid
            | PairError::Accessory(accessory_error::AUTHENTICATION)
            | PairError::Accessory(accessory_error::MAX_TRIES) => H::Unauthorised(msg),
            PairError::Accessory(_) => H::Unreachable(msg),
            PairError::Tlv(_) | PairError::Protocol(_) | PairError::Srp(_) | PairError::Decrypt => {
                H::Malformed(msg)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The setup code
// ---------------------------------------------------------------------------

/// The password `P` is the setup code STRING INCLUDING THE DASHES — ten ASCII
/// bytes, `XXX-XX-XXX`. `12345678` is not the password; `123-45-678` is.
///
/// adk_setupinfo.c:325-331 passes `setupCode.stringValue` with `sizeof … - 1`,
/// and adk_HAPAccessorySetup.c:22-26 shows positions 3 and 6 are `'-'` and the
/// rest are `'0'..'9'`. This is the single most common integration bug in
/// third-party HAP controllers, which is why the type system never sees a
/// "setup code" that has had its dashes helpfully removed.
pub fn valid_setup_code(code: &str) -> bool {
    let b = code.as_bytes();
    if b.len() != 10 {
        return false;
    }
    b.iter().enumerate().all(|(i, c)| match i {
        3 | 6 => *c == b'-',
        _ => c.is_ascii_digit(),
    })
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Fresh,
    AwaitingM2,
    AwaitingM4,
    AwaitingM6,
    Done,
    Failed,
}

pub struct PairSetup {
    setup_code: String,
    controller_pairing_id: String,
    ltsk: SigningKey,
    /// The SRP client secret `a`. Its length is not on the wire (only `A` is),
    /// so 32 bytes is a choice, matching the ADK's own `SRP_SECRET_KEY_BYTES`
    /// and clearing RFC 5054 §2.5.4's 256-bit floor.
    a: [u8; 32],
    srp: Srp,
    stage: Stage,

    a_pub: Vec<u8>,
    /// SRP session key K (64 bytes), from which everything else is derived.
    k_session: Vec<u8>,
    m1: Vec<u8>,
    /// HKDF output used to encrypt M5 and decrypt M6.
    encrypt_key: [u8; 32],
}

/// A pair-setup holds the four things worth wiping: the setup code the user
/// read off the accessory's label, the SRP client secret `a`, the SRP session
/// key `K` that every later derivation hangs off, and the M5/M6 AEAD key.
/// `ltsk` is an `ed25519_dalek::SigningKey` and already wipes itself.
impl Drop for PairSetup {
    fn drop(&mut self) {
        super::wipe_string(&mut self.setup_code);
        super::wipe(&mut self.a);
        super::wipe(&mut self.k_session);
        super::wipe(&mut self.encrypt_key);
    }
}

impl PairSetup {
    /// `ltsk` is the controller's long-term Ed25519 secret. It is loaded from
    /// the Keychain by the caller and never leaves this process.
    pub fn new(
        setup_code: &str,
        controller_pairing_id: &str,
        ltsk: &[u8; 32],
    ) -> Result<PairSetup, PairError> {
        // Validate before asking the OS for entropy: a malformed code is a
        // typo, and it should be refused without side effects of any kind.
        if !valid_setup_code(setup_code) {
            return Err(PairError::BadSetupCode);
        }
        let mut a = [0u8; 32];
        getrandom::getrandom(&mut a).map_err(|_| PairError::NoEntropy)?;
        PairSetup::with_client_secret(setup_code, controller_pairing_id, ltsk, a)
    }

    /// The deterministic seam. Exists so the loopback test can pin `a` and so
    /// a future transcript-replay test is possible at all; production always
    /// goes through `new`.
    pub fn with_client_secret(
        setup_code: &str,
        controller_pairing_id: &str,
        ltsk: &[u8; 32],
        a: [u8; 32],
    ) -> Result<PairSetup, PairError> {
        if !valid_setup_code(setup_code) {
            return Err(PairError::BadSetupCode);
        }
        if controller_pairing_id.is_empty() || controller_pairing_id.len() > 255 {
            return Err(PairError::Protocol(
                "the controller pairing id must be 1..=255 bytes".into(),
            ));
        }
        // `None` only for an even modulus, which the compiled-in group is not.
        let srp = Srp::new(srp::hap_group())
            .ok_or_else(|| PairError::Protocol("the SRP group is not usable".into()))?;
        Ok(PairSetup {
            setup_code: setup_code.to_string(),
            controller_pairing_id: controller_pairing_id.to_string(),
            ltsk: SigningKey::from_bytes(ltsk),
            a,
            srp,
            stage: Stage::Fresh,
            a_pub: Vec::new(),
            k_session: Vec::new(),
            m1: Vec::new(),
            encrypt_key: [0u8; 32],
        })
    }

    /// Our long-term PUBLIC key, which is what M5 hands the accessory.
    pub fn controller_ltpk(&self) -> [u8; 32] {
        self.ltsk.verifying_key().to_bytes()
    }

    /// M1: `State = 1`, `Method = 0`. No Flags TLV — transient/split setup is
    /// a BLE-adjacent optimisation we do not want.
    pub fn start(&mut self) -> Result<Vec<u8>, PairError> {
        if self.stage != Stage::Fresh {
            return Err(PairError::OutOfOrder);
        }
        let body = tlv::encode(&[
            Tlv::byte(tlv::TYPE_STATE, STATE_M1),
            Tlv::byte(tlv::TYPE_METHOD, METHOD_PAIR_SETUP),
        ])?;
        self.stage = Stage::AwaitingM2;
        Ok(body)
    }

    /// M2 in, M3 out. M2 carries the accessory's SRP public key B (384 bytes,
    /// always arriving as two TLV fragments) and the 16-byte salt.
    pub fn handle_m2(&mut self, body: &[u8]) -> Result<Vec<u8>, PairError> {
        self.expect(Stage::AwaitingM2)?;
        let items = self.parse(body, STATE_M2)?;

        let salt = tlv::get(&items, tlv::TYPE_SALT)
            .ok_or_else(|| self.fail(PairError::Protocol("M2 has no salt".into())))?;
        if salt.len() != 16 {
            return Err(self.fail(PairError::Protocol(format!(
                "M2's salt is {} bytes, expected 16",
                salt.len()
            ))));
        }
        let b_pub = tlv::get(&items, tlv::TYPE_PUBLIC_KEY)
            .ok_or_else(|| self.fail(PairError::Protocol("M2 has no public key".into())))?
            .to_vec();

        let group = self.srp.group().clone();
        let x = srp::compute_x::<Sha512Srp>(salt, SRP_USER, self.setup_code.as_bytes());
        let k = srp::compute_k::<Sha512Srp>(&group);
        let a_pub = self.srp.public_a(&self.a);
        let u = srp::compute_u::<Sha512Srp>(&a_pub, &b_pub);
        let premaster = match self.srp.premaster_client(&self.a, &b_pub, &x, &u, &k) {
            Ok(s) => s,
            Err(e) => return Err(self.fail(PairError::Srp(e))),
        };
        let k_session = srp::session_key::<Sha512Srp>(&premaster);
        let m1 = srp::proof_m1::<Sha512Srp>(&group, SRP_USER, salt, &a_pub, &b_pub, &k_session);

        let out = tlv::encode(&[
            Tlv::byte(tlv::TYPE_STATE, STATE_M3),
            Tlv::new(tlv::TYPE_PUBLIC_KEY, a_pub.clone()),
            Tlv::new(tlv::TYPE_PROOF, m1.clone()),
        ])?;

        self.a_pub = a_pub;
        self.k_session = k_session;
        self.m1 = m1;
        self.stage = Stage::AwaitingM4;
        Ok(out)
    }

    /// M4 in, M5 out.
    ///
    /// M4's proof M2 is the accessory proving it knows the setup code. Not
    /// checking it would throw away the entire point of running SRP — we would
    /// be handing our long-term public key to whatever answered the socket.
    pub fn handle_m4(&mut self, body: &[u8]) -> Result<Vec<u8>, PairError> {
        self.expect(Stage::AwaitingM4)?;
        let items = self.parse(body, STATE_M4)?;

        let proof = tlv::get(&items, tlv::TYPE_PROOF)
            .ok_or_else(|| self.fail(PairError::Protocol("M4 has no proof".into())))?;
        let expected = srp::proof_m2::<Sha512Srp>(&self.a_pub, &self.m1, &self.k_session);
        // Constant-time: a proof compared byte-by-byte with an early return is
        // searchable one byte at a time. Same construction as
        // control/auth.rs::ct_eq, for the same reason.
        if !ct_eq(proof, &expected) {
            return Err(self.fail(PairError::ProofMismatch));
        }

        self.encrypt_key =
            hkdf_sha512_32(SETUP_ENCRYPT_SALT, &self.k_session, SETUP_ENCRYPT_INFO);

        // iOSDeviceInfo = iOSDeviceX ‖ iOSDevicePairingID ‖ iOSDeviceLTPK,
        // concatenated raw — no separators, no length prefixes.
        // adk_pairsetup.c:963-991.
        let x = hkdf_sha512_32(CONTROLLER_SIGN_SALT, &self.k_session, CONTROLLER_SIGN_INFO);
        let ltpk = self.controller_ltpk();
        let mut info = Vec::with_capacity(32 + self.controller_pairing_id.len() + 32);
        info.extend_from_slice(&x);
        info.extend_from_slice(self.controller_pairing_id.as_bytes());
        info.extend_from_slice(&ltpk);
        let signature: Signature = self.ltsk.sign(&info);

        let sub = tlv::encode(&[
            Tlv::new(tlv::TYPE_IDENTIFIER, self.controller_pairing_id.as_bytes().to_vec()),
            Tlv::new(tlv::TYPE_PUBLIC_KEY, ltpk.to_vec()),
            Tlv::new(tlv::TYPE_SIGNATURE, signature.to_bytes().to_vec()),
        ])?;
        let sealed = match seal(&self.encrypt_key, NONCE_MSG05, &sub) {
            Some(c) => c,
            None => return Err(self.fail(PairError::Decrypt)),
        };

        let out = tlv::encode(&[
            Tlv::byte(tlv::TYPE_STATE, STATE_M5),
            Tlv::new(tlv::TYPE_ENCRYPTED_DATA, sealed),
        ])?;
        self.stage = Stage::AwaitingM6;
        Ok(out)
    }

    /// M6 in, the pairing out.
    ///
    /// A failed signature check ABORTS and discards the pairing: an accessory
    /// that cannot prove possession of the secret key matching the public key
    /// it just sent is not the accessory we agreed a key with.
    pub fn handle_m6(&mut self, body: &[u8]) -> Result<PairingRecord, PairError> {
        self.expect(Stage::AwaitingM6)?;
        let items = self.parse(body, STATE_M6)?;

        let sealed = tlv::get(&items, tlv::TYPE_ENCRYPTED_DATA)
            .ok_or_else(|| self.fail(PairError::Protocol("M6 has no encrypted data".into())))?;
        let plain = match open(&self.encrypt_key, NONCE_MSG06, sealed) {
            Some(p) => p,
            None => return Err(self.fail(PairError::Decrypt)),
        };
        let sub = match tlv::decode(&plain) {
            Ok(s) => s,
            Err(e) => return Err(self.fail(PairError::Tlv(e))),
        };

        let accessory_id = tlv::get(&sub, tlv::TYPE_IDENTIFIER)
            .ok_or_else(|| self.fail(PairError::Protocol("M6 has no accessory id".into())))?
            .to_vec();
        let accessory_id = String::from_utf8(accessory_id)
            .map_err(|_| self.fail(PairError::Protocol("M6's accessory id is not UTF-8".into())))?;
        if accessory_id.is_empty() {
            return Err(self.fail(PairError::Protocol("M6's accessory id is empty".into())));
        }

        let ltpk_bytes = tlv::get(&sub, tlv::TYPE_PUBLIC_KEY)
            .ok_or_else(|| self.fail(PairError::Protocol("M6 has no accessory key".into())))?;
        let ltpk: [u8; 32] = ltpk_bytes.try_into().map_err(|_| {
            self.fail(PairError::Protocol(format!(
                "M6's accessory key is {} bytes, expected 32",
                ltpk_bytes.len()
            )))
        })?;
        let sig_bytes = tlv::get(&sub, tlv::TYPE_SIGNATURE)
            .ok_or_else(|| self.fail(PairError::Protocol("M6 has no signature".into())))?;
        let sig: [u8; 64] = sig_bytes.try_into().map_err(|_| {
            self.fail(PairError::Protocol(format!(
                "M6's signature is {} bytes, expected 64",
                sig_bytes.len()
            )))
        })?;

        // AccessoryInfo = AccessoryX ‖ AccessoryPairingID ‖ AccessoryLTPK.
        // adk_pairsetup.c:1128-1164.
        let x = hkdf_sha512_32(ACCESSORY_SIGN_SALT, &self.k_session, ACCESSORY_SIGN_INFO);
        let mut info = Vec::with_capacity(32 + accessory_id.len() + 32);
        info.extend_from_slice(&x);
        info.extend_from_slice(accessory_id.as_bytes());
        info.extend_from_slice(&ltpk);

        let key = VerifyingKey::from_bytes(&ltpk)
            .map_err(|_| self.fail(PairError::SignatureInvalid))?;
        // `verify_strict` rather than `verify`: it rejects small-order and
        // non-canonical keys, which is the difference between "a signature
        // verified" and "a signature verified under a key only one party can
        // have produced".
        if key.verify_strict(&info, &Signature::from_bytes(&sig)).is_err() {
            return Err(self.fail(PairError::SignatureInvalid));
        }

        self.stage = Stage::Done;
        Ok(PairingRecord {
            accessory_pairing_id: accessory_id,
            accessory_ltpk: ltpk,
            controller_pairing_id: self.controller_pairing_id.clone(),
        })
    }

    fn expect(&mut self, want: Stage) -> Result<(), PairError> {
        if self.stage != want {
            self.stage = Stage::Failed;
            return Err(PairError::OutOfOrder);
        }
        Ok(())
    }

    /// Any failure poisons the exchange. Restarting means a new `PairSetup`
    /// with a new `a` — resuming a half-failed SRP handshake is how a replayed
    /// M2 gets a second bite at the same secret.
    fn fail(&mut self, e: PairError) -> PairError {
        self.stage = Stage::Failed;
        e
    }

    /// Decode a response, surface a `kTLVType_Error` as itself, and refuse a
    /// message whose State is not the one this step expects.
    fn parse(&mut self, body: &[u8], want_state: u8) -> Result<Vec<Tlv>, PairError> {
        let items = match tlv::decode(body) {
            Ok(i) => i,
            Err(e) => return Err(self.fail(PairError::Tlv(e))),
        };
        if let Some(code) = tlv::get_byte(&items, tlv::TYPE_ERROR) {
            return Err(self.fail(PairError::Accessory(code)));
        }
        match tlv::get_byte(&items, tlv::TYPE_STATE) {
            Some(s) if s == want_state => Ok(items),
            Some(s) => Err(self.fail(PairError::Protocol(format!(
                "expected state {want_state}, got {s}"
            )))),
            None => Err(self.fail(PairError::Protocol("the reply carries no state".into()))),
        }
    }
}

// ---------------------------------------------------------------------------
// AEAD
// ---------------------------------------------------------------------------

/// ChaCha20-Poly1305 with an EMPTY AAD — every pair-setup and pair-verify
/// message is sealed with no additional data. (The encrypted SESSION frames
/// later use the 2-byte length prefix as AAD; that is a different layer.)
/// Output is ciphertext ‖ 16-byte tag.
fn seal(key: &[u8; 32], tag: &[u8; 8], plaintext: &[u8]) -> Option<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = message_nonce(tag);
    cipher.encrypt(Nonce::from_slice(&nonce), Payload { msg: plaintext, aad: &[] }).ok()
}

/// `None` on any AEAD failure. The tag check cannot distinguish a wrong key
/// from a tampered ciphertext, and pretending otherwise in the error would be
/// inventing information.
fn open(key: &[u8; 32], tag: &[u8; 8], sealed: &[u8]) -> Option<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = message_nonce(tag);
    cipher.decrypt(Nonce::from_slice(&nonce), Payload { msg: sealed, aad: &[] }).ok()
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/// Load the controller's long-term identity from the Keychain, minting it on
/// first use. One identity per installation, shared across every accessory —
/// that is what an `iOSDevicePairingID` is.
///
/// The secret half NEVER leaves this function's return value: it goes into
/// `PairSetup` and nowhere else. There is no `#[tauri::command]` in this
/// module, so it cannot reach the webview even by accident.
pub fn load_or_create_identity() -> Result<(String, [u8; 32]), String> {
    use super::keystore;
    if let (Some(id), Some(sk)) = (keystore::controller_id(), keystore::ltsk()) {
        return Ok((id, sk));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let mut sk = [0u8; 32];
    getrandom::getrandom(&mut sk).map_err(|e| format!("no secure randomness available: {e}"))?;
    keystore::set_ltsk(&sk)?;
    keystore::set_controller_id(&id)?;
    Ok((id, sk))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::home::hap::srp::unhex;

    fn hx(s: &str) -> Vec<u8> {
        unhex(s).expect("test hex")
    }

    // =======================================================================
    // LAYER 1 — published vectors. These prove the primitives are the
    // primitives, independently of anything I transcribed from the ADK.
    // =======================================================================

    /// RFC 8439 §2.8.2, verbatim from https://www.rfc-editor.org/rfc/rfc8439.txt
    /// (lines 1258-1367). Note the nonce shape — a 32-bit fixed part followed
    /// by a 64-bit IV — is structurally identical to HAP's
    /// `0000_0000 ‖ counter`, which is why this vector is the right one.
    #[test]
    fn rfc_8439_chacha20_poly1305_aead_vector() {
        let key = hx("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
        let nonce = hx("070000004041424344454647");
        let aad = hx("50515253c0c1c2c3c4c5c6c7");
        let plaintext = b"Ladies and Gentlemen of the class of '99: If I could offer you only \
                          one tip for the future, sunscreen would be it."
            .to_vec();
        // The RFC prints the plaintext as ASCII across several lines; assert
        // the byte string we built matches its hex so the wrapping above
        // cannot have introduced a stray space.
        assert_eq!(
            plaintext,
            hx("4c616469657320616e642047656e746c656d656e206f662074686520636c617373\
                206f66202739393a204966204920636f756c64206f6666657220796f75206f6e6c\
                79206f6e652074697020666f7220746865206675747572652c2073756e73637265\
                656e20776f756c642062652069742e")
        );

        let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
        let out = cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: &plaintext, aad: &aad })
            .unwrap();
        assert_eq!(
            out,
            hx("d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d6\
                3dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b36\
                92ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc\
                3ff4def08e4b7a9de576d26586cec64b6116\
                1ae10b594f09e26a7e902ecbd0600691")
        );

        // The decrypt path, run separately so it is not merely encrypt in
        // reverse: it must also REFUSE a flipped bit.
        let back = cipher
            .decrypt(Nonce::from_slice(&nonce), Payload { msg: &out, aad: &aad })
            .unwrap();
        assert_eq!(back, plaintext);
        let mut tampered = out.clone();
        tampered[0] ^= 1;
        assert!(cipher
            .decrypt(Nonce::from_slice(&nonce), Payload { msg: &tampered, aad: &aad })
            .is_err());
        // …and refuse the right ciphertext with the wrong AAD.
        assert!(cipher
            .decrypt(Nonce::from_slice(&nonce), Payload { msg: &out, aad: &[] })
            .is_err());
    }

    /// RFC 8032 §7.1, verbatim from https://www.rfc-editor.org/rfc/rfc8032.txt
    /// (lines 1300-1371). The public keys double as key-derivation vectors.
    #[test]
    fn rfc_8032_ed25519_vectors_1_2_and_3() {
        let cases: [(&str, &str, &str, &str); 3] = [
            (
                "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
                "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
                "",
                "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555f\
                 b8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
            ),
            (
                "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
                "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
                "72",
                "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da08\
                 5ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
            ),
            (
                "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
                "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
                "af82",
                "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18\
                 ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
            ),
        ];
        for (sk_hex, pk_hex, msg_hex, sig_hex) in cases {
            let sk: [u8; 32] = hx(sk_hex).try_into().unwrap();
            let signing = SigningKey::from_bytes(&sk);
            assert_eq!(signing.verifying_key().to_bytes().to_vec(), hx(pk_hex), "public key");
            let msg = hx(msg_hex);
            let sig: Signature = signing.sign(&msg);
            assert_eq!(sig.to_bytes().to_vec(), hx(sig_hex), "signature");
            let vk = VerifyingKey::from_bytes(&hx(pk_hex).try_into().unwrap()).unwrap();
            assert!(vk.verify_strict(&msg, &sig).is_ok());
            // A one-bit change to the message must not verify — otherwise the
            // M6 identity check proves nothing.
            let mut bad = msg.clone();
            bad.push(0);
            assert!(vk.verify_strict(&bad, &sig).is_err());
        }
    }

    // =======================================================================
    // LAYER 2 — the HAP composition. No published vector exists for any of
    // this; what these tests can prove is that nothing was mistyped since it
    // was transcribed, with the ADK line numbers recorded so a reviewer can
    // re-check the transcription itself in one command.
    // =======================================================================

    /// Lengths as well as contents. A `sizeof` where the ADK writes
    /// `sizeof - 1` appends a NUL and changes every key derived from the
    /// string, and the resulting failure is invisible without an accessory.
    #[test]
    fn the_hkdf_strings_are_the_adk_strings_with_no_trailing_nul() {
        let pinned: [(&[u8], usize); 10] = [
            (SRP_USER, 10),
            (SETUP_ENCRYPT_SALT, 23),
            (SETUP_ENCRYPT_INFO, 23),
            (CONTROLLER_SIGN_SALT, 31),
            (CONTROLLER_SIGN_INFO, 31),
            (ACCESSORY_SIGN_SALT, 30),
            (ACCESSORY_SIGN_INFO, 30),
            (NONCE_MSG05, 8),
            (NONCE_MSG06, 8),
            (&[], 0),
        ];
        for (s, len) in pinned {
            assert_eq!(s.len(), len, "{:?}", String::from_utf8_lossy(s));
            assert!(!s.contains(&0), "a NUL crept into {:?}", String::from_utf8_lossy(s));
        }
        assert_eq!(SRP_USER, b"Pair-Setup");
        assert_eq!(SETUP_ENCRYPT_SALT, b"Pair-Setup-Encrypt-Salt");
        assert_eq!(SETUP_ENCRYPT_INFO, b"Pair-Setup-Encrypt-Info");
        assert_eq!(CONTROLLER_SIGN_SALT, b"Pair-Setup-Controller-Sign-Salt");
        assert_eq!(CONTROLLER_SIGN_INFO, b"Pair-Setup-Controller-Sign-Info");
        assert_eq!(ACCESSORY_SIGN_SALT, b"Pair-Setup-Accessory-Sign-Salt");
        assert_eq!(ACCESSORY_SIGN_INFO, b"Pair-Setup-Accessory-Sign-Info");
        // Salt and info differ only in the last word. Swapping them is a
        // one-character mistake that silently changes every key.
        assert_ne!(SETUP_ENCRYPT_SALT, SETUP_ENCRYPT_INFO);
        assert_ne!(CONTROLLER_SIGN_SALT, ACCESSORY_SIGN_SALT);
    }

    #[test]
    fn message_nonces_right_align_the_tag_in_a_zeroed_twelve_byte_buffer() {
        assert_eq!(message_nonce(NONCE_MSG05).to_vec(), hx("0000000050532d4d73673035"));
        assert_eq!(message_nonce(NONCE_MSG06).to_vec(), hx("0000000050532d4d73673036"));
        // Left-aligning is the mistake this pins against.
        let mut wrong = [0u8; 12];
        wrong[..8].copy_from_slice(NONCE_MSG05);
        assert_ne!(message_nonce(NONCE_MSG05), wrong);
    }

    #[test]
    fn the_setup_code_keeps_its_dashes_and_is_exactly_ten_bytes() {
        assert!(valid_setup_code("123-45-678"));
        assert!(valid_setup_code("000-00-000"));
        // The bug this exists to prevent: stripping the dashes.
        assert!(!valid_setup_code("12345678"));
        assert!(!valid_setup_code("123-456-78"));
        assert!(!valid_setup_code("12-345-678"));
        assert!(!valid_setup_code("123-45-67"));
        assert!(!valid_setup_code("123-45-6789"));
        assert!(!valid_setup_code("abc-de-fgh"));
        assert!(!valid_setup_code(""));
        // Non-ASCII must not panic on the byte indexing.
        assert!(!valid_setup_code("æøå-45-678"));
    }

    #[test]
    fn a_malformed_setup_code_is_refused_before_any_bytes_are_generated() {
        assert_eq!(
            PairSetup::new("12345678", "id", &[1u8; 32]).err(),
            Some(PairError::BadSetupCode)
        );
    }

    // =======================================================================
    // LAYER 3 — loopback.
    //
    // READ THIS BEFORE TRUSTING WHAT FOLLOWS. The accessory below is a test
    // double built from the ADK's ACCESSORY path, and it necessarily calls
    // the same `srp::` and `hkdf` helpers the controller does. So it CANNOT
    // detect a wrong salt string, a wrong info string or a wrong hash
    // composition: both sides would be wrong together and agree. It proves
    // exactly three things, all of which are real bugs it has to catch:
    // message framing and TLV fragmentation over the wire shapes; the state
    // machine's ordering and its refusals; and that the controller's SRP
    // branch meets the accessory's, which are genuinely different formulas.
    //
    // The only thing that would prove interoperability is a live accessory,
    // and Apple's HomeKit Accessory Simulator is not installed on this
    // machine. Nothing here has ever spoken to one.
    // =======================================================================

    struct FakeAccessory {
        pairing_id: String,
        ltsk: SigningKey,
        srp: Srp,
        salt: [u8; 16],
        b: [u8; 32],
        v: Vec<u8>,
        k: Vec<u8>,
        b_pub: Vec<u8>,
        k_session: Vec<u8>,
        encrypt_key: [u8; 32],
        /// Set once M5 has been accepted, so the test can assert the
        /// accessory really did verify the controller rather than shrugging.
        pub saw_controller: Option<(String, [u8; 32])>,
    }

    impl FakeAccessory {
        fn new(setup_code: &str, pairing_id: &str) -> FakeAccessory {
            let srp = Srp::new(srp::hap_group()).unwrap();
            let salt = [0xA5u8; 16];
            let group = srp.group().clone();
            let x = srp::compute_x::<Sha512Srp>(&salt, SRP_USER, setup_code.as_bytes());
            let k = srp::compute_k::<Sha512Srp>(&group);
            let v = srp.verifier(&x);
            let b = [0x5Au8; 32];
            let b_pub = srp.public_b(&b, &v, &k);
            FakeAccessory {
                pairing_id: pairing_id.to_string(),
                ltsk: SigningKey::from_bytes(&[0x11u8; 32]),
                srp,
                salt,
                b,
                v,
                k,
                b_pub,
                k_session: Vec::new(),
                encrypt_key: [0u8; 32],
                saw_controller: None,
            }
        }

        fn m2(&self) -> Vec<u8> {
            tlv::encode(&[
                Tlv::byte(tlv::TYPE_STATE, STATE_M2),
                Tlv::new(tlv::TYPE_PUBLIC_KEY, self.b_pub.clone()),
                Tlv::new(tlv::TYPE_SALT, self.salt.to_vec()),
            ])
            .unwrap()
        }

        /// M3 in, M4 out. Recomputes M1 the way the accessory does and
        /// answers with M2 — or with `kTLVType_Error` = Authentication, which
        /// is what a wrong setup code really produces.
        fn m4(&mut self, m3: &[u8]) -> Vec<u8> {
            let items = tlv::decode(m3).unwrap();
            let a_pub = tlv::get(&items, tlv::TYPE_PUBLIC_KEY).unwrap().to_vec();
            assert_eq!(a_pub.len(), 384, "A must survive TLV fragmentation intact");
            let proof = tlv::get(&items, tlv::TYPE_PROOF).unwrap().to_vec();

            let u = srp::compute_u::<Sha512Srp>(&a_pub, &self.b_pub);
            let s = self.srp.premaster_server(&a_pub, &self.b, &u, &self.v);
            let k_session = srp::session_key::<Sha512Srp>(&s);
            let want =
                srp::proof_m1::<Sha512Srp>(self.srp.group(), SRP_USER, &self.salt, &a_pub, &self.b_pub, &k_session);
            if !ct_eq(&proof, &want) {
                return tlv::encode(&[
                    Tlv::byte(tlv::TYPE_STATE, STATE_M4),
                    Tlv::byte(tlv::TYPE_ERROR, accessory_error::AUTHENTICATION),
                ])
                .unwrap();
            }
            let m2 = srp::proof_m2::<Sha512Srp>(&a_pub, &proof, &k_session);
            self.encrypt_key = hkdf_sha512_32(SETUP_ENCRYPT_SALT, &k_session, SETUP_ENCRYPT_INFO);
            self.k_session = k_session;
            tlv::encode(&[
                Tlv::byte(tlv::TYPE_STATE, STATE_M4),
                Tlv::new(tlv::TYPE_PROOF, m2),
            ])
            .unwrap()
        }

        /// M5 in, M6 out. Verifies iOSDeviceInfo, then signs AccessoryInfo.
        fn m6(&mut self, m5: &[u8]) -> Vec<u8> {
            let items = tlv::decode(m5).unwrap();
            let sealed = tlv::get(&items, tlv::TYPE_ENCRYPTED_DATA).unwrap();
            let plain = open(&self.encrypt_key, NONCE_MSG05, sealed).expect("M5 must decrypt");
            let sub = tlv::decode(&plain).unwrap();
            let id = String::from_utf8(tlv::get(&sub, tlv::TYPE_IDENTIFIER).unwrap().to_vec()).unwrap();
            let ltpk: [u8; 32] = tlv::get(&sub, tlv::TYPE_PUBLIC_KEY).unwrap().try_into().unwrap();
            let sig: [u8; 64] = tlv::get(&sub, tlv::TYPE_SIGNATURE).unwrap().try_into().unwrap();

            let x = hkdf_sha512_32(CONTROLLER_SIGN_SALT, &self.k_session, CONTROLLER_SIGN_INFO);
            let mut info = Vec::new();
            info.extend_from_slice(&x);
            info.extend_from_slice(id.as_bytes());
            info.extend_from_slice(&ltpk);
            VerifyingKey::from_bytes(&ltpk)
                .unwrap()
                .verify_strict(&info, &Signature::from_bytes(&sig))
                .expect("the accessory must be able to verify iOSDeviceInfo");
            self.saw_controller = Some((id, ltpk));

            let ax = hkdf_sha512_32(ACCESSORY_SIGN_SALT, &self.k_session, ACCESSORY_SIGN_INFO);
            let a_ltpk = self.ltsk.verifying_key().to_bytes();
            let mut ainfo = Vec::new();
            ainfo.extend_from_slice(&ax);
            ainfo.extend_from_slice(self.pairing_id.as_bytes());
            ainfo.extend_from_slice(&a_ltpk);
            let sig: Signature = self.ltsk.sign(&ainfo);

            let sub = tlv::encode(&[
                Tlv::new(tlv::TYPE_IDENTIFIER, self.pairing_id.as_bytes().to_vec()),
                Tlv::new(tlv::TYPE_PUBLIC_KEY, a_ltpk.to_vec()),
                Tlv::new(tlv::TYPE_SIGNATURE, sig.to_bytes().to_vec()),
            ])
            .unwrap();
            let sealed = seal(&self.encrypt_key, NONCE_MSG06, &sub).unwrap();
            tlv::encode(&[
                Tlv::byte(tlv::TYPE_STATE, STATE_M6),
                Tlv::new(tlv::TYPE_ENCRYPTED_DATA, sealed),
            ])
            .unwrap()
        }
    }

    /// A controller that has not yet sent M1.
    fn fresh(code: &str) -> PairSetup {
        PairSetup::with_client_secret(
            code,
            "9f1c0f00-0000-4000-8000-00000000abcd",
            &[0x33u8; 32],
            [0x77u8; 32],
        )
        .unwrap()
    }

    /// A controller that has sent M1 and is waiting for M2 — the state every
    /// test below except the ordering one starts from.
    fn controller(code: &str) -> PairSetup {
        let mut c = fresh(code);
        c.start().unwrap();
        c
    }

    #[test]
    fn a_full_pair_setup_completes_and_yields_the_accessory_identity() {
        let code = "123-45-678";
        let mut acc = FakeAccessory::new(code, "AA:BB:CC:DD:EE:FF");
        let mut c = fresh(code);

        let m1 = c.start().unwrap();
        // M1 is exactly State=1, Method=0 — six bytes, no Flags TLV.
        assert_eq!(m1, vec![0x06, 0x01, 0x01, 0x00, 0x01, 0x00]);

        let m3 = c.handle_m2(&acc.m2()).unwrap();
        let m5 = c.handle_m4(&acc.m4(&m3)).unwrap();
        let record = c.handle_m6(&acc.m6(&m5)).unwrap();

        assert_eq!(record.accessory_pairing_id, "AA:BB:CC:DD:EE:FF");
        assert_eq!(record.accessory_ltpk, acc.ltsk.verifying_key().to_bytes());
        assert_eq!(record.controller_pairing_id, "9f1c0f00-0000-4000-8000-00000000abcd");
        // The accessory must have actually verified us, not just replied.
        let (id, ltpk) = acc.saw_controller.clone().expect("accessory never saw a controller");
        assert_eq!(id, "9f1c0f00-0000-4000-8000-00000000abcd");
        assert_eq!(ltpk, c.controller_ltpk());
    }

    /// The wrong setup code must fail at M4 — not later, and not with a
    /// pairing. This is the path that proves the SRP proof is load-bearing.
    #[test]
    fn a_wrong_setup_code_is_rejected_at_m4_and_no_pairing_is_produced() {
        let mut acc = FakeAccessory::new("123-45-678", "AA:BB:CC:DD:EE:FF");
        let mut c = controller("876-54-321");
        let m3 = c.handle_m2(&acc.m2()).unwrap();
        let m4 = acc.m4(&m3);
        assert_eq!(
            c.handle_m4(&m4),
            Err(PairError::Accessory(accessory_error::AUTHENTICATION))
        );
        // And the exchange is poisoned: no second attempt on this object.
        assert_eq!(c.handle_m4(&m4), Err(PairError::OutOfOrder));
    }

    /// The mirror of the above: if the ACCESSORY cannot prove the code, the
    /// controller must refuse. Simulated by handing back a proof of the right
    /// length that is simply wrong.
    #[test]
    fn a_forged_m4_proof_is_refused_and_our_public_key_is_never_sent() {
        let acc = FakeAccessory::new("123-45-678", "AA:BB:CC:DD:EE:FF");
        let mut c = controller("123-45-678");
        let _ = c.handle_m2(&acc.m2()).unwrap();
        let forged = tlv::encode(&[
            Tlv::byte(tlv::TYPE_STATE, STATE_M4),
            Tlv::new(tlv::TYPE_PROOF, vec![0u8; 64]),
        ])
        .unwrap();
        assert_eq!(c.handle_m4(&forged), Err(PairError::ProofMismatch));
    }

    /// M6 signed with a key other than the one M6 advertises. This is the
    /// check that stops us persisting a public key its holder cannot use.
    #[test]
    fn an_m6_whose_signature_does_not_match_its_own_public_key_is_refused() {
        let code = "123-45-678";
        let mut acc = FakeAccessory::new(code, "AA:BB:CC:DD:EE:FF");
        let mut c = controller(code);
        let m3 = c.handle_m2(&acc.m2()).unwrap();
        let m5 = c.handle_m4(&acc.m4(&m3)).unwrap();

        // Rebuild M6 with a valid structure but a signature over junk.
        let good = acc.m6(&m5);
        let items = tlv::decode(&good).unwrap();
        let sealed = tlv::get(&items, tlv::TYPE_ENCRYPTED_DATA).unwrap();
        let plain = open(&acc.encrypt_key, NONCE_MSG06, sealed).unwrap();
        let mut sub = tlv::decode(&plain).unwrap();
        for item in sub.iter_mut() {
            if item.typ == tlv::TYPE_SIGNATURE {
                item.value[0] ^= 0xFF;
            }
        }
        let tampered = seal(&acc.encrypt_key, NONCE_MSG06, &tlv::encode(&sub).unwrap()).unwrap();
        let bad = tlv::encode(&[
            Tlv::byte(tlv::TYPE_STATE, STATE_M6),
            Tlv::new(tlv::TYPE_ENCRYPTED_DATA, tampered),
        ])
        .unwrap();
        assert_eq!(c.handle_m6(&bad), Err(PairError::SignatureInvalid));
    }

    /// A tampered M6 ciphertext must fail the AEAD tag, not the parser.
    #[test]
    fn a_tampered_m6_ciphertext_fails_the_tag_check() {
        let code = "123-45-678";
        let mut acc = FakeAccessory::new(code, "AA:BB:CC:DD:EE:FF");
        let mut c = controller(code);
        let m3 = c.handle_m2(&acc.m2()).unwrap();
        let m5 = c.handle_m4(&acc.m4(&m3)).unwrap();
        let mut m6 = acc.m6(&m5);
        let last = m6.len() - 1;
        m6[last] ^= 0x01;
        assert_eq!(c.handle_m6(&m6), Err(PairError::Decrypt));
    }

    #[test]
    fn steps_taken_out_of_order_are_refused_rather_than_half_run() {
        let acc = FakeAccessory::new("123-45-678", "AA:BB:CC:DD:EE:FF");
        // M2 before M1 has been sent.
        let mut c = fresh("123-45-678");
        assert_eq!(c.handle_m2(&acc.m2()), Err(PairError::OutOfOrder));
        // M4 and M6 before their predecessors.
        let mut c = controller("123-45-678");
        assert_eq!(c.handle_m4(&[]), Err(PairError::OutOfOrder));
        let mut c = controller("123-45-678");
        assert_eq!(c.handle_m6(&[]), Err(PairError::OutOfOrder));
        // A second M1.
        let mut c = controller("123-45-678");
        assert_eq!(c.start(), Err(PairError::OutOfOrder));
        // …and a replayed M2 is not a second chance at the same secret.
        let mut c = controller("123-45-678");
        c.handle_m2(&acc.m2()).unwrap();
        assert_eq!(c.handle_m2(&acc.m2()), Err(PairError::OutOfOrder));
    }

    /// Every accessory error code must surface as itself. Collapsing "already
    /// paired" into "wrong code" would send the user to change a code that is
    /// correct.
    #[test]
    fn every_accessory_error_code_reaches_the_caller_intact() {
        for code in [
            accessory_error::UNKNOWN,
            accessory_error::AUTHENTICATION,
            accessory_error::BACKOFF,
            accessory_error::MAX_PEERS,
            accessory_error::MAX_TRIES,
            accessory_error::UNAVAILABLE,
            accessory_error::BUSY,
        ] {
            let mut c = controller("123-45-678");
            let body = tlv::encode(&[
                Tlv::byte(tlv::TYPE_STATE, STATE_M2),
                Tlv::byte(tlv::TYPE_ERROR, code),
            ])
            .unwrap();
            assert_eq!(c.handle_m2(&body), Err(PairError::Accessory(code)));
        }
        // The sentence a user reads must distinguish the two that matter.
        assert!(PairError::Accessory(accessory_error::UNAVAILABLE)
            .to_string()
            .contains("already paired"));
        assert!(PairError::Accessory(accessory_error::AUTHENTICATION)
            .to_string()
            .contains("setup code"));
    }

    /// Malformed or hostile M2/M4/M6 bodies. None may panic — these arrive
    /// from an unauthenticated peer on the LAN.
    #[test]
    fn hostile_replies_produce_errors_and_never_a_panic() {
        let bodies: Vec<Vec<u8>> = vec![
            vec![],
            vec![0x06],
            vec![0x06, 0x01, 0x02],
            // right state, no salt
            tlv::encode(&[Tlv::byte(tlv::TYPE_STATE, STATE_M2)]).unwrap(),
            // salt of the wrong length
            tlv::encode(&[
                Tlv::byte(tlv::TYPE_STATE, STATE_M2),
                Tlv::new(tlv::TYPE_SALT, vec![0; 8]),
                Tlv::new(tlv::TYPE_PUBLIC_KEY, vec![0; 384]),
            ])
            .unwrap(),
            // B of the wrong length
            tlv::encode(&[
                Tlv::byte(tlv::TYPE_STATE, STATE_M2),
                Tlv::new(tlv::TYPE_SALT, vec![0; 16]),
                Tlv::new(tlv::TYPE_PUBLIC_KEY, vec![0; 16]),
            ])
            .unwrap(),
            // B = 0, which is 0 mod N
            tlv::encode(&[
                Tlv::byte(tlv::TYPE_STATE, STATE_M2),
                Tlv::new(tlv::TYPE_SALT, vec![0; 16]),
                Tlv::new(tlv::TYPE_PUBLIC_KEY, vec![0; 384]),
            ])
            .unwrap(),
            // the wrong state entirely
            tlv::encode(&[Tlv::byte(tlv::TYPE_STATE, STATE_M6)]).unwrap(),
            // a state that is two bytes long
            tlv::encode(&[Tlv::new(tlv::TYPE_STATE, vec![2, 2])]).unwrap(),
        ];
        for body in bodies {
            let mut c = controller("123-45-678");
            assert!(c.handle_m2(&body).is_err(), "{body:?}");
        }
    }

    /// The error mapping is what the surface renders, so the CATEGORY must
    /// match the fix: a wrong code is an auth problem, a busy accessory is a
    /// reachability problem, garbage on the wire is malformed.
    #[test]
    fn pair_errors_map_onto_the_home_error_that_names_the_right_fix() {
        use crate::home::HomeError as H;
        /// Names the "is this the right category?" predicate so the case list
        /// reads as a table rather than as a type.
        type Wants = fn(&H) -> bool;
        let cases: Vec<(PairError, Wants)> = vec![
            (PairError::BadSetupCode, |e| matches!(e, H::Refused(_))),
            (PairError::ProofMismatch, |e| matches!(e, H::Unauthorised(_))),
            (PairError::SignatureInvalid, |e| matches!(e, H::Unauthorised(_))),
            (PairError::Accessory(accessory_error::AUTHENTICATION), |e| {
                matches!(e, H::Unauthorised(_))
            }),
            (PairError::Accessory(accessory_error::BUSY), |e| matches!(e, H::Unreachable(_))),
            (PairError::Decrypt, |e| matches!(e, H::Malformed(_))),
            (PairError::Protocol("x".into()), |e| matches!(e, H::Malformed(_))),
        ];
        for (err, want) in cases {
            let shown = err.to_string();
            let mapped: H = err.into();
            assert!(want(&mapped), "{mapped}");
            // The sentence must survive the conversion — the surface shows it.
            assert_eq!(mapped.to_string(), shown);
        }
    }

    /// The MFi strings exist in this file ONLY as a do-not-use list. If one of
    /// them ever becomes a live constant, this test is the tripwire.
    #[test]
    fn the_mfi_strings_are_listed_but_never_used() {
        assert_eq!(MFI_NOT_IMPLEMENTED, &["PS-Msg04", "MFi-Pair-Setup-Salt", "MFi-Pair-Setup-Info"]);
        // A live HKDF salt or AEAD nonce in this file is a BYTE-string
        // literal, so that is what this looks for — prose and doc comments
        // may name these freely, and should. The needles are built at runtime
        // so they cannot match this assertion's own source text.
        let src = include_str!("pairing.rs");
        let q = '"';
        for tag in ["MFi-Pair-Setup", "PS-Msg04"] {
            let needle = format!("b{q}{tag}");
            assert!(
                !src.contains(&needle),
                "{tag} became a live constant — PairSetupWithAuth needs an MFi coprocessor"
            );
        }
    }
}
