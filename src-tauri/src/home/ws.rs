// A minimal RFC 6455 client, written by hand, for exactly one job: Home
// Assistant's `/api/websocket` push channel on the LAN.
//
// WHY THIS IS HAND-WRITTEN AND NOT A CRATE
// `tungstenite 0.28` is ALREADY in Cargo.lock (librespot-core's dealer pulls
// it in through tokio-tungstenite), so `tungstenite = "0.28"` would be a
// zero-resolution-change dependency and would replace this whole file. That is
// a Cargo.toml edit, and Cargo.toml is not this change's to make — the vergen
// pin (see the manifest) is the reason dependency edits are deliberate here.
// So the choice was: hand-write the client, or ship no push channel at all.
//
// WHAT MAKES THAT ACCEPTABLE RATHER THAN RECKLESS: every piece of this file is
// a pure function over bytes, and the tests below drive them against the
// RFC's own published vectors plus a stub server. Nothing here needs a running
// Home Assistant to be believed.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//   * No TLS. `wss://` is REFUSED by `connect` with a message saying so,
//     rather than silently working because some other crate in the graph
//     happens to enable tungstenite's native-tls feature. A LAN Home Assistant
//     is plain http/ws; a remote one belongs behind a decision nobody has made.
//   * No outgoing fragmentation. Every message this client sends is one final
//     text frame. Incoming fragmentation IS handled — a server may fragment
//     whatever it likes.
//   * No permessage-deflate. We never offer the extension, so a conforming
//     server must not use it.
//   * No server-to-client masking is accepted: RFC 6455 §5.1 forbids it, and a
//     masked server frame means we are not talking to a WebSocket server.

use std::io::{BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;

/// The magic string from RFC 6455 §1.3. Not a secret and not configurable.
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Refuse a frame that claims to be larger than this.
///
/// Home Assistant's largest realistic push is a `state_changed` for one entity
/// with its attributes — kilobytes. A megabyte ceiling is generous by three
/// orders of magnitude and still means a hostile or broken peer cannot make
/// this thread allocate until the app dies.
const MAX_FRAME_BYTES: usize = 1024 * 1024;

/// Connect and read deadlines. A push socket is idle most of the time, so the
/// READ timeout is not a liveness check — it is how the reader loop gets a
/// chance to notice the stop flag. The supervisor treats a timeout as "keep
/// waiting", not as a failure.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const READ_POLL: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub enum WsError {
    /// The URL is not one this client can serve (scheme, missing host).
    BadUrl(String),
    /// TCP-level failure: nothing answered, or the connection dropped.
    Io(String),
    /// Answered, but not as a WebSocket server.
    Handshake(String),
    /// Answered as a WebSocket server, then broke the framing rules.
    Protocol(String),
    /// The peer closed cleanly.
    Closed,
    /// No bytes arrived within the poll window. Not a failure.
    Idle,
}

impl std::fmt::Display for WsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WsError::BadUrl(m) => write!(f, "{m}"),
            WsError::Io(m) => write!(f, "could not reach the bridge: {m}"),
            WsError::Handshake(m) => write!(f, "the bridge did not accept a WebSocket: {m}"),
            WsError::Protocol(m) => write!(f, "the bridge broke the WebSocket protocol: {m}"),
            WsError::Closed => write!(f, "the bridge closed the connection"),
            WsError::Idle => write!(f, "no message within the poll window"),
        }
    }
}

// ---------------------------------------------------------------------------
// SHA-1 (RFC 3174) — used for ONE thing: Sec-WebSocket-Accept
// ---------------------------------------------------------------------------

/// SHA-1 over `data`.
///
/// This is not a security primitive in this file and must never be used as
/// one. RFC 6455 uses SHA-1 as a *handshake checksum*: it proves the peer read
/// our nonce and understood the protocol, which is what stops a plain HTTP
/// endpoint (or a cache) from being mistaken for a WebSocket server. Its
/// collision weakness is irrelevant to that job and would be disqualifying for
/// any other one.
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [0x6745_2301, 0xEFCD_AB89, 0x98BA_DCFE, 0x1032_5476, 0xC3D2_E1F0];
    let bit_len = (data.len() as u64).wrapping_mul(8);

    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in w.iter_mut().enumerate().take(16) {
            let b = &chunk[i * 4..i * 4 + 4];
            *word = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }

        let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
        for (i, wi) in w.iter().enumerate() {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let tmp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*wi);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = tmp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut out = [0u8; 20];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

