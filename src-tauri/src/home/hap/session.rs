// The encrypted HAP session — the frame layer that everything after
// pair-verify travels inside.
//
// The moment pair-verify M4 comes back without an Error, the SAME TCP
// connection switches to this framing in both directions, immediately, with no
// further handshake bytes. From then on every byte of HTTP is inside a frame.
//
// THE FRAME (adk_HAPIPSecurityProtocol.c:43-70 for the writer, :95-115 for the
// reader):
//
//     +----------------+---------------------------+------------------+
//     | length         | ciphertext                | Poly1305 tag     |
//     | 2 bytes, LE    | `length` bytes            | 16 bytes         |
//     +----------------+---------------------------+------------------+
//             ^
//             └── these 2 bytes are ALSO the AAD
//
// The length prefix is sent in the clear AND authenticated: the ADK passes
// `&buffer->data[position]` — the two bytes it just wrote — as the aad pointer.
// That is what stops a man in the middle from re-cutting the stream: change the
// prefix and the tag stops verifying. `a_tampered_length_prefix_fails_the_tag`
// is the test that this file exists to make true.
//
// THE NONCE (adk_HAPSession.c:560): four zero bytes followed by a 64-bit
// LITTLE-ENDIAN counter, one counter per direction, both zeroed when the
// session is activated (adk_HAPPairingPairVerify.c:75-76) and incremented by
// exactly one after every frame — encrypt or decrypt, adk_HAPSession.c:584 and
// :706. There is no rekey and no counter reset within a session.
//
// WHY THE COUNTER IS THE MOST DANGEROUS THING IN THIS FILE. ChaCha20-Poly1305
// is a stream cipher with a one-time authenticator: reusing a (key, nonce) pair
// across two frames leaks the XOR of their plaintexts AND, worse, hands an
// attacker the Poly1305 key for that nonce, which is a total loss of
// authenticity for every frame that shares it. So a counter that resets,
// repeats, or is skipped on a failure is not a bug that degrades performance —
// it is the collapse of the whole session. The design consequences, each with
// a test below:
//   * the counters live in this struct and nothing outside can set them;
//   * they advance per FRAME, never per HTTP message;
//   * a failed tag check POISONS the session rather than retrying, because
//     retrying at the same counter is exactly the reuse above and continuing at
//     the next one desynchronises the streams permanently.
//
// EVERY LENGTH ON THIS PATH ARRIVES FROM THE LAN. The one length field a peer
// controls is the 2-byte prefix, and it is bounded by the protocol at 1024
// before it is ever used to size anything.

use std::io::{Read, Write};

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, KeyInit, Nonce};

use super::verify::SessionKeys;

// ---------------------------------------------------------------------------
// Sizes — all of them protocol, none of them policy
// ---------------------------------------------------------------------------

/// `kHAPIPSecurityProtocol_MaxFrameBytes ((size_t) 1024)` —
/// adk_HAPIPSecurityProtocol.h:23. The reader rejects anything larger
/// (:100-103), so this is a hard ceiling and not a tuning knob.
pub const MAX_FRAME_PLAINTEXT: usize = 1024;

/// `kHAPIPSecurityProtocol_NumAADBytes ((size_t) 2)` —
/// adk_HAPIPSecurityProtocol.c:12.
pub const AAD_BYTES: usize = 2;

pub const TAG_BYTES: usize = 16;

/// The largest a single frame can be on the wire. Because the length prefix is
/// capped at 1024 BEFORE it sizes anything, no peer can make this file
/// allocate more than this per frame, whatever it claims.
pub const MAX_FRAME_WIRE: usize = AAD_BYTES + MAX_FRAME_PLAINTEXT + TAG_BYTES;

/// Ceiling on undecrypted bytes held while waiting for a frame to complete.
///
/// `drain` removes every COMPLETE frame, so what is left is always a partial
/// frame — under `MAX_FRAME_WIRE` bytes — plus at most one read's worth. Two
/// frames' worth is therefore unreachable in normal operation and exists as a
/// tripwire: if it ever trips, the drain/fill invariant has been broken by a
/// later edit, and failing loudly beats growing quietly.
pub const MAX_RAW_BUFFER: usize = 2 * MAX_FRAME_WIRE;

/// Ceiling on decrypted-but-unconsumed plaintext.
///
/// An HTTP message spans frames, so plaintext has to accumulate somewhere, and
/// that somewhere is a buffer a peer can grow by sending frames. `http.rs`
/// enforces its own, tighter, per-message limits; this is the backstop that
/// holds even if a future caller forgets to. One MiB matches `ws.rs`'s
/// `MAX_FRAME_BYTES` for the same reason: generous by orders of magnitude
/// against any real accessory, and still a bound.
pub const MAX_PLAINTEXT_BUFFER: usize = 1024 * 1024;

