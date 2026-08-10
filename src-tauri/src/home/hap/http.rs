// HTTP/1.1 over the encrypted HAP session — the layer the actual accessory
// operations live on.
//
// WHY THIS IS HAND-WRITTEN AND NOT `ureq` (which ha.rs uses and which is
// already in Cargo.toml). The payload is not on a socket: it is inside the
// custom frame layer in `session.rs`, so there is no stream an HTTP client
// could be pointed at. On top of that the protocol is not quite HTTP —
// accessories push unsolicited messages whose status line is `EVENT/1.0 200
// OK` (adk_HAPIPAccessoryServer.c:3350), and any client that assumes every
// inbound message starts with `HTTP/1.1` desynchronises the connection the
// first time somebody flips a light at the wall. Same reasoning that made
// `ws.rs` a hand-written RFC 6455 client.
//
// NEVER TLS. HAP's confidentiality is the ChaCha20-Poly1305 session, and the
// bytes below are plaintext HTTP inside it.
//
// EVERYTHING THIS FILE PARSES CAME FROM THE LAN. The accessory is authenticated
// — nothing reaches here before pair-verify — but "authenticated" is not
// "trusted": a compromised or simply broken accessory is exactly the peer this
// parser has to survive. So every ceiling below is checked BEFORE the number it
// bounds is used to allocate, index or wait, and the file contains no `unwrap`
// on a parse path. That is the same discipline `ws.rs` applies to its frame
// header, for the same reason.
//
// ADDRESSING. A characteristic is named by the PAIR `(aid, iid)`:
//   * `aid` is unique within one accessory SERVER — a non-bridge is aid 1, a
//     bridge is aid 1 with its bridged devices at 2, 3, …
//   * `iid` is unique within ONE ACCESSORY only, across that accessory's
//     services AND characteristics. iid 2 on aid 1 and iid 2 on aid 2 are
//     unrelated.
// So `CharId` carries both and there is no bare-iid API anywhere in this file.
//
// AND THE CACHE RULE THAT GOES WITH IT: iids are stable only while the Bonjour
// `c#` (configuration number) is. When it changes the attribute database
// changed, and every cached iid must be re-read from `/accessories` before the
// next write. Enforcing that needs the discovery layer, so it is NOT enforced
// here — it is stated here so whoever writes the adapter cannot miss it.

use std::io::{Read, Write};

use serde_json::{json, Value};

use super::session::{HapSession, SessionError};

// ---------------------------------------------------------------------------
// Ceilings — every one of them bounds something a peer controls
// ---------------------------------------------------------------------------

/// A status line is `HTTP/1.1 207 Multi-Status` — 26 bytes. 256 is room for a
/// long reason phrase and no room for a peer to stream a line forever.
pub const MAX_STATUS_LINE: usize = 256;

/// The whole header block, status line included. The ADK's largest response
/// header is four short lines.
pub const MAX_HEADER_BLOCK: usize = 8 * 1024;

/// Headers per message. Bounded separately from the byte ceiling so a peer
/// cannot hand us a hundred thousand one-byte headers inside 8 KiB.
pub const MAX_HEADER_COUNT: usize = 64;

/// The largest body accepted. `GET /accessories` on a big bridge is the only
/// realistic large response — a hundred-plus accessories with their full
/// attribute database, which is tens of KiB. Half a megabyte is generous by an
/// order of magnitude and is still a number a `Content-Length` cannot exceed.
///
/// Kept below `session::MAX_PLAINTEXT_BUFFER` (1 MiB) on purpose: the session's
/// ceiling is the backstop, this one is the actual policy, and they must not be
/// the same number or the backstop stops backstopping.
pub const MAX_BODY_BYTES: usize = 512 * 1024;

/// Header block plus body. Nothing accumulates past this while a single
/// message is being assembled.
pub const MAX_MESSAGE_BYTES: usize = MAX_HEADER_BLOCK + MAX_BODY_BYTES;

/// Characteristics per `GET /characteristics`. The query goes in the request
/// LINE, and accessories have modest request buffers; batching beyond this is
/// the caller's job.
pub const MAX_QUERY_IDS: usize = 64;

/// Characteristics per `PUT /characteristics`.
pub const MAX_WRITE_IDS: usize = 64;

/// Unsolicited `EVENT/1.0` messages tolerated while waiting for one response.
/// An accessory whose sensors are chattering is normal; one that never lets a
/// response through is not, and this is what stops that from wedging a call.
pub const MAX_EVENTS_PER_EXCHANGE: usize = 32;

/// Consecutive read timeouts tolerated inside one exchange. With the socket
/// read timeout the caller is expected to set (`ws.rs` uses 5s for the same
/// job) this is about a minute of silence before an exchange gives up.
pub const MAX_IDLE_POLLS: usize = 12;

/// Structural ceilings on `/accessories`. A bridge is the large case; Apple's
/// own limit is 150 accessories per bridge, and the service/characteristic
/// numbers are far past anything a real profile uses. They exist so a
/// malformed-but-small body cannot expand into a large allocation.
pub const MAX_ACCESSORIES: usize = 256;
pub const MAX_SERVICES_PER_ACCESSORY: usize = 128;
pub const MAX_CHARACTERISTICS_PER_SERVICE: usize = 128;
pub const MAX_PERMS_PER_CHARACTERISTIC: usize = 16;

/// "You are not in a verified session." NOT an authentication failure — it
/// means re-run pair-verify on a fresh connection.
/// adk_HAPIPAccessoryServer.c:106.
pub const STATUS_CONNECTION_AUTH_REQUIRED: u16 = 470;

const CONTENT_TYPE_JSON: &str = "application/hap+json";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HttpError {
    Session(SessionError),
    /// The bytes did not parse as the protocol.
    Protocol(String),
    /// A ceiling was hit. Named so the log says which.
    TooLarge(&'static str),
    /// The accessory answered with a status we do not treat as success.
    Status(u16),
    /// 470 — the session is gone; re-run pair-verify.
    NotVerified,
    /// The body was not the JSON shape this endpoint promises.
    Json(String),
    /// The caller asked for something this layer refuses to send.
    Refused(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::Session(e) => write!(f, "{e}"),
            HttpError::Protocol(m) => write!(f, "the accessory's reply was not HTTP: {m}"),
            HttpError::TooLarge(what) => {
                write!(f, "the accessory sent more {what} than Atlas will read")
            }
            HttpError::Status(s) => write!(f, "the accessory answered {s}"),
            HttpError::NotVerified => {
                write!(f, "the accessory no longer considers this connection verified")
            }
            HttpError::Json(m) => write!(f, "the accessory's JSON did not make sense: {m}"),
            HttpError::Refused(m) => write!(f, "{m}"),
        }
    }
}

