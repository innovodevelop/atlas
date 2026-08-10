// Finding HomeKit accessories on the LAN — mDNS/DNS-SD, hand-written.
//
// WHY THIS FILE EXISTS AT ALL. `home/store.rs:595` says, truthfully as of the
// commit that wrote it, "Atlas has no discovery stack: no mDNS responder, no
// Matter commissioner, no Thread border router". A HAP controller cannot work
// without the first of those: an accessory is addressed by an IP and a port
// that DHCP hands out, and its stable identity — the `id` this module reads —
// is only ever published in a Bonjour TXT record. There is no other way to
// learn it short of asking the user to type a MAC address.
//
// HAND-WRITTEN, LIKE ws.rs. RFC 1035 §4.1 message format, RFC 6762 multicast
// DNS, RFC 6763 DNS-SD, and the TXT keys from Apple's own accessory-side code.
// The alternatives were a crate (a new dependency, in a lockfile pinned by
// librespot's vergen requirement) or the system's `dns-sd`/DNSServiceBrowse
// (a native framework binding, which is the thing ADR 008 is about). A parser
// for four record types is smaller than either, and — crucially — it is a pure
// function over bytes, so it is the part of discovery that CAN be tested
// without an accessory.
//
// WHAT IS AND IS NOT PROVEN HERE, stated before anyone trusts it:
//   PROVEN   the message parser, the compression-pointer handling and its
//            hardening, the TXT key/value split, and every rule that turns a
//            TXT record into "you can pair with this" or "unpair it first".
//            All of that is bytes in, verdict out, and the tests are byte
//            fixtures built from the RFC's own field layout.
//   NOT PROVEN  that `browse()` finds anything. It opens a real socket and
//            talks to real responders; Apple's HomeKit Accessory Simulator is
//            not installed on this machine, so no `_hap._tcp` service has ever
//            answered it. The parser HAS been run against genuine mDNS
//            responses captured from this LAN (an AirPlay browse — Apple's own
//            mDNSResponder and an LG TV, both with compression pointers and a
//            PTR/SRV/TXT/A additional section), which is why the parser is not
//            merely self-consistent. Those captures are not committed: they
//            carry the machine owner's name, MAC addresses and a serial number.
//
// THE ONE PROTOCOL CHOICE WORTH ARGUING WITH. The query sets the QU bit
// (RFC 6762 §5.4, "unicast response requested"), and the socket is bound to an
// EPHEMERAL port rather than 5353. That is not laziness: macOS runs
// mDNSResponder, which holds 5353 with SO_REUSEPORT, an option `std::net` does
// not expose — binding it would fail, and the fallback would be another
// dependency. A QU query is answered by unicast straight back to our source
// port, which needs no group membership at all. THE COST IS REAL AND IS NOT
// HIDDEN: a responder that ignores QU multicasts its answer to 224.0.0.251:5353
// instead, where we are not listening, and we never see it. The captures above
// show that both Apple's responder and a third-party TV do honour it. If a
// Simulator run ever shows an accessory that this misses, the fix is a
// socket2-style SO_REUSEPORT bind on 5353, not a longer timeout.

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// The service, and the TXT keys it publishes
// ---------------------------------------------------------------------------

/// The DNS-SD service type HAP accessories advertise.
/// `#define kServiceDiscoveryProtocol_HAP "_hap._tcp"`,
/// adk_HAPIPServiceDiscovery.c:16, plus the `local` domain DNS-SD browses in.
pub const SERVICE_LABELS: &[&str] = &["_hap", "_tcp", "local"];

/// TXT record keys, HAP R14 Table 6-7, transcribed from
/// adk_HAPIPServiceDiscovery.c:26-50 where each one is a `#define`:
///   c#  ConfigurationNumber (:26)   ff  PairingFeatureFlags (:29)
///   id  DeviceID            (:32)   md  Model               (:35)
///   pv  ProtocolVersion     (:38)   s#  StateNumber         (:41)
///   sf  StatusFlags         (:44)   ci  Category            (:47)
///   sh  SetupHash           (:50)
pub const TXT_DEVICE_ID: &str = "id";
pub const TXT_MODEL: &str = "md";
pub const TXT_STATUS_FLAGS: &str = "sf";
pub const TXT_CONFIG_NUMBER: &str = "c#";
pub const TXT_STATE_NUMBER: &str = "s#";
pub const TXT_CATEGORY: &str = "ci";
pub const TXT_PROTOCOL_VERSION: &str = "pv";
pub const TXT_FEATURE_FLAGS: &str = "ff";

/// THE BIT THIS WHOLE FILE IS FOR.
///
/// `kHAPAccessoryServerStatusFlags_NotPaired = 1 << 0`
/// (adk_HAPAccessoryServer.c:911, and set at :928-930 by
/// `if (!HAPAccessoryServerIsPaired(server_))`). Note the polarity, because it
/// is the opposite of what the name "status flags" suggests: the bit is SET
/// while the accessory is free, and CLEARED once somebody owns it. Reading it
/// backwards would tell every user that their already-paired lock is available
/// and that their free one is taken.
pub const STATUS_FLAG_NOT_PAIRED: u8 = 1 << 0;

/// `kHAPAccessoryServerStatusFlags_ProblemDetected = 1 << 2`
/// (adk_HAPAccessoryServer.c:920). Bit 1 is not defined for IP in R14 — the
/// enum skips from 1<<0 to 1<<2 — so it is deliberately not named here.
pub const STATUS_FLAG_PROBLEM: u8 = 1 << 2;

// ---------------------------------------------------------------------------
// Bounds
//
// Every one of these caps something a hostile or broken responder controls.
// mDNS arrives on UDP from anybody on the link, unauthenticated, before any
// pairing exists — it is the least trusted input in the whole module.
// ---------------------------------------------------------------------------

/// RFC 6762 §17 allows an mDNS message up to the interface MTU; 9000 covers a
/// jumbo frame and is the read buffer. Anything larger is not read at all.
pub const MAX_PACKET: usize = 9000;
/// A browse answer with more records than this is not a house, it is a flood.
pub const MAX_RECORDS: usize = 256;
/// RFC 1035 §2.3.4 caps a name at 255 octets; labels at 63 are enforced by the
/// two-bit length encoding itself.
pub const MAX_NAME_BYTES: usize = 255;
/// A floor, not a live guard. A label costs at least two bytes on the wire, so
/// 128 labels is 256 bytes and `MAX_NAME_BYTES` has always tripped first —
/// mutation testing confirmed that deleting this check changes no test. It is
/// kept so that raising the byte ceiling does not silently remove every bound
/// on how many `String`s one name allocates.
pub const MAX_NAME_LABELS: usize = 128;
/// Compression pointers must also strictly move backwards (see `read_name`),
/// so this is belt to that braces.
pub const MAX_NAME_JUMPS: usize = 64;
pub const MAX_TXT_PAIRS: usize = 32;
pub const MAX_TXT_VALUE_BYTES: usize = 255;
/// One `_hap._tcp` browse cannot return more accessories than this. A home
/// with 64 HomeKit accessories exists; one with 6000 is an attack.
pub const MAX_ACCESSORIES: usize = 64;
/// A discovered address list longer than this is a responder being silly.
pub const MAX_ADDRESSES: usize = 8;

const QTYPE_A: u16 = 1;
const QTYPE_PTR: u16 = 12;
const QTYPE_TXT: u16 = 16;
const QTYPE_AAAA: u16 = 28;
const QTYPE_SRV: u16 = 33;
/// QCLASS IN with RFC 6762 §5.4's unicast-response bit set.
const QCLASS_IN_UNICAST: u16 = 0x8001;
/// The cache-flush bit (RFC 6762 §10.2) rides in the top bit of a RR's class
/// and must be masked off before the class is compared to IN.
const CLASS_MASK: u16 = 0x7FFF;
const CLASS_IN: u16 = 1;

