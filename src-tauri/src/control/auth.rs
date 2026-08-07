// The control port's auth ladder.
//
// Everything here is a PURE function of the request head — method, path,
// headers, body length. Keeping it free of `tauri::AppHandle` (and of tiny_http
// types) is what makes the security-critical logic testable directly, without
// booting an app or opening a socket.
//
// The ladder is ordered cheapest-and-most-structural first. Every rung except
// the size cap produces the IDENTICAL 403 body: a caller must not be able to
// probe which check it tripped. Distinguishing "unknown path" from "bad token"
// would tell an attacker whether the surface exists and whether their token
// guess was the right length — so it does not.

/// 256 KB. Read-only op arguments are small; anything larger is either a
/// mistake or an attempt to make a worker thread allocate.
pub const MAX_BODY: usize = 256 * 1024;

/// The single response body for every authorisation failure, whatever the
/// cause. Do not add a reason field to this — the sameness is the point.
pub const FORBIDDEN_BODY: &str = r#"{"ok":false,"error":{"code":"forbidden","message":"forbidden"}}"#;

/// Distinct from the 403s because it is not an authorisation answer: the caller
/// is authenticated and simply sent too much, and it needs to know to retry
/// smaller rather than to re-check its token.
pub const TOO_LARGE_BODY: &str =
    r#"{"ok":false,"error":{"code":"too_large","message":"request body too large"}}"#;

const BEARER_PREFIX: &str = "Bearer ";

/// The only two things this port answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    Invoke,
    Capabilities,
}

/// Why a request was refused. Callers only ever see `render()`'s output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    /// Rungs 1-4, collapsed on purpose.
    Forbidden,
    /// Rung 5.
    TooLarge,
}

impl Reject {
    /// The wire answer: status code and body.
    pub fn render(self) -> (u16, &'static str) {
        match self {
            Reject::Forbidden => (403, FORBIDDEN_BODY),
            Reject::TooLarge => (413, TOO_LARGE_BODY),
        }
    }
}

/// Just enough of a request to decide on it.
pub struct RequestHead<'a> {
    pub method: &'a str,
    /// Path with any query string already stripped.
    pub path: &'a str,
    pub origin: Option<&'a str>,
    pub host: Option<&'a str>,
    pub authorization: Option<&'a str>,
    pub content_length: usize,
}

