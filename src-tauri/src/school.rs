// School connectors: the Lectio calendar feed and a Moodle (LearnIT) web-service
// token. These are the only two network paths the School screen has, and both
// run here rather than in the webview for the same two reasons.
//
// 1. CORS. Neither lectio.dk nor a Moodle site answers a webview origin, so a
//    fetch from the page would fail before it reached the server.
// 2. The capability stays out of the JS layer. A Lectio "Abonnér" link is a
//    private link — anyone holding it can read the student's schedule — and a
//    Moodle token reads everything the student can. Both go into the macOS
//    Keychain (the atlas-core blob, see secrets.rs) the moment they are
//    accepted, and nothing here ever returns them: the webview gets the
//    calendar text, the Moodle JSON, and whether a connection exists.
//
// Never the student's school password. Lectio is a link they copy; Moodle is a
// token they create themselves under Preferences → Security keys. Atlas only
// reads: the Moodle functions allowed below are all read-only, and nothing here
// posts, submits or sends.
//
// Every response is capped in size and bounded in time (the shared agent in
// http.rs), and every error is redacted the way datafetch.rs redacts provider
// errors: ureq prints the whole URL, and the URL carries the capability.

use std::collections::HashMap;
use std::io::Read;

use serde_json::{json, Value};

use crate::secrets;

const LECTIO_ACCOUNT: &str = "school_lectio_feed";
const MOODLE_SITE_ACCOUNT: &str = "school_moodle_site";
const MOODLE_TOKEN_ACCOUNT: &str = "school_moodle_token";

/// A year of lessons is a few hundred kilobytes; four megabytes is room to spare.
const ICS_CAP: u64 = 4 * 1024 * 1024;
/// Course contents for a large course run to a few megabytes of JSON.
const MOODLE_CAP: u64 = 8 * 1024 * 1024;
/// A material is read for its text only; past this the rest is cut off.
const FILE_CAP: u64 = 2 * 1024 * 1024;

/// The Moodle functions the School screen reads with. All read-only, and all
/// in the mobile web service a student's own token is issued for.
const MOODLE_FUNCTIONS: &[&str] = &[
    "core_webservice_get_site_info",
    "core_enrol_get_users_courses",
    "mod_assign_get_assignments",
    "core_course_get_contents",
    "core_message_get_conversations",
    "gradereport_user_get_grade_items",
];

/// Status code and transport kind only. ureq's own Display prints the request
/// URL, which for Lectio IS the private link and for a Moodle file carries the
/// token; see `safe_err` in datafetch.rs for the incident behind this.
fn redact(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("http:{code}"),
        ureq::Error::Transport(t) => format!("unreachable:{:?}", t.kind()),
    }
}

/// Reads at most `cap` bytes. Past the cap a calendar or an API answer is an
/// error (half a JSON document is no answer); a material's text is cut off.
fn read_capped(resp: ureq::Response, cap: u64, truncate: bool) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    resp.into_reader()
        .take(cap + 1)
        .read_to_end(&mut buf)
        .map_err(|_| "interrupted".to_string())?;
    if buf.len() as u64 > cap {
        if !truncate {
            return Err("too-large".to_string());
        }
        buf.truncate(cap as usize);
    }
    Ok(buf)
}

/// Bytes to text by the declared charset. Older Danish servers still answer in
/// Latin-1; anything that is not valid UTF-8 is read that way rather than
/// turning every æ, ø and å into a replacement character.
fn decode_text(bytes: &[u8], charset: Option<&str>) -> String {
    let latin = charset
        .map(|c| {
            let c = c.to_ascii_lowercase();
            c.contains("8859-1") || c.contains("latin1") || c.contains("1252")
        })
        .unwrap_or(false);
    if !latin {
        if let Ok(s) = std::str::from_utf8(bytes) {
            return s.to_string();
        }
    }
    bytes.iter().map(|&b| b as char).collect()
}

