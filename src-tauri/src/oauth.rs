// Provider-agnostic OAuth plumbing for native (desktop) OAuth flows.
//
// Atlas is a *public* OAuth client (a shipped binary can't keep a secret
// secret), so per RFC 8252 ("OAuth 2.0 for Native Apps") it uses Authorization
// Code + PKCE, with one of two ways to catch the redirect:
//
// - an OS **deep link** (`REDIRECT_URI`, routed by `FlowRegistry`) where the
//   provider allows a custom scheme. Spotify.
// - a **loopback** listener (`Loopback`, http://127.0.0.1:<random port>) where
//   it doesn't. Google's "Desktop app" clients accept only that, and also want
//   the client's secret, which Google documents as non-confidential for
//   installed apps. Gmail.
//
// Either way the code comes straight back into this process and is exchanged
// in Rust; it never reaches the webview.
//
// The deep-link target is a single seam (`REDIRECT_URI`). Today it's the custom
// scheme `atlas://…`, which works on any build (signed or not). When Atlas gains
// an Apple Developer Team ID + notarization, flipping to the branded universal
// link `https://helloatlas.dk/…` is a one-line change here plus hosting the AASA
// file (see docs/decisions/007-oauth-deep-link.md) — the flow itself (PKCE →
// deep-link capture → token exchange) is unchanged. Spotify/librespot is the
// first consumer; the module is deliberately provider-neutral.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};

/// How long a started sign-in may take before its callback is refused.
pub const FLOW_TTL: Duration = Duration::from_secs(10 * 60);

/// Which provider issued which OAuth `state`.
///
/// For providers on the shared atlas:// redirect (`REDIRECT_URI`; Spotify
/// today: Gmail uses `Loopback` instead). No provider echoes a tag back, so the
/// state is the only thing that says whose callback this is. lib.rs asks the
/// registry and hands the callback to that provider alone, so a second
/// provider on the deep link can never consume another's sign-in.
///
/// Entries outlive their FLOW_TTL on purpose (they are pruned at twice that),
/// so a late callback is still routed to its provider, which refuses it with a
/// message instead of the callback vanishing and the UI waiting forever.
#[derive(Default)]
pub struct FlowRegistry {
    issued: Mutex<HashMap<String, (&'static str, Instant)>>,
}

/// Whose a callback is, and whether it arrived in time.
#[derive(Debug, PartialEq, Eq)]
pub struct Claim {
    pub provider: &'static str,
    /// False once FLOW_TTL has passed: the provider should refuse the callback
    /// AND say so, or its UI waits forever for a result that never comes.
    pub fresh: bool,
}

impl FlowRegistry {
    pub fn issue(&self, provider: &'static str, state: &str) {
        let mut issued = self.issued.lock().unwrap();
        // Kept for twice the TTL, so a late callback can still be attributed
        // to its provider and refused with a message rather than dropped.
        issued.retain(|_, (_, at)| at.elapsed() < FLOW_TTL * 2);
        issued.insert(state.to_string(), (provider, Instant::now()));
    }

    /// Who issued `state`. None only for a state no provider issued (or one
    /// claimed already, or very old): there is no one to report it to. A state
    /// is answered once: claiming removes it.
    pub fn claim(&self, state: Option<&str>) -> Option<Claim> {
        self.claim_at(state, Instant::now())
    }

