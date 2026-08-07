// Outbound data fetches: weather, quotes, headlines.
//
// These take no managed Tauri state — they were the first three ops registered
// precisely because that made the transport, the auth ladder and the dispatch
// path provable in isolation. They are unchanged; they moved out of registry.rs
// so that file stays a table you can read in one screen.
//
// Each pulls its arguments out of the untyped `args` object leniently: a missing
// or wrong-typed field becomes `None`, and the underlying fetcher applies its
// own documented default. That is safe here only because these are reads — a
// write op must reject a malformed argument instead of guessing at what the
// caller meant.
//
// Nothing is projected. Unlike the provider documents the music ops receive,
// crate::datafetch already returns a small hand-built shape (it exists to boil
// three third-party APIs down to what the dashboard renders), so there is no
// second trimming to do.

use serde_json::Value;
use tauri::AppHandle;

use crate::control::Ctx;

pub fn weather(_app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let city = args.get("city").and_then(Value::as_str).map(str::to_string);
    let lat = args.get("lat").and_then(Value::as_f64);
    let lon = args.get("lon").and_then(Value::as_f64);
    crate::datafetch::fetch_weather(city, lat, lon)
}

pub fn stocks(_app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let symbols = args.get("symbols").and_then(Value::as_array).map(|arr| {
        arr.iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<String>>()
    });
    crate::datafetch::fetch_stocks(symbols)
}

pub fn news(_app: &AppHandle, args: &Value, _ctx: &Ctx) -> Result<Value, String> {
    let category = args.get("category").and_then(Value::as_str).map(str::to_string);
    crate::datafetch::fetch_news(category)
}