fn charset_of(resp: &ureq::Response) -> Option<String> {
    resp.header("content-type").and_then(|ct| {
        ct.split(';').map(str::trim).find_map(|p| {
            p.strip_prefix("charset=")
                .map(|c| c.trim_matches('"').to_string())
        })
    })
}

// ── Lectio ────────────────────────────────────────────────────────────────────

/// The link from Lectio → Skema → Abonnér, as an https URL on lectio.dk.
///
/// Calendar apps hand out `webcal://`; it is plain https underneath. The host
/// must be Lectio's own, so the stored link can never point this fetch at
/// another server (or at something on the student's own network).
pub(crate) fn normalise_lectio_link(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("Paste the link from Lectio first.".to_string());
    }
    if t.len() > 2048 {
        return Err("That is too long to be a Lectio link.".to_string());
    }
    let lower = t.to_ascii_lowercase();
    let https = if let Some(rest) = ["webcals://", "webcal://", "https://", "http://"]
        .iter()
        .find_map(|p| lower.starts_with(p).then(|| &t[p.len()..]))
    {
        format!("https://{rest}")
    } else {
        return Err(
            "That isn't a link. It starts with webcal:// or https:// in Lectio.".to_string(),
        );
    };
    let url = url::Url::parse(&https).map_err(|_| {
        "That link can't be read. Copy it again from Lectio → Skema → Abonnér.".to_string()
    })?;
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return Err("That isn't a Lectio calendar link.".to_string());
    }
    if !is_lectio_host(url.as_str()) {
        return Err("That isn't a Lectio link. It should be on lectio.dk.".to_string());
    }
    Ok(url.to_string())
}

/// True for an https address on lectio.dk or one of its subdomains.
fn is_lectio_host(address: &str) -> bool {
    match url::Url::parse(address) {
        Ok(u) => {
            let host = u.host_str().unwrap_or("").to_ascii_lowercase();
            u.scheme() == "https" && (host == "lectio.dk" || host.ends_with(".lectio.dk"))
        }
        Err(_) => false,
    }
}

fn fetch_ics(url: &str) -> Result<String, String> {
    let resp = crate::http::agent()
        .get(url)
        .set("Accept", "text/calendar, text/plain;q=0.5")
        .call()
        .map_err(redact)?;
    // The agent follows redirects; the calendar must still come from Lectio,
    // so a link that bounces elsewhere is read as no calendar at all.
    if !is_lectio_host(resp.get_url()) {
        return Err("not-a-calendar".to_string());
    }
    let charset = charset_of(&resp);
    let bytes = read_capped(resp, ICS_CAP, false)?;
    let text = decode_text(&bytes, charset.as_deref());
    // A link Lectio no longer knows answers with its login page, not an error.
    let head = text.trim_start_matches('\u{feff}').trim_start();
    if !head
        .get(..15)
        .unwrap_or("")
        .eq_ignore_ascii_case("BEGIN:VCALENDAR")
    {
        return Err("not-a-calendar".to_string());
    }
    Ok(text)
}

/// Which school connections exist. Never the link, the site's token or anything
/// derived from them; the Moodle site's address is not a secret and is shown.
#[tauri::command(async)]
pub fn school_connections() -> Value {
    let site = secrets::core_key(MOODLE_SITE_ACCOUNT);
    let token = secrets::core_key(MOODLE_TOKEN_ACCOUNT).is_some();
    json!({
        "lectio": secrets::core_key(LECTIO_ACCOUNT).is_some(),
        "moodle": { "connected": token && site.is_some(), "site": site },
    })
}

/// Checks the link by fetching it once — a calendar must come back — and only
/// then keeps it. Returns the calendar so the screen fills at once.
#[tauri::command(async)]
pub fn school_lectio_connect(link: String) -> Result<String, String> {
    let url = normalise_lectio_link(&link)?;
    let ics = fetch_ics(&url)?;
    secrets::set_core_key(LECTIO_ACCOUNT, &url)?;
    Ok(ics)
}