impl From<SessionError> for HttpError {
    fn from(e: SessionError) -> HttpError {
        HttpError::Session(e)
    }
}

impl From<HttpError> for crate::home::HomeError {
    fn from(e: HttpError) -> crate::home::HomeError {
        use crate::home::HomeError as H;
        let msg = e.to_string();
        match e {
            HttpError::Session(s) => H::from(s),
            // A lost session needs a reconnect, which is what Unreachable
            // means to the caller — not Unauthorised, because the PAIRING is
            // still good and telling the user to re-pair would be wrong.
            HttpError::NotVerified => H::Unreachable(msg),
            HttpError::Status(_) => H::Unreachable(msg),
            HttpError::Protocol(_) | HttpError::TooLarge(_) | HttpError::Json(_) => {
                H::Malformed(msg)
            }
            HttpError::Refused(_) => H::Refused(msg),
        }
    }
}

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/// The only way to name a characteristic in this module. See the header
/// comment: `iid` alone is meaningless across a bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct CharId {
    pub aid: u64,
    pub iid: u64,
}

impl CharId {
    pub fn new(aid: u64, iid: u64) -> CharId {
        CharId { aid, iid }
    }
}

impl std::fmt::Display for CharId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}", self.aid, self.iid)
    }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

fn request_bytes(method: &str, target: &str, host: &str, body: Option<&[u8]>) -> Vec<u8> {
    let mut out = Vec::with_capacity(128 + body.map(|b| b.len()).unwrap_or(0));
    out.extend_from_slice(method.as_bytes());
    out.extend_from_slice(b" ");
    out.extend_from_slice(target.as_bytes());
    out.extend_from_slice(b" HTTP/1.1\r\nHost: ");
    out.extend_from_slice(host.as_bytes());
    out.extend_from_slice(b"\r\n");
    if let Some(b) = body {
        out.extend_from_slice(b"Content-Type: ");
        out.extend_from_slice(CONTENT_TYPE_JSON.as_bytes());
        out.extend_from_slice(b"\r\nContent-Length: ");
        out.extend_from_slice(b.len().to_string().as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"\r\n");
    if let Some(b) = body {
        out.extend_from_slice(b);
    }
    out
}

/// The host is only ever an IP or a `.local.` name resolved from Bonjour, but
/// it still lands in a header we compose, so a control character in it would
/// let a hostile discovery record inject a header. Refused rather than
/// sanitised — there is no legitimate name this rejects.
fn check_host(host: &str) -> Result<(), HttpError> {
    if host.is_empty() || host.len() > 255 {
        return Err(HttpError::Refused("the accessory host is not a usable name".into()));
    }
    // Printable ASCII only: no space, no CR, no LF, no control byte, nothing
    // above 0x7E. That is stricter than any hostname or IP needs.
    if host.bytes().any(|b| !(0x21..=0x7E).contains(&b)) {
        return Err(HttpError::Refused(
            "the accessory host contains characters that cannot go in a header".into(),
        ));
    }
    Ok(())
}

/// `GET /accessories` — the whole attribute database.
pub fn get_accessories(host: &str) -> Result<Vec<u8>, HttpError> {
    check_host(host)?;
    Ok(request_bytes("GET", "/accessories", host, None))
}

/// `GET /characteristics?id=1.10,1.11`
///
/// The ADK's query parser (adk_HAPIPAccessoryProtocol.c:177-250) takes a
/// comma-separated `<aid>.<iid>` list plus optional `meta`/`perms`/`type`/`ev`,
/// each of which must be exactly `0` or `1` — any other value is a parse error
/// there, so this builder only ever emits `1` and only for flags it was asked
/// for.
pub fn get_characteristics(
    host: &str,
    ids: &[CharId],
    include_meta: bool,
) -> Result<Vec<u8>, HttpError> {
    check_host(host)?;
    if ids.is_empty() {
        return Err(HttpError::Refused("refusing to read no characteristics".into()));
    }
    if ids.len() > MAX_QUERY_IDS {
        return Err(HttpError::TooLarge("characteristics in one read"));
    }
    let list = ids.iter().map(|c| c.to_string()).collect::<Vec<_>>().join(",");
    let mut target = format!("/characteristics?id={list}");
    if include_meta {
        target.push_str("&meta=1&perms=1&type=1&ev=1");
    }
    Ok(request_bytes("GET", &target, host, None))
}

/// One characteristic write. `value` is whatever the characteristic's declared
/// format says — this layer does not coerce, because a bool written to a uint8
/// is the accessory's error to report and not ours to invent.
#[derive(Debug, Clone, PartialEq)]
pub struct CharWrite {
    pub id: CharId,
    pub value: Value,
}

/// `PUT /characteristics` with a value per characteristic.
pub fn put_characteristics(host: &str, writes: &[CharWrite]) -> Result<Vec<u8>, HttpError> {
    check_host(host)?;
    if writes.is_empty() {
        return Err(HttpError::Refused("refusing to send an empty write".into()));
    }
    if writes.len() > MAX_WRITE_IDS {
        return Err(HttpError::TooLarge("characteristics in one write"));
    }
    let arr: Vec<Value> = writes
        .iter()
        .map(|w| json!({ "aid": w.id.aid, "iid": w.id.iid, "value": w.value }))
        .collect();
    let body = serde_json::to_vec(&json!({ "characteristics": arr }))
        .map_err(|e| HttpError::Json(e.to_string()))?;
    if body.len() > MAX_BODY_BYTES {
        return Err(HttpError::TooLarge("request body"));
    }
    Ok(request_bytes("PUT", "/characteristics", host, Some(&body)))
}

/// Event subscription rides the SAME endpoint as a write, with `ev` in place of
/// `value` (§5.5 of the spec notes; adk_HAPIPAccessoryServer.c handles both in
/// one handler). Kept as its own function because mixing `value` and `ev` in
/// one element is a shape the accessory does not promise to accept.
pub fn put_event_subscriptions(
    host: &str,
    subs: &[(CharId, bool)],
) -> Result<Vec<u8>, HttpError> {
    check_host(host)?;
    if subs.is_empty() {
        return Err(HttpError::Refused("refusing to send an empty subscription".into()));
    }
    if subs.len() > MAX_WRITE_IDS {
        return Err(HttpError::TooLarge("characteristics in one subscription"));
    }
    let arr: Vec<Value> = subs
        .iter()
        .map(|(id, on)| json!({ "aid": id.aid, "iid": id.iid, "ev": on }))
        .collect();
    let body = serde_json::to_vec(&json!({ "characteristics": arr }))
        .map_err(|e| HttpError::Json(e.to_string()))?;
    Ok(request_bytes("PUT", "/characteristics", host, Some(&body)))
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    /// `HTTP/1.1 …` — the answer to something we asked.
    Response,
    /// `EVENT/1.0 …` — unsolicited. Arrives on the same connection, between
    /// or even in the middle of request/response pairs.
    Event,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub kind: MessageKind,
    pub status: u16,
    pub content_type: Option<String>,
    pub body: Vec<u8>,
}

/// Parse one message from the front of `buf`.
///
/// `Ok(None)` means "not yet complete" — the caller must read more. The `usize`
/// is how many bytes the message occupied, so the caller can consume exactly
/// that and leave the next message alone.
pub fn parse_message(buf: &[u8]) -> Result<Option<(Message, usize)>, HttpError> {
    let head_end = match find(buf, b"\r\n\r\n") {
        Some(i) => i,
        None => {
            // Not complete yet — but a peer that never sends the blank line
            // must not be allowed to make us buffer forever.
            if buf.len() > MAX_HEADER_BLOCK {
                return Err(HttpError::TooLarge("header"));
            }
            return Ok(None);
        }
    };
    if head_end > MAX_HEADER_BLOCK {
        return Err(HttpError::TooLarge("header"));
    }
    let head = std::str::from_utf8(&buf[..head_end])
        .map_err(|_| HttpError::Protocol("the header block is not UTF-8".into()))?;

    let mut lines = head.split("\r\n");
    let status_line = lines.next().unwrap_or_default();
    if status_line.len() > MAX_STATUS_LINE {
        return Err(HttpError::TooLarge("status line"));
    }
    let (kind, rest) = if let Some(r) = status_line.strip_prefix("HTTP/1.1 ") {
        (MessageKind::Response, r)
    } else if let Some(r) = status_line.strip_prefix("EVENT/1.0 ") {
        // The literal at adk_HAPIPAccessoryServer.c:3350. Accepting it is the
        // difference between a working push channel and a connection that
        // desynchronises the first time a light is switched at the wall.
        (MessageKind::Event, r)
    } else {
        return Err(HttpError::Protocol(format!(
            "unknown status line '{}'",
            status_line.chars().take(40).collect::<String>()
        )));
    };
    let status: u16 = rest
        .split(' ')
        .next()
        .unwrap_or_default()
        .parse()
        .map_err(|_| HttpError::Protocol("the status line has no status code".into()))?;

    let mut content_length: Option<usize> = None;
    let mut content_type: Option<String> = None;
    let mut count = 0usize;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        count += 1;
        if count > MAX_HEADER_COUNT {
            return Err(HttpError::TooLarge("headers"));
        }
        let (name, value) = match line.split_once(':') {
            Some(p) => p,
            None => return Err(HttpError::Protocol("a header line has no colon".into())),
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        match name.as_str() {
            "content-length" => {
                // Two Content-Lengths mean two possible message boundaries,
                // and picking either one is a guess. Refuse instead of letting
                // last-one-wins decide where the next message starts.
                if content_length.is_some() {
                    return Err(HttpError::Protocol("two Content-Length headers".into()));
                }
                // BOUNDED BEFORE IT SIZES ANYTHING. Parsed as usize, then
                // checked against the ceiling before it is used to decide how
                // long to wait or how much to copy.
                let n: usize = value
                    .parse()
                    .map_err(|_| HttpError::Protocol("Content-Length is not a number".into()))?;
                if n > MAX_BODY_BYTES {
                    return Err(HttpError::TooLarge("body"));
                }
                content_length = Some(n);
            }
            "content-type" => content_type = Some(value.to_string()),
            "transfer-encoding" => {
                // The ADK always sends Content-Length. Refusing rather than
                // implementing chunked keeps a parser we would never be able
                // to test out of the trust boundary.
                return Err(HttpError::Protocol(
                    "Transfer-Encoding is not something a HAP accessory sends".into(),
                ));
            }
            _ => {}
        }
    }

    // No Content-Length means no body: `HTTP/1.1 204 No Content\r\n\r\n` is
    // written exactly that way (adk_HAPIPAccessoryServer.c:69). There is no
    // read-until-close case in HAP, so absence is zero and never "unknown".
    let body_len = content_length.unwrap_or(0);
    let total = head_end + 4 + body_len;
    if total > MAX_MESSAGE_BYTES {
        return Err(HttpError::TooLarge("message"));
    }
    if buf.len() < total {
        return Ok(None);
    }
    Ok(Some((
        Message {
            kind,
            status,
            content_type,
            body: buf[head_end + 4..total].to_vec(),
        },
        total,
    )))
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).find(|&i| &haystack[i..i + needle.len()] == needle)
}