/// How many times `fill` retries a read interrupted by a signal before giving
/// up and reporting `Idle`. See the comment at the retry loop: the point is
/// that `fill` must never be able to return "no progress and no error"
/// forever, because its caller loops on exactly that condition.
const EINTR_RETRIES: usize = 8;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionError {
    /// TCP-level failure.
    Io(String),
    /// The peer closed.
    Closed,
    /// No bytes within the socket's read timeout. Not a failure — the caller
    /// decides whether to keep waiting.
    Idle,
    /// The framing rules were broken. Always a refusal, never a repair.
    Protocol(String),
    /// A tag check failed at this counter. Fatal for the session.
    Decrypt { counter: u64 },
    /// A previous failure tore the session down. Every later call says so
    /// rather than starting a fresh counter on a stream the peer is still
    /// encrypting against the old one.
    Poisoned,
    /// A buffer ceiling was hit.
    Overflow(&'static str),
}

impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SessionError::Io(m) => write!(f, "the accessory connection failed: {m}"),
            SessionError::Closed => write!(f, "the accessory closed the connection"),
            SessionError::Idle => write!(f, "no data from the accessory within the poll window"),
            SessionError::Protocol(m) => write!(f, "the accessory broke the HAP framing: {m}"),
            SessionError::Decrypt { counter } => write!(
                f,
                "frame {counter} from the accessory did not authenticate — dropping the session"
            ),
            SessionError::Poisoned => {
                write!(f, "this accessory session already failed and cannot be reused")
            }
            SessionError::Overflow(what) => {
                write!(f, "the accessory sent more {what} than Atlas will hold")
            }
        }
    }
}

impl From<SessionError> for crate::home::HomeError {
    fn from(e: SessionError) -> crate::home::HomeError {
        use crate::home::HomeError as H;
        let msg = e.to_string();
        match e {
            // Idle is not a failure, but a caller that converts it has already
            // decided to give up waiting, and "nothing answered" is what that
            // means to the user.
            SessionError::Io(_) | SessionError::Closed | SessionError::Idle => H::Unreachable(msg),
            SessionError::Protocol(_)
            | SessionError::Decrypt { .. }
            | SessionError::Overflow(_) => H::Malformed(msg),
            SessionError::Poisoned => H::Refused(msg),
        }
    }
}

// ---------------------------------------------------------------------------
// The nonce
// ---------------------------------------------------------------------------

/// Four zero bytes, then the counter as a 64-bit LITTLE-endian integer.
///
/// `uint8_t nonce[] = { HAPExpandLittleUInt64(channel->nonce) };`
/// (adk_HAPSession.c:560) produces the 8 bytes, and the AEAD layer left-pads
/// them into a 12-byte buffer (HAPMbedTLS.c:539-546) — the same right-alignment
/// the "PS-Msg05" style nonces get. Big-endian here would produce a session
/// where frame 0 works and frame 1 does not.
pub fn frame_nonce(counter: u64) -> [u8; 12] {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_le_bytes());
    n
}

// ---------------------------------------------------------------------------
// One frame
// ---------------------------------------------------------------------------

/// Seal one frame: `LE16(len) ‖ ciphertext ‖ tag`, with the two length bytes as
/// AAD. `None` only if the AEAD refuses, which it will not for a plaintext this
/// size — the fallback keeps the function total rather than adding an unwrap.
///
/// Public so tests can construct frames without a `HapSession`, and so the AAD
/// property can be exercised directly rather than only through the stream.
pub fn seal_frame(key: &[u8; 32], counter: u64, plaintext: &[u8]) -> Option<Vec<u8>> {
    if plaintext.is_empty() || plaintext.len() > MAX_FRAME_PLAINTEXT {
        return None;
    }
    let aad = (plaintext.len() as u16).to_le_bytes();
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let sealed = cipher
        .encrypt(
            Nonce::from_slice(&frame_nonce(counter)),
            Payload { msg: plaintext, aad: &aad },
        )
        .ok()?;
    let mut out = Vec::with_capacity(AAD_BYTES + sealed.len());
    out.extend_from_slice(&aad);
    out.extend_from_slice(&sealed);
    Some(out)
}

/// Open one frame. `aad` is the length prefix EXACTLY as it arrived — passing a
/// re-derived value instead of the received bytes would quietly disable the
/// authentication this prefix exists to provide.
pub fn open_frame(
    key: &[u8; 32],
    counter: u64,
    aad: &[u8; 2],
    ciphertext_and_tag: &[u8],
) -> Option<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    cipher
        .decrypt(
            Nonce::from_slice(&frame_nonce(counter)),
            Payload { msg: ciphertext_and_tag, aad },
        )
        .ok()
}