#[tauri::command(async)]
pub fn school_lectio_fetch() -> Result<String, String> {
    let url = secrets::core_key(LECTIO_ACCOUNT).ok_or_else(|| "not-connected".to_string())?;
    fetch_ics(&url)
}

#[tauri::command(async)]
pub fn school_lectio_disconnect() -> Result<(), String> {
    secrets::clear_core_key(LECTIO_ACCOUNT)
}

// ── Moodle (LearnIT) ──────────────────────────────────────────────────────────

/// The site's base address: https only (a token over plain http is a token
/// given away), no credentials, query or fragment. A Moodle can live under a
/// path (`https://school.dk/moodle`), so the path is kept.
pub(crate) fn validate_moodle_site(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    let with_scheme = if t.contains("://") {
        t.to_string()
    } else {
        format!("https://{t}")
    };
    let url = url::Url::parse(&with_scheme).map_err(|_| "That isn't a web address.".to_string())?;
    if url.scheme() != "https" {
        return Err("The site must use https.".to_string());
    }
    if url.host_str().unwrap_or("").is_empty()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Give just the site's address, like https://learnit.itu.dk.".to_string());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

/// Moodle tokens are 32 hexadecimal characters; anything alphanumeric of a
/// sane length is let through, anything else (a password, a pasted sentence)
/// is refused before it leaves the Mac.
pub(crate) fn validate_token(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.len() < 16 || t.len() > 128 || !t.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(
            "That doesn't look like a Moodle security key. Copy the key itself, not your password."
                .to_string(),
        );
    }
    Ok(t.to_string())
}

/// Form keys like `courseid`, `courseids[0]` or `options[0][name]`; values short
/// and plain. The webview chooses the parameters, so they are checked here.
pub(crate) fn param_ok(key: &str, value: &str) -> bool {
    let key_ok = !key.is_empty()
        && key.len() <= 48
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '[' | ']'))
        && key.chars().next().is_some_and(|c| c.is_ascii_lowercase());
    let value_ok = value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'));
    key_ok && value_ok && !matches!(key, "wstoken" | "wsfunction" | "moodlewsrestformat")
}

fn moodle_credentials() -> Result<(String, String), String> {
    let site = secrets::core_key(MOODLE_SITE_ACCOUNT).ok_or_else(|| "not-connected".to_string())?;
    let token =
        secrets::core_key(MOODLE_TOKEN_ACCOUNT).ok_or_else(|| "not-connected".to_string())?;
    Ok((site, token))
}

/// One web-service call. The token travels in the POST body, not the URL.
/// Moodle reports its own errors as HTTP 200 with an `exception` object; those
/// come back as `moodle:<errorcode>:<message>`, with the token scrubbed from
/// the message in case a site ever echoes it.
fn moodle_call(
    site: &str,
    token: &str,
    function: &str,
    params: &[(String, String)],
) -> Result<Value, String> {
    if !MOODLE_FUNCTIONS.contains(&function) {
        return Err(format!("not-allowed:{function}"));
    }
    let endpoint = format!("{site}/webservice/rest/server.php");
    let mut form: Vec<(&str, &str)> = vec![
        ("wstoken", token),
        ("wsfunction", function),
        ("moodlewsrestformat", "json"),
    ];
    for (k, v) in params {
        if !param_ok(k, v) {
            return Err(format!("bad-param:{k}"));
        }
        form.push((k.as_str(), v.as_str()));
    }
    let resp = crate::http::agent()
        .post(&endpoint)
        .send_form(&form)
        .map_err(redact)?;
    let bytes = read_capped(resp, MOODLE_CAP, false)?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| "not-moodle".to_string())?;
    if let Some(obj) = value.as_object() {
        if obj.contains_key("exception") {
            let code: String = obj
                .get("errorcode")
                .and_then(Value::as_str)
                .unwrap_or("error")
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
                .take(64)
                .collect();
            let message: String = obj
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("")
                .replace(token, "…")
                .chars()
                .take(240)
                .collect();
            return Err(format!("moodle:{code}:{message}"));
        }
    }
    Ok(value)
}