/// Read exactly one message — response OR event — off the session.
pub fn read_message(session: &mut HapSession, r: &mut impl Read) -> Result<Message, HttpError> {
    loop {
        if let Some((msg, used)) = parse_message(session.buffered())? {
            session.consume(used);
            return Ok(msg);
        }
        if session.buffered().len() > MAX_MESSAGE_BYTES {
            // Unreachable given the checks in `parse_message`, which refuse a
            // Content-Length over the ceiling before we ever wait for it. Kept
            // as a tripwire: if a later edit loosens one of those, this stops
            // the buffer growing rather than letting it.
            session.poison();
            return Err(HttpError::TooLarge("message"));
        }
        session.fill(r)?;
        session.drain()?;
    }
}

/// Send a request and read until its response arrives, setting aside any
/// `EVENT/1.0` messages that turn up in between.
///
/// Events genuinely can interleave — the accessory does not wait for a quiet
/// moment — so a caller that ignored them would either lose them or mistake one
/// for its response. They are returned rather than dropped.
pub fn exchange<S: Read + Write>(
    session: &mut HapSession,
    stream: &mut S,
    request: &[u8],
    events: &mut Vec<Message>,
) -> Result<Message, HttpError> {
    session.write_message(stream, request)?;
    let mut idle = 0usize;
    let mut seen_events = 0usize;
    loop {
        match read_message(session, stream) {
            Ok(m) if m.kind == MessageKind::Response => return Ok(m),
            Ok(m) => {
                seen_events += 1;
                if seen_events > MAX_EVENTS_PER_EXCHANGE {
                    return Err(HttpError::TooLarge("events before a response"));
                }
                events.push(m);
            }
            Err(HttpError::Session(SessionError::Idle)) => {
                // A timeout consumed nothing, so waiting again is safe — but
                // only a bounded number of times, or a silent accessory holds
                // this thread forever.
                idle += 1;
                if idle > MAX_IDLE_POLLS {
                    return Err(HttpError::Session(SessionError::Idle));
                }
            }
            Err(e) => return Err(e),
        }
    }
}