/// Wire size of a plaintext once framed. `HAPIPSecurityProtocolGetNumEncrypted
/// Bytes` (adk_HAPIPSecurityProtocol.c:15-24), transcribed so a caller can size
/// a buffer without guessing.
pub fn encrypted_len(plaintext_len: usize) -> usize {
    let whole = plaintext_len / MAX_FRAME_PLAINTEXT;
    let rest = plaintext_len % MAX_FRAME_PLAINTEXT;
    whole * MAX_FRAME_WIRE + if rest != 0 { AAD_BYTES + rest + TAG_BYTES } else { 0 }
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/// One direction's key and counter, plus the two buffers the stream needs.
///
/// The counters are PRIVATE and there is no setter. That is the entire defence
/// against nonce reuse: the only way either moves is one frame at a time,
/// through the two methods below.
pub struct HapSession {
    read_key: [u8; 32],
    write_key: [u8; 32],
    read_counter: u64,
    write_counter: u64,
    /// Undecrypted bytes, awaiting a complete frame.
    raw: Vec<u8>,
    /// Decrypted bytes the HTTP parser has not consumed yet.
    plain: Vec<u8>,
    poisoned: bool,
}

/// The two directional keys are wiped when the session ends. A session ends
/// when the connection does, so without this every connection Atlas ever makes
/// leaves its keys in freed heap for the rest of the process' life. The
/// plaintext buffer goes too — it holds decrypted accessory replies.
impl Drop for HapSession {
    fn drop(&mut self) {
        super::wipe(&mut self.read_key);
        super::wipe(&mut self.write_key);
        super::wipe(&mut self.plain);
    }
}

/// Hand-written: the derived one would print both keys.
impl std::fmt::Debug for HapSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HapSession")
            .field("read_counter", &self.read_counter)
            .field("write_counter", &self.write_counter)
            .field("buffered_raw", &self.raw.len())
            .field("buffered_plain", &self.plain.len())
            .field("poisoned", &self.poisoned)
            .finish()
    }
}

impl HapSession {
    /// Both counters start at zero, matching the accessory zeroing its pair at
    /// session activation. A session is created by exactly one successful
    /// pair-verify and is never reused across connections.
    pub fn new(keys: SessionKeys) -> HapSession {
        HapSession {
            read_key: keys.read,
            write_key: keys.write,
            read_counter: 0,
            write_counter: 0,
            raw: Vec::new(),
            plain: Vec::new(),
            poisoned: false,
        }
    }