    fn claim_at(&self, state: Option<&str>, now: Instant) -> Option<Claim> {
        let (provider, at) = self.issued.lock().unwrap().remove(state?)?;
        Some(Claim { provider, fresh: now.saturating_duration_since(at) < FLOW_TTL })
    }
}

/// Take `slot`'s pending flow only if `state` is the one it issued, leaving a
/// newer flow in place when an older (superseded) callback arrives.
pub fn take_matching<T>(
    slot: &Mutex<Option<T>>,
    state: Option<&str>,
    state_of: impl Fn(&T) -> &str,
) -> Option<T> {
    let mut slot = slot.lock().unwrap();
    match slot.as_ref() {
        Some(p) if state == Some(state_of(p)) => slot.take(),
        _ => None,
    }
}

/// Custom-scheme redirect used now (works unsigned, in dev and prod).
/// Consumed by the per-provider flow (music.rs) once it lands.
#[allow(dead_code)]
pub const REDIRECT_URI: &str = "atlas://oauth/callback";
/// Branded universal-link variant, pre-staged. Becomes usable once the app is
/// signed with a Team ID and the AASA file is served from the apex. Flip
/// `REDIRECT_URI` to this to activate — nothing else in the flow changes.
#[allow(dead_code)]
pub const REDIRECT_URI_UNIVERSAL: &str = "https://helloatlas.dk/oauth/callback";

/// The custom scheme Atlas registers with the OS (mirrors tauri.conf.json).
pub const SCHEME: &str = "atlas";

/// Hosts whose `https` deep links count as our universal-link callback.
/// `helloatlas.dk` is the canonical host and the one we generate;
/// `atlas.innovo-studio.com` is the pre-migration host, still served by the same
/// Pages project and still compiled into already-installed builds — so a
/// callback that started against it must keep being accepted.
const UNIVERSAL_HOSTS: [&str; 2] = ["helloatlas.dk", "atlas.innovo-studio.com"];

/// A parsed OAuth redirect, forwarded to the webview as the `oauth-callback`
/// event. Exactly one of `code` / `error` is normally present.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct OauthCallback {
    /// Logical provider the flow was for, e.g. "spotify". Derived from the
    /// redirect's first path segment (`atlas://oauth/callback?provider=…` is
    /// also honoured via the query for providers that drop the path).
    pub provider: String,
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// RFC 7636 PKCE pair: `(code_verifier, code_challenge)` where the challenge is
/// `BASE64URL(SHA256(verifier))` (the `S256` method — the only one Atlas uses).
/// The verifier is 64 chars drawn from the PKCE unreserved set (two v4 UUIDs,
/// 256 bits of entropy), so no extra RNG dependency is needed.
pub fn generate_pkce() -> (String, String) {
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = code_challenge(&verifier);
    (verifier, challenge)
}

/// `BASE64URL-NO-PAD(SHA256(verifier))` — the S256 transform, split out so it
/// can be pinned against the RFC 7636 test vector.
pub fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// Parse a redirect URL captured from the deep link into an `OauthCallback`.
/// Accepts the custom scheme (`atlas://oauth/callback?…`) now and the branded
/// universal link (`https://helloatlas.dk/oauth/callback?…`, plus the old
/// `atlas.innovo-studio.com` host — see `UNIVERSAL_HOSTS`) once it's live.
/// Returns `None` for anything that isn't one of our OAuth callbacks, so
/// unrelated deep links are ignored rather than mis-handled.
pub fn parse_callback(raw: &str) -> Option<OauthCallback> {
    let url = url::Url::parse(raw).ok()?;

    let is_ours = match url.scheme() {
        SCHEME => true,
        "https" => url
            .host_str()
            .is_some_and(|h| UNIVERSAL_HOSTS.contains(&h)),
        _ => false,
    };
    if !is_ours {
        return None;
    }

    // The callback path is ".../oauth/callback" regardless of scheme. For the
    // custom scheme the host is the first segment ("oauth"), so normalise by
    // stitching host + path back together before matching.
    let joined = match url.scheme() {
        SCHEME => format!("{}{}", url.host_str().unwrap_or(""), url.path()),
        _ => url.path().trim_start_matches('/').to_string(),
    };
    if joined.trim_end_matches('/') != "oauth/callback" {
        return None;
    }
    callback_from_query(&url)
}

/// The OAuth fields of a redirect's query, shared by the deep-link and
/// loopback paths. A redirect with neither a code nor an error isn't
/// actionable, so it's None.
fn callback_from_query(url: &url::Url) -> Option<OauthCallback> {
    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut provider = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            "provider" => provider = Some(v.into_owned()),
            _ => {}
        }
    }
    if code.is_none() && error.is_none() {
        return None;
    }
    Some(OauthCallback {
        provider: provider.unwrap_or_default(),
        code,
        state,
        error,
    })
}

// ---------------------------------------------------------------------------
// Loopback redirect (RFC 8252 §7.3)
// ---------------------------------------------------------------------------

/// A one-shot HTTP listener on 127.0.0.1 that catches an OAuth redirect.
///
/// For providers that refuse custom-scheme redirects: Google's "Desktop app"
/// client type accepts only loopback redirects (on any port), so Gmail sign-in
/// lands here instead of on the atlas:// deep link. The OS picks a free port,
/// and only loopback connections can reach it because that is the only
/// interface it binds.
///
/// tiny_http (already the control port's server) does the HTTP: it reads each
/// connection on its own worker and only hands over complete requests, so a
/// slow or idle socket (a browser preconnect, or a hostile local process) can't
/// stall the real redirect, the deadline, or a cancel.
///
/// Any local process, or a web page requesting 127.0.0.1, can still reach the
/// port. So only a request carrying the expected state ends the wait; anything
/// else gets a 400 and the listener keeps waiting, so a wrong guess can't
/// cancel or hijack the real sign-in.
pub struct Loopback {
    server: tiny_http::Server,
    port: u16,
}