// ---------------------------------------------------------------------------
// The two endpoints, typed
// ---------------------------------------------------------------------------

/// One characteristic in a `/characteristics` response.
///
/// `status` is `Some` only in a 207. HAP's numeric status values are NOT
/// pinned here — I could not confirm the enum from a primary source — so this
/// module treats any non-zero status as failure and never claims to know which
/// failure it was.
#[derive(Debug, Clone, PartialEq)]
pub struct CharResult {
    pub id: CharId,
    pub value: Option<Value>,
    pub status: Option<i64>,
}

impl CharResult {
    pub fn ok(&self) -> bool {
        self.status.unwrap_or(0) == 0
    }
}

/// A characteristic as `/accessories` describes it.
///
/// `type_uuid` is kept EXACTLY as it arrived. Apple-defined types come in short
/// form (`"25"`), vendor types in full 128-bit form, and the short-to-long
/// expansion suffix is NOT confirmed from a primary source — so no
/// normalisation happens here and no classification decision is made here
/// either. Deciding that a service is a lock is the adapter's job and it must
/// fail closed; see the note in `home/hap/mod.rs`.
#[derive(Debug, Clone, PartialEq)]
pub struct Characteristic {
    pub iid: u64,
    pub type_uuid: String,
    pub format: Option<String>,
    pub perms: Vec<String>,
    pub value: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Service {
    pub iid: u64,
    pub type_uuid: String,
    pub characteristics: Vec<Characteristic>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Accessory {
    pub aid: u64,
    pub services: Vec<Service>,
}

fn as_u64(v: Option<&Value>, what: &str) -> Result<u64, HttpError> {
    v.and_then(|v| v.as_u64()).ok_or_else(|| HttpError::Json(format!("{what} is not a number")))
}

fn require_json(msg: &Message) -> Result<&[u8], HttpError> {
    match msg.status {
        STATUS_CONNECTION_AUTH_REQUIRED => return Err(HttpError::NotVerified),
        200 | 207 => {}
        s => return Err(HttpError::Status(s)),
    }
    Ok(&msg.body)
}

/// Parse `GET /accessories`.
///
/// Unknown keys are IGNORED, never rejected: a newer accessory adding a field
/// must not make Atlas refuse to talk to it. Unknown `perms` strings are
/// likewise carried through rather than dropped — the set is larger than the
/// four the ADK emits and this layer has no business deciding which matter.
pub fn parse_accessories(msg: &Message) -> Result<Vec<Accessory>, HttpError> {
    let body = require_json(msg)?;
    // serde_json's own nesting limit (128) turns a deeply nested body into an
    // error rather than a stack overflow, and the body is already capped at
    // MAX_BODY_BYTES, so the parse itself is bounded in both dimensions.
    let root: Value = serde_json::from_slice(body).map_err(|e| HttpError::Json(e.to_string()))?;
    let list = root
        .get("accessories")
        .and_then(|v| v.as_array())
        .ok_or_else(|| HttpError::Json("no accessories array".into()))?;
    if list.len() > MAX_ACCESSORIES {
        return Err(HttpError::TooLarge("accessories"));
    }

    let mut out = Vec::with_capacity(list.len());
    for a in list {
        let aid = as_u64(a.get("aid"), "aid")?;
        let svcs = a.get("services").and_then(|v| v.as_array());
        let svcs = match svcs {
            Some(s) => s,
            None => return Err(HttpError::Json(format!("accessory {aid} has no services"))),
        };
        if svcs.len() > MAX_SERVICES_PER_ACCESSORY {
            return Err(HttpError::TooLarge("services"));
        }
        let mut services = Vec::with_capacity(svcs.len());
        for s in svcs {
            let iid = as_u64(s.get("iid"), "service iid")?;
            let type_uuid = s
                .get("type")
                .and_then(|v| v.as_str())
                .ok_or_else(|| HttpError::Json(format!("service {aid}.{iid} has no type")))?
                .to_string();
            let chars = s.get("characteristics").and_then(|v| v.as_array());
            let chars = match chars {
                Some(c) => c,
                None => &Vec::new(),
            };
            if chars.len() > MAX_CHARACTERISTICS_PER_SERVICE {
                return Err(HttpError::TooLarge("characteristics"));
            }
            let mut characteristics = Vec::with_capacity(chars.len());
            for c in chars {
                let ciid = as_u64(c.get("iid"), "characteristic iid")?;
                let ctype = c
                    .get("type")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        HttpError::Json(format!("characteristic {aid}.{ciid} has no type"))
                    })?
                    .to_string();
                let perms: Vec<String> = c
                    .get("perms")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .take(MAX_PERMS_PER_CHARACTERISTIC)
                            .filter_map(|p| p.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                characteristics.push(Characteristic {
                    iid: ciid,
                    type_uuid: ctype,
                    format: c.get("format").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    perms,
                    value: c.get("value").cloned(),
                });
            }
            services.push(Service { iid, type_uuid, characteristics });
        }
        out.push(Accessory { aid, services });
    }
    Ok(out)
}

/// Parse a `/characteristics` body — the same shape for a read response and
/// for a 207 write response.
pub fn parse_characteristics(msg: &Message) -> Result<Vec<CharResult>, HttpError> {
    let body = require_json(msg)?;
    let root: Value = serde_json::from_slice(body).map_err(|e| HttpError::Json(e.to_string()))?;
    let list = root
        .get("characteristics")
        .and_then(|v| v.as_array())
        .ok_or_else(|| HttpError::Json("no characteristics array".into()))?;
    if list.len() > MAX_QUERY_IDS.max(MAX_WRITE_IDS) {
        return Err(HttpError::TooLarge("characteristics"));
    }
    let mut out = Vec::with_capacity(list.len());
    for c in list {
        out.push(CharResult {
            id: CharId::new(as_u64(c.get("aid"), "aid")?, as_u64(c.get("iid"), "iid")?),
            value: c.get("value").cloned(),
            status: c.get("status").and_then(|v| v.as_i64()),
        });
    }
    Ok(out)
}

/// What a `PUT /characteristics` actually did.
///
/// `204 No Content` means every write landed and the body is empty — the ADK
/// sends the status line and nothing else. `207 Multi-Status` means at least
/// one failed and EVERY element then carries a status, including the ones that
/// worked (status 0). Treating 207 as success because it is a 2xx is the
/// mistake this function exists to make impossible.
pub fn parse_write_outcome(msg: &Message) -> Result<Vec<CharResult>, HttpError> {
    match msg.status {
        204 => Ok(Vec::new()),
        207 => parse_characteristics(msg),
        STATUS_CONNECTION_AUTH_REQUIRED => Err(HttpError::NotVerified),
        s => Err(HttpError::Status(s)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::home::hap::verify::SessionKeys;
    use std::io::Cursor;

    fn keys() -> SessionKeys {
        SessionKeys { read: [0x01u8; 32], write: [0x02u8; 32] }
    }

    /// Two sessions keyed as peers: what one writes, the other reads.
    fn peers() -> (HapSession, HapSession) {
        let k = keys();
        (
            HapSession::new(k.clone()),
            HapSession::new(SessionKeys { read: k.write, write: k.read }),
        )
    }

    fn msg(bytes: &[u8]) -> Message {
        parse_message(bytes).unwrap().unwrap().0
    }

    fn json_response(status: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/hap+json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    // -- requests ---------------------------------------------------------

    #[test]
    fn the_accessories_request_is_a_plain_get_with_a_host() {
        let r = get_accessories("192.168.1.9:51826").unwrap();
        assert_eq!(
            String::from_utf8(r).unwrap(),
            "GET /accessories HTTP/1.1\r\nHost: 192.168.1.9:51826\r\n\r\n"
        );
    }

    /// `(aid, iid)` pairs, comma separated, in the request line — and the
    /// flags, when asked for, are exactly `1`, which is the only value besides
    /// `0` the ADK's parser accepts.
    #[test]
    fn a_characteristics_read_addresses_aid_and_iid_pairs() {
        let ids = [CharId::new(1, 10), CharId::new(1, 11), CharId::new(2, 7)];
        let r = String::from_utf8(get_characteristics("h", &ids, false).unwrap()).unwrap();
        assert!(r.starts_with("GET /characteristics?id=1.10,1.11,2.7 HTTP/1.1\r\n"), "{r}");
        let with_meta = String::from_utf8(get_characteristics("h", &ids, true).unwrap()).unwrap();
        assert!(with_meta.contains("&meta=1&perms=1&type=1&ev=1"), "{with_meta}");
    }

    #[test]
    fn a_characteristics_write_is_json_with_a_content_length() {
        let w = [CharWrite { id: CharId::new(1, 10), value: json!(true) }];
        let r = String::from_utf8(put_characteristics("h", &w).unwrap()).unwrap();
        let (head, body) = r.split_once("\r\n\r\n").unwrap();
        assert!(head.starts_with("PUT /characteristics HTTP/1.1\r\n"));
        assert!(head.contains("Content-Type: application/hap+json\r\n"));
        // `split_once` consumed the blank-line separator, so the last header
        // has no trailing CRLF left to match against.
        assert!(head.ends_with(&format!("Content-Length: {}", body.len())), "{head}");
        let v: Value = serde_json::from_str(body).unwrap();
        assert_eq!(v, json!({"characteristics":[{"aid":1,"iid":10,"value":true}]}));
    }

    /// Subscription is the same endpoint with `ev` instead of `value`.
    #[test]
    fn an_event_subscription_uses_ev_and_not_value() {
        let r = String::from_utf8(
            put_event_subscriptions("h", &[(CharId::new(1, 10), true)]).unwrap(),
        )
        .unwrap();
        let body = r.split_once("\r\n\r\n").unwrap().1;
        let v: Value = serde_json::from_str(body).unwrap();
        assert_eq!(v, json!({"characteristics":[{"aid":1,"iid":10,"ev":true}]}));
    }

    /// Batch ceilings, and the empty case, refused before any bytes exist.
    #[test]
    fn oversized_and_empty_batches_are_refused_before_a_request_is_built() {
        let many: Vec<CharId> = (0..MAX_QUERY_IDS as u64 + 1).map(|i| CharId::new(1, i)).collect();
        assert_eq!(
            get_characteristics("h", &many, false),
            Err(HttpError::TooLarge("characteristics in one read"))
        );
        assert!(get_characteristics("h", &[], false).is_err());
        let writes: Vec<CharWrite> = (0..MAX_WRITE_IDS as u64 + 1)
            .map(|i| CharWrite { id: CharId::new(1, i), value: json!(1) })
            .collect();
        assert_eq!(
            put_characteristics("h", &writes),
            Err(HttpError::TooLarge("characteristics in one write"))
        );
        assert!(put_characteristics("h", &[]).is_err());
    }

    /// A host string comes from Bonjour, i.e. from the network. A CR in it
    /// would inject a header line.
    #[test]
    fn a_host_that_could_inject_a_header_is_refused() {
        for bad in ["", "a\r\nX-Evil: 1", "a\nb", "a b", "a\u{0}b", "hÿst"] {
            assert!(get_accessories(bad).is_err(), "{bad:?} was accepted");
        }
        assert!(get_accessories("atlas-lamp.local.:51826").is_ok());
    }

    // -- response parsing -------------------------------------------------

    #[test]
    fn a_complete_response_reports_exactly_how_many_bytes_it_used() {
        let mut wire = json_response("200 OK", "{\"a\":1}");
        wire.extend_from_slice(b"LEFTOVER");
        let (m, used) = parse_message(&wire).unwrap().unwrap();
        assert_eq!(m.kind, MessageKind::Response);
        assert_eq!(m.status, 200);
        assert_eq!(m.body, b"{\"a\":1}");
        assert_eq!(&wire[used..], b"LEFTOVER");
    }

    /// THE ONE THAT DESYNCHRONISES A NAIVE CLIENT. `EVENT/1.0` is a valid
    /// inbound status line and must parse as a message, not as garbage.
    #[test]
    fn an_event_status_line_parses_as_a_message() {
        let body = "{\"characteristics\":[{\"aid\":1,\"iid\":10,\"value\":false}]}";
        let wire = format!(
            "EVENT/1.0 200 OK\r\nContent-Type: application/hap+json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let m = msg(wire.as_bytes());
        assert_eq!(m.kind, MessageKind::Event);
        assert_eq!(m.status, 200);
        let parsed = parse_characteristics(&m).unwrap();
        assert_eq!(parsed[0].id, CharId::new(1, 10));
        assert_eq!(parsed[0].value, Some(json!(false)));
    }

    #[test]
    fn a_204_has_no_body_and_is_complete_at_the_blank_line() {
        let (m, used) = parse_message(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap().unwrap();
        assert_eq!(m.status, 204);
        assert!(m.body.is_empty());
        assert_eq!(used, 27);
        assert_eq!(parse_write_outcome(&m).unwrap(), Vec::new());
    }

    /// 207 is NOT success. Every element carries a status, including the ones
    /// that worked.
    #[test]
    fn a_207_write_reports_per_characteristic_status_and_is_not_treated_as_success() {
        let body = "{\"characteristics\":[{\"aid\":1,\"iid\":10,\"status\":0},\
                     {\"aid\":1,\"iid\":11,\"status\":-70402}]}";
        let m = msg(&json_response("207 Multi-Status", body));
        let r = parse_write_outcome(&m).unwrap();
        assert_eq!(r.len(), 2);
        assert!(r[0].ok());
        assert!(!r[1].ok());
        assert_eq!(r[1].status, Some(-70402));
    }

    /// 470 is "re-run pair-verify", not "wrong credentials". Getting this
    /// wrong tells the user to re-pair a perfectly good accessory.
    #[test]
    fn a_470_is_reported_as_an_unverified_session_and_not_as_an_auth_failure() {
        let m = msg(b"HTTP/1.1 470 Connection Authorization Required\r\n\r\n");
        assert_eq!(parse_write_outcome(&m), Err(HttpError::NotVerified));
        assert_eq!(parse_accessories(&m), Err(HttpError::NotVerified));
        use crate::home::HomeError as H;
        assert!(matches!(H::from(HttpError::NotVerified), H::Unreachable(_)));
    }

    #[test]
    fn an_incomplete_message_is_none_rather_than_an_error() {
        let wire = json_response("200 OK", "{\"a\":1}");
        for cut in 0..wire.len() {
            assert_eq!(parse_message(&wire[..cut]).unwrap(), None, "cut {cut}");
        }
        assert!(parse_message(&wire).unwrap().is_some());
    }

    // -- bounds -----------------------------------------------------------

    /// A Content-Length is a number a peer picks. It must be refused BEFORE it
    /// is used to size anything or to decide how long to keep reading.
    #[test]
    fn an_oversized_content_length_is_refused_without_waiting_for_the_body() {
        let wire = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_BODY_BYTES + 1
        );
        // Note the body is absent: if the ceiling were checked after reading,
        // this would return None (keep waiting) rather than an error.
        assert_eq!(parse_message(wire.as_bytes()), Err(HttpError::TooLarge("body")));

        let huge = "HTTP/1.1 200 OK\r\nContent-Length: 18446744073709551615\r\n\r\n";
        assert_eq!(parse_message(huge.as_bytes()), Err(HttpError::TooLarge("body")));
        // Exactly at the ceiling is legal, and still parses as incomplete
        // rather than allocating.
        let at = format!("HTTP/1.1 200 OK\r\nContent-Length: {MAX_BODY_BYTES}\r\n\r\n");
        assert_eq!(parse_message(at.as_bytes()).unwrap(), None);
    }

    #[test]
    fn a_header_block_that_never_ends_is_refused_rather_than_buffered() {
        let mut wire = b"HTTP/1.1 200 OK\r\n".to_vec();
        while wire.len() <= MAX_HEADER_BLOCK {
            wire.extend_from_slice(b"X-Pad: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n");
        }
        assert_eq!(parse_message(&wire), Err(HttpError::TooLarge("header")));
    }

    #[test]
    fn too_many_headers_are_refused_even_inside_the_byte_ceiling() {
        let mut wire = b"HTTP/1.1 200 OK\r\n".to_vec();
        for _ in 0..MAX_HEADER_COUNT + 2 {
            wire.extend_from_slice(b"A: b\r\n");
        }
        wire.extend_from_slice(b"\r\n");
        assert!(wire.len() < MAX_HEADER_BLOCK);
        assert_eq!(parse_message(&wire), Err(HttpError::TooLarge("headers")));
    }

    #[test]
    fn chunked_transfer_encoding_is_refused_rather_than_guessed_at() {
        let wire = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert!(matches!(parse_message(wire), Err(HttpError::Protocol(_))));
    }

    /// Two Content-Lengths describe two different places the next message
    /// starts. Last-one-wins would silently pick one and then read the other
    /// message's bytes as this one's body.
    #[test]
    fn two_content_length_headers_are_refused_rather_than_resolved() {
        let wire = b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nContent-Length: 9\r\n\r\nabcdefghi";
        assert!(matches!(parse_message(wire), Err(HttpError::Protocol(_))));
        // Case-insensitively, too — the header name is matched lowercased.
        let wire = b"HTTP/1.1 200 OK\r\ncontent-length: 4\r\nCONTENT-LENGTH: 4\r\n\r\nabcd";
        assert!(matches!(parse_message(wire), Err(HttpError::Protocol(_))));
        // One is of course fine.
        let wire = b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nabcd";
        assert_eq!(parse_message(wire).unwrap().unwrap().0.body, b"abcd");
    }

    #[test]
    fn a_status_line_we_do_not_recognise_is_refused() {
        for bad in [
            &b"HTTP/1.0 200 OK\r\n\r\n"[..],
            &b"ICY 200 OK\r\n\r\n"[..],
            &b"\r\n\r\n"[..],
            &b"HTTP/1.1 notanumber\r\n\r\n"[..],
        ] {
            assert!(matches!(parse_message(bad), Err(HttpError::Protocol(_))), "{bad:?}");
        }
    }

    /// The structural ceilings on `/accessories`, each refused rather than
    /// expanded into allocations.
    #[test]
    fn an_oversized_attribute_database_is_refused() {
        let accs: Vec<Value> =
            (0..MAX_ACCESSORIES as u64 + 1).map(|i| json!({"aid": i, "services": []})).collect();
        let body = serde_json::to_string(&json!({ "accessories": accs })).unwrap();
        let m = msg(&json_response("200 OK", &body));
        assert_eq!(parse_accessories(&m), Err(HttpError::TooLarge("accessories")));

        let svcs: Vec<Value> = (0..MAX_SERVICES_PER_ACCESSORY as u64 + 1)
            .map(|i| json!({"iid": i, "type": "3E", "characteristics": []}))
            .collect();
        let body = serde_json::to_string(&json!({"accessories":[{"aid":1,"services":svcs}]}))
            .unwrap();
        let m = msg(&json_response("200 OK", &body));
        assert_eq!(parse_accessories(&m), Err(HttpError::TooLarge("services")));
    }

    /// Arbitrary bytes must never panic the message parser.
    #[test]
    fn arbitrary_bytes_never_panic_the_parser() {
        let mut state: u32 = 0x9E37_79B9;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state
        };
        for len in 0..96usize {
            for _ in 0..32 {
                let buf: Vec<u8> = (0..len).map(|_| (next() & 0xFF) as u8).collect();
                let _ = parse_message(&buf);
            }
        }
        // And every truncation and single-byte corruption of a real response.
        let good = json_response("207 Multi-Status", "{\"characteristics\":[]}");
        for cut in 0..good.len() {
            let _ = parse_message(&good[..cut]);
        }
        for i in 0..good.len() {
            let mut bad = good.clone();
            bad[i] ^= 0xFF;
            let _ = parse_message(&bad);
        }
    }

    /// Malformed JSON of the right size is an error, not a panic and not a
    /// half-built model.
    #[test]
    fn malformed_json_bodies_are_errors() {
        for body in ["", "null", "[]", "{}", "{\"accessories\":{}}", "{\"accessories\":[{}]}", "{"] {
            let m = msg(&json_response("200 OK", body));
            assert!(parse_accessories(&m).is_err(), "{body}");
        }
        for body in ["{\"characteristics\":[{\"aid\":1}]}", "{\"characteristics\":3}"] {
            let m = msg(&json_response("200 OK", body));
            assert!(parse_characteristics(&m).is_err(), "{body}");
        }
    }

    // -- the model --------------------------------------------------------

    #[test]
    fn an_accessories_body_parses_into_aid_and_iid_addressed_characteristics() {
        let body = r#"{"accessories":[{"aid":1,"services":[
            {"iid":1,"type":"3E","primary":true,"hidden":false,"characteristics":[
                {"iid":2,"type":"23","format":"string","value":"Living Room Lamp",
                 "perms":["pr"],"maxLen":64}]},
            {"iid":8,"type":"43","characteristics":[
                {"iid":9,"type":"25","format":"bool","value":false,
                 "perms":["pr","pw","ev","tw"]}]}]}]}"#;
        let m = msg(&json_response("200 OK", body));
        let accs = parse_accessories(&m).unwrap();
        assert_eq!(accs.len(), 1);
        assert_eq!(accs[0].aid, 1);
        assert_eq!(accs[0].services.len(), 2);
        let on = &accs[0].services[1].characteristics[0];
        assert_eq!(on.iid, 9);
        // The type is kept EXACTLY as it arrived — short form is not expanded,
        // because the expansion suffix is unconfirmed.
        assert_eq!(on.type_uuid, "25");
        assert_eq!(on.value, Some(json!(false)));
        // An unknown perm ("tw") is carried through, not dropped and not a
        // reason to reject the accessory.
        assert_eq!(on.perms, vec!["pr", "pw", "ev", "tw"]);
        assert_eq!(CharId::new(accs[0].aid, on.iid).to_string(), "1.9");
    }