    pub fn read_counter(&self) -> u64 {
        self.read_counter
    }
    pub fn write_counter(&self) -> u64 {
        self.write_counter
    }
    pub fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    /// Frame a whole message: 1024-byte plaintext chunks, a short final frame,
    /// and one counter increment per frame.
    ///
    /// An HTTP request is NOT a frame boundary. A 3000-byte body is three
    /// frames and moves the counter by three; treating it as one message and
    /// incrementing once would reuse nonces on the very next request.
    pub fn seal_message(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, SessionError> {
        if self.poisoned {
            return Err(SessionError::Poisoned);
        }
        if plaintext.is_empty() {
            // The ADK's writer loop (`while (position < buffer->limit)`) emits
            // nothing for an empty message, so an empty frame is not a thing
            // this protocol has. Refusing keeps `seal_frame`'s precondition
            // honest instead of silently sending zero frames.
            return Err(SessionError::Protocol("refusing to send an empty message".into()));
        }
        let mut out = Vec::with_capacity(encrypted_len(plaintext.len()));
        for chunk in plaintext.chunks(MAX_FRAME_PLAINTEXT) {
            let frame = match seal_frame(&self.write_key, self.write_counter, chunk) {
                Some(f) => f,
                None => {
                    self.poisoned = true;
                    return Err(SessionError::Protocol("the AEAD refused to seal a frame".into()));
                }
            };
            out.extend_from_slice(&frame);
            // Wrapping is unreachable — a u64 of 1 KiB frames is more data than
            // this machine will ever move — but `wrapping_add` would silently
            // restart the counter if it ever were, so it is not used.
            self.write_counter = match self.write_counter.checked_add(1) {
                Some(n) => n,
                None => {
                    self.poisoned = true;
                    return Err(SessionError::Protocol("the send counter would wrap".into()));
                }
            };
        }
        Ok(out)
    }

    /// Frame and write. Kept together so no caller can seal a message (moving
    /// the counter) and then fail to send it, which would desynchronise the
    /// stream just as badly as reusing one.
    pub fn write_message(
        &mut self,
        w: &mut impl Write,
        plaintext: &[u8],
    ) -> Result<(), SessionError> {
        let bytes = self.seal_message(plaintext)?;
        w.write_all(&bytes).map_err(|e| {
            self.poisoned = true;
            SessionError::Io(e.to_string())
        })?;
        w.flush().map_err(|e| {
            self.poisoned = true;
            SessionError::Io(e.to_string())
        })
    }

    /// Read once from the socket into the raw buffer. Returns how many bytes
    /// arrived.
    ///
    /// The read is bounded to one frame's worth per call, which is what keeps
    /// `raw` inside `MAX_RAW_BUFFER` given that `drain` runs between fills.
    pub fn fill(&mut self, r: &mut impl Read) -> Result<usize, SessionError> {
        if self.poisoned {
            return Err(SessionError::Poisoned);
        }
        if self.raw.len() >= MAX_RAW_BUFFER {
            self.poisoned = true;
            return Err(SessionError::Overflow("unframed bytes"));
        }
        let mut buf = [0u8; MAX_FRAME_WIRE];
        let want = (MAX_RAW_BUFFER - self.raw.len()).min(MAX_FRAME_WIRE);
        // EINTR is a signal arriving mid-syscall, not anything the peer did,
        // so retrying is the correct response — but a BOUNDED number of times.
        // `http.rs::read_message` loops until it has a message or an error, so
        // a `fill` that could return "no bytes, no error" indefinitely would be
        // an unbounded loop with nothing to stop it. Falling through to `Idle`
        // hands the decision to a caller that already has a poll budget.
        for _ in 0..EINTR_RETRIES {
            match r.read(&mut buf[..want]) {
                Ok(0) => return Err(SessionError::Closed),
                Ok(n) => {
                    self.raw.extend_from_slice(&buf[..n]);
                    return Ok(n);
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    // NOT poisoning: a timeout means no bytes were consumed, so
                    // the stream is exactly where it was. This is the one
                    // recoverable error in the file.
                    return Err(SessionError::Idle);
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    self.poisoned = true;
                    return Err(SessionError::Io(e.to_string()));
                }
            }
        }
        Err(SessionError::Idle)
    }

    /// Decrypt every COMPLETE frame currently buffered, appending plaintext.
    /// Returns how many plaintext bytes were added.
    ///
    /// A partial frame is left untouched — the counter must not move until a
    /// frame has actually been authenticated.
    pub fn drain(&mut self) -> Result<usize, SessionError> {
        if self.poisoned {
            return Err(SessionError::Poisoned);
        }
        let mut added = 0usize;
        let mut offset = 0usize;

        loop {
            if self.raw.len() - offset < AAD_BYTES {
                break;
            }
            let aad = [self.raw[offset], self.raw[offset + 1]];
            let len = u16::from_le_bytes(aad) as usize;
            // BOUNDED BEFORE IT IS USED. This is the only length a peer
            // controls on this path, and it is checked against the protocol
            // ceiling before it indexes, sizes or allocates anything.
            if len > MAX_FRAME_PLAINTEXT {
                self.poisoned = true;
                return Err(SessionError::Protocol(format!(
                    "a frame claiming {len} plaintext bytes is over the 1024 ceiling"
                )));
            }
            if len == 0 {
                // The ADK never emits one, and accepting them would let a peer
                // spin this loop forever at 18 bytes a turn while `plain` never
                // grows, so no ceiling would ever stop it.
                self.poisoned = true;
                return Err(SessionError::Protocol("a frame carrying no plaintext".into()));
            }
            let need = AAD_BYTES + len + TAG_BYTES;
            if self.raw.len() - offset < need {
                break;
            }
            let body = &self.raw[offset + AAD_BYTES..offset + need];
            let plain = match open_frame(&self.read_key, self.read_counter, &aad, body) {
                Some(p) => p,
                None => {
                    // FATAL, and the counter does not move. Retrying at the
                    // same counter is nonce reuse; carrying on at the next one
                    // desynchronises the streams for good. The ADK tears the
                    // session down here too (adk_HAPSession.c:697-702).
                    self.poisoned = true;
                    return Err(SessionError::Decrypt { counter: self.read_counter });
                }
            };
            if self.plain.len() + plain.len() > MAX_PLAINTEXT_BUFFER {
                self.poisoned = true;
                return Err(SessionError::Overflow("data"));
            }
            self.plain.extend_from_slice(&plain);
            added += plain.len();
            offset += need;
            self.read_counter = match self.read_counter.checked_add(1) {
                Some(n) => n,
                None => {
                    self.poisoned = true;
                    return Err(SessionError::Protocol("the receive counter would wrap".into()));
                }
            };
        }

        if offset > 0 {
            self.raw.drain(..offset);
        }
        Ok(added)
    }

    /// The decrypted bytes not yet consumed. The HTTP parser reads from here
    /// and calls `consume` once it has taken a whole message.
    pub fn buffered(&self) -> &[u8] {
        &self.plain
    }

    pub fn consume(&mut self, n: usize) {
        let n = n.min(self.plain.len());
        self.plain.drain(..n);
    }

    /// Tear the session down deliberately — used by `http.rs` when the HTTP
    /// layer, not the crypto, decides the stream can no longer be trusted.
    pub fn poison(&mut self) {
        self.poisoned = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::home::hap::srp::unhex;
    use std::io::Cursor;

    fn hx(s: &str) -> Vec<u8> {
        unhex(s).expect("test hex")
    }

    fn keys() -> SessionKeys {
        SessionKeys { read: [0x01u8; 32], write: [0x02u8; 32] }
    }

    /// A session whose read key is the OTHER one's write key — i.e. two peers.
    fn pair() -> (HapSession, HapSession) {
        let k = keys();
        let ours = HapSession::new(k.clone());
        let theirs = HapSession::new(SessionKeys { read: k.write, write: k.read });
        (ours, theirs)
    }

    // =======================================================================
    // LAYER 1 — the AEAD itself, against RFC 8439.
    // =======================================================================

    /// RFC 8439 §2.8.2, verbatim from https://www.rfc-editor.org/rfc/rfc8439.txt
    /// (lines 1258-1367). Run HERE and not only in pairing.rs because this file
    /// uses the AEAD differently: a NON-EMPTY AAD and a counter nonce. The
    /// vector's own nonce shape — a 32-bit fixed part then a 64-bit IV — is
    /// structurally identical to HAP's `00000000 ‖ counter_LE`, which is what
    /// makes it the right vector for a frame layer.
    #[test]
    fn rfc_8439_aead_vector_with_a_non_empty_aad() {
        let key = hx("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
        let nonce = hx("070000004041424344454647");
        let aad = hx("50515253c0c1c2c3c4c5c6c7");
        let plaintext = hx("4c616469657320616e642047656e746c656d656e206f662074686520636c617373\
                            206f66202739393a204966204920636f756c64206f6666657220796f75206f6e6c\
                            79206f6e652074697020666f7220746865206675747572652c2073756e73637265\
                            656e20776f756c642062652069742e");
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
        // The AAD is authenticated, not encrypted: flip one AAD byte and the
        // SAME ciphertext must stop opening. This is the property the length
        // prefix relies on.
        let mut bad_aad = aad.clone();
        bad_aad[0] ^= 0x01;
        assert!(cipher
            .decrypt(Nonce::from_slice(&nonce), Payload { msg: &out, aad: &bad_aad })
            .is_err());
        assert!(cipher
            .decrypt(Nonce::from_slice(&nonce), Payload { msg: &out, aad: &aad })
            .is_ok());
    }

    // =======================================================================
    // LAYER 2 — the HAP composition, pinned as bytes.
    // =======================================================================

    /// Little-endian, right-aligned in twelve bytes. Big-endian would give a
    /// session where frame 0 works — both encodings agree on zero — and frame 1
    /// does not, which is the worst possible place for the bug to surface.
    /// The layout is derived, not remembered: `HAPExpandLittleUInt64`
    /// (PAL/HAPBase.h:654-658) expands to EIGHT bytes, LSB first, so
    /// `uint8_t nonce[] = { … }` has `sizeof nonce == 8`; the AEAD layer then
    /// does `memcpy(nonce + 12 - 8, n, 8)` (HAPMbedTLS.c:545), putting the
    /// counter at offset 4 and NOT at offset 8. The counter occupies bytes
    /// 4..12 in full, which is what makes the last case below all-`ff`.
    #[test]
    fn the_frame_nonce_is_four_zeros_then_a_little_endian_counter() {
        assert_eq!(frame_nonce(0).to_vec(), hx("000000000000000000000000"));
        assert_eq!(frame_nonce(1).to_vec(), hx("000000000100000000000000"));
        assert_eq!(frame_nonce(0x0102).to_vec(), hx("000000000201000000000000"));
        assert_eq!(frame_nonce(u64::MAX).to_vec(), hx("00000000ffffffffffffffff"));
        // The counter really does span all eight remaining bytes: a value that
        // only fits in the top one must land in the LAST byte.
        assert_eq!(frame_nonce(1u64 << 56).to_vec(), hx("000000000000000000000001"));
        // The first four bytes are ALWAYS zero — that is the padding, not part
        // of the counter.
        for c in [0u64, 1, 255, 65_536, u64::MAX] {
            assert_eq!(&frame_nonce(c)[..4], &[0, 0, 0, 0]);
        }
    }

    /// Every counter produces a different nonce. Trivially true of a
    /// bijection, and the whole safety argument rests on it, so it is asserted
    /// rather than assumed.
    #[test]
    fn no_two_counters_share_a_nonce() {
        let mut seen = std::collections::HashSet::new();
        for c in 0..2048u64 {
            assert!(seen.insert(frame_nonce(c)), "counter {c} repeated a nonce");
        }
    }

    #[test]
    fn the_frame_layout_is_a_little_endian_length_then_ciphertext_then_tag() {
        let f = seal_frame(&[7u8; 32], 0, b"hello").unwrap();
        assert_eq!(f.len(), AAD_BYTES + 5 + TAG_BYTES);
        assert_eq!(&f[..2], &[5u8, 0], "length is LE16");
        assert_eq!(open_frame(&[7u8; 32], 0, &[5, 0], &f[2..]).unwrap(), b"hello");
    }

    /// `HAPIPSecurityProtocolGetNumEncryptedBytes`, transcribed.
    #[test]
    fn the_wire_size_matches_the_adk_formula() {
        assert_eq!(encrypted_len(0), 0);
        assert_eq!(encrypted_len(1), 2 + 1 + 16);
        assert_eq!(encrypted_len(1024), 1042);
        assert_eq!(encrypted_len(1025), 1042 + 2 + 1 + 16);
        assert_eq!(encrypted_len(3000), 1042 + 1042 + 2 + 952 + 16);
    }

    // -- the counter ------------------------------------------------------

    #[test]
    fn sequential_frames_advance_the_counter_once_per_frame() {
        let (mut ours, mut theirs) = pair();
        assert_eq!((ours.write_counter(), theirs.read_counter()), (0, 0));

        for expected in 1..=5u64 {
            let wire = ours.seal_message(b"one short message").unwrap();
            assert_eq!(ours.write_counter(), expected);
            theirs.fill(&mut Cursor::new(wire)).unwrap();
            theirs.drain().unwrap();
            assert_eq!(theirs.read_counter(), expected);
        }
        assert_eq!(theirs.buffered().len(), 5 * b"one short message".len());
    }

    /// A message longer than one frame moves the counter by the number of
    /// FRAMES, not by one. An implementation that incremented per message would
    /// pass every single-frame test and reuse a nonce on the second request.
    #[test]
    fn a_three_frame_message_advances_the_counter_by_three() {
        let (mut ours, mut theirs) = pair();
        let msg: Vec<u8> = (0..3000u32).map(|i| (i % 251) as u8).collect();
        let wire = ours.seal_message(&msg).unwrap();
        assert_eq!(wire.len(), encrypted_len(3000));
        assert_eq!(ours.write_counter(), 3);

        // Feed it in one go; `fill` is bounded to a frame at a time, so this
        // also exercises the fill/drain loop.
        let mut cur = Cursor::new(wire);
        while theirs.buffered().len() < msg.len() {
            theirs.fill(&mut cur).unwrap();
            theirs.drain().unwrap();
        }
        assert_eq!(theirs.read_counter(), 3);
        assert_eq!(theirs.buffered(), &msg[..]);
    }

    /// THE ONE THAT MATTERS. A frame the peer already sent, sent again, was
    /// sealed under counter N and now arrives at counter N+1 — so its tag
    /// cannot verify, and the session dies rather than accepting it.
    #[test]
    fn a_replayed_frame_is_rejected_and_kills_the_session() {
        let (mut ours, mut theirs) = pair();
        let wire = ours.seal_message(b"unlock the door").unwrap();

        theirs.fill(&mut Cursor::new(wire.clone())).unwrap();
        assert_eq!(theirs.drain().unwrap(), b"unlock the door".len());
        assert_eq!(theirs.read_counter(), 1);

        theirs.fill(&mut Cursor::new(wire)).unwrap();
        assert_eq!(theirs.drain(), Err(SessionError::Decrypt { counter: 1 }));
        assert!(theirs.is_poisoned());
        // And the counter did NOT move on the failure.
        assert_eq!(theirs.read_counter(), 1);
        // Nothing further is accepted, in either direction.
        assert_eq!(theirs.drain(), Err(SessionError::Poisoned));
        assert_eq!(theirs.seal_message(b"x"), Err(SessionError::Poisoned));
    }

    /// Frames delivered out of order are the same failure as a replay: frame 1
    /// arriving where frame 0 was expected authenticates under the wrong nonce.
    #[test]
    fn frames_delivered_out_of_order_are_rejected() {
        let (mut ours, mut theirs) = pair();
        let a = ours.seal_message(b"first").unwrap();
        let b = ours.seal_message(b"second").unwrap();
        let mut swapped = b;
        swapped.extend_from_slice(&a);
        theirs.fill(&mut Cursor::new(swapped)).unwrap();
        assert_eq!(theirs.drain(), Err(SessionError::Decrypt { counter: 0 }));
    }

    // -- the AAD ----------------------------------------------------------

    /// The length prefix IS the AAD, checked at the primitive so the property
    /// is stated without any stream mechanics in the way: same key, same
    /// counter, same ciphertext, one different length byte — and it does not
    /// open.
    #[test]
    fn the_length_prefix_is_authenticated_not_merely_transmitted() {
        let key = [0x5Au8; 32];
        let f = seal_frame(&key, 0, &[0u8; 100]).unwrap();
        assert_eq!(&f[..2], &[100u8, 0]);
        assert!(open_frame(&key, 0, &[100, 0], &f[2..]).is_some());
        for wrong in [[101u8, 0], [99, 0], [100, 1], [0, 0]] {
            assert!(
                open_frame(&key, 0, &wrong, &f[2..]).is_none(),
                "aad {wrong:?} must not open a frame sealed with [100, 0]"
            );
        }
    }

    /// The same property through the stream, which is how it will actually be
    /// attacked: two frames back to back, the first one's length prefix nudged
    /// up by one so the reader would swallow a byte of the second frame.
    /// Re-cutting the stream must not be possible.
    #[test]
    fn a_tampered_length_prefix_fails_the_tag_rather_than_recutting_the_stream() {
        let (mut ours, mut theirs) = pair();
        let mut wire = ours.seal_message(&[0xAAu8; 100]).unwrap();
        wire.extend_from_slice(&ours.seal_message(&[0xBBu8; 100]).unwrap());
        assert_eq!(wire[0], 100);

        wire[0] = 101;
        let mut cur = Cursor::new(wire);
        theirs.fill(&mut cur).unwrap();
        assert_eq!(theirs.drain(), Err(SessionError::Decrypt { counter: 0 }));
        assert!(theirs.is_poisoned());
    }

    #[test]
    fn a_tampered_ciphertext_or_tag_fails_the_tag_check() {
        for flip in [2usize, 50, 101, 117] {
            let (mut ours, mut theirs) = pair();
            let mut wire = ours.seal_message(&[0x11u8; 100]).unwrap();
            assert_eq!(wire.len(), 118);
            wire[flip] ^= 0x01;
            theirs.fill(&mut Cursor::new(wire)).unwrap();
            assert_eq!(theirs.drain(), Err(SessionError::Decrypt { counter: 0 }), "byte {flip}");
        }
    }

    /// Swapping the two directional keys is the mistake pair-verify's naming
    /// exists to prevent; it must fail loudly on the first frame.
    #[test]
    fn a_session_keyed_in_the_wrong_direction_fails_immediately() {
        let k = keys();
        let mut ours = HapSession::new(k.clone());
        // Same keys, NOT crossed over.
        let mut theirs = HapSession::new(k);
        let wire = ours.seal_message(b"hello").unwrap();
        theirs.fill(&mut Cursor::new(wire)).unwrap();
        assert_eq!(theirs.drain(), Err(SessionError::Decrypt { counter: 0 }));
    }

    // -- bounds -----------------------------------------------------------

    /// The one length field a peer controls, rejected before it sizes
    /// anything. 1025 is the first illegal value.
    #[test]
    fn a_length_prefix_over_1024_is_refused_before_anything_is_allocated() {
        for len in [1025u16, 4096, 30_000, u16::MAX] {
            let mut s = HapSession::new(keys());
            let mut wire = len.to_le_bytes().to_vec();
            // Deliberately WITHOUT the bytes it claims: if the ceiling were
            // checked after allocating or after waiting for the body, this test
            // would hang or allocate instead of failing.
            wire.extend_from_slice(&[0u8; 8]);
            s.fill(&mut Cursor::new(wire)).unwrap();
            assert!(
                matches!(s.drain(), Err(SessionError::Protocol(_))),
                "length {len} was not refused"
            );
            assert!(s.is_poisoned());
        }
        // 1024 exactly is legal and must still work.
        let (mut ours, mut theirs) = pair();
        let wire = ours.seal_message(&[0x7Eu8; 1024]).unwrap();
        assert_eq!(wire.len(), MAX_FRAME_WIRE);
        theirs.fill(&mut Cursor::new(wire)).unwrap();
        theirs.drain().unwrap();
        assert_eq!(theirs.buffered().len(), 1024);
    }

    /// A zero-length frame costs the sender 18 bytes and would otherwise buy an
    /// infinite loop that no plaintext ceiling can stop, because the plaintext
    /// never grows.
    #[test]
    fn a_zero_length_frame_is_refused() {
        let mut s = HapSession::new(keys());
        let mut wire = vec![0u8, 0];
        wire.extend_from_slice(&[0u8; TAG_BYTES]);
        s.fill(&mut Cursor::new(wire)).unwrap();
        assert!(matches!(s.drain(), Err(SessionError::Protocol(_))));
        // And we never emit one either.
        let mut t = HapSession::new(keys());
        assert!(matches!(t.seal_message(&[]), Err(SessionError::Protocol(_))));
        assert_eq!(t.write_counter(), 0);
    }

    /// A partial frame must leave the counter and the plaintext alone, and must
    /// complete correctly once the rest arrives. A dribbling peer is the normal
    /// case on a real network, not an attack.
    #[test]
    fn a_frame_that_arrives_in_pieces_is_held_until_it_is_whole() {
        let (mut ours, mut theirs) = pair();
        let wire = ours.seal_message(&[0x42u8; 300]).unwrap();
        for cut in 1..wire.len() {
            let mut t = HapSession::new(SessionKeys { read: keys().write, write: keys().read });
            t.fill(&mut Cursor::new(wire[..cut].to_vec())).unwrap();
            assert_eq!(t.drain().unwrap(), 0, "cut {cut} decrypted something");
            assert_eq!(t.read_counter(), 0);
        }
        let mut cur = Cursor::new(wire);
        theirs.fill(&mut cur).unwrap();
        theirs.drain().unwrap();
        assert_eq!(theirs.buffered().len(), 300);
    }

    /// Bytes arriving one at a time — the pathological version of the above.
    #[test]
    fn a_byte_at_a_time_peer_still_produces_exactly_one_message() {
        let (mut ours, mut theirs) = pair();
        let wire = ours.seal_message(b"drip").unwrap();
        for b in wire {
            theirs.fill(&mut Cursor::new(vec![b])).unwrap();
            theirs.drain().unwrap();
        }
        assert_eq!(theirs.buffered(), b"drip");
        assert_eq!(theirs.read_counter(), 1);
    }

    #[test]
    fn consume_takes_only_what_was_asked_for_and_never_over_runs() {
        let (mut ours, mut theirs) = pair();
        let wire = ours.seal_message(b"abcdefghij").unwrap();
        theirs.fill(&mut Cursor::new(wire)).unwrap();
        theirs.drain().unwrap();
        theirs.consume(4);
        assert_eq!(theirs.buffered(), b"efghij");
        theirs.consume(999);
        assert_eq!(theirs.buffered(), b"");
    }

    /// EOF is `Closed`, not a silent success.
    #[test]
    fn an_empty_read_is_reported_as_a_close() {
        let mut s = HapSession::new(keys());
        assert_eq!(s.fill(&mut Cursor::new(Vec::new())), Err(SessionError::Closed));
    }

    /// A timeout must NOT poison: nothing was consumed, so the stream is
    /// exactly where it was and waiting longer is the right move.
    #[test]
    fn a_read_timeout_is_idle_and_leaves_the_session_usable() {
        struct Timeout;
        impl Read for Timeout {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "timed out"))
            }
        }
        let (mut ours, mut theirs) = pair();
        assert_eq!(theirs.fill(&mut Timeout), Err(SessionError::Idle));
        assert!(!theirs.is_poisoned());
        let wire = ours.seal_message(b"still fine").unwrap();
        theirs.fill(&mut Cursor::new(wire)).unwrap();
        theirs.drain().unwrap();
        assert_eq!(theirs.buffered(), b"still fine");
    }

