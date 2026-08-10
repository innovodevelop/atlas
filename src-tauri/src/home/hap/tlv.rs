// TLV8 — the encoding every HAP pairing message is written in.
//
// PROVENANCE. Every rule below was read out of Apple's own reference
// implementation, `apple/HomeKitADK` (Apache-2.0), not remembered: the reader
// is `HAP/HAPTLVReader.c` (`HAPTLVReaderGetNext`, lines 35-120) and the type
// numbers are `HAP/HAPPairing.h` lines 126-238. That file is the ACCESSORY
// side — which is exactly what we need, because what an accessory accepts is
// the definition of what this controller must produce.
//
// WHY THIS FILE IS WRITTEN DEFENSIVELY. `decode` parses bytes that arrived
// over the LAN from a device we have not authenticated yet — pair-setup M2
// and M4 are read BEFORE we know the accessory holds the setup code. A panic
// here is a remote crash, so there is no indexing without a length check, no
// slicing without a bounds check, and no `unwrap` anywhere in the decode path.
// The tests at the bottom feed it every truncation of a well-formed buffer and
// assert it returns an error instead of unwinding.

// ---------------------------------------------------------------------------
// Type numbers — HAPPairing.h:126-238
// ---------------------------------------------------------------------------

pub const TYPE_METHOD: u8 = 0x00;
pub const TYPE_IDENTIFIER: u8 = 0x01;
pub const TYPE_SALT: u8 = 0x02;
pub const TYPE_PUBLIC_KEY: u8 = 0x03;
pub const TYPE_PROOF: u8 = 0x04;
pub const TYPE_ENCRYPTED_DATA: u8 = 0x05;
pub const TYPE_STATE: u8 = 0x06;
pub const TYPE_ERROR: u8 = 0x07;
pub const TYPE_RETRY_DELAY: u8 = 0x08;
pub const TYPE_CERTIFICATE: u8 = 0x09;
pub const TYPE_SIGNATURE: u8 = 0x0A;
pub const TYPE_PERMISSIONS: u8 = 0x0B;
/// BLE PDU chunking, NOT the long-value rule below. Named so nobody reaches
/// for it when they mean fragmentation: over IP these must never appear.
pub const TYPE_FRAGMENT_DATA: u8 = 0x0C;
pub const TYPE_FRAGMENT_LAST: u8 = 0x0D;
pub const TYPE_SEPARATOR: u8 = 0xFF;

/// The maximum bytes ONE item can carry. Not a policy — the length field is a
/// single byte, and there is no 16-bit form.
pub const MAX_ITEM: usize = 255;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TlvError {
    /// Fewer than the two header bytes remain.
    TruncatedHeader { at: usize, remaining: usize },
    /// The header claimed more value bytes than the buffer holds.
    TruncatedBody { at: usize, want: usize, remaining: usize },
    /// A continuation fragment followed one that was shorter than 255.
    /// HAPTLVReader.c:86-89 — only the LAST fragment may be short, so this
    /// buffer is either corrupt or two distinct items that must not merge.
    ShortFragmentContinued { typ: u8, so_far: usize },
    /// A continuation fragment of length 0. HAPTLVReader.c:92-95.
    ZeroLengthContinuation { typ: u8 },
    /// Refused at ENCODE time, not decode: two adjacent items of the same type
    /// are indistinguishable from one fragmented value, so emitting them would
    /// hand the accessory a value we did not mean. Separate them with a
    /// Separator (0xFF) or do not emit them.
    AdjacentDuplicateType { typ: u8 },
    /// Refused at DECODE time: the same type appeared twice in one document
    /// with something else in between, so it is not a fragmented value.
    /// `HAPTLVReaderGetAll` (adk_HAPTLVReader.c:160-166) rejects this, and a
    /// controller more permissive than the accessory builds messages the
    /// accessory would have refused and then blames the crypto.
    DuplicateType { typ: u8 },
}

