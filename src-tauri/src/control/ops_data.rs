// Outbound data fetches: weather, quotes, headlines.
//
// These take no managed Tauri state — they were the first three ops registered
// precisely because that made the transport, the auth ladder and the dispatch
// path provable in isolation. They moved out of registry.rs so that file stays
// a table you can read in one screen.
//
// Each pulls its arguments out of the untyped `args` object leniently: a missing
// or wrong-typed field becomes `None`, and the underlying fetcher applies its
// own documented default. That is safe here only because these are reads — a
// write op must reject a malformed argument instead of guessing at what the
// caller meant.
//
// WEATHER AND NEWS ARE NOT PROJECTED, AND STOCKS NOW IS. The blanket claim that
// used to sit here ("crate::datafetch already returns a small hand-built shape,
// so there is no second trimming to do") was true of a fixed-size answer and
// false of `data.stocks`, whose size the CALLER chooses: `fetch_stocks` returns
// one object per requested symbol, each carrying a 12-point sparkline and six
// price fields the model has no use for. `stocks` below therefore bounds the
// request and projects and caps the answer, like every other list op. Weather
// (one location) and news (one category, fixed page size) still answer with a
// shape the caller cannot inflate.

use serde_json::{json, Value};
use tauri::AppHandle;

use super::ops_project;
use crate::control::Ctx;

pub fn weather(_app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let city = args.get("city").and_then(Value::as_str).map(str::to_string);
    let lat = args.get("lat").and_then(Value::as_f64);
    let lon = args.get("lon").and_then(Value::as_f64);
    crate::datafetch::fetch_weather(city, lat, lon)
}

/// The most symbols one call may ask for.
///
/// The dashboard renders four. 25 is generous for anything a person actually
/// watches, and the bound is what makes this op affordable: `fetch_stocks`
/// issues TWO sequential blocking Finnhub requests per symbol, each carrying the
/// user's API key. Unbounded, one call with 25,000 symbols — which fits inside
/// the 256 KB body cap — became 50,000 outbound requests on one rate-limit
/// token, and since `Op::timeout_ms` is advisory the real ceiling was 20s x 2N
/// per the shared HTTP agent. Four such calls parked all four workers.
const MAX_SYMBOLS: usize = 25;

/// The longest symbol Finnhub's plain-ticker form takes; also the bound
/// `ops_write::as_symbol` applies before one is stored on the watchlist.
const MAX_SYMBOL_LEN: usize = 12;

/// Decide, from untrusted arguments, exactly which symbols will be fetched.
///
/// `None` means "the caller named none", which `fetch_stocks` answers with its
/// own default set. Split out from `stocks` with no I/O so every rule here is
/// covered by a unit test.
fn plan_symbols(args: &Value) -> Result<Option<Vec<String>>, String> {
    let Some(raw) = args.get("symbols") else { return Ok(None) };
    if raw.is_null() {
        return Ok(None);
    }
    let arr = raw
        .as_array()
        .ok_or_else(|| "'symbols' must be an array of ticker symbols".to_string())?;
    if arr.len() > MAX_SYMBOLS {
        // A count, not the list: echoing the rejected symbols back would put
        // the whole attacker-authored payload into the model's context on the
        // error path, which is the thing this op is being bounded to prevent.
        return Err(format!(
            "'symbols' has {} entries; data.stocks fetches at most {MAX_SYMBOLS} at a time",
            arr.len()
        ));
    }

    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        // Shape-checked, not just length-checked, and rejected rather than
        // dropped. Two reasons, either sufficient: with no Finnhub key every
        // symbol falls through to `datafetch::mock_stock`, which ECHOES the
        // caller's string into both `symbol` and `name` — so an unchecked
        // symbol is a way to author the tool result outright; and the symbol is
        // interpolated straight into the Finnhub query string, where a '#' or a
        // '%' silently changes which URL is requested.
        let s = item
            .as_str()
            .ok_or_else(|| "each entry in 'symbols' must be a string".to_string())?
            .trim()
            .to_ascii_uppercase();
        let ok = !s.is_empty()
            && s.len() <= MAX_SYMBOL_LEN
            && s.chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '.' || c == '-');
        if !ok {
            return Err(format!(
                "'{}' is not a ticker symbol (up to {MAX_SYMBOL_LEN} characters: letters, \
                 digits, '.' or '-'), such as AAPL or BRK.B",
                ops_project::snippet(&s)
            ));
        }
        out.push(s);
    }
    Ok(Some(out))
}

/// The fields of a quote that answer a question, and nothing else.
const QUOTE_FIELDS: &[&str] = &["symbol", "name", "price", "change", "changePercent"];
const INDEX_FIELDS: &[&str] = &["label", "price", "changePercent"];

/// Project and cap what `fetch_stocks` returned.
///
/// `sparkline` (12 floats), `open`, `high`, `low`, `prevClose` and `marketCap`
/// are dropped: they exist so the dashboard can draw a tile, and every one of
/// them lands in the model's context for every later turn otherwise.
fn project_quotes(raw: &Value) -> Value {
    let pick_all = |key: &str, fields: &[&str]| -> Vec<Value> {
        raw.get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|row| ops_project::pick(row, fields)).collect())
            .unwrap_or_default()
    };
    json!({
        "stocks": ops_project::capped(pick_all("stocks", QUOTE_FIELDS)),
        "indices": ops_project::capped(pick_all("indices", INDEX_FIELDS)),
    })
}

pub fn stocks(_app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let symbols = plan_symbols(args)?;
    let raw = crate::datafetch::fetch_stocks(symbols)?;
    Ok(project_quotes(&raw))
}