/// Constant-time byte comparison.
///
/// The length check short-circuits — that is deliberate and harmless, since a
/// mismatched length is already observable from the timing of any comparison
/// and the token's length is not the secret. The bytes themselves are folded
/// with no early exit, so no prefix of a guess is faster to reject than any
/// other, and a caller cannot walk the token out one byte at a time.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Run the ladder. `Ok(route)` means the request may be dispatched.
pub fn inspect(
    head: &RequestHead,
    expected_host: &str,
    expected_token: &str,
) -> Result<Route, Reject> {
    // Rung 1 — method and path. An unlisted path is not a 404: telling an
    // unauthenticated caller which URLs exist maps the surface for them.
    let route = match (head.method, head.path) {
        ("POST", "/v1/invoke") => Route::Invoke,
        ("GET", "/v1/capabilities") => Route::Capabilities,
        _ => return Err(Reject::Forbidden),
    };

    // Rung 2 — any Origin header at all is disqualifying. This port has no
    // browser clients; the only caller is the brain process, which sends none.
    // A page attempting a cross-origin request always has one attached by the
    // browser, so its mere presence identifies a context that must not be here.
    if head.origin.is_some() {
        return Err(Reject::Forbidden);
    }

    // Rung 3 — DNS-rebinding defence. An attacker who controls a domain can
    // make it resolve to 127.0.0.1 and get a page talking to this port, but the
    // browser will still send `Host: evil.example`. Host is one of the few
    // headers a page cannot forge, so pinning it to our exact literal
    // address:port shuts that whole class down.
    match head.host {
        Some(h) if h == expected_host => {}
        _ => return Err(Reject::Forbidden),
    }

    // Rung 4 — bearer token. Splitting off the "Bearer " prefix returns early,
    // which leaks nothing: the prefix is a fixed public string. The secret
    // comparison itself is constant-time.
    let presented = head
        .authorization
        .and_then(|v| v.strip_prefix(BEARER_PREFIX))
        .unwrap_or("");
    if !ct_eq(presented.as_bytes(), expected_token.as_bytes()) {
        return Err(Reject::Forbidden);
    }

    // Rung 5 — size cap, last because it is the only rung that answers
    // differently, and only an authenticated caller earns that distinction.
    if head.content_length > MAX_BODY {
        return Err(Reject::TooLarge);
    }

    Ok(route)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "11111111-2222-3333-4444-555555555555";
    const HOST: &str = "127.0.0.1:54321";

    /// A request that passes every rung. Individual tests break one thing.
    fn good() -> RequestHead<'static> {
        RequestHead {
            method: "POST",
            path: "/v1/invoke",
            origin: None,
            host: Some(HOST),
            authorization: Some("Bearer 11111111-2222-3333-4444-555555555555"),
            content_length: 12,
        }
    }

    // --- ct_eq -------------------------------------------------------------

    #[test]
    fn ct_eq_equal() {
        assert!(ct_eq(b"abcdef", b"abcdef"));
        assert!(ct_eq(b"", b""));
    }

    #[test]
    fn ct_eq_differing_same_length() {
        assert!(!ct_eq(b"abcdef", b"abcdeg"));
        // Differing in the FIRST byte must be rejected too — a naive
        // implementation with an early return would still pass this, but it
        // pins the behaviour we want.
        assert!(!ct_eq(b"abcdef", b"zbcdef"));
    }

    #[test]
    fn ct_eq_different_length() {
        assert!(!ct_eq(b"abc", b"abcd"));
        assert!(!ct_eq(b"abcd", b"abc"));
        assert!(!ct_eq(b"", b"a"));
    }

    // --- happy path --------------------------------------------------------

    #[test]
    fn accepts_invoke_and_capabilities() {
        assert_eq!(inspect(&good(), HOST, TOKEN), Ok(Route::Invoke));
        let caps = RequestHead {
            method: "GET",
            path: "/v1/capabilities",
            content_length: 0,
            ..good()
        };
        assert_eq!(inspect(&caps, HOST, TOKEN), Ok(Route::Capabilities));
    }

    // --- the ladder --------------------------------------------------------

    /// Every rejection rung must be indistinguishable on the wire. If this test
    /// ever fails, the port has started leaking which check tripped.
    #[test]
    fn every_rejection_rung_renders_an_identical_403() {
        let rungs: Vec<(&str, RequestHead)> = vec![
            (
                "wrong method",
                RequestHead { method: "GET", ..good() },
            ),
            (
                "unknown path",
                RequestHead { path: "/v1/nope", ..good() },
            ),
            (
                "root path",
                RequestHead { path: "/", ..good() },
            ),
            (
                "origin present",
                RequestHead { origin: Some("https://evil.example"), ..good() },
            ),
            (
                "origin present but null",
                RequestHead { origin: Some("null"), ..good() },
            ),
            (
                "host missing",
                RequestHead { host: None, ..good() },
            ),
            (
                "host rebound to a hostile name",
                RequestHead { host: Some("evil.example:54321"), ..good() },
            ),
            (
                "host right name wrong port",
                RequestHead { host: Some("127.0.0.1:1"), ..good() },
            ),
            (
                "host localhost alias",
                RequestHead { host: Some("localhost:54321"), ..good() },
            ),
            (
                "token missing",
                RequestHead { authorization: None, ..good() },
            ),
            (
                "token without Bearer prefix",
                RequestHead {
                    authorization: Some("11111111-2222-3333-4444-555555555555"),
                    ..good()
                },
            ),
            (
                "token wrong same length",
                RequestHead {
                    authorization: Some("Bearer 11111111-2222-3333-4444-555555555556"),
                    ..good()
                },
            ),
            (
                "token wrong prefix of the real one",
                RequestHead {
                    authorization: Some("Bearer 11111111"),
                    ..good()
                },
            ),
        ];

        let expected = Reject::Forbidden.render();
        assert_eq!(expected.0, 403);
        for (label, head) in rungs {
            let got = inspect(&head, HOST, TOKEN).expect_err(label);
            assert_eq!(got, Reject::Forbidden, "{label} should be forbidden");
            assert_eq!(got.render(), expected, "{label} rendered a different body");
        }
    }

    #[test]
    fn oversize_body_is_413() {
        let head = RequestHead {
            content_length: MAX_BODY + 1,
            ..good()
        };
        let got = inspect(&head, HOST, TOKEN).expect_err("oversize");
        assert_eq!(got, Reject::TooLarge);
        assert_eq!(got.render(), (413, TOO_LARGE_BODY));
    }

    #[test]
    fn body_exactly_at_the_cap_is_allowed() {
        let head = RequestHead {
            content_length: MAX_BODY,
            ..good()
        };
        assert_eq!(inspect(&head, HOST, TOKEN), Ok(Route::Invoke));
    }

    /// An oversize body from an UNAUTHORISED caller must still look like every
    /// other 403 — the size cap must not become an oracle for "token was fine".
    #[test]
    fn oversize_body_with_a_bad_token_is_still_403() {
        let head = RequestHead {
            authorization: Some("Bearer wrong"),
            content_length: MAX_BODY * 4,
            ..good()
        };
        let got = inspect(&head, HOST, TOKEN).expect_err("bad token");
        assert_eq!(got.render(), Reject::Forbidden.render());
    }
}