impl std::fmt::Display for TlvError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TlvError::TruncatedHeader { at, remaining } => {
                write!(f, "TLV header truncated at byte {at} ({remaining} left)")
            }
            TlvError::TruncatedBody { at, want, remaining } => {
                write!(f, "TLV body truncated at byte {at}: wanted {want}, {remaining} left")
            }
            TlvError::ShortFragmentContinued { typ, so_far } => write!(
                f,
                "TLV type {typ:#04x} continued after a {so_far}-byte fragment that was not 255"
            ),
            TlvError::ZeroLengthContinuation { typ } => {
                write!(f, "TLV type {typ:#04x} has a zero-length continuation fragment")
            }
            TlvError::AdjacentDuplicateType { typ } => write!(
                f,
                "refusing to encode two adjacent TLV items of type {typ:#04x}: a reader would \
                 merge them into one value"
            ),
            TlvError::DuplicateType { typ } => {
                write!(f, "TLV type {typ:#04x} appears twice in one message")
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The item
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tlv {
    pub typ: u8,
    /// The REASSEMBLED value. A 384-byte SRP public key is one `Tlv` here even
    /// though it is two items on the wire.
    pub value: Vec<u8>,
}

impl Tlv {
    pub fn new(typ: u8, value: impl Into<Vec<u8>>) -> Tlv {
        Tlv { typ, value: value.into() }
    }
    /// The one-byte items — State, Error, Method, Permissions.
    pub fn byte(typ: u8, v: u8) -> Tlv {
        Tlv { typ, value: vec![v] }
    }
    pub fn separator() -> Tlv {
        Tlv { typ: TYPE_SEPARATOR, value: Vec::new() }
    }
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/// Serialise a list of logical items, fragmenting any value over 255 bytes.
///
/// Fragmentation is positional: consecutive items carrying the SAME type byte,
/// every one of them exactly 255 bytes except the last. There is no fragment
/// index and no total-length field, which is why `AdjacentDuplicateType` is an
/// error — the wire cannot express "two values that happen to share a type".
pub fn encode(items: &[Tlv]) -> Result<Vec<u8>, TlvError> {
    let mut out = Vec::new();
    let mut previous_type: Option<u8> = None;
    for item in items {
        if previous_type == Some(item.typ) {
            return Err(TlvError::AdjacentDuplicateType { typ: item.typ });
        }
        previous_type = Some(item.typ);

        if item.value.is_empty() {
            // Length 0 is legal and is how the Separator is written.
            out.push(item.typ);
            out.push(0);
            continue;
        }
        for chunk in item.value.chunks(MAX_ITEM) {
            out.push(item.typ);
            // chunk.len() <= 255 by construction, so the cast cannot truncate.
            out.push(chunk.len() as u8);
            out.extend_from_slice(chunk);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/// Parse a TLV8 document, reassembling fragmented values.
///
/// Mirrors `HAPTLVReaderGetNext` including its two rejections, because a
/// controller that is more permissive than the accessory will happily build a
/// value the accessory would have refused and then blame the crypto.
pub fn decode(bytes: &[u8]) -> Result<Vec<Tlv>, TlvError> {
    let mut items: Vec<Tlv> = Vec::new();
    let mut o = 0usize;

    while o < bytes.len() {
        if bytes.len() - o < 2 {
            return Err(TlvError::TruncatedHeader { at: o, remaining: bytes.len() - o });
        }
        let typ = bytes[o];
        let len = bytes[o + 1] as usize;
        o += 2;
        if bytes.len() - o < len {
            return Err(TlvError::TruncatedBody { at: o, want: len, remaining: bytes.len() - o });
        }
        let mut value = bytes[o..o + len].to_vec();
        o += len;
        let mut fragments = 1usize;

        // Contiguity is the whole rule: an item of another type ENDS this
        // value, so the loop stops the moment the next type byte differs.
        while o < bytes.len() && bytes[o] == typ {
            if value.len() != fragments * MAX_ITEM {
                return Err(TlvError::ShortFragmentContinued { typ, so_far: value.len() });
            }
            if bytes.len() - o < 2 {
                return Err(TlvError::TruncatedHeader { at: o, remaining: bytes.len() - o });
            }
            let flen = bytes[o + 1] as usize;
            if flen == 0 {
                return Err(TlvError::ZeroLengthContinuation { typ });
            }
            o += 2;
            if bytes.len() - o < flen {
                return Err(TlvError::TruncatedBody {
                    at: o,
                    want: flen,
                    remaining: bytes.len() - o,
                });
            }
            value.extend_from_slice(&bytes[o..o + flen]);
            o += flen;
            fragments += 1;
        }

        // A REPEATED TYPE IS INVALID DATA, not a second item to be ignored.
        // `HAPTLVReaderGetAll` (adk_HAPTLVReader.c:160-166) logs "[%02x]
        // Duplicate TLV." and returns kHAPError_InvalidData on exactly this,
        // and the module's rule is to be no more permissive than the accessory.
        // Without it, `Salt(16) PublicKey(384) Salt(16)` — non-adjacent, so not
        // fragments — parsed happily and `get` silently returned the FIRST
        // salt, which is a message this controller accepts and an Apple
        // accessory refuses. That divergence is not a break on its own (the SRP
        // proof binds whichever salt we chose, so the exchange fails closed),
        // but a difference of interpretation between two parsers of the same
        // bytes is where the next one comes from.
        //
        // The Separator is exempt because repetition is its entire job: it
        // delimits repeated groups in the list-pairings response
        // (adk_pairings.c:653-665), which this controller does not implement
        // but should not become unable to read.
        if typ != TYPE_SEPARATOR && items.iter().any(|t| t.typ == typ) {
            return Err(TlvError::DuplicateType { typ });
        }
        items.push(Tlv { typ, value });
    }

    Ok(items)
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/// The item of this type. `decode` merges fragments and REFUSES a repeated
/// type outright, so at most one can be here — "first" is "the one", and that
/// is now enforced upstream rather than assumed here.
pub fn get(items: &[Tlv], typ: u8) -> Option<&[u8]> {
    items.iter().find(|t| t.typ == typ).map(|t| t.value.as_slice())
}

/// A one-byte item. `None` when absent OR when the length is not 1 — a State
/// of two bytes is not a State, and treating it as one would let a malformed
/// message steer the state machine.
pub fn get_byte(items: &[Tlv], typ: u8) -> Option<u8> {
    match get(items, typ) {
        Some([b]) => Some(*b),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seq(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn a_value_of_exactly_255_bytes_is_one_item_with_no_continuation() {
        let v = seq(255);
        let wire = encode(&[Tlv::new(TYPE_PUBLIC_KEY, v.clone())]).unwrap();
        assert_eq!(wire.len(), 2 + 255);
        assert_eq!(wire[0], TYPE_PUBLIC_KEY);
        assert_eq!(wire[1], 255);
        assert_eq!(decode(&wire).unwrap(), vec![Tlv::new(TYPE_PUBLIC_KEY, v)]);
    }

    #[test]
    fn a_256_byte_value_fragments_as_255_then_1() {
        let v = seq(256);
        let wire = encode(&[Tlv::new(TYPE_PUBLIC_KEY, v.clone())]).unwrap();
        assert_eq!(wire.len(), 2 + 255 + 2 + 1);
        assert_eq!((wire[0], wire[1]), (TYPE_PUBLIC_KEY, 255));
        assert_eq!((wire[257], wire[258]), (TYPE_PUBLIC_KEY, 1));
        assert_eq!(decode(&wire).unwrap(), vec![Tlv::new(TYPE_PUBLIC_KEY, v)]);
    }

    #[test]
    fn exact_multiples_and_one_over_round_trip() {
        for n in [0usize, 1, 254, 255, 256, 509, 510, 511, 765, 766] {
            let v = seq(n);
            let wire = encode(&[Tlv::new(TYPE_ENCRYPTED_DATA, v.clone())]).unwrap();
            let back = decode(&wire).unwrap();
            assert_eq!(back, vec![Tlv::new(TYPE_ENCRYPTED_DATA, v)], "n = {n}");
        }
    }

    /// The one that actually happens on the wire: the SRP public key is 384
    /// bytes, every single time, so this fragmentation is not an edge case —
    /// it is the normal path of pair-setup M3.
    #[test]
    fn the_384_byte_srp_public_key_always_fragments_as_255_plus_129() {
        let a = seq(384);
        let wire = encode(&[Tlv::new(TYPE_PUBLIC_KEY, a.clone())]).unwrap();
        assert_eq!(wire.len(), 2 + 255 + 2 + 129, "388 bytes on the wire");
        assert_eq!(wire[1], 255);
        assert_eq!(wire[257], TYPE_PUBLIC_KEY);
        assert_eq!(wire[258], 129);
        assert_eq!(decode(&wire).unwrap()[0].value, a);
    }

    #[test]
    fn an_empty_value_is_a_two_byte_item_and_survives_the_round_trip() {
        let wire = encode(&[Tlv::separator()]).unwrap();
        assert_eq!(wire, vec![0xFF, 0x00]);
        assert_eq!(decode(&wire).unwrap(), vec![Tlv::separator()]);
    }

    #[test]
    fn an_unknown_type_is_carried_through_untouched_rather_than_rejected() {
        // A future accessory adding a TLV we have never heard of must not make
        // pair-setup fail. We ignore what we do not know; we do not refuse it.
        let wire = encode(&[Tlv::byte(TYPE_STATE, 2), Tlv::new(0x7E, vec![9, 9, 9])]).unwrap();
        let back = decode(&wire).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[1], Tlv::new(0x7E, vec![9, 9, 9]));
        assert_eq!(get_byte(&back, TYPE_STATE), Some(2));
    }

    /// HAPTLVReader.c:86-89. `03 10 <16> 03 05 <5>` must NOT decode as a
    /// 21-byte value: the first fragment was not 255, so this is corrupt.
    #[test]
    fn a_continuation_after_a_short_fragment_is_rejected_not_merged() {
        let mut wire = vec![TYPE_PUBLIC_KEY, 16];
        wire.extend_from_slice(&seq(16));
        wire.push(TYPE_PUBLIC_KEY);
        wire.push(5);
        wire.extend_from_slice(&seq(5));
        assert_eq!(
            decode(&wire),
            Err(TlvError::ShortFragmentContinued { typ: TYPE_PUBLIC_KEY, so_far: 16 })
        );
    }

    /// HAPTLVReader.c:92-95.
    #[test]
    fn a_zero_length_continuation_is_rejected() {
        let mut wire = vec![TYPE_PUBLIC_KEY, 255];
        wire.extend_from_slice(&seq(255));
        wire.push(TYPE_PUBLIC_KEY);
        wire.push(0);
        assert_eq!(decode(&wire), Err(TlvError::ZeroLengthContinuation { typ: TYPE_PUBLIC_KEY }));
    }

    /// The decode-side mirror of the guard below, and the one that reads a
    /// HOSTILE message rather than one of ours. `HAPTLVReaderGetAll`
    /// (adk_HAPTLVReader.c:160-166) refuses a repeated type; before this, a
    /// pair-setup M2 shaped `State | Salt | PublicKey | Salt` decoded happily
    /// here and `get(TYPE_SALT)` returned the first salt with no complaint —
    /// a message this controller accepted and an Apple accessory rejects.
    #[test]
    fn a_type_repeated_non_adjacently_is_rejected_the_way_the_adk_rejects_it() {
        let mut wire = vec![TYPE_STATE, 1, 0x02];
        wire.extend_from_slice(&[TYPE_SALT, 4]);
        wire.extend_from_slice(&seq(4));
        wire.extend_from_slice(&[TYPE_PUBLIC_KEY, 4]);
        wire.extend_from_slice(&seq(4));
        wire.extend_from_slice(&[TYPE_SALT, 4]);
        wire.extend_from_slice(&seq(4));
        assert_eq!(decode(&wire), Err(TlvError::DuplicateType { typ: TYPE_SALT }));
    }

    /// …and the Separator is exempt, because delimiting repeated groups is its
    /// only job (adk_pairings.c:653-665). Refusing it would make the
    /// list-pairings response unreadable for the sake of a rule it predates.
    #[test]
    fn a_repeated_separator_is_not_a_duplicate() {
        let wire = vec![
            TYPE_IDENTIFIER,
            1,
            b'a',
            TYPE_SEPARATOR,
            0,
            TYPE_PERMISSIONS,
            1,
            1,
            TYPE_SEPARATOR,
            0,
        ];
        let items = decode(&wire).expect("separators repeat legally");
        assert_eq!(items.iter().filter(|t| t.typ == TYPE_SEPARATOR).count(), 2);
    }

    /// The encode-side guard. Two 255-byte values of the same type would
    /// decode as one 510-byte value, silently.
    #[test]
    fn encoding_two_adjacent_items_of_one_type_is_refused() {
        let items = [Tlv::new(TYPE_IDENTIFIER, b"a".to_vec()), Tlv::new(TYPE_IDENTIFIER, b"b".to_vec())];
        assert_eq!(encode(&items), Err(TlvError::AdjacentDuplicateType { typ: TYPE_IDENTIFIER }));
        // A Separator between them makes the intent expressible, and that is
        // exactly what the list-pairings response does (adk_pairings.c:653).
        let with_sep = [
            Tlv::new(TYPE_IDENTIFIER, b"a".to_vec()),
            Tlv::separator(),
            Tlv::new(TYPE_IDENTIFIER, b"b".to_vec()),
        ];
        assert!(encode(&with_sep).is_ok());
    }

    /// EVERY truncation of a well-formed buffer, including inside a fragment
    /// header and inside a body. None may panic; all must be an error. This is
    /// the test that stands in for a fuzzer: the buffer contains a fragmented
    /// value, a short value and an empty value, so the cut lands in each shape.
    #[test]
    fn no_truncation_of_a_valid_buffer_can_panic_the_decoder() {
        let full = encode(&[
            Tlv::new(TYPE_PUBLIC_KEY, seq(384)),
            Tlv::new(TYPE_PROOF, seq(64)),
            Tlv::separator(),
            Tlv::byte(TYPE_STATE, 3),
        ])
        .unwrap();
        assert!(decode(&full).is_ok());
        for cut in 1..full.len() {
            let r = decode(&full[..cut]);
            // Some prefixes are legitimately complete documents (they end on an
            // item boundary). The contract is only that nothing unwinds and the
            // rest are clean errors.
            if let Ok(items) = r {
                assert!(!items.is_empty(), "cut = {cut}");
            }
        }
    }

    /// Random-ish garbage, exhaustively over short lengths. `decode` must
    /// terminate and must not panic for any of it.
    #[test]
    fn arbitrary_bytes_never_panic_the_decoder() {
        // A tiny xorshift keeps this deterministic and dependency-free.
        let mut state: u32 = 0x1234_5678;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state
        };
        for len in 0..64usize {
            for _ in 0..64 {
                let buf: Vec<u8> = (0..len).map(|_| (next() & 0xFF) as u8).collect();
                let _ = decode(&buf);
            }
        }
        // And the pathological shapes by hand.
        for buf in [vec![], vec![0x01], vec![0x01, 0xFF], vec![0xFF, 0x00, 0xFF, 0x00]] {
            let _ = decode(&buf);
        }
    }

    #[test]
    fn get_byte_refuses_a_multi_byte_item() {
        let items = vec![Tlv::new(TYPE_STATE, vec![1, 2])];
        assert_eq!(get_byte(&items, TYPE_STATE), None);
        assert_eq!(get_byte(&items, TYPE_ERROR), None);
        assert_eq!(get(&items, TYPE_STATE), Some(&[1u8, 2][..]));
    }

    /// The type numbers are protocol, not preference. If one of these ever
    /// changes, every message silently addresses the wrong field.
    #[test]
    fn the_tlv_type_numbers_match_hap_pairing_h() {
        assert_eq!(
            [
                TYPE_METHOD,
                TYPE_IDENTIFIER,
                TYPE_SALT,
                TYPE_PUBLIC_KEY,
                TYPE_PROOF,
                TYPE_ENCRYPTED_DATA,
                TYPE_STATE,
                TYPE_ERROR,
                TYPE_RETRY_DELAY,
                TYPE_CERTIFICATE,
                TYPE_SIGNATURE,
                TYPE_PERMISSIONS,
                TYPE_FRAGMENT_DATA,
                TYPE_FRAGMENT_LAST,
                TYPE_SEPARATOR,
            ],
            [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0xFF]
        );
    }
}