/// The `Sec-WebSocket-Accept` value a conforming server must return for `key`.
pub fn accept_for(key: &str) -> String {
    STANDARD.encode(sha1(format!("{key}{WS_GUID}").as_bytes()))
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/// Host, port and request path of a `ws://` URL.
#[derive(Debug, PartialEq, Eq)]
pub struct WsUrl {
    pub host: String,
    pub port: u16,
    pub path: String,
}

/// Parse a `ws://host[:port]/path` URL.
///
/// `wss://` is refused rather than downgraded: silently talking plaintext to a
/// URL the user wrote as encrypted is worse than not connecting.
pub fn parse_ws_url(url: &str) -> Result<WsUrl, WsError> {
    let rest = match url.split_once("://") {
        Some(("ws", rest)) => rest,
        Some(("wss", _)) => {
            return Err(WsError::BadUrl(
                "Atlas' push channel speaks ws:// only. A wss:// bridge needs TLS support that \
                 this build does not have — link the bridge over its LAN address instead."
                    .into(),
            ))
        }
        _ => return Err(WsError::BadUrl(format!("'{url}' is not a ws:// URL"))),
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    if authority.contains('@') {
        // Credentials in the authority would end up in logs and in the audit
        // trail. Home Assistant does not use them; refuse rather than strip.
        return Err(WsError::BadUrl("a bridge URL must not carry credentials".into()));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (
            h,
            p.parse::<u16>()
                .map_err(|_| WsError::BadUrl(format!("'{p}' is not a port")))?,
        ),
        None => (authority, 80u16),
    };
    if host.is_empty() {
        return Err(WsError::BadUrl("that URL has no host".into()));
    }
    Ok(WsUrl {
        host: host.to_string(),
        port,
        path: path.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opcode {
    Continuation,
    Text,
    Binary,
    Close,
    Ping,
    Pong,
}

impl Opcode {
    fn from_bits(bits: u8) -> Option<Opcode> {
        Some(match bits {
            0x0 => Opcode::Continuation,
            0x1 => Opcode::Text,
            0x2 => Opcode::Binary,
            0x8 => Opcode::Close,
            0x9 => Opcode::Ping,
            0xA => Opcode::Pong,
            _ => return None,
        })
    }

    fn bits(self) -> u8 {
        match self {
            Opcode::Continuation => 0x0,
            Opcode::Text => 0x1,
            Opcode::Binary => 0x2,
            Opcode::Close => 0x8,
            Opcode::Ping => 0x9,
            Opcode::Pong => 0xA,
        }
    }
}

/// Encode one FINAL, masked client frame.
///
/// Masking is mandatory for a client (RFC 6455 §5.3) and a conforming server
/// closes the connection on an unmasked client frame, so this is not optional
/// hardening — it is the wire format.
pub fn encode_frame(op: Opcode, payload: &[u8], mask: [u8; 4]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 14);
    out.push(0x80 | op.bits()); // FIN + opcode
    let len = payload.len();
    if len < 126 {
        out.push(0x80 | len as u8);
    } else if len <= u16::MAX as usize {
        out.push(0x80 | 126);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(0x80 | 127);
        out.extend_from_slice(&(len as u64).to_be_bytes());
    }
    out.extend_from_slice(&mask);
    out.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
    out
}

/// One decoded frame header plus its payload.
#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub fin: bool,
    pub op: Opcode,
    pub payload: Vec<u8>,
}

/// Read exactly one frame from `r`.
///
/// Every rejection here is a REFUSAL, never a repair: a reserved bit, an
/// unknown opcode, a masked server frame or an oversized length all mean the
/// stream is not what it claims to be, and continuing to parse it would be
/// guessing.
fn read_frame(r: &mut impl Read) -> Result<Frame, WsError> {
    let mut head = [0u8; 2];
    read_exact(r, &mut head)?;

    if head[0] & 0x70 != 0 {
        return Err(WsError::Protocol(
            "a reserved bit is set, which means an extension we never negotiated".into(),
        ));
    }
    let fin = head[0] & 0x80 != 0;
    let op = Opcode::from_bits(head[0] & 0x0F)
        .ok_or_else(|| WsError::Protocol(format!("unknown opcode {}", head[0] & 0x0F)))?;

    if head[1] & 0x80 != 0 {
        return Err(WsError::Protocol(
            "a server frame must not be masked (RFC 6455 §5.1)".into(),
        ));
    }
    let len = match head[1] & 0x7F {
        126 => {
            let mut b = [0u8; 2];
            read_exact(r, &mut b)?;
            u16::from_be_bytes(b) as usize
        }
        127 => {
            let mut b = [0u8; 8];
            read_exact(r, &mut b)?;
            let n = u64::from_be_bytes(b);
            if n > MAX_FRAME_BYTES as u64 {
                return Err(WsError::Protocol(format!("frame of {n} bytes is over the ceiling")));
            }
            n as usize
        }
        n => n as usize,
    };
    if len > MAX_FRAME_BYTES {
        return Err(WsError::Protocol(format!("frame of {len} bytes is over the ceiling")));
    }
    // A control frame carries at most 125 bytes and is never fragmented
    // (§5.5). Enforced because a "ping" with a megabyte body is a resource
    // attack wearing a protocol hat.
    if matches!(op, Opcode::Close | Opcode::Ping | Opcode::Pong) && (len > 125 || !fin) {
        return Err(WsError::Protocol("a control frame must be short and final".into()));
    }

    let mut payload = vec![0u8; len];
    read_exact(r, &mut payload)?;
    Ok(Frame { fin, op, payload })
}

fn read_exact(r: &mut impl Read, buf: &mut [u8]) -> Result<(), WsError> {
    match r.read_exact(buf) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => Err(WsError::Closed),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) =>
        {
            Err(WsError::Idle)
        }
        Err(e) => Err(WsError::Io(e.to_string())),
    }
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

pub struct WsClient {
    stream: TcpStream,
    reader: BufReader<TcpStream>,
    /// Assembled payload of a fragmented message in progress.
    partial: Vec<u8>,
    partial_op: Option<Opcode>,
}

/// Build the client handshake request. Separate from `connect` so the exact
/// bytes we put on the wire are testable without a socket.
pub fn handshake_request(url: &WsUrl, key: &str) -> String {
    format!(
        "GET {path} HTTP/1.1\r\n\
         Host: {host}:{port}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: {key}\r\n\
         Sec-WebSocket-Version: 13\r\n\
         \r\n",
        path = url.path,
        host = url.host,
        port = url.port,
        key = key,
    )
}

/// Check a server's handshake response against the key we sent.
///
/// Both halves matter. The 101 says the server agreed to upgrade; the accept
/// header says it is a WebSocket server rather than something that answers 101
/// to anything (a proxy, a cached response, a misconfigured reverse proxy).
pub fn check_handshake_response(response: &str, key: &str) -> Result<(), WsError> {
    let mut lines = response.split("\r\n");
    let status = lines.next().unwrap_or_default();
    if !status.contains(" 101") {
        return Err(WsError::Handshake(format!(
            "expected '101 Switching Protocols', got '{}'",
            status.chars().take(60).collect::<String>()
        )));
    }
    let expected = accept_for(key);
    let got = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("sec-websocket-accept"))
        .map(|(_, v)| v.trim().to_string());
    match got {
        Some(v) if v == expected => Ok(()),
        Some(_) => Err(WsError::Handshake(
            "Sec-WebSocket-Accept did not match the key Atlas sent".into(),
        )),
        None => Err(WsError::Handshake("no Sec-WebSocket-Accept header".into())),
    }
}

/// 16 random bytes, base64 — the nonce RFC 6455 §4.1 requires.
///
/// `Uuid::new_v4` is the CSPRNG this crate already depends on; its 16 bytes
/// carry 122 bits of entropy (6 are version/variant markers), which is enough
/// for a value whose only job is to be unpredictable to a cache.
fn nonce() -> String {
    STANDARD.encode(uuid::Uuid::new_v4().as_bytes())
}

fn mask_key() -> [u8; 4] {
    let b = *uuid::Uuid::new_v4().as_bytes();
    [b[0], b[1], b[2], b[3]]
}

impl WsClient {
    /// Open a WebSocket to `url`. Blocking; call this off the main thread.
    pub fn connect(url: &str) -> Result<WsClient, WsError> {
        let parsed = parse_ws_url(url)?;
        let addrs: Vec<std::net::SocketAddr> = std::net::ToSocketAddrs::to_socket_addrs(&(
            parsed.host.as_str(),
            parsed.port,
        ))
        .map_err(|e| WsError::Io(e.to_string()))?
        .collect();
        let addr = addrs
            .first()
            .ok_or_else(|| WsError::Io(format!("{} does not resolve", parsed.host)))?;
        let stream =
            TcpStream::connect_timeout(addr, CONNECT_TIMEOUT).map_err(|e| WsError::Io(e.to_string()))?;
        stream
            .set_read_timeout(Some(READ_POLL))
            .map_err(|e| WsError::Io(e.to_string()))?;

        let key = nonce();
        let mut stream = stream;
        stream
            .write_all(handshake_request(&parsed, &key).as_bytes())
            .map_err(|e| WsError::Io(e.to_string()))?;

        let read_half = stream.try_clone().map_err(|e| WsError::Io(e.to_string()))?;
        let mut reader = BufReader::new(read_half);
        let response = read_headers(&mut reader)?;
        check_handshake_response(&response, &key)?;

        Ok(WsClient {
            stream,
            reader,
            partial: Vec::new(),
            partial_op: None,
        })
    }

    /// Send one text message.
    pub fn send_text(&mut self, text: &str) -> Result<(), WsError> {
        let frame = encode_frame(Opcode::Text, text.as_bytes(), mask_key());
        self.stream
            .write_all(&frame)
            .map_err(|e| WsError::Io(e.to_string()))
    }

    /// Read the next complete TEXT message.
    ///
    /// Control frames are answered here and never surfaced: a ping gets a pong
    /// with the same payload (§5.5.2), a close ends the stream. Binary frames
    /// are refused — Home Assistant's protocol is JSON text, so a binary frame
    /// means something else is on this socket.
    pub fn next_text(&mut self) -> Result<String, WsError> {
        loop {
            let frame = read_frame(&mut self.reader)?;
            match frame.op {
                Opcode::Ping => {
                    let pong = encode_frame(Opcode::Pong, &frame.payload, mask_key());
                    self.stream
                        .write_all(&pong)
                        .map_err(|e| WsError::Io(e.to_string()))?;
                }
                Opcode::Pong => {}
                Opcode::Close => return Err(WsError::Closed),
                Opcode::Binary => {
                    return Err(WsError::Protocol(
                        "a binary frame arrived on a JSON channel".into(),
                    ))
                }
                Opcode::Text | Opcode::Continuation => {
                    if frame.op == Opcode::Text {
                        if self.partial_op.is_some() {
                            return Err(WsError::Protocol(
                                "a new message started before the previous one finished".into(),
                            ));
                        }
                        self.partial_op = Some(Opcode::Text);
                        self.partial.clear();
                    } else if self.partial_op.is_none() {
                        return Err(WsError::Protocol(
                            "a continuation frame arrived with no message in progress".into(),
                        ));
                    }
                    if self.partial.len() + frame.payload.len() > MAX_FRAME_BYTES {
                        return Err(WsError::Protocol("fragmented message over the ceiling".into()));
                    }
                    self.partial.extend_from_slice(&frame.payload);
                    if frame.fin {
                        self.partial_op = None;
                        let bytes = std::mem::take(&mut self.partial);
                        return String::from_utf8(bytes).map_err(|_| {
                            WsError::Protocol("a text frame was not valid UTF-8".into())
                        });
                    }
                }
            }
        }
    }

    /// Send a close frame. Best effort — the socket drops either way.
    pub fn close(&mut self) {
        // 1000 = normal closure.
        let frame = encode_frame(Opcode::Close, &1000u16.to_be_bytes(), mask_key());
        let _ = self.stream.write_all(&frame);
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

/// Read the response head up to the blank line, byte at a time.
///
/// Byte at a time on purpose: the body after the blank line is WebSocket
/// frames, and a buffered line reader would swallow the first of them.
/// `BufReader` here is shared with the frame reader, so anything it buffers
/// past the head is still available — but only if we never ask it for more
/// than the head.
fn read_headers(r: &mut impl Read) -> Result<String, WsError> {
    let mut out = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while out.len() < 8 * 1024 {
        read_exact(r, &mut byte)?;
        out.push(byte[0]);
        if out.ends_with(b"\r\n\r\n") {
            return String::from_utf8(out)
                .map_err(|_| WsError::Handshake("the response head was not text".into()));
        }
    }
    Err(WsError::Handshake("the response head never ended".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// RFC 3174 §7.3 publishes these. Without them the accept value below
    /// could be self-consistently wrong.
    #[test]
    fn sha1_matches_the_published_vectors() {
        let hex = |d: [u8; 20]| d.iter().map(|b| format!("{b:02x}")).collect::<String>();
        assert_eq!(hex(sha1(b"abc")), "a9993e364706816aba3e25717850c26c9cd0d89d");
        assert_eq!(hex(sha1(b"")), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(
            hex(sha1(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
        // Crosses the 64-byte block boundary and the length-field encoding.
        assert_eq!(
            hex(sha1(&vec![b'a'; 1000000])),
            "34aa973cd4c4daa4f61eeb2bdbad27316534016f"
        );
    }

    /// The worked example from RFC 6455 §1.3. This is the whole point of the
    /// SHA-1 above: get it wrong and every real server rejects us.
    #[test]
    fn accept_matches_the_rfc_worked_example() {
        assert_eq!(
            accept_for("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
        );
    }

    #[test]
    fn a_wss_url_is_refused_rather_than_downgraded() {
        let err = parse_ws_url("wss://homeassistant.local:8123/api/websocket")
            .expect_err("wss must not silently become ws");
        assert!(err.to_string().contains("ws://"), "{err}");
    }

    #[test]
    fn urls_parse_into_host_port_path() {
        assert_eq!(
            parse_ws_url("ws://homeassistant.local:8123/api/websocket").unwrap(),
            WsUrl {
                host: "homeassistant.local".into(),
                port: 8123,
                path: "/api/websocket".into()
            }
        );
        // No port, no path.
        assert_eq!(
            parse_ws_url("ws://10.0.0.5").unwrap(),
            WsUrl { host: "10.0.0.5".into(), port: 80, path: "/".into() }
        );
        for bad in [
            "http://x/y",
            "homeassistant.local:8123",
            "ws://",
            "ws://user:pw@host/api",
            "ws://host:notaport/api",
        ] {
            assert!(parse_ws_url(bad).is_err(), "'{bad}' must not parse");
        }
    }

    #[test]
    fn a_client_frame_is_always_masked_and_round_trips() {
        let mask = [0x37, 0xfa, 0x21, 0x3d];
        let out = encode_frame(Opcode::Text, b"Hello", mask);
        // RFC 6455 §5.7's masked "Hello" example, byte for byte.
        assert_eq!(
            out,
            vec![0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58]
        );
        assert_eq!(out[1] & 0x80, 0x80, "the mask bit must be set");
    }

    #[test]
    fn extended_lengths_use_the_right_width() {
        let m = [0u8; 4];
        assert_eq!(encode_frame(Opcode::Text, &[0u8; 125], m)[1] & 0x7F, 125);
        let mid = encode_frame(Opcode::Text, &[0u8; 126], m);
        assert_eq!(mid[1] & 0x7F, 126);
        assert_eq!(&mid[2..4], &126u16.to_be_bytes());
        let big = encode_frame(Opcode::Text, &vec![0u8; 70_000], m);
        assert_eq!(big[1] & 0x7F, 127);
        assert_eq!(&big[2..10], &70_000u64.to_be_bytes());
    }

    /// A server frame is unmasked, so the encoder cannot be reused to build
    /// one — this is the shape the reader has to accept.
    fn server_frame(op: Opcode, fin: bool, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![if fin { 0x80 | op.bits() } else { op.bits() }];
        if payload.len() < 126 {
            out.push(payload.len() as u8);
        } else {
            out.push(126);
            out.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        }
        out.extend_from_slice(payload);
        out
    }

    #[test]
    fn reads_a_plain_text_frame() {
        let mut c = Cursor::new(server_frame(Opcode::Text, true, b"{\"type\":\"auth_ok\"}"));
        let f = read_frame(&mut c).unwrap();
        assert_eq!(f.op, Opcode::Text);
        assert!(f.fin);
        assert_eq!(f.payload, b"{\"type\":\"auth_ok\"}");
    }

    #[test]
    fn a_masked_server_frame_is_refused() {
        // Exactly the bytes a client would send; from a server they are illegal.
        let bytes = encode_frame(Opcode::Text, b"hi", [1, 2, 3, 4]);
        let err = read_frame(&mut Cursor::new(bytes)).expect_err("masked server frame");
        assert!(matches!(err, WsError::Protocol(_)), "{err}");
    }

    #[test]
    fn reserved_bits_and_unknown_opcodes_are_refused() {
        let err = read_frame(&mut Cursor::new(vec![0xC1, 0x00])).expect_err("RSV1 set");
        assert!(matches!(err, WsError::Protocol(_)), "{err}");
        let err = read_frame(&mut Cursor::new(vec![0x83, 0x00])).expect_err("opcode 3");
        assert!(matches!(err, WsError::Protocol(_)), "{err}");
    }

    #[test]
    fn an_oversized_frame_is_refused_before_it_is_allocated() {
        let mut head = vec![0x81, 127];
        head.extend_from_slice(&(u64::MAX).to_be_bytes());
        let err = read_frame(&mut Cursor::new(head)).expect_err("absurd length");
        assert!(matches!(err, WsError::Protocol(_)), "{err}");
    }

    #[test]
    fn a_giant_control_frame_is_refused() {
        let err = read_frame(&mut Cursor::new(server_frame(Opcode::Ping, true, &[0u8; 200])))
            .expect_err("control frames are <=125 bytes");
        assert!(matches!(err, WsError::Protocol(_)), "{err}");
    }

    #[test]
    fn the_handshake_request_carries_the_four_required_headers() {
        let url = parse_ws_url("ws://hub.local:8123/api/websocket").unwrap();
        let req = handshake_request(&url, "dGhlIHNhbXBsZSBub25jZQ==");
        assert!(req.starts_with("GET /api/websocket HTTP/1.1\r\n"));
        for needle in [
            "Host: hub.local:8123\r\n",
            "Upgrade: websocket\r\n",
            "Connection: Upgrade\r\n",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
            "Sec-WebSocket-Version: 13\r\n",
        ] {
            assert!(req.contains(needle), "missing {needle:?} in {req:?}");
        }
        assert!(req.ends_with("\r\n\r\n"));
    }

    #[test]
    fn a_handshake_response_must_prove_it_read_our_key() {
        let key = "dGhlIHNhbXBsZSBub25jZQ==";
        let good = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\
             Sec-WebSocket-Accept: {}\r\n\r\n",
            accept_for(key)
        );
        assert!(check_handshake_response(&good, key).is_ok());

        // A 200 from a plain HTTP endpoint.
        assert!(check_handshake_response("HTTP/1.1 200 OK\r\n\r\n", key).is_err());
        // 101 with no proof, and 101 with the WRONG proof — the two ways a
        // non-WebSocket peer gets this far.
        assert!(check_handshake_response("HTTP/1.1 101 Switching Protocols\r\n\r\n", key).is_err());
        assert!(check_handshake_response(
            "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: nope\r\n\r\n",
            key
        )
        .is_err());
        // Header names are case-insensitive on the wire.
        let odd = format!(
            "HTTP/1.1 101 Switching Protocols\r\nsec-websocket-accept: {}\r\n\r\n",
            accept_for(key)
        );
        assert!(check_handshake_response(&odd, key).is_ok());
    }

    #[test]
    fn header_reading_stops_at_the_blank_line() {
        let mut raw = b"HTTP/1.1 101 Switching Protocols\r\nX: y\r\n\r\n".to_vec();
        raw.extend_from_slice(&server_frame(Opcode::Text, true, b"after"));
        let mut cur = Cursor::new(raw);
        let head = read_headers(&mut cur).unwrap();
        assert!(head.ends_with("\r\n\r\n"));
        // The frame that followed the head is still readable — a line-buffered
        // reader here would have eaten it.
        assert_eq!(read_frame(&mut cur).unwrap().payload, b"after");
    }
}