    /// A full 128-bit vendor UUID must survive untouched alongside the short
    /// Apple forms.
    #[test]
    fn a_vendor_uuid_is_carried_through_in_full() {
        let body = r#"{"accessories":[{"aid":1,"services":[{"iid":1,
            "type":"E863F007-079E-48FF-8F27-9C2605A29F52","characteristics":[]}]}]}"#;
        let m = msg(&json_response("200 OK", body));
        let accs = parse_accessories(&m).unwrap();
        assert_eq!(accs[0].services[0].type_uuid, "E863F007-079E-48FF-8F27-9C2605A29F52");
    }

    // -- over the session -------------------------------------------------

    /// End to end through the frame layer: a response longer than one frame,
    /// reassembled across frames, with the counters landing where they should.
    /// An HTTP message is NOT a frame boundary and this is the test that says
    /// so.
    #[test]
    fn a_response_spanning_several_frames_is_reassembled() {
        let (mut accessory, mut controller) = peers();
        let filler = "x".repeat(2500);
        let body = format!("{{\"accessories\":[],\"pad\":\"{filler}\"}}");
        let wire = accessory.seal_message(&json_response("200 OK", &body)).unwrap();
        assert!(accessory.write_counter() >= 3, "the response must span frames");

        let mut cur = Cursor::new(wire);
        let m = read_message(&mut controller, &mut cur).unwrap();
        assert_eq!(m.status, 200);
        assert_eq!(m.body.len(), body.len());
        assert_eq!(controller.read_counter(), accessory.write_counter());
        assert!(controller.buffered().is_empty(), "nothing left over");
    }

    /// Two responses in one frame — the reader must return them one at a time
    /// and leave the second alone.
    #[test]
    fn two_messages_inside_one_frame_are_read_separately() {
        let (mut accessory, mut controller) = peers();
        let mut both = json_response("200 OK", "{\"a\":1}");
        both.extend_from_slice(&json_response("200 OK", "{\"b\":2}"));
        let wire = accessory.seal_message(&both).unwrap();
        assert_eq!(accessory.write_counter(), 1, "both fit in one frame");

        let mut cur = Cursor::new(wire);
        assert_eq!(read_message(&mut controller, &mut cur).unwrap().body, b"{\"a\":1}");
        assert_eq!(read_message(&mut controller, &mut cur).unwrap().body, b"{\"b\":2}");
    }

    /// A duplex stub: what the controller writes is captured, what it reads is
    /// the script the accessory would have sent. Shared by the `exchange`
    /// tests so each of them drives the real function rather than a
    /// re-implementation of it.
    struct Duplex {
        inbound: Cursor<Vec<u8>>,
        written: Vec<u8>,
    }
    impl Read for Duplex {
        fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
            self.inbound.read(b)
        }
    }
    impl Write for Duplex {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.written.extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// An event arriving between the request and its response must be set
    /// aside, not mistaken for the response and not lost.
    #[test]
    fn an_event_interleaved_with_a_response_is_kept_and_does_not_confuse_the_exchange() {
        let (mut accessory, mut controller) = peers();
        let event_body = "{\"characteristics\":[{\"aid\":1,\"iid\":9,\"value\":true}]}";
        let event = format!(
            "EVENT/1.0 200 OK\r\nContent-Type: application/hap+json\r\nContent-Length: {}\r\n\r\n{event_body}",
            event_body.len()
        );
        let mut script = accessory.seal_message(event.as_bytes()).unwrap();
        script.extend_from_slice(&accessory.seal_message(b"HTTP/1.1 204 No Content\r\n\r\n").unwrap());

        let mut stream = Duplex { inbound: Cursor::new(script), written: Vec::new() };
        let mut events = Vec::new();
        let req = put_characteristics(
            "h",
            &[CharWrite { id: CharId::new(1, 9), value: json!(true) }],
        )
        .unwrap();
        let resp = exchange(&mut controller, &mut stream, &req, &mut events).unwrap();

        assert_eq!(resp.status, 204);
        assert_eq!(parse_write_outcome(&resp).unwrap(), Vec::new());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, MessageKind::Event);
        assert_eq!(parse_characteristics(&events[0]).unwrap()[0].id, CharId::new(1, 9));
        // The request really went out framed, not in the clear.
        assert!(!stream.written.windows(3).any(|w| w == b"PUT"));
        assert_eq!(controller.write_counter(), 1);
    }

    /// A peer that never answers must not hold the thread forever.
    ///
    /// The stub gives up on its own after far more reads than the bound
    /// allows. That is deliberate: without it, deleting `MAX_IDLE_POLLS` would
    /// make this test HANG rather than fail, and a hanging test is a test that
    /// gets killed by a CI timeout with no useful message. With it, the bound
    /// disappearing produces a different error and a clean red.
    #[test]
    fn an_exchange_gives_up_after_a_bounded_number_of_idle_polls() {
        struct AlwaysIdle {
            reads: usize,
        }
        impl Read for AlwaysIdle {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                self.reads += 1;
                if self.reads > MAX_IDLE_POLLS * 10 {
                    return Err(std::io::Error::other("the idle bound did not fire"));
                }
                Err(std::io::Error::new(std::io::ErrorKind::WouldBlock, "timed out"))
            }
        }
        impl Write for AlwaysIdle {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (_, mut controller) = peers();
        let mut stream = AlwaysIdle { reads: 0 };
        let mut events = Vec::new();
        let req = get_accessories("h").unwrap();
        assert_eq!(
            exchange(&mut controller, &mut stream, &req, &mut events),
            Err(HttpError::Session(SessionError::Idle))
        );
        assert_eq!(stream.reads, MAX_IDLE_POLLS + 1);
    }

    /// An accessory that streams events and never gets round to responding is
    /// bounded too.
    ///
    /// This drives `exchange` ITSELF. An earlier version of this test ran its
    /// own read_message loop and re-implemented the ceiling inside the test,
    /// which meant it asserted the test's arithmetic and not the code's —
    /// deleting the real bound left it green. Mutation testing caught that;
    /// the rule it taught is written down here because the mistake is an easy
    /// one to make again: a test for a bound must call the function that owns
    /// the bound.
    #[test]
    fn an_endless_event_stream_does_not_wedge_an_exchange() {
        let (mut accessory, mut controller) = peers();
        let event = "EVENT/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}";
        let mut script = Vec::new();
        // Comfortably more events than the ceiling, so the ceiling is what
        // stops it and not the end of the script.
        for _ in 0..MAX_EVENTS_PER_EXCHANGE * 3 {
            script.extend_from_slice(&accessory.seal_message(event.as_bytes()).unwrap());
        }
        let mut stream = Duplex { inbound: Cursor::new(script), written: Vec::new() };
        let mut events = Vec::new();
        let req = get_accessories("h").unwrap();
        assert_eq!(
            exchange(&mut controller, &mut stream, &req, &mut events),
            Err(HttpError::TooLarge("events before a response"))
        );
        // The event that broke the ceiling is NOT handed to the caller: the
        // ceiling is checked before the push, so `events` holds exactly the
        // ones that were within budget.
        assert_eq!(events.len(), MAX_EVENTS_PER_EXCHANGE);
    }

    #[test]
    fn http_errors_map_onto_the_home_error_that_names_the_right_fix() {
        use crate::home::HomeError as H;
        let cases: Vec<(HttpError, &str)> = vec![
            (HttpError::Session(SessionError::Closed), "unreachable"),
            (HttpError::Session(SessionError::Poisoned), "refused"),
            (HttpError::NotVerified, "unreachable"),
            (HttpError::Status(500), "unreachable"),
            (HttpError::Protocol("x".into()), "malformed"),
            (HttpError::TooLarge("body"), "malformed"),
            (HttpError::Json("x".into()), "malformed"),
            (HttpError::Refused("x".into()), "refused"),
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
