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
/// Every provider shares one redirect (`REDIRECT_URI`) and neither Google nor
/// Spotify echoes a provider tag back, so the state is the only thing that says
/// whose callback this is. lib.rs asks the registry and hands the callback to
/// that provider alone. Before this, every handler saw every callback and a
/// Spotify sign-in could consume and fail a Gmail one in flight.
///
/// Entries outlive a replaced flow on purpose: if the user clicks Connect
/// twice and finishes the FIRST browser tab, the registry still knows that
/// state was Spotify's, so Spotify can say "superseded" instead of the callback
/// vanishing and the UI waiting forever.
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