const MDNS_GROUP: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 251);
const MDNS_PORT: u16 = 5353;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryError {
    /// The packet ran out before the structure said it should.
    Truncated,
    /// A compression pointer that did not move backwards, or too many hops.
    NameLoop,
    /// A bound was exceeded. Named so the log says which.
    TooLarge(&'static str),
    /// A label length used one of the two reserved two-bit forms.
    BadLabel,
    /// The socket could not be opened, joined or written.
    Socket(String),
}

impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DiscoveryError::Truncated => write!(f, "an mDNS packet ended in the middle of a record"),
            DiscoveryError::NameLoop => {
                write!(f, "an mDNS name compression pointer pointed in a circle")
            }
            DiscoveryError::TooLarge(what) => {
                write!(f, "an mDNS responder sent more {what} than Atlas will read")
            }
            DiscoveryError::BadLabel => write!(f, "an mDNS name used a reserved label form"),
            DiscoveryError::Socket(m) => write!(f, "Atlas could not search the local network: {m}"),
        }
    }
}

impl From<DiscoveryError> for crate::home::HomeError {
    fn from(e: DiscoveryError) -> crate::home::HomeError {
        use crate::home::HomeError as H;
        let msg = e.to_string();
        match e {
            // A socket that will not open is a machine problem, not a bridge
            // one — but "unreachable" is still the right shape for the caller:
            // nothing answered.
            DiscoveryError::Socket(_) => H::Unreachable(msg),
            _ => H::Malformed(msg),
        }
    }
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/// A DNS name as its labels, NOT as a dotted string.
///
/// Kept unjoined on purpose. A DNS-SD service INSTANCE name is a single label
/// that routinely contains dots and spaces — "Magnus' Lamp v1.2" is one label,
/// not four — so a dotted string cannot be split back into labels without an
/// escaping convention, and every bug in that convention shows up as an
/// accessory with the wrong name. Comparison is case-insensitive because DNS
/// is (RFC 1035 §2.3.3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Name(pub Vec<String>);

impl Name {
    pub fn matches(&self, labels: &[&str]) -> bool {
        self.0.len() == labels.len()
            && self.0.iter().zip(labels).all(|(a, b)| a.eq_ignore_ascii_case(b))
    }

    /// True when this is `<instance>.<labels…>` — one extra leading label.
    pub fn is_instance_of(&self, labels: &[&str]) -> bool {
        self.0.len() == labels.len() + 1
            && self.0[1..].iter().zip(labels).all(|(a, b)| a.eq_ignore_ascii_case(b))
    }

    pub fn instance(&self) -> Option<&str> {
        self.0.first().map(String::as_str)
    }

