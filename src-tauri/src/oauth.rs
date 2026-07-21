// Provider-agnostic OAuth plumbing for native (desktop) OAuth flows.
//
// Atlas is a *public* OAuth client (a shipped binary can't hold a secret), so
// per RFC 8252 ("OAuth 2.0 for Native Apps") it uses Authorization Code + PKCE
// and captures the redirect through an OS **deep link** instead of a loopback
// server — the code is delivered straight back into this process.
//
// The redirect target is a single seam (`REDIRECT_URI`). Today it's the custom
// scheme `atlas://…`, which works on any build (signed or not). When Atlas gains
// an Apple Developer Team ID + notarization, flipping to the branded universal
// link `https://atlas.innovo-studio.com/…` is a one-line change here plus hosting
// the AASA file (see docs/decisions/007-oauth-deep-link.md) — the flow itself
// (PKCE → deep-link capture → token exchange) is unchanged. Spotify/librespot is
// the first consumer; the module is deliberately provider-neutral.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};

/// Custom-scheme redirect used now (works unsigned, in dev and prod).
/// Consumed by the per-provider flow (music.rs) once it lands.
#[allow(dead_code)]
pub const REDIRECT_URI: &str = "atlas://oauth/callback";
/// Branded universal-link variant, pre-staged. Becomes usable once the app is
/// signed with a Team ID and the AASA file is served from the apex. Flip
/// `REDIRECT_URI` to this to activate — nothing else in the flow changes.
#[allow(dead_code)]
pub const REDIRECT_URI_UNIVERSAL: &str = "https://atlas.innovo-studio.com/oauth/callback";

/// The custom scheme Atlas registers with the OS (mirrors tauri.conf.json).
pub const SCHEME: &str = "atlas";

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
/// universal link (`https://atlas.innovo-studio.com/oauth/callback?…`) once it's
/// live. Returns `None` for anything that isn't one of our OAuth callbacks, so
/// unrelated deep links are ignored rather than mis-handled.
pub fn parse_callback(raw: &str) -> Option<OauthCallback> {
    let url = url::Url::parse(raw).ok()?;

    let is_ours = match url.scheme() {
        SCHEME => true,
        "https" => url.host_str() == Some("atlas.innovo-studio.com"),
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

    // A callback with neither a code nor an error isn't actionable.
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

#[cfg(test)]
mod tests {
    use super::*;

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