pub fn news(_app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let category = args.get("category").and_then(Value::as_str).map(str::to_string);
    crate::datafetch::fetch_news(category)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The unbounded-fan-out defect, stated as the call that caused it.
    ///
    /// `symbols` went to `fetch_stocks` verbatim, which loops issuing two
    /// sequential blocking Finnhub requests per symbol. 25,000 symbols fit
    /// inside the 256 KB body cap, so one Read-tier call — no audit row, one
    /// rate-limit token — was 50,000 outbound requests carrying the user's API
    /// key, with no time bound because `timeout_ms` is advisory.
    #[test]
    fn a_symbol_list_that_would_fan_out_is_refused() {
        let many: Vec<String> = (0..MAX_SYMBOLS + 1).map(|i| format!("SYM{i}")).collect();
        let err = plan_symbols(&json!({ "symbols": many }))
            .expect_err("one call must not become thousands of outbound requests");
        assert!(err.contains(&MAX_SYMBOLS.to_string()), "{err}");

        // The rejection must not carry the payload it rejected.
        assert!(err.len() < 200, "the refusal is {} bytes long", err.len());

        // Exactly at the cap still works, so the bound is a bound and not an
        // off-by-one that refuses everything.
        let ok: Vec<String> = (0..MAX_SYMBOLS).map(|_| "AAPL".to_string()).collect();
        assert_eq!(
            plan_symbols(&json!({ "symbols": ok })).unwrap().unwrap().len(),
            MAX_SYMBOLS
        );
    }

    /// With no Finnhub key every symbol falls through to `mock_stock`, which
    /// echoes the caller's string into `symbol` AND `name`. 200 symbols of 400
    /// attacker-chosen characters was ~100 KB of attacker-authored text in the
    /// tool result, and therefore in every later turn of the conversation.
    #[test]
    fn a_symbol_cannot_be_a_paragraph_of_attacker_text() {
        for bad in [
            json!(["x".repeat(400)]),
            json!(["Apple Inc."]),
            json!(["AAPL#"]),
            json!(["AAPL&token=x"]),
            json!(["AAPL/../quote"]),
            json!([""]),
            json!(["   "]),
            json!([7]),
            json!("AAPL"),
        ] {
            let out = plan_symbols(&json!({ "symbols": bad }));
            assert!(out.is_err(), "{bad} must be refused, not forwarded");
            assert!(out.unwrap_err().len() < 200, "the refusal must stay short");
        }

        // Real tickers, in the shapes the watchlist stores them, still pass —
        // and are normalised the same way `ops_write::as_symbol` normalises.
        let out = plan_symbols(&json!({ "symbols": [" aapl ", "BRK.B", "RDS-A"] }))
            .unwrap()
            .unwrap();
        assert_eq!(out, vec!["AAPL", "BRK.B", "RDS-A"]);
    }

    #[test]
    fn an_absent_symbol_list_still_means_use_the_defaults() {
        assert!(plan_symbols(&json!({})).unwrap().is_none());
        assert!(plan_symbols(&json!({ "symbols": Value::Null })).unwrap().is_none());
        assert_eq!(plan_symbols(&json!({ "symbols": [] })).unwrap().unwrap().len(), 0);
    }

    /// `ops_data` was the one list-returning module that neither projected nor
    /// capped, so the size of its answer was the caller's to choose.
    #[test]
    fn the_answer_is_projected_and_capped_like_every_other_list() {
        let raw = json!({
            "stocks": [{
                "symbol": "AAPL", "name": "Apple Inc.", "price": 189.84,
                "change": 1.24, "changePercent": 0.66,
                "sparkline": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
                "open": 188.6, "high": 192.1, "low": 188.1, "prevClose": 188.6,
                "marketCap": 2_900_000_000_000i64,
            }],
            "indices": [{ "label": "S&P 500", "price": 6284, "changePercent": 0.6 }],
        });

        let out = project_quotes(&raw);
        let quote = &out["stocks"]["items"][0];
        assert_eq!(quote["symbol"], json!("AAPL"));
        assert_eq!(quote["price"], json!(189.84));
        for decorative in ["sparkline", "open", "high", "low", "prevClose", "marketCap"] {
            assert!(
                quote.get(decorative).is_none(),
                "{decorative} is dashboard chrome and must not reach the model"
            );
        }
        assert_eq!(out["indices"]["items"][0]["label"], json!("S&P 500"));

        // The envelope is the same one every other list op answers with, so the
        // brain reads a partial answer as partial.
        assert_eq!(out["stocks"]["returned"], json!(1));
        assert_eq!(out["stocks"]["truncated"], json!(false));
    }

    /// A projection that exists and is not on the live path is the same defect
    /// wearing a test suite: every assertion above would still pass while the
    /// raw provider document went to the model. `stocks` needs an `AppHandle`
    /// and a network, so this is a source check — the same device mod.rs uses
    /// for the claims a unit test cannot reach.
    #[test]
    fn the_runner_is_the_thing_that_bounds_and_projects() {
        let src = include_str!("ops_data.rs");
        let from = src.find("pub fn stocks(").expect("the runner exists");
        let body = &src[from..];
        let body = &body[..body.find("\n}\n").expect("the runner ends")];
        assert!(
            body.contains("plan_symbols(args)?"),
            "the request bound must be on the live path, not just in a test"
        );
        assert!(
            body.contains("Ok(project_quotes(&raw))"),
            "the runner must answer with the projection, not the provider document"
        );
    }

    #[test]
    fn a_malformed_upstream_answer_projects_to_an_empty_list_not_a_panic() {
        let out = project_quotes(&json!({}));
        assert_eq!(out["stocks"]["returned"], json!(0));
        assert_eq!(out["indices"]["returned"], json!(0));
        let out = project_quotes(&json!({ "stocks": "not a list" }));
        assert_eq!(out["stocks"]["returned"], json!(0));
    }
}