    /// The dotted form, for a host name that is going into a TCP connect or an
    /// HTTP `Host:` header. Only used where the labels really are hostname
    /// labels, which cannot contain a dot.
    pub fn dotted(&self) -> String {
        self.0.join(".")
    }
}

/// Read one name, following compression pointers.
///
/// Returns the name and the offset just past the name AS IT APPEARED HERE —
/// which for a compressed name is two bytes after where it started, not
/// wherever the pointer led. Getting that wrong walks the parser into the
/// middle of a record.
///
/// THE HARDENING IS THE POINT. A pointer may only move STRICTLY BACKWARDS.
/// That single rule makes an infinite loop impossible by construction rather
/// than by a hop counter that a cleverer packet could still exhaust; the hop
/// counter is kept anyway because two cheap guards on unauthenticated LAN input
/// is not one too many.
fn read_name(msg: &[u8], start: usize) -> Result<(Name, usize), DiscoveryError> {
    let mut labels: Vec<String> = Vec::new();
    let mut pos = start;
    let mut end_of_name: Option<usize> = None;
    let mut jumps = 0usize;
    let mut bytes = 0usize;

    loop {
        let len_byte = *msg.get(pos).ok_or(DiscoveryError::Truncated)?;
        match len_byte & 0xC0 {
            0x00 => {
                let len = len_byte as usize;
                pos += 1;
                if len == 0 {
                    // The root label ends the name.
                    return Ok((Name(labels), end_of_name.unwrap_or(pos)));
                }
                let end = pos.checked_add(len).ok_or(DiscoveryError::Truncated)?;
                let raw = msg.get(pos..end).ok_or(DiscoveryError::Truncated)?;
                bytes += len + 1;
                if bytes > MAX_NAME_BYTES {
                    return Err(DiscoveryError::TooLarge("name bytes"));
                }
                if labels.len() >= MAX_NAME_LABELS {
                    return Err(DiscoveryError::TooLarge("name labels"));
                }
                // Lossy rather than strict: a DNS-SD instance label is
                // "Net-Unicode" (RFC 6763 §4.1.1) and is meant to be UTF-8, but
                // a responder that emits Latin-1 in a device name must not make
                // the whole browse fail. The bytes are a display label, never a
                // key: nothing downstream compares or addresses by it.
                labels.push(String::from_utf8_lossy(raw).into_owned());
                pos = end;
            }
            0xC0 => {
                let second = *msg.get(pos + 1).ok_or(DiscoveryError::Truncated)?;
                let target = (((len_byte & 0x3F) as usize) << 8) | second as usize;
                if target >= pos {
                    return Err(DiscoveryError::NameLoop);
                }
                jumps += 1;
                if jumps > MAX_NAME_JUMPS {
                    return Err(DiscoveryError::NameLoop);
                }
                // Only the FIRST pointer decides where this name ended in the
                // record we are reading.
                end_of_name.get_or_insert(pos + 2);
                pos = target;
            }
            // 0x40 and 0x80 are the reserved forms. Refused rather than
            // skipped: guessing a length for a label form nobody defined would
            // desynchronise the whole packet.
            _ => return Err(DiscoveryError::BadLabel),
        }
    }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordData {
    Ptr(Name),
    Srv { port: u16, target: Name },
    /// The raw character-strings, before any `key=value` interpretation.
    Txt(Vec<Vec<u8>>),
    A(Ipv4Addr),
    Aaaa(Ipv6Addr),
    /// A type this module does not use. Kept as a variant rather than dropped
    /// so the record count and the parse position stay honest.
    Other(u16),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
    pub name: Name,
    pub data: RecordData,
}

fn u16_at(msg: &[u8], at: usize) -> Result<u16, DiscoveryError> {
    let b = msg.get(at..at + 2).ok_or(DiscoveryError::Truncated)?;
    Ok(u16::from_be_bytes([b[0], b[1]]))
}

/// Parse a whole mDNS message into the records it carries.
///
/// The QUESTION section is skipped rather than returned: a response echoes the
/// question (all three captures from this LAN do), and a question carries no
/// answer. Answer, authority and additional are treated ALIKE — DNS-SD puts
/// the SRV, TXT and A records for a browse into `additional` (RFC 6763 §12),
/// so a parser that only read `answer` would find a PTR and no address.
pub fn parse_message(msg: &[u8]) -> Result<Vec<Record>, DiscoveryError> {
    if msg.len() > MAX_PACKET {
        return Err(DiscoveryError::TooLarge("packet bytes"));
    }
    if msg.len() < 12 {
        return Err(DiscoveryError::Truncated);
    }
    let qd = u16_at(msg, 4)? as usize;
    let counts = [u16_at(msg, 6)? as usize, u16_at(msg, 8)? as usize, u16_at(msg, 10)? as usize];
    let total: usize = counts.iter().sum();
    if total > MAX_RECORDS || qd > MAX_RECORDS {
        return Err(DiscoveryError::TooLarge("records"));
    }

    let mut pos = 12usize;
    for _ in 0..qd {
        let (_, next) = read_name(msg, pos)?;
        // QTYPE + QCLASS.
        pos = next.checked_add(4).ok_or(DiscoveryError::Truncated)?;
        if pos > msg.len() {
            return Err(DiscoveryError::Truncated);
        }
    }

    let mut out = Vec::with_capacity(total.min(MAX_RECORDS));
    for _ in 0..total {
        let (name, next) = read_name(msg, pos)?;
        let rtype = u16_at(msg, next)?;
        let class = u16_at(msg, next + 2)?;
        // TTL at next+4..next+8 is deliberately not read: nothing here caches,
        // and a goodbye record (TTL 0) is handled by the caller re-browsing,
        // not by this module holding state between browses.
        let rdlen = u16_at(msg, next + 8)? as usize;
        let rdata_start = next + 10;
        let rdata_end = rdata_start.checked_add(rdlen).ok_or(DiscoveryError::Truncated)?;
        let rdata = msg.get(rdata_start..rdata_end).ok_or(DiscoveryError::Truncated)?;

        let data = if class & CLASS_MASK != CLASS_IN {
            // A class we do not speak. Its rdata is still skipped correctly,
            // which is the only thing that matters for the records after it.
            RecordData::Other(rtype)
        } else {
            match rtype {
                QTYPE_PTR => RecordData::Ptr(read_name(msg, rdata_start)?.0),
                QTYPE_SRV => {
                    // priority(2) weight(2) port(2) target — RFC 2782. Only the
                    // port and the target are used: mDNS-SD services do not
                    // meaningfully use priority or weight, and inventing a
                    // preference order from fields nobody sets would be noise.
                    if rdlen < 7 {
                        return Err(DiscoveryError::Truncated);
                    }
                    RecordData::Srv {
                        port: u16_at(msg, rdata_start + 4)?,
                        target: read_name(msg, rdata_start + 6)?.0,
                    }
                }
                QTYPE_TXT => RecordData::Txt(parse_txt_strings(rdata)?),
                QTYPE_A => {
                    if rdlen != 4 {
                        return Err(DiscoveryError::Truncated);
                    }
                    RecordData::A(Ipv4Addr::new(rdata[0], rdata[1], rdata[2], rdata[3]))
                }
                QTYPE_AAAA => {
                    if rdlen != 16 {
                        return Err(DiscoveryError::Truncated);
                    }
                    let mut b = [0u8; 16];
                    b.copy_from_slice(rdata);
                    RecordData::Aaaa(Ipv6Addr::from(b))
                }
                other => RecordData::Other(other),
            }
        };
        out.push(Record { name, data });
        pos = rdata_end;
    }
    Ok(out)
}

/// TXT rdata is a sequence of length-prefixed character-strings
/// (RFC 1035 §3.3.14, RFC 6763 §6.1).
fn parse_txt_strings(rdata: &[u8]) -> Result<Vec<Vec<u8>>, DiscoveryError> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < rdata.len() {
        let len = rdata[i] as usize;
        i += 1;
        let end = i.checked_add(len).ok_or(DiscoveryError::Truncated)?;
        let s = rdata.get(i..end).ok_or(DiscoveryError::Truncated)?;
        if out.len() >= MAX_TXT_PAIRS {
            return Err(DiscoveryError::TooLarge("TXT strings"));
        }
        out.push(s.to_vec());
        i = end;
    }
    Ok(out)
}

/// Split DNS-SD character-strings into the key/value map RFC 6763 §6.3-6.4
/// defines.
///
/// Three rules from §6.4, all of which change what a HAP browse sees:
///   * the key is everything before the FIRST `=`; a value may contain more.
///   * a string with no `=` is a key that is PRESENT WITH NO VALUE, which is
///     not the same as absent — so it is stored, with an empty value.
///   * keys are case-insensitive, and the FIRST occurrence of a key wins.
///     Later duplicates are ignored, never overwritten, or a responder could
///     append `sf=1` after its real `sf=0` and look unpaired.
pub fn txt_map(strings: &[Vec<u8>]) -> BTreeMap<String, Vec<u8>> {
    let mut out: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for s in strings {
        if s.is_empty() || s.len() > MAX_TXT_VALUE_BYTES {
            continue;
        }
        let (key, value) = match s.iter().position(|&b| b == b'=') {
            Some(i) => (&s[..i], s[i + 1..].to_vec()),
            None => (&s[..], Vec::new()),
        };
        if key.is_empty() {
            continue;
        }
        let key = String::from_utf8_lossy(key).to_ascii_lowercase();
        out.entry(key).or_insert(value);
    }
    out
}

// ---------------------------------------------------------------------------
// One accessory, as the network described it
// ---------------------------------------------------------------------------

/// A `_hap._tcp` service, assembled from the PTR/SRV/TXT/A records that name it.
///
/// EVERY OPTIONAL FIELD IS OPTIONAL BECAUSE THE RESPONDER MAY GENUINELY NOT
/// HAVE SAID, and that distinction is load-bearing for exactly one of them:
/// `status_flags: None` means "Atlas cannot tell whether this is already
/// paired", which is a different sentence from either answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Accessory {
    /// The DNS-SD instance label — the accessory's advertised name, which is
    /// what the user recognises. Never used to address anything.
    pub instance: String,
    /// The SRV target, dotted, e.g. `Lamp-1.local`. This is what a TCP connect
    /// and the HTTP `Host:` header use.
    pub host: String,
    pub port: u16,
    pub addresses: Vec<IpAddr>,
    /// `id` — the `XX:XX:XX:XX:XX:XX` device id. THE stable identity: pairings
    /// are keyed on it, never on the instance name or the address.
    pub id: String,
    pub model: Option<String>,
    /// `ci`. Carried as the NUMBER the accessory sent. HAP R14 §13 gives these
    /// numbers names ("Lightbulb", "Door Lock"), but that table is in the
    /// specification PDF and is not in any primary source available here, so
    /// this module does not name them. `md` is a human-readable string the
    /// manufacturer wrote and is what the surface shows.
    pub category: Option<u16>,
    pub config_number: Option<u32>,
    pub state_number: Option<u32>,
    pub protocol_version: Option<String>,
    pub status_flags: Option<u8>,
    pub feature_flags: Option<u8>,
}

fn txt_str(map: &BTreeMap<String, Vec<u8>>, key: &str) -> Option<String> {
    let raw = map.get(key)?;
    // `ok()?`, not lossy: these are protocol fields, and a mangled `id` that
    // still looks like a string would be stored as a pairing key.
    std::str::from_utf8(raw).ok().map(str::to_string)
}

fn txt_num<T: std::str::FromStr>(map: &BTreeMap<String, Vec<u8>>, key: &str) -> Option<T> {
    txt_str(map, key)?.trim().parse::<T>().ok()
}