/// What the screen keeps of the site info: who, where, and which functions the
/// token's service allows (so a view can say "this site doesn't share grades"
/// rather than fail).
fn site_summary(info: &Value) -> Value {
    let functions: Vec<&str> = info["functions"]
        .as_array()
        .map(|a| a.iter().filter_map(|f| f["name"].as_str()).collect())
        .unwrap_or_default();
    json!({
        "sitename": info["sitename"],
        "fullname": info["fullname"],
        "userid": info["userid"],
        "release": info["release"],
        "functions": functions,
    })
}

/// Checks the token against the site before keeping either. A site that
/// issues no tokens to students answers with an error here, and the screen
/// says so; the student's Moodle password is never asked for.
#[tauri::command(async)]
pub fn school_moodle_connect(site: String, token: String) -> Result<Value, String> {
    let site = validate_moodle_site(&site)?;
    let token = validate_token(&token)?;
    let info = moodle_call(&site, &token, "core_webservice_get_site_info", &[])?;
    if info["userid"].as_i64().is_none() {
        return Err("not-moodle".to_string());
    }
    secrets::set_core_key(MOODLE_SITE_ACCOUNT, &site)?;
    secrets::set_core_key(MOODLE_TOKEN_ACCOUNT, &token)?;
    Ok(site_summary(&info))
}

/// A read-only call with the stored token. The site info comes back trimmed
/// to `site_summary`, the rest as Moodle sent it.
#[tauri::command(async)]
pub fn school_moodle_call(
    function: String,
    params: Option<HashMap<String, String>>,
) -> Result<Value, String> {
    let (site, token) = moodle_credentials()?;
    let mut pairs: Vec<(String, String)> = params.unwrap_or_default().into_iter().collect();
    pairs.sort();
    let value = moodle_call(&site, &token, &function, &pairs)?;
    Ok(if function == "core_webservice_get_site_info" {
        site_summary(&value)
    } else {
        value
    })
}

/// The text of one material, for cards. Only files on the connected site's own
/// `pluginfile.php`, fetched through the web-service file endpoint (the one a
/// token opens), and only when the site serves text — a PDF or an image comes
/// back as `not-text`, and the screen says Atlas can't read it.
#[tauri::command(async)]
pub fn school_moodle_file(url: String) -> Result<Value, String> {
    let (site, token) = moodle_credentials()?;
    let site_url = url::Url::parse(&site).map_err(|_| "not-connected".to_string())?;
    let mut file = url::Url::parse(url.trim()).map_err(|_| "not-on-site".to_string())?;
    if file.scheme() != "https"
        || file.host_str() != site_url.host_str()
        || file.port_or_known_default() != site_url.port_or_known_default()
    {
        return Err("not-on-site".to_string());
    }
    let path = file.path().to_string();
    if !path.contains("/pluginfile.php/") {
        return Err("not-a-file".to_string());
    }
    if !path.contains("/webservice/pluginfile.php/") {
        file.set_path(&path.replacen("/pluginfile.php/", "/webservice/pluginfile.php/", 1));
    }
    // `forcedownload=1` (which course contents put on every file URL) makes
    // Moodle answer with a download type instead of the file's own, and a text
    // file would then be refused below as not text.
    let kept: Vec<(String, String)> = file
        .query_pairs()
        .filter(|(k, _)| k != "token" && k != "forcedownload")
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    {
        let mut q = file.query_pairs_mut();
        q.clear();
        for (k, v) in &kept {
            q.append_pair(k, v);
        }
        q.append_pair("token", &token);
    }
    let resp = crate::http::agent()
        .get(file.as_str())
        .call()
        .map_err(redact)?;
    let mime = resp.content_type().to_ascii_lowercase();
    let readable = mime.starts_with("text/") || mime == "application/xhtml+xml";
    if !readable {
        return Err(format!("not-text:{mime}"));
    }
    let charset = charset_of(&resp);
    let bytes = read_capped(resp, FILE_CAP, true)?;
    Ok(json!({ "mime": mime, "text": decode_text(&bytes, charset.as_deref()) }))
}

