// Rejseplanen departures for the Beta Answer screen and Home's Transit widget
// (Beta left-out rows 20 and 26).
//
// DORMANT UNTIL THE USER ADDS AN ACCESS ID. Rejseplanen's API (HAFAS ReST at
// https://www.rejseplanen.dk/api/) needs a personal access ID, free for
// private use by request at labs.rejseplanen.dk. The ID lives in the Keychain
// blob (`atlas-core`, account `rejseplanen_access_id`) beside the other
// provider keys, is written only by `transit_set_key`, and never goes back to
// the webview: the requests are made here and the webview gets Rejseplanen's
// own JSON, which src/lib/transit.ts reads.
//
// What leaves the Mac, and only when the screen asks: the stop name being
// searched, the stop id and an optional direction stop, with the access ID,
// to www.rejseplanen.dk. Nothing else.
//
// User input reaches the request only as ureq query parameters (percent-
// encoded by ureq), after `clean` has bounded and checked it — never spliced
// into a URL string.

use serde_json::{json, Value};

use crate::secrets::{clear_core_key, core_key, set_core_key};

const ACCOUNT: &str = "rejseplanen_access_id";
const BASE: &str = "https://www.rejseplanen.dk/api";
const NO_KEY: &str = "Rejseplanen: no access ID yet";

/// THE SAME SECRET-REDACTION BOUNDARY AS datafetch.rs `safe_err`: the access
/// ID is a query parameter, and ureq's Display prints the whole URL. Status
/// code and transport kind only.
fn safe_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("Rejseplanen: provider returned HTTP {code}"),
        ureq::Error::Transport(t) => format!("Rejseplanen: provider unreachable ({:?})", t.kind()),
    }
}

/// Trim, bound and refuse control characters. Rejseplanen's stop ids carry
/// `=`, `@`, spaces and Danish letters, so the check is about size and
/// control bytes, not an allow-list of characters.
fn clean(value: &str, what: &str, max: usize) -> Result<String, String> {
    let v = value.trim();
    if v.is_empty() {
        return Err(format!("Rejseplanen: {what} is empty"));
    }
    if v.chars().count() > max {
        return Err(format!("Rejseplanen: {what} is too long"));
    }
    if v.chars().any(|c| c.is_control()) {
        return Err(format!(
            "Rejseplanen: {what} has characters it cannot carry"
        ));
    }
    Ok(v.to_string())
}

/// An access ID is one printable token. Refusing anything else keeps a pasted
/// sentence (or a newline that would break the Keychain item) out of the store.
fn valid_key(key: &str) -> bool {
    (8..=200).contains(&key.len()) && key.chars().all(|c| c.is_ascii_graphic())
}

fn get(path: &str, params: &[(&str, &str)]) -> Result<Value, String> {
    let key = core_key(ACCOUNT).ok_or_else(|| NO_KEY.to_string())?;
    let mut req = crate::http::agent()
        .get(&format!("{BASE}/{path}"))
        .set("Accept", "application/json")
        .query("accessId", &key)
        .query("format", "json");
    for (k, v) in params {
        req = req.query(k, v);
    }
    req.call()
        .map_err(safe_err)?
        // serde's parse errors describe the payload, never the request.
        .into_json::<Value>()
        .map_err(|e| format!("Rejseplanen: unreadable reply ({e})"))
}

/// Whether an access ID is stored. Never the value.
#[tauri::command(async)]
pub fn transit_status() -> Value {
    json!({ "configured": core_key(ACCOUNT).is_some() })
}

/// Store the access ID in the Keychain; an empty value removes it.
#[tauri::command(async)]
pub fn transit_set_key(key: String) -> Result<(), String> {
    let k = key.trim();
    if k.is_empty() {
        return clear_core_key(ACCOUNT);
    }
    if !valid_key(k) {
        return Err(
            "That does not look like a Rejseplanen access ID: one word, no spaces.".to_string(),
        );
    }
    set_core_key(ACCOUNT, k)
}

/// Stops whose name matches `query` (`location.name`, stops only).
#[tauri::command(async)]
pub fn transit_find_stops(query: String) -> Result<Value, String> {
    let q = clean(&query, "the stop name", 80)?;
    get(
        "location.name",
        &[("input", q.as_str()), ("type", "S"), ("maxNo", "8")],
    )
}

/// The next departures from a stop (`departureBoard`), optionally only those
/// that pass `direction` (another stop's id) — "trains to Lund" includes the
/// ones whose last stop is Malmö.
#[tauri::command(async)]
pub fn transit_departures(stop_id: String, direction: Option<String>) -> Result<Value, String> {
    let id = clean(&stop_id, "the stop", 300)?;
    let dir = match direction
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        Some(d) => Some(clean(d, "the direction", 300)?),
        None => None,
    };
    let mut params: Vec<(&str, &str)> = vec![
        ("id", id.as_str()),
        ("maxJourneys", "12"),
        ("duration", "120"),
    ];
    if let Some(d) = dir.as_deref() {
        params.push(("direction", d));
    }
    get("departureBoard", &params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_bounds_and_refuses_control_characters() {
        assert_eq!(
            clean("  Nørreport St.  ", "x", 80).unwrap(),
            "Nørreport St."
        );
        assert!(clean("", "x", 80).is_err());
        assert!(clean("a\nb", "x", 80).is_err());
        assert!(clean(&"a".repeat(81), "x", 80).is_err());
        assert!(clean(
            "A=1@O=Nørreport St.@X=12571@Y=55683@U=86@L=8600646@",
            "x",
            300
        )
        .is_ok());
    }

    #[test]
    fn access_ids_are_one_printable_token() {
        assert!(valid_key("abcd1234-ef56"));
        assert!(!valid_key("short"));
        assert!(!valid_key("has a space in it"));
        assert!(!valid_key("line\nbreak123"));
    }
}