/// Assemble the accessories a browse's records describe.
///
/// PURE, and separate from the socket for the reason the rest of this codebase
/// splits the same way: this is the part that can be wrong in a way nobody
/// notices, and a function that needs a LAN cannot be unit-tested.
///
/// An entry is only produced when a service has BOTH an SRV (an address to
/// talk to) and an `id` in its TXT (an identity to remember). A PTR alone is a
/// name with nowhere to send anything, and listing it would put a row on the
/// screen that no button could act on.
pub fn accessories_from(records: &[Record]) -> Vec<Accessory> {
    // Addresses first: SRV targets resolve into this.
    let mut addrs: BTreeMap<String, Vec<IpAddr>> = BTreeMap::new();
    for r in records {
        let ip = match r.data {
            RecordData::A(v4) => IpAddr::V4(v4),
            RecordData::Aaaa(v6) => IpAddr::V6(v6),
            _ => continue,
        };
        let entry = addrs.entry(r.name.dotted().to_ascii_lowercase()).or_default();
        if entry.len() < MAX_ADDRESSES && !entry.contains(&ip) {
            entry.push(ip);
        }
    }

    let mut srv: BTreeMap<String, (String, u16)> = BTreeMap::new();
    let mut txt: BTreeMap<String, BTreeMap<String, Vec<u8>>> = BTreeMap::new();
    for r in records {
        if !r.name.is_instance_of(SERVICE_LABELS) {
            continue;
        }
        let key = r.name.dotted().to_ascii_lowercase();
        match &r.data {
            RecordData::Srv { port, target } => {
                srv.entry(key).or_insert((target.dotted(), *port));
            }
            RecordData::Txt(strings) => {
                txt.entry(key).or_insert_with(|| txt_map(strings));
            }
            _ => {}
        }
    }

    let mut out: Vec<Accessory> = Vec::new();
    for r in records {
        if !r.name.is_instance_of(SERVICE_LABELS) {
            continue;
        }
        let key = r.name.dotted().to_ascii_lowercase();
        let (Some((host, port)), Some(map)) = (srv.get(&key), txt.get(&key)) else {
            continue;
        };
        let Some(id) = txt_str(map, TXT_DEVICE_ID).filter(|s| !s.trim().is_empty()) else {
            continue;
        };
        if out.iter().any(|a| a.id == id) {
            continue;
        }
        if out.len() >= MAX_ACCESSORIES {
            break;
        }
        out.push(Accessory {
            instance: r.name.instance().unwrap_or_default().to_string(),
            host: host.clone(),
            port: *port,
            addresses: addrs.get(&host.to_ascii_lowercase()).cloned().unwrap_or_default(),
            id,
            model: txt_str(map, TXT_MODEL),
            category: txt_num(map, TXT_CATEGORY),
            config_number: txt_num(map, TXT_CONFIG_NUMBER),
            state_number: txt_num(map, TXT_STATE_NUMBER),
            protocol_version: txt_str(map, TXT_PROTOCOL_VERSION),
            status_flags: txt_num(map, TXT_STATUS_FLAGS),
            feature_flags: txt_num(map, TXT_FEATURE_FLAGS),
        });
    }
    out
}

// ---------------------------------------------------------------------------
// What the user is actually asking
// ---------------------------------------------------------------------------

/// Whether this accessory can be paired, and if not, what the person has to do.
///
/// AN ACCESSORY HOLDS ONE PAIRING OWNER. That is the fact the whole enum exists
/// to communicate: a lock already in Apple Home cannot also be in Atlas, and
/// "enter its setup code" is the wrong instruction — the right one is "remove
/// it from the Home app first, which will factory-reset its pairing". Telling
/// the user to type a code that can only ever be refused
/// (`kTLVError_Unavailable`, worded in pairing.rs) is the difference between a
/// screen that works and a screen that lies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairingStatus {
    /// `sf` bit 0 set, and Atlas holds no pairing: free to pair.
    Available,
    /// Atlas holds a pairing and the accessory agrees it is paired.
    PairedToAtlas,
    /// The accessory says it is paired and it is not paired to us.
    PairedElsewhere,
    /// Atlas holds a pairing but the accessory says it is paired with NOBODY.
    /// It has been factory-reset behind our back, so the stored key is dead
    /// and pair-verify will fail with an authentication error rather than
    /// anything that explains itself. Worth its own variant because the fix —
    /// forget the stale pairing, then pair again — is not obvious from the
    /// symptom.
    StalePairing,
    /// No `sf` in the TXT record at all (or one that was not a number), so
    /// nothing here knows. Distinct from every answer above; `Unknown` is not
    /// `Available`, and — see `pairing_status` — it is not `PairedToAtlas`
    /// either, whatever the Keychain happens to hold.
    Unknown,
}

impl Accessory {
    /// `atlas_has_pairing` is whether the Keychain holds a pairing record for
    /// this accessory's `id`. Passed in rather than read here so the decision
    /// is a pure function of two facts and can be tested without a Keychain.
    pub fn pairing_status(&self, atlas_has_pairing: bool) -> PairingStatus {
        match (self.status_flags, atlas_has_pairing) {
            // NO `sf` MEANS NO ANSWER, IN BOTH DIRECTIONS. Holding a Keychain
            // record proves we paired once; it proves nothing about now, which
            // is exactly the gap `StalePairing` exists to name — and that
            // variant is only reachable when `sf` IS present. Answering
            // "Paired with Atlas" here turned an absence into a positive claim
            // and, because `can_attempt_pairing` excludes `PairedToAtlas`,
            // withdrew the setup-code field: an accessory that had been
            // factory-reset and stopped publishing `sf` could not be re-paired
            // from the screen, with no explanation. `Unknown` offers the code
            // and lets the accessory answer for itself.
            (None, _) => PairingStatus::Unknown,
            (Some(sf), has) => {
                let unpaired = sf & STATUS_FLAG_NOT_PAIRED != 0;
                match (unpaired, has) {
                    (true, false) => PairingStatus::Available,
                    (true, true) => PairingStatus::StalePairing,
                    (false, true) => PairingStatus::PairedToAtlas,
                    (false, false) => PairingStatus::PairedElsewhere,
                }
            }
        }
    }

    /// Has the accessory raised its own problem flag?
    pub fn reports_a_problem(&self) -> bool {
        self.status_flags.map(|sf| sf & STATUS_FLAG_PROBLEM != 0).unwrap_or(false)
    }

    /// The name to put on the row. The instance label when there is one, the
    /// model when there is not, and the id as the last resort — never a blank.
    pub fn display_name(&self) -> String {
        let instance = self.instance.trim();
        if !instance.is_empty() {
            return instance.to_string();
        }
        match self.model.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            Some(m) => m.to_string(),
            None => self.id.clone(),
        }
    }
}