#[tauri::command(async)]
pub fn school_moodle_disconnect() -> Result<(), String> {
    secrets::clear_core_key(MOODLE_TOKEN_ACCOUNT)?;
    secrets::clear_core_key(MOODLE_SITE_ACCOUNT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lectio_links_become_https_on_lectio_only() {
        assert_eq!(
            normalise_lectio_link(" webcal://www.lectio.dk/lectio/123/ical.aspx?id=9 ").unwrap(),
            "https://www.lectio.dk/lectio/123/ical.aspx?id=9"
        );
        assert_eq!(
            normalise_lectio_link("HTTP://lectio.dk/x").unwrap(),
            "https://lectio.dk/x"
        );
        assert!(normalise_lectio_link("https://evil.example/lectio.dk").is_err());
        assert!(normalise_lectio_link("https://lectio.dk.evil.example/x").is_err());
        assert!(normalise_lectio_link("https://user:pw@www.lectio.dk/x").is_err());
        assert!(normalise_lectio_link("https://www.lectio.dk:8443/x").is_err());
        assert!(normalise_lectio_link("ftp://www.lectio.dk/x").is_err());
        assert!(normalise_lectio_link("").is_err());
    }

    #[test]
    fn a_redirect_off_lectio_is_not_lectio() {
        assert!(is_lectio_host("https://www.lectio.dk/lectio/1/ical.aspx"));
        assert!(!is_lectio_host("http://www.lectio.dk/x"));
        assert!(!is_lectio_host("https://login.example.com/lectio.dk"));
        assert!(!is_lectio_host("not a url"));
    }

    #[test]
    fn moodle_sites_are_https_addresses_without_extras() {
        assert_eq!(
            validate_moodle_site("https://learnit.itu.dk/").unwrap(),
            "https://learnit.itu.dk"
        );
        assert_eq!(
            validate_moodle_site("learnit.itu.dk").unwrap(),
            "https://learnit.itu.dk"
        );
        assert_eq!(
            validate_moodle_site("https://school.dk/moodle/").unwrap(),
            "https://school.dk/moodle"
        );
        assert!(validate_moodle_site("http://learnit.itu.dk").is_err());
        assert!(validate_moodle_site("https://learnit.itu.dk/?x=1").is_err());
        assert!(validate_moodle_site("https://me:pw@learnit.itu.dk").is_err());
    }

    #[test]
    fn tokens_are_keys_not_passwords() {
        assert!(validate_token("0123456789abcdef0123456789abcdef").is_ok());
        assert!(validate_token("hunter2").is_err());
        assert!(validate_token("my password is long enough").is_err());
    }

    #[test]
    fn params_are_plain_and_cannot_override_the_call() {
        assert!(param_ok("courseid", "42"));
        assert!(param_ok("courseids[0]", "42"));
        assert!(param_ok("options[0][name]", "excludecontents"));
        assert!(!param_ok("wstoken", "abc"));
        assert!(!param_ok("wsfunction", "core_user_update_users"));
        assert!(!param_ok("courseid", "1&wsfunction=x"));
        assert!(!param_ok("CourseId", "1"));
    }

    #[test]
    fn only_read_functions_are_called() {
        let err =
            moodle_call("https://127.0.0.1:1", "x", "core_user_update_users", &[]).unwrap_err();
        assert!(err.starts_with("not-allowed"));
    }

    #[test]
    fn latin1_is_read_as_latin1() {
        assert_eq!(
            decode_text(
                &[0x53, 0x6b, 0x65, 0x6d, 0x61, 0x20, 0xe6, 0xf8, 0xe5],
                None
            ),
            "Skema æøå"
        );
        assert_eq!(decode_text("æøå".as_bytes(), Some("utf-8")), "æøå");
        assert_eq!(decode_text(&[0xe6], Some("ISO-8859-1")), "æ");
    }
}