/// How often wait() re-checks its keep-waiting condition while live.
const LOOPBACK_POLL: Duration = Duration::from_millis(200);

/// How long a retired listener (sign-in cancelled in Atlas) stays up to tell a
/// tab finished afterwards what happened, before freeing its port and thread.
const RETIRED_GRACE: Duration = Duration::from_secs(2 * 60);

/// How a wait() ended.
pub enum LoopbackOutcome {
    /// The redirect for this sign-in, with the browser's request held open so
    /// the caller can answer with the real outcome.
    Redirect(OauthCallback, LoopbackReply),
    /// The deadline passed (or the retired grace period ran out).
    TimedOut,
    /// The listener itself failed. Not a timeout, so not reported as one.
    Failed(String),
}

/// The browser's request, held open so it can be answered with the outcome.
pub struct LoopbackReply(tiny_http::Request);

impl LoopbackReply {
    pub fn send(self, ok: bool, title: &str, message: &str) {
        answer(self.0, ok, title, message);
    }
}

impl Loopback {
    pub fn bind() -> Result<Self, String> {
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
        let port = server
            .server_addr()
            .to_ip()
            .ok_or("loopback listener bound to a non-IP address")?
            .port();
        Ok(Self { server, port })
    }

    /// The redirect_uri to send, in both the authorize request and the token
    /// exchange (the provider requires the two to match exactly).
    pub fn redirect_uri(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Wait for the redirect that carries `expected_state`, until `deadline`.
    ///
    /// Once `keep_waiting` says the sign-in was cancelled in Atlas, the
    /// listener stays up for RETIRED_GRACE (never past the deadline) only to
    /// tell a tab finished late that this sign-in is no longer active; a closed
    /// port would leave it on a bare "can't be reached" page.
    pub fn wait(
        self,
        expected_state: &str,
        mut deadline: Instant,
        keep_waiting: impl Fn() -> bool,
    ) -> LoopbackOutcome {
        let mut live = true;
        loop {
            if live && !keep_waiting() {
                live = false;
                deadline = deadline.min(Instant::now() + RETIRED_GRACE);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return LoopbackOutcome::TimedOut;
            }
            // Retired: nothing left to re-check, so block until the deadline.
            let slice = if live { left.min(LOOPBACK_POLL) } else { left };
            let request = match self.server.recv_timeout(slice) {
                Ok(Some(request)) => request,
                Ok(None) => continue,
                Err(e) => return LoopbackOutcome::Failed(e.to_string()),
            };
            let cb = (*request.method() == tiny_http::Method::Get)
                .then(|| parse_loopback_target(request.url()))
                .flatten()
                .filter(|cb| cb.state.as_deref() == Some(expected_state));
            match cb {
                Some(cb) if live => return LoopbackOutcome::Redirect(cb, LoopbackReply(request)),
                Some(_) => answer(
                    request,
                    false,
                    "This sign-in is no longer active",
                    "It was cancelled in Atlas. Connect again from Atlas if you still want to.",
                ),
                None => answer(
                    request,
                    false,
                    "Not an Atlas sign-in",
                    "This address only accepts the sign-in Atlas is waiting for. You can close this tab.",
                ),
            }
        }
    }
}

/// Parse a loopback request-target ("/?code=…&state=…") into a callback.
/// Only the root path, and only a request with a code or an error, counts.
fn parse_loopback_target(target: &str) -> Option<OauthCallback> {
    if !target.starts_with('/') {
        return None;
    }
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/" {
        return None;
    }
    callback_from_query(&url)
}