    /// A read interrupted by a signal is retried, because nothing was consumed
    /// and the peer did nothing wrong — but only a bounded number of times, so
    /// `fill` can never answer "no bytes and no error" forever to a caller that
    /// loops on precisely that.
    #[test]
    fn an_endlessly_interrupted_read_gives_up_instead_of_spinning() {
        // The stub stops interrupting after far more reads than the budget
        // allows. Without that, removing the budget would make this test HANG
        // instead of fail, and a hung test is one a CI timeout kills with no
        // useful message. With it, an unbounded retry loop produces a clean
        // red.
        struct AlwaysInterrupted {
            reads: usize,
        }
        impl Read for AlwaysInterrupted {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                self.reads += 1;
                if self.reads > EINTR_RETRIES * 10 {
                    return Err(std::io::Error::other("the retry budget did not run out"));
                }
                Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "signal"))
            }
        }
        let mut s = HapSession::new(keys());
        let mut r = AlwaysInterrupted { reads: 0 };
        assert_eq!(s.fill(&mut r), Err(SessionError::Idle));
        assert_eq!(r.reads, EINTR_RETRIES, "the retry budget must be finite");
        // And it is recoverable, not fatal: a signal is not the peer's fault.
        assert!(!s.is_poisoned());
    }

    /// A single interruption followed by real data must still deliver the
    /// data — the retry is a retry, not a give-up.
    #[test]
    fn a_read_interrupted_once_still_delivers_the_bytes() {
        struct InterruptThenData {
            done: bool,
            data: Vec<u8>,
        }
        impl Read for InterruptThenData {
            fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
                if !self.done {
                    self.done = true;
                    return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "signal"));
                }
                let n = self.data.len().min(b.len());
                b[..n].copy_from_slice(&self.data[..n]);
                self.data.drain(..n);
                Ok(n)
            }
        }
        let (mut ours, mut theirs) = pair();
        let wire = ours.seal_message(b"after the signal").unwrap();
        let mut r = InterruptThenData { done: false, data: wire };
        theirs.fill(&mut r).unwrap();
        theirs.drain().unwrap();
        assert_eq!(theirs.buffered(), b"after the signal");
    }

    /// The raw ceiling. `fill` refuses rather than growing without limit if the
    /// drain invariant is ever broken by a later edit.
    #[test]
    fn the_unframed_buffer_has_a_ceiling() {
        let mut s = HapSession::new(keys());
        // Never drained, so raw only grows. `fill` takes at most one frame's
        // worth per call, so the ceiling is reached on the third.
        let junk = vec![0x01u8; MAX_FRAME_WIRE];
        assert_eq!(s.fill(&mut Cursor::new(junk.clone())), Ok(MAX_FRAME_WIRE));
        assert_eq!(s.fill(&mut Cursor::new(junk.clone())), Ok(MAX_FRAME_WIRE));
        assert_eq!(s.fill(&mut Cursor::new(junk)), Err(SessionError::Overflow("unframed bytes")));
        assert!(s.is_poisoned());
    }

    /// `Debug` prints counters and sizes, never keys.
    #[test]
    fn a_session_does_not_print_its_keys() {
        let s = HapSession::new(SessionKeys { read: [0xABu8; 32], write: [0xCDu8; 32] });
        let shown = format!("{s:?}");
        assert!(shown.contains("read_counter"));
        assert!(!shown.contains("171") && !shown.contains("ab") && !shown.contains("205"));
    }

    /// A write failure poisons: the counter has already moved for a message
    /// the peer never saw, so the streams are out of step and only a new
    /// session can fix it.
    #[test]
    fn a_failed_write_poisons_rather_than_leaving_a_skipped_counter() {
        struct Broken;
        impl Write for Broken {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "gone"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut s = HapSession::new(keys());
        assert!(matches!(s.write_message(&mut Broken, b"hi"), Err(SessionError::Io(_))));
        assert!(s.is_poisoned());
        assert_eq!(s.seal_message(b"hi"), Err(SessionError::Poisoned));
    }

    #[test]
    fn session_errors_map_onto_the_home_error_that_names_the_right_fix() {
        use crate::home::HomeError as H;
        let cases: Vec<(SessionError, &str)> = vec![
            (SessionError::Io("x".into()), "unreachable"),
            (SessionError::Closed, "unreachable"),
            (SessionError::Idle, "unreachable"),
            (SessionError::Protocol("x".into()), "malformed"),
            (SessionError::Decrypt { counter: 3 }, "malformed"),
            (SessionError::Overflow("data"), "malformed"),
            (SessionError::Poisoned, "refused"),
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
}