impl PairingStatus {
    /// The machine-readable value the surface and the control port both use.
    pub fn as_str(self) -> &'static str {
        match self {
            PairingStatus::Available => "available",
            PairingStatus::PairedToAtlas => "paired-to-atlas",
            PairingStatus::PairedElsewhere => "paired-elsewhere",
            PairingStatus::StalePairing => "stale-pairing",
            PairingStatus::Unknown => "unknown",
        }
    }

    /// Would entering a setup code get anywhere?
    ///
    /// `Unknown` says YES, and that is deliberate: the flag is missing, the
    /// accessory may well be free, and the failure mode of trying is one clear
    /// refusal from the accessory itself ("already paired with another
    /// controller", pairing.rs). The failure mode of hiding the button is a
    /// pairable accessory the user cannot pair with no explanation at all.
    pub fn can_attempt_pairing(self) -> bool {
        !matches!(self, PairingStatus::PairedElsewhere | PairingStatus::PairedToAtlas)
    }

    /// The sentence the user reads. One place, so the Setup screen, the error
    /// path and the control port's answer cannot drift apart.
    pub fn explain(self) -> &'static str {
        match self {
            PairingStatus::Available => {
                "Ready to pair. Enter the 8-digit setup code printed on the accessory."
            }
            PairingStatus::PairedToAtlas => "Paired with Atlas.",
            PairingStatus::PairedElsewhere => {
                "Already paired with another home — most likely Apple Home. A HomeKit \
                 accessory only holds one pairing, so remove it from that home first; the \
                 accessory resets its pairing when you do, and it will show up here as ready."
            }
            PairingStatus::StalePairing => {
                "Atlas has a pairing for this accessory, but the accessory says it is paired \
                 with nobody — it has been reset. Unlink it in Atlas, then pair it again with \
                 its setup code."
            }
            PairingStatus::Unknown => {
                "This accessory did not say whether it is already paired. Try its setup code — \
                 if it belongs to another home, it will refuse and say so."
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The socket
// ---------------------------------------------------------------------------

/// Build a DNS-SD browse query.
///
/// One question, QTYPE PTR, QCLASS IN with the unicast-response bit — see the
/// header for why that bit and not a 5353 bind. The transaction id is 0, which
/// RFC 6762 §18.1 requires of multicast DNS queries.
pub fn browse_query(labels: &[&str]) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    // id=0, flags=0 (standard QUERY), qd=1, an=ns=ar=0.
    out.extend_from_slice(&[0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    for label in labels {
        let b = label.as_bytes();
        // A label longer than 63 cannot be encoded; the caller's labels are
        // compile-time constants, so truncating here would hide a typo rather
        // than surface it — the label is written whole and DNS refuses it.
        out.push(b.len().min(63) as u8);
        out.extend_from_slice(&b[..b.len().min(63)]);
    }
    out.push(0);
    out.extend_from_slice(&QTYPE_PTR.to_be_bytes());
    out.extend_from_slice(&QCLASS_IN_UNICAST.to_be_bytes());
    out
}

/// A follow-up query for one instance's SRV and TXT.
///
/// Needed because §12's "additional section" optimisation is a SHOULD: a
/// responder is allowed to answer a browse with the PTR alone and wait to be
/// asked. Both responders captured from this LAN did include the extras, but
/// an accessory that does not would otherwise be discovered and unusable.
pub fn instance_query(instance: &Name, qtype_srv: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(&[0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    for label in &instance.0 {
        let b = label.as_bytes();
        out.push(b.len().min(63) as u8);
        out.extend_from_slice(&b[..b.len().min(63)]);
    }
    out.push(0);
    out.extend_from_slice(&(if qtype_srv { QTYPE_SRV } else { QTYPE_TXT }).to_be_bytes());
    out.extend_from_slice(&QCLASS_IN_UNICAST.to_be_bytes());
    out
}

/// Which instances still need chasing, de-duplicated and capped.
///
/// SPLIT OUT OF `browse` SO IT CAN BE TESTED WITHOUT A SOCKET, and because the
/// ceiling is the load-bearing part. `records` holds up to `MAX_RECORDS * 4`
/// entries and a responder chooses what goes in it: 1024 identical PTR-only
/// records — a few KB of compression-pointer input, well inside `MAX_PACKET` —
/// became 2048 outbound multicast queries, because a PTR with no SRV/TXT never
/// reaches `accessories_from` and nothing collapsed duplicates. `home.discover`
/// is a `Tier::Read` op the model may call unattended, so that was a multicast
/// amplifier addressable from the LAN.
///
/// `MAX_ACCESSORIES` is the cap because it is already the cap on what a browse
/// can RETURN: chasing more names than could ever be reported is work with no
/// possible product.
fn chase_targets<'a>(records: &'a [Record], known: &[Accessory]) -> Vec<&'a Name> {
    let mut chased: Vec<&Name> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for r in records {
        if chased.len() >= MAX_ACCESSORIES {
            break;
        }
        let RecordData::Ptr(instance) = &r.data else { continue };
        if !instance.is_instance_of(SERVICE_LABELS) {
            continue;
        }
        if known.iter().any(|a| Some(a.instance.as_str()) == instance.instance()) {
            continue;
        }
        let key = instance.dotted().to_ascii_lowercase();
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        chased.push(instance);
    }
    chased
}

/// Browse `_hap._tcp.local` for `window`, and report what answered.
///
/// BLOCKING, AND IT MUST NOT RUN ON THE MAIN THREAD. Every caller reaches it
/// through a `#[tauri::command(async)]` or the control port's own threads —
/// see the note at the top of `home/mod.rs` and the incident at the top of
/// `src/http.rs`.
///
/// Never returns an error for "found nothing": an empty list is a true answer
/// and the only honest one for a house with no HomeKit accessories in it.
pub fn browse(window: Duration) -> Result<Vec<Accessory>, DiscoveryError> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|e| DiscoveryError::Socket(e.to_string()))?;
    // Short enough that the deadline below is honoured to within a tick, and
    // long enough not to spin.
    socket
        .set_read_timeout(Some(Duration::from_millis(200)))
        .map_err(|e| DiscoveryError::Socket(e.to_string()))?;
    let target = SocketAddr::new(IpAddr::V4(MDNS_GROUP), MDNS_PORT);

    let deadline = Instant::now() + window;
    let mut records: Vec<Record> = Vec::new();
    let mut asked_again = false;
    let mut buf = vec![0u8; MAX_PACKET];

    socket
        .send_to(&browse_query(SERVICE_LABELS), target)
        .map_err(|e| DiscoveryError::Socket(e.to_string()))?;

    while Instant::now() < deadline {
        match socket.recv_from(&mut buf) {
            Ok((n, _from)) => {
                // A MALFORMED PACKET FROM ONE RESPONDER MUST NOT END THE
                // BROWSE. Anything on the link can send us a UDP datagram, so a
                // parse failure is that sender's problem and nobody else's.
                match parse_message(&buf[..n]) {
                    Ok(mut rs) => {
                        if records.len() + rs.len() <= MAX_RECORDS * 4 {
                            records.append(&mut rs);
                        }
                    }
                    Err(e) => log::debug!("[hap] ignoring an unparseable mDNS packet: {e}"),
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => return Err(DiscoveryError::Socket(e.to_string())),
        }

        // Halfway through, chase anything that answered with a bare PTR. Once,
        // not per packet: a responder that stayed silent will stay silent, and
        // re-asking on every loop turn would be a broadcast storm of our own.
        //
        // The list is de-duplicated and capped by `chase_targets` — see there
        // for why that is a defence and not tidiness.
        if !asked_again && Instant::now() + window / 2 >= deadline {
            asked_again = true;
            let known = accessories_from(&records);
            for instance in chase_targets(&records, &known) {
                let _ = socket.send_to(&instance_query(instance, true), target);
                let _ = socket.send_to(&instance_query(instance, false), target);
            }
        }
    }

    Ok(accessories_from(&records))
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Fixtures
    //
    // BUILT BY HAND FROM RFC 1035 §4.1's field layout, not copied from a
    // published vector — the DNS RFCs publish a wire format and no packet
    // hexdump, so there is nothing to copy. What makes them worth something is
    // that they are written as BYTES here and read by the parser under test,
    // rather than being produced by an encoder in this same file: a mistake in
    // my understanding of the format shows up as a test that disagrees with
    // the RFC's prose, which is checkable by eye.
    //
    // The parser has separately been run against genuine mDNS responses
    // captured from this LAN — Apple's mDNSResponder and an LG TV answering an
    // `_airplay._tcp` browse, 724 and 684 bytes, both using compression
    // pointers and both carrying PTR + SRV + TXT + A + AAAA. Those bytes are
    // NOT committed: they contain the machine owner's name, MAC addresses and
    // a device serial number.
    // -----------------------------------------------------------------------

    fn header(qd: u16, an: u16, ar: u16) -> Vec<u8> {
        let mut h = vec![0x00, 0x00, 0x84, 0x00];
        h.extend_from_slice(&qd.to_be_bytes());
        h.extend_from_slice(&an.to_be_bytes());
        h.extend_from_slice(&0u16.to_be_bytes());
        h.extend_from_slice(&ar.to_be_bytes());
        h
    }

    fn labels(parts: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for p in parts {
            out.push(p.len() as u8);
            out.extend_from_slice(p.as_bytes());
        }
        out.push(0);
        out
    }

    fn rr(name: &[u8], rtype: u16, class: u16, rdata: &[u8]) -> Vec<u8> {
        let mut out = name.to_vec();
        out.extend_from_slice(&rtype.to_be_bytes());
        out.extend_from_slice(&class.to_be_bytes());
        out.extend_from_slice(&10u32.to_be_bytes()); // TTL
        out.extend_from_slice(&(rdata.len() as u16).to_be_bytes());
        out.extend_from_slice(rdata);
        out
    }

    fn txt_rdata(pairs: &[&str]) -> Vec<u8> {
        let mut out = Vec::new();
        for p in pairs {
            out.push(p.len() as u8);
            out.extend_from_slice(p.as_bytes());
        }
        out
    }

    /// One accessory, in the shape a real browse answer takes: the question
    /// echoed, a PTR in the answer section, and SRV/TXT/A in `additional` —
    /// with the SERVICE NAME COMPRESSED to a pointer back into the question,
    /// exactly as both captured real responders did (`c00c`).
    fn one_accessory_packet(txt_pairs: &[&str]) -> Vec<u8> {
        let mut p = header(1, 1, 3);
        let question_at = p.len();
        assert_eq!(question_at, 12);
        p.extend_from_slice(&labels(&["_hap", "_tcp", "local"]));
        p.extend_from_slice(&QTYPE_PTR.to_be_bytes());
        p.extend_from_slice(&QCLASS_IN_UNICAST.to_be_bytes());

        // PTR: _hap._tcp.local -> "Front Door".<pointer to _hap._tcp.local>
        let ptr_to_service = [0xC0, question_at as u8];
        let mut instance_name = vec![b"Front Door".len() as u8];
        instance_name.extend_from_slice(b"Front Door");
        instance_name.extend_from_slice(&ptr_to_service);
        p.extend_from_slice(&rr(&ptr_to_service, QTYPE_PTR, 1, &instance_name));

        // SRV / TXT / A in the additional section, all naming the instance.
        let mut srv = vec![0u8, 0, 0, 0]; // priority, weight
        srv.extend_from_slice(&51826u16.to_be_bytes());
        srv.extend_from_slice(&labels(&["lock-1", "local"]));
        p.extend_from_slice(&rr(&instance_name, QTYPE_SRV, 0x8001, &srv));
        p.extend_from_slice(&rr(&instance_name, QTYPE_TXT, 0x8001, &txt_rdata(txt_pairs)));
        p.extend_from_slice(&rr(&labels(&["lock-1", "local"]), QTYPE_A, 0x8001, &[192, 168, 1, 9]));
        p
    }

    const HAP_TXT: &[&str] = &[
        "c#=2",
        "ff=0",
        "id=AA:BB:CC:DD:EE:FF",
        "md=Atlas Test Lock",
        "pv=1.1",
        "s#=1",
        "sf=1",
        "ci=6",
    ];

    // -----------------------------------------------------------------------
    // The parser
    // -----------------------------------------------------------------------

    #[test]
    fn a_browse_answer_yields_the_accessory_its_records_describe() {
        let records = parse_message(&one_accessory_packet(HAP_TXT)).expect("parses");
        let found = accessories_from(&records);
        assert_eq!(found.len(), 1, "{records:#?}");
        let a = &found[0];
        assert_eq!(a.instance, "Front Door");
        assert_eq!(a.host, "lock-1.local");
        assert_eq!(a.port, 51826);
        assert_eq!(a.addresses, vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 9))]);
        assert_eq!(a.id, "AA:BB:CC:DD:EE:FF");
        assert_eq!(a.model.as_deref(), Some("Atlas Test Lock"));
        assert_eq!(a.category, Some(6));
        assert_eq!(a.config_number, Some(2));
        assert_eq!(a.state_number, Some(1));
        assert_eq!(a.protocol_version.as_deref(), Some("1.1"));
        assert_eq!(a.status_flags, Some(1));
        assert_eq!(a.feature_flags, Some(0));
    }

    /// An instance label may contain dots and spaces — "Magnus' Lamp v1.2" is
    /// ONE label. If names were carried as dotted strings and re-split, this
    /// accessory would be discovered under the name "Magnus' Lamp v1" and its
    /// service match would fail.
    #[test]
    fn an_instance_label_containing_dots_survives_as_one_label() {
        let mut p = header(0, 1, 0);
        let mut instance = vec![b"Lamp v1.2".len() as u8];
        instance.extend_from_slice(b"Lamp v1.2");
        instance.extend_from_slice(&labels(&["_hap", "_tcp", "local"]));
        p.extend_from_slice(&rr(&instance, QTYPE_TXT, 1, &txt_rdata(&["id=X"])));
        let records = parse_message(&p).expect("parses");
        assert_eq!(records[0].name.0[0], "Lamp v1.2");
        assert_eq!(records[0].name.0.len(), 4);
        assert!(records[0].name.is_instance_of(SERVICE_LABELS));
    }

    /// The service match is case-insensitive because DNS is (RFC 1035 §2.3.3),
    /// and a responder that capitalises `_HAP._TCP.LOCAL` is conformant.
    #[test]
    fn the_service_match_ignores_case_but_not_shape() {
        assert!(Name(vec!["_HAP".into(), "_TCP".into(), "Local".into()]).matches(SERVICE_LABELS));
        assert!(!Name(vec!["_hap".into(), "_udp".into(), "local".into()]).matches(SERVICE_LABELS));
        // A sibling service must not be mistaken for ours.
        assert!(!Name(vec!["Lamp".into(), "_hap".into(), "_udp".into(), "local".into()])
            .is_instance_of(SERVICE_LABELS));
        assert!(!Name(vec!["_hap".into(), "_tcp".into(), "local".into()])
            .is_instance_of(SERVICE_LABELS));
    }

    // -- hostile input ----------------------------------------------------

    /// A pointer to itself. Without the strictly-backwards rule this is an
    /// infinite loop in a parser fed by anything on the LAN.
    #[test]
    fn a_self_referential_compression_pointer_is_refused() {
        let mut p = header(1, 0, 0);
        p.extend_from_slice(&[0xC0, 12]); // at offset 12, pointing at 12
        p.extend_from_slice(&QTYPE_PTR.to_be_bytes());
        p.extend_from_slice(&QCLASS_IN_UNICAST.to_be_bytes());
        assert_eq!(parse_message(&p), Err(DiscoveryError::NameLoop));
    }

    /// Two pointers chasing each other, which a hop counter alone catches only
    /// after 64 hops and the backwards rule catches immediately.
    #[test]
    fn a_mutual_compression_pointer_pair_is_refused() {
        let mut p = header(1, 0, 0);
        p.extend_from_slice(&[0xC0, 14]); // offset 12 -> 14
        p.extend_from_slice(&[0xC0, 12]); // offset 14 -> 12
        assert_eq!(parse_message(&p), Err(DiscoveryError::NameLoop));
    }

    /// A pointer that moves FORWARD to a name that TERMINATES.
    ///
    /// THIS IS THE ONE THAT PINS THE STRICTLY-BACKWARDS RULE, and it was added
    /// because mutation testing showed the two loop tests above do not: delete
    /// the rule and a self-pointer or a mutual pair simply exhausts the hop
    /// counter and comes back as `NameLoop` anyway, so both still pass. Only a
    /// forward pointer that ENDS tells the two apart — and that is precisely
    /// the shape that matters, because it is how a hostile packet gets the
    /// parser to read a name out of a region the record structure never
    /// validated.
    #[test]
    fn a_forward_compression_pointer_is_refused_even_when_it_terminates() {
        let mut p = header(1, 0, 0);
        p.extend_from_slice(&[0xC0, 14]); // offset 12 -> 14, forwards
        p.extend_from_slice(&labels(&["a"])); // offset 14: a complete, valid name
        p.extend_from_slice(&QTYPE_PTR.to_be_bytes());
        p.extend_from_slice(&QCLASS_IN_UNICAST.to_be_bytes());
        // Without the rule this parses perfectly happily as a question named
        // "a." and returns `Ok(vec![])`.
        assert_eq!(parse_message(&p), Err(DiscoveryError::NameLoop));
    }

    /// The follow-up query is the one place a browse turns INPUT into OUTBOUND
    /// PACKETS, so its fan-out must be a function of what we can use, not of
    /// what a responder chose to send. Two independent rules, asserted
    /// separately because either alone leaves the amplifier open: duplicates
    /// collapse, and the total is capped at `MAX_ACCESSORIES`.
    #[test]
    fn the_follow_up_query_is_deduplicated_and_capped() {
        let ptr = |instance: &str| Record {
            name: Name(SERVICE_LABELS.iter().map(|s| s.to_string()).collect()),
            data: RecordData::Ptr(Name(
                std::iter::once(instance.to_string())
                    .chain(SERVICE_LABELS.iter().map(|s| s.to_string()))
                    .collect(),
            )),
        };

        // 1024 copies of ONE name — the shape a hostile responder can produce
        // in a few KB, and the shape that used to become 2048 sends.
        let flood: Vec<Record> = (0..MAX_RECORDS * 4).map(|_| ptr("Lamp")).collect();
        assert_eq!(chase_targets(&flood, &[]).len(), 1, "duplicates must collapse to one query");

        // 1024 DISTINCT names: de-duplication cannot help, so the cap must.
        let distinct: Vec<Record> =
            (0..MAX_RECORDS * 4).map(|i| ptr(&format!("Lamp {i}"))).collect();
        assert_eq!(chase_targets(&distinct, &[]).len(), MAX_ACCESSORIES);

        // An instance already resolved is not chased at all.
        let known = accessories_from(&one_accessory_packet(HAP_TXT).pipe_parse());
        assert!(!known.is_empty(), "fixture must resolve, or the next line proves nothing");
        let already = vec![ptr(&known[0].instance)];
        assert!(chase_targets(&already, &known).is_empty());
    }

    /// Sugar so the test above reads as one expression; `parse_message` is
    /// fallible and the fixture is known-good.
    trait PipeParse {
        fn pipe_parse(&self) -> Vec<Record>;
    }
    impl PipeParse for Vec<u8> {
        fn pipe_parse(&self) -> Vec<Record> {
            parse_message(self).expect("the hand-built fixture must parse")
        }
    }

    #[test]
    fn a_reserved_label_form_is_refused_rather_than_guessed() {
        for reserved in [0x40u8, 0x80u8] {
            let mut p = header(1, 0, 0);
            p.extend_from_slice(&[reserved, 0, 0, 0]);
            assert_eq!(parse_message(&p), Err(DiscoveryError::BadLabel), "{reserved:#x}");
        }
    }

    /// Truncation at every single byte. Not one hand-picked cut: the property
    /// is that NO prefix of a valid packet panics or hangs, and only a
    /// systematic sweep proves it.
    #[test]
    fn no_prefix_of_a_valid_packet_panics() {
        let full = one_accessory_packet(HAP_TXT);
        for cut in 0..full.len() {
            let _ = parse_message(&full[..cut]);
        }
        // …and the whole thing still parses, or the sweep above proves nothing
        // except that errors are errors.
        assert_eq!(accessories_from(&parse_message(&full).unwrap()).len(), 1);
    }

    /// A record count in the header that the body cannot back up.
    #[test]
    fn a_lying_record_count_is_an_error_not_a_partial_answer() {
        let mut p = header(0, 200, 0);
        p.extend_from_slice(&rr(&labels(&["x", "local"]), QTYPE_A, 1, &[1, 2, 3, 4]));
        assert_eq!(parse_message(&p), Err(DiscoveryError::Truncated));
    }

    /// A name longer than RFC 1035 §2.3.4 allows.
    ///
    /// ADDED BECAUSE MUTATION TESTING FOUND THE CEILING UNGUARDED: deleting the
    /// `MAX_NAME_BYTES` check left every other test green. Nothing else stops
    /// this shape — each label is individually legal, the packet is well formed
    /// and short — so without the ceiling a 9 KB datagram from anything on the
    /// link becomes a 9 KB `String` assembled out of its bytes.
    ///
    /// Sixty five-byte labels: 300 encoded bytes, past the 255 ceiling, while
    /// staying well under `MAX_NAME_LABELS`, so it is the BYTE limit this
    /// exercises and not the label count.
    #[test]
    fn a_name_longer_than_the_rfc_allows_is_refused() {
        let mut name = Vec::new();
        for _ in 0..60 {
            name.push(4u8);
            name.extend_from_slice(b"aaaa");
        }
        name.push(0);
        let mut p = header(1, 0, 0);
        p.extend_from_slice(&name);
        p.extend_from_slice(&QTYPE_PTR.to_be_bytes());
        p.extend_from_slice(&QCLASS_IN_UNICAST.to_be_bytes());
        assert_eq!(parse_message(&p), Err(DiscoveryError::TooLarge("name bytes")));
    }

    /// Many tiny labels — the allocation-count shape rather than the
    /// byte-count one.
    ///
    /// HONEST ABOUT WHICH CEILING FIRES: mutation testing showed that deleting
    /// the `MAX_NAME_LABELS` check changes nothing, and the arithmetic says why
    /// — a label costs at least two bytes on the wire, so 128 labels is 256
    /// bytes and `MAX_NAME_BYTES` has already tripped. That check is therefore
    /// UNREACHABLE at the current constants and is not independently pinned by
    /// anything; it is kept as a floor in case the byte ceiling is ever raised,
    /// and this test asserts only what is actually true: a name of this shape
    /// is refused rather than assembled.
    #[test]
    fn a_name_with_absurdly_many_labels_is_refused() {
        let mut name = Vec::new();
        for _ in 0..200 {
            name.push(1u8);
            name.push(b'a');
        }
        name.push(0);
        let mut p = header(1, 0, 0);
        p.extend_from_slice(&name);
        p.extend_from_slice(&QTYPE_PTR.to_be_bytes());
        p.extend_from_slice(&QCLASS_IN_UNICAST.to_be_bytes());
        // 200 labels × 2 bytes = 400, so the byte ceiling trips first — which
        // is fine and is the point of asserting the ERROR rather than which
        // one: what must not happen is 200 allocations.
        assert!(matches!(parse_message(&p), Err(DiscoveryError::TooLarge(_))));
    }

    #[test]
    fn an_oversized_packet_is_refused_before_it_is_parsed() {
        assert_eq!(
            parse_message(&vec![0u8; MAX_PACKET + 1]),
            Err(DiscoveryError::TooLarge("packet bytes"))
        );
    }

    /// A responder that names a thousand accessories gets truncated, not
    /// obeyed. `MAX_RECORDS` bounds the header's own claim first.
    #[test]
    fn the_record_count_is_bounded_before_anything_is_allocated() {
        let mut p = header(0, u16::MAX, 0);
        p.extend_from_slice(&[0u8; 16]);
        assert_eq!(parse_message(&p), Err(DiscoveryError::TooLarge("records")));
    }

    // -- TXT ---------------------------------------------------------------

    /// RFC 6763 §6.4's three rules, each with a consequence for HAP.
    #[test]
    fn txt_parsing_follows_the_dns_sd_rules_that_change_the_answer() {
        let m = txt_map(&[
            b"sf=0".to_vec(),
            // A duplicate key. FIRST wins — otherwise a responder could append
            // `sf=1` after its real `sf=0` and look free to pair.
            b"sf=1".to_vec(),
            // The value may contain further '='; only the first splits.
            b"md=Model=X".to_vec(),
            // No '=' at all: present, with an empty value.
            b"flag".to_vec(),
            // Keys are case-insensitive.
            b"ID=aa".to_vec(),
            // Refused: a key of zero length.
            b"=nothing".to_vec(),
            b"".to_vec(),
        ]);
        assert_eq!(m.get("sf").map(|v| v.as_slice()), Some(&b"0"[..]));
        assert_eq!(m.get("md").map(|v| v.as_slice()), Some(&b"Model=X"[..]));
        assert_eq!(m.get("flag").map(|v| v.as_slice()), Some(&b""[..]));
        assert_eq!(m.get("id").map(|v| v.as_slice()), Some(&b"aa"[..]));
        assert!(!m.contains_key(""));
        assert_eq!(m.len(), 4);
    }

    /// A `sf` that is not a number must not silently become one. `txt_num`
    /// returning `None` is what routes this to `Unknown` rather than to a
    /// wrong-but-confident verdict.
    #[test]
    fn an_unparseable_status_flag_is_absent_rather_than_zero() {
        let records =
            parse_message(&one_accessory_packet(&["id=AA", "sf=yes"])).expect("parses");
        let a = &accessories_from(&records)[0];
        assert_eq!(a.status_flags, None);
        assert_eq!(a.pairing_status(false), PairingStatus::Unknown);
    }

    /// A service with no `id` has no identity to key a pairing on, and a
    /// service with no SRV has nowhere to send anything. Neither is listed.
    #[test]
    fn a_service_with_no_identity_or_no_address_is_not_listed() {
        let no_id = parse_message(&one_accessory_packet(&["md=Nameless"])).unwrap();
        assert!(accessories_from(&no_id).is_empty());

        let mut p = header(0, 1, 0);
        let mut instance = vec![b"Lonely".len() as u8];
        instance.extend_from_slice(b"Lonely");
        instance.extend_from_slice(&labels(&["_hap", "_tcp", "local"]));
        p.extend_from_slice(&rr(&instance, QTYPE_TXT, 1, &txt_rdata(&["id=AA:BB"])));
        assert!(accessories_from(&parse_message(&p).unwrap()).is_empty());
    }

    // -----------------------------------------------------------------------
    // THE VERDICT. This is the part with a consequence for a person standing
    // in front of a lock.
    // -----------------------------------------------------------------------

    /// The polarity of `sf` bit 0, in both directions, with and without a
    /// stored pairing.
    ///
    /// READ IT BACKWARDS AND EVERY ANSWER IS EXACTLY WRONG: an already-owned
    /// lock reads "ready to pair" (so the user types a code that is always
    /// refused) and a free one reads "remove it from Apple Home first" (so the
    /// user hunts for it in an app that has never seen it). The bit is SET when
    /// the accessory is FREE — adk_HAPAccessoryServer.c:928-930.
    #[test]
    fn the_not_paired_bit_is_read_in_the_direction_the_adk_sets_it() {
        let acc = |sf: Option<u8>| Accessory {
            instance: "Front Door".into(),
            host: "lock-1.local".into(),
            port: 51826,
            addresses: vec![],
            id: "AA:BB:CC:DD:EE:FF".into(),
            model: None,
            category: None,
            config_number: None,
            state_number: None,
            protocol_version: None,
            status_flags: sf,
            feature_flags: None,
        };
        // sf=1: the accessory says it is paired with NOBODY.
        assert_eq!(acc(Some(1)).pairing_status(false), PairingStatus::Available);
        assert_eq!(acc(Some(1)).pairing_status(true), PairingStatus::StalePairing);
        // sf=0: somebody owns it.
        assert_eq!(acc(Some(0)).pairing_status(false), PairingStatus::PairedElsewhere);
        assert_eq!(acc(Some(0)).pairing_status(true), PairingStatus::PairedToAtlas);
        // The problem bit is a different bit and must not disturb the verdict.
        assert_eq!(
            acc(Some(STATUS_FLAG_NOT_PAIRED | STATUS_FLAG_PROBLEM)).pairing_status(false),
            PairingStatus::Available
        );
        assert!(acc(Some(STATUS_FLAG_PROBLEM)).reports_a_problem());
        assert!(!acc(Some(STATUS_FLAG_NOT_PAIRED)).reports_a_problem());
        // Absent: unknown, not "free" — AND not "paired with us" either. A
        // Keychain record is a fact about the past; `sf` is the only thing
        // that speaks for the accessory now. The second assertion is the one
        // that bites: while it read `PairedToAtlas`, a reset accessory that
        // stopped publishing `sf` was reported as paired and its setup-code
        // field was withdrawn, so the only fix was unreachable from the screen.
        assert_eq!(acc(None).pairing_status(false), PairingStatus::Unknown);
        assert_eq!(acc(None).pairing_status(true), PairingStatus::Unknown);
        assert!(acc(None).pairing_status(true).can_attempt_pairing());
    }

    /// The whole point of the enum: an accessory owned by another home must
    /// not be offered a setup-code field, and its explanation must name the
    /// action that actually unblocks it.
    #[test]
    fn an_accessory_owned_by_another_home_is_explained_rather_than_offered() {
        let s = PairingStatus::PairedElsewhere;
        assert!(!s.can_attempt_pairing());
        assert!(s.explain().contains("remove it from that home first"), "{}", s.explain());
        assert!(s.explain().contains("one pairing"), "{}", s.explain());
        // Already ours: also not pairable, and for a different reason.
        assert!(!PairingStatus::PairedToAtlas.can_attempt_pairing());

        // The three that ARE worth trying.
        for s in [PairingStatus::Available, PairingStatus::Unknown, PairingStatus::StalePairing] {
            assert!(s.can_attempt_pairing(), "{}", s.as_str());
        }
        // And a reset accessory's advice names the unlink, or the user retypes
        // a code forever against a dead key.
        assert!(PairingStatus::StalePairing.explain().contains("Unlink"));
    }

    #[test]
    fn every_status_has_a_distinct_wire_value_and_a_real_sentence() {
        let all = [
            PairingStatus::Available,
            PairingStatus::PairedToAtlas,
            PairingStatus::PairedElsewhere,
            PairingStatus::StalePairing,
            PairingStatus::Unknown,
        ];
        let mut seen = std::collections::BTreeSet::new();
        for s in all {
            assert!(seen.insert(s.as_str()), "duplicate wire value {}", s.as_str());
            assert!(s.explain().len() > 15, "{} has no explanation", s.as_str());
        }
    }

    #[test]
    fn a_row_always_has_a_name_a_person_can_read() {
        let mut a = Accessory {
            instance: "  ".into(),
            host: "h".into(),
            port: 1,
            addresses: vec![],
            id: "AA:BB".into(),
            model: Some("  ".into()),
            category: None,
            config_number: None,
            state_number: None,
            protocol_version: None,
            status_flags: None,
            feature_flags: None,
        };
        assert_eq!(a.display_name(), "AA:BB");
        a.model = Some("Eve Door".into());
        assert_eq!(a.display_name(), "Eve Door");
        a.instance = "Front Door".into();
        assert_eq!(a.display_name(), "Front Door");
    }

    // -----------------------------------------------------------------------
    // The query
    // -----------------------------------------------------------------------

    /// RFC 6762 §18.1: a multicast DNS query carries transaction id 0. §5.4:
    /// the top bit of QCLASS asks for a unicast reply, which is what lets this
    /// work from an ephemeral port while mDNSResponder holds 5353.
    #[test]
    fn the_browse_query_is_the_one_the_rfc_describes() {
        let q = browse_query(SERVICE_LABELS);
        assert_eq!(&q[0..2], &[0, 0], "RFC 6762 §18.1 requires id 0");
        assert_eq!(&q[2..4], &[0, 0], "a plain QUERY: QR=0, opcode 0");
        assert_eq!(&q[4..6], &[0, 1], "exactly one question");
        assert_eq!(&q[6..12], &[0, 0, 0, 0, 0, 0], "no records in a query");
        assert_eq!(&q[12..], b"\x04_hap\x04_tcp\x05local\x00\x00\x0c\x80\x01");

        // And it round-trips: the parser reads its own query's question and
        // finds no records, which is what a query is.
        assert_eq!(parse_message(&q), Ok(vec![]));
    }

    #[test]
    fn an_instance_query_asks_for_exactly_srv_or_txt() {
        let n = Name(vec!["Front Door".into(), "_hap".into(), "_tcp".into(), "local".into()]);
        let srv = instance_query(&n, true);
        assert!(srv.ends_with(&[0x00, 0x21, 0x80, 0x01]), "SRV is type 33");
        let txt = instance_query(&n, false);
        assert!(txt.ends_with(&[0x00, 0x10, 0x80, 0x01]), "TXT is type 16");
        assert_eq!(parse_message(&srv), Ok(vec![]));
    }
}