/// Answer the browser with a small self-contained page. no-referrer and
/// no-store keep the code in the URL from leaking anywhere.
fn answer(request: tiny_http::Request, ok: bool, title: &str, message: &str) {
    let (title, message) = (escape_html(title), escape_html(message));
    let body = format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{title}</title></head>\
         <body style=\"font:16px -apple-system,system-ui,sans-serif;max-width:32em;margin:18vh auto;padding:0 1.5em;color:#1e1e24;background:#f9f7f4\">\
         <h1 style=\"font-size:1.4em\">{title}</h1><p>{message}</p></body></html>"
    );
    let mut response = tiny_http::Response::from_string(body).with_status_code(if ok { 200 } else { 400 });
    for (name, value) in [
        ("Content-Type", "text/html; charset=utf-8"),
        ("Cache-Control", "no-store"),
        ("Referrer-Policy", "no-referrer"),
    ] {
        let header = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes())
            .expect("static header is well-formed");
        response = response.with_header(header);
    }
    // A tab closed before the answer is the browser's business; nothing to do.
    let _ = request.respond(response);
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_callback_goes_to_the_provider_that_issued_its_state_once() {
        let flows = FlowRegistry::default();
        flows.issue("spotify", "s1");
        flows.issue("gmail", "g1");
        assert_eq!(flows.claim(Some("g1")), Some(Claim { provider: "gmail", fresh: true }));
        assert_eq!(flows.claim(Some("s1")), Some(Claim { provider: "spotify", fresh: true }));
        assert_eq!(flows.claim(Some("g1")), None, "a state is answered once");
        assert_eq!(flows.claim(Some("forged")), None);
        assert_eq!(flows.claim(None), None);
    }

    #[test]
    fn a_superseded_state_is_still_attributed_to_its_provider() {
        let flows = FlowRegistry::default();
        flows.issue("spotify", "first-click");
        flows.issue("spotify", "second-click");
        assert_eq!(flows.claim(Some("first-click")).map(|c| c.provider), Some("spotify"));
    }

    #[test]
    fn a_late_state_is_attributed_but_not_fresh() {
        let flows = FlowRegistry::default();
        flows.issue("gmail", "g1");
        let later = Instant::now() + FLOW_TTL + Duration::from_secs(1);
        assert_eq!(flows.claim_at(Some("g1"), later), Some(Claim { provider: "gmail", fresh: false }));
    }

    #[test]
    fn a_loopback_target_parses_into_a_callback() {
        let cb = parse_loopback_target("/?state=s1&code=4%2F0Ab&scope=x").unwrap();
        assert_eq!(cb.code.as_deref(), Some("4/0Ab"));
        assert_eq!(cb.state.as_deref(), Some("s1"));
        let denied = parse_loopback_target("/?error=access_denied&state=s1").unwrap();
        assert_eq!(denied.error.as_deref(), Some("access_denied"));

        assert!(parse_loopback_target("/favicon.ico").is_none());
        assert!(parse_loopback_target("/other?code=c&state=s").is_none(), "root path only");
        assert!(parse_loopback_target("/?state=s1").is_none(), "neither code nor error");
        assert!(parse_loopback_target("evil.com/?code=c").is_none());
    }

    #[test]
    fn html_in_messages_is_escaped() {
        assert_eq!(escape_html("<b>\"x\" & 'y'</b>"), "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;");
    }

    /// Send one raw request to the loopback port; return the whole response.
    fn hit(port: u16, request: &str) -> String {
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        s.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    fn redirect(outcome: LoopbackOutcome) -> (OauthCallback, LoopbackReply) {
        match outcome {
            LoopbackOutcome::Redirect(cb, reply) => (cb, reply),
            LoopbackOutcome::TimedOut => panic!("timed out instead of returning the redirect"),
            LoopbackOutcome::Failed(e) => panic!("listener failed: {e}"),
        }
    }

    fn get(port: u16, target: &str) -> String {
        hit(port, &format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"))
    }

    #[test]
    fn loopback_ignores_a_wrong_state_and_returns_the_right_one() {
        let lb = Loopback::bind().unwrap();
        assert!(lb.redirect_uri().starts_with("http://127.0.0.1:"));
        let port = lb.port;
        let client = std::thread::spawn(move || {
            let forged = get(port, "/?code=evil&state=guess");
            let junk = hit(port, "POST /?code=c&state=expected HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            let real = get(port, "/?code=good&state=expected");
            (forged, junk, real)
        });

        let (cb, reply) = redirect(lb.wait("expected", Instant::now() + Duration::from_secs(10), || true));
        assert_eq!(cb.code.as_deref(), Some("good"));
        reply.send(true, "Connected", "Done <now>");

        let (forged, junk, real) = client.join().unwrap();
        assert!(forged.starts_with("HTTP/1.1 400"), "a wrong state is answered and ignored");
        assert!(junk.starts_with("HTTP/1.1 400"), "only GET counts");
        assert!(real.starts_with("HTTP/1.1 200"));
        assert!(real.contains("Done &lt;now&gt;"));
        assert!(real.contains("Referrer-Policy: no-referrer"));
    }

    #[test]
    fn a_stalled_connection_does_not_hold_up_the_redirect() {
        use std::io::Write;
        let lb = Loopback::bind().unwrap();
        let port = lb.port;
        // Half a request, then silence: a preconnect, or a local process
        // trying to stall the sign-in.
        let mut stall = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stall.write_all(b"GET /?co").unwrap();
        let client = std::thread::spawn(move || get(port, "/?code=good&state=s1"));

        let start = Instant::now();
        let (cb, reply) = redirect(lb.wait("s1", Instant::now() + Duration::from_secs(20), || true));
        assert!(start.elapsed() < Duration::from_secs(3));
        assert_eq!(cb.code.as_deref(), Some("good"));
        reply.send(true, "ok", "ok");
        assert!(client.join().unwrap().starts_with("HTTP/1.1 200"));
        drop(stall);
    }

    #[test]
    fn a_retired_sign_in_tells_a_late_tab_instead_of_completing() {
        let lb = Loopback::bind().unwrap();
        let port = lb.port;
        let client = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            get(port, "/?code=late&state=s1")
        });
        let start = Instant::now();
        // keep_waiting false: cancelled or replaced in Atlas.
        assert!(matches!(lb.wait("s1", Instant::now() + Duration::from_secs(2), || false), LoopbackOutcome::TimedOut));
        assert!(start.elapsed() >= Duration::from_secs(1), "stays up to answer until the deadline");
        let late = client.join().unwrap();
        assert!(late.starts_with("HTTP/1.1 400"));
        assert!(late.contains("no longer active"));
    }

    #[test]
    fn loopback_gives_up_at_the_deadline() {
        let lb = Loopback::bind().unwrap();
        assert!(matches!(lb.wait("s", Instant::now(), || true), LoopbackOutcome::TimedOut));
        let lb = Loopback::bind().unwrap();
        let start = Instant::now();
        assert!(matches!(lb.wait("s", Instant::now() + Duration::from_millis(500), || true), LoopbackOutcome::TimedOut));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn take_matching_leaves_a_newer_flow_in_place() {
        let slot = Mutex::new(Some(String::from("newer")));
        assert!(take_matching(&slot, Some("older"), |s| s.as_str()).is_none());
        assert!(take_matching(&slot, None, |s| s.as_str()).is_none());
        assert!(slot.lock().unwrap().is_some());
        assert_eq!(take_matching(&slot, Some("newer"), |s| s.as_str()).as_deref(), Some("newer"));
        assert!(slot.lock().unwrap().is_none());
    }

    // RFC 7636 Appendix B: the canonical verifier → challenge vector. Pins the
    // S256 transform so a future refactor can't silently break PKCE.
    #[test]
    fn pkce_matches_rfc7636_vector() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn generated_pkce_is_well_formed() {
        let (verifier, challenge) = generate_pkce();
        // 43..=128 chars, all from the PKCE unreserved set.
        assert_eq!(verifier.len(), 64);
        assert!(verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~')));
        // Challenge is base64url(32-byte digest) with no padding => 43 chars.
        assert_eq!(challenge.len(), 43);
        assert!(!challenge.contains('='));
        assert_eq!(challenge, code_challenge(&verifier));
    }

    #[test]
    fn parses_custom_scheme_success() {
        let cb = parse_callback("atlas://oauth/callback?provider=spotify&code=AQ123&state=xyz")
            .expect("should parse");
        assert_eq!(
            cb,
            OauthCallback {
                provider: "spotify".into(),
                code: Some("AQ123".into()),
                state: Some("xyz".into()),
                error: None,
            }
        );
    }

    #[test]
    fn parses_error_redirect() {
        let cb = parse_callback("atlas://oauth/callback?error=access_denied&state=xyz")
            .expect("should parse");
        assert_eq!(cb.error.as_deref(), Some("access_denied"));
        assert!(cb.code.is_none());
    }

    #[test]
    fn parses_universal_link_variant() {
        let cb = parse_callback("https://helloatlas.dk/oauth/callback?provider=spotify&code=AQ9")
            .expect("should parse");
        assert_eq!(cb.provider, "spotify");
        assert_eq!(cb.code.as_deref(), Some("AQ9"));
    }

    /// The pre-migration host is still live and still baked into installed
    /// builds, so a callback aimed at it must keep parsing.
    #[test]
    fn parses_legacy_universal_link_host() {
        let cb = parse_callback(
            "https://atlas.innovo-studio.com/oauth/callback?provider=spotify&code=AQ9",
        )
        .expect("should parse");
        assert_eq!(cb.provider, "spotify");
        assert_eq!(cb.code.as_deref(), Some("AQ9"));
    }

    #[test]
    fn ignores_unrelated_deep_links() {
        // Wrong scheme, wrong host, wrong path, and empty-payload callbacks all
        // yield None so they fall through to whatever else handles them.
        assert!(parse_callback("otherapp://oauth/callback?code=x").is_none());
        assert!(parse_callback("https://evil.example.com/oauth/callback?code=x").is_none());
        assert!(parse_callback("atlas://something/else?code=x").is_none());
        assert!(parse_callback("atlas://oauth/callback?state=only").is_none());
    }
}
