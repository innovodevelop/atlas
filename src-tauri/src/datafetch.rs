// Local data-fetch (Supabase-removal, Phase 5). Ports the get-weather /
// get-stocks / get-news edge functions to on-device Tauri commands: call the
// external API with `ureq`, keys from the Keychain (`atlas-core`), and fall back
// to the same mock data the edge functions used when a key is absent — so the
// dashboard behaves identically until real keys are in place. No auth hop, no
// cloud: the frontend shim routes functions.invoke('get-weather'|…) here.

use chrono::{Timelike, Utc};
use serde_json::{json, Value};

use crate::secrets::core_key;

/// Turn a ureq failure into a message that CANNOT contain the request URL.
///
/// THIS IS A SECRET-REDACTION BOUNDARY, NOT TIDINESS. Every provider in this
/// file authenticates by query parameter — OpenWeather `appid=`, Finnhub
/// `token=`, NewsAPI `apiKey=` — so the API key is part of the URL. And ureq's
/// `Display` prints that URL: `Error::Status` writes `response.get_url()` and
/// `Transport` writes `self.url` (ureq-2.12.1 src/error.rs:210-232). So the
/// obvious `.map_err(|e| e.to_string())` converts any 401, rate-limit or
/// timeout directly into a string containing a live credential.
///
/// That string does not stay local. `fetch_weather`/`fetch_stocks`/`fetch_news`
/// return it to the webview, and the control port now hands it to the AI brain
/// as `op_failed` — whose contract is to forward the op's own message verbatim
/// — which puts the key in a model's context, where it can be echoed to the
/// user, written into a note, or sent to the inference provider.
///
/// So: status code and transport kind only. Both are what you actually need to
/// debug a provider outage; neither can carry the secret.
fn safe_err(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("provider returned HTTP {code}"),
        ureq::Error::Transport(t) => format!("provider unreachable ({:?})", t.kind()),
    }
}

fn get_json(url: &str) -> Result<Value, String> {
    crate::http::agent()
        .get(url)
        .call()
        .map_err(safe_err)?
        // serde's parse errors describe the payload, never the request, so this
        // one is safe to surface as-is.
        .into_json::<Value>()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Weather (OpenWeatherMap)
// ---------------------------------------------------------------------------
fn map_icon(icon: &str) -> &'static str {
    if icon.contains("01") { "sunny" }
    else if icon.contains("02") || icon.contains("03") { "partly-cloudy" }
    else if icon.contains("04") { "cloudy" }
    else if icon.contains("09") || icon.contains("10") { "rainy" }
    else if icon.contains("11") { "stormy" }
    else if icon.contains("13") { "snowy" }
    else { "cloudy" }
}

// Format a UTC unix timestamp shifted by the location's tz offset → "6:42 AM".
fn fmt_time(ts: i64, tz_offset: i64) -> String {
    let dt = chrono::DateTime::from_timestamp(ts + tz_offset, 0).unwrap_or_default();
    let (h24, m) = (dt.hour(), dt.minute());
    let ampm = if h24 < 12 { "AM" } else { "PM" };
    let h12 = if h24 % 12 == 0 { 12 } else { h24 % 12 };
    format!("{h12}:{m:02} {ampm}")
}

fn mock_weather(city: &str) -> Value {
    json!({
        "location": city, "temp": 68, "condition": "Partly Cloudy", "humidity": 65,
        "windSpeed": 12, "icon": "partly-cloudy", "sunrise": "6:42 AM", "sunset": "5:24 PM",
        "hourly": [
            {"time":"Now","temp":68,"icon":"partly-cloudy"},{"time":"12PM","temp":71,"icon":"sunny"},
            {"time":"3PM","temp":72,"icon":"sunny"},{"time":"6PM","temp":69,"icon":"partly-cloudy"},
            {"time":"9PM","temp":64,"icon":"cloudy"}
        ],
        "daily": [
            {"day":"Today","high":72,"low":58,"icon":"partly-cloudy"},{"day":"Tue","high":70,"low":57,"icon":"sunny"},
            {"day":"Wed","high":68,"low":56,"icon":"cloudy"},{"day":"Thu","high":66,"low":55,"icon":"rainy"},
            {"day":"Fri","high":69,"low":56,"icon":"partly-cloudy"},{"day":"Sat","high":71,"low":58,"icon":"sunny"},
            {"day":"Sun","high":73,"low":59,"icon":"sunny"}
        ],
        "high": 72, "low": 58, "air": null
    })
}

/// One forecast slice for the hour strip. Beyond the temperature and icon the
/// strip always had, it carries what the 3-hour forecast says about that slice
/// itself: the chance of precipitation (`pop`, 0–1 from OpenWeather, sent as a
/// whole percentage), the rain expected in those three hours (`rain.3h`, mm —
/// absent from the payload when none is forecast, so 0), how warm it will feel
/// and the wind. No field is invented: each is read from the slice or omitted.
fn slice_json(label: String, item: &Value) -> Value {
    let round = |v: &Value| v.as_f64().unwrap_or(0.0).round() as i64;
    json!({
        "time": label,
        "temp": round(&item["main"]["temp"]),
        "icon": map_icon(item["weather"][0]["icon"].as_str().unwrap_or("")),
        "pop": item["pop"].as_f64().map(|p| (p.clamp(0.0, 1.0) * 100.0).round() as i64),
        "rain": item["rain"]["3h"].as_f64().map(|mm| (mm * 10.0).round() / 10.0).unwrap_or(0.0),
        "feelsLike": item["main"]["feels_like"].as_f64().map(|v| v.round() as i64),
        "wind": item["wind"]["speed"].as_f64().map(|v| v.round() as i64),
    })
}

/// The air-pollution reading: OpenWeather's 1–5 index and the four pollutants
/// the Weather screen draws, all µg/m³. A pollutant the station does not
/// report stays null rather than becoming a reassuring zero.
fn air_json(item: &Value) -> Value {
    let c = &item["components"];
    json!({
        "aqi": item["main"]["aqi"].as_i64().unwrap_or(0),
        "pm25": c["pm2_5"].as_f64().unwrap_or(0.0),
        "pm10": c["pm10"].as_f64(),
        "o3": c["o3"].as_f64(),
        "no2": c["no2"].as_f64(),
    })
}

#[tauri::command(async)]
pub fn fetch_weather(city: Option<String>, lat: Option<f64>, lon: Option<f64>) -> Result<Value, String> {
    let city = city.unwrap_or_else(|| "San Francisco".to_string());
    let Some(api) = core_key("openweather_api_key") else { return Ok(mock_weather(&city)) };

    let base = "https://api.openweathermap.org/data/2.5";
    // ureq's .query() percent-encodes the city (which may contain spaces/commas).
    let data = match (lat, lon) {
        (Some(la), Some(lo)) => get_json(&format!("{base}/weather?appid={api}&units=imperial&lat={la}&lon={lo}"))?,
        _ => crate::http::agent()
            .get(&format!("{base}/weather"))
            .query("appid", &api)
            .query("units", "imperial")
            .query("q", &city)
            .call()
            // safe_err, not e.to_string(): `appid` is on this request too, and
            // ureq would print the whole URL. See safe_err's comment.
            .map_err(safe_err)?
            .into_json::<Value>()
            .map_err(|e| e.to_string())?,
    };

    let round = |v: &Value| v.as_f64().unwrap_or(0.0).round() as i64;
    let tz = data["timezone"].as_i64().unwrap_or(0);
    let clat = data["coord"]["lat"].as_f64().unwrap_or(0.0);
    let clon = data["coord"]["lon"].as_f64().unwrap_or(0.0);
    let cur_icon = data["weather"][0]["icon"].as_str().unwrap_or("");

    let mut today_high = round(&data["main"]["temp_max"]);
    let mut today_low = round(&data["main"]["temp_min"]);
    let mut hourly = vec![json!({"time":"Now","temp":round(&data["main"]["temp"]),"icon":map_icon(cur_icon)})];
    let mut daily: Vec<Value> = vec![];

    // 5-day/3-hour forecast → hourly (first 5 slices) + per-day high/low + midday icon.
    let fc_url = format!("{base}/forecast?appid={api}&units=imperial&lat={clat}&lon={clon}");
    if let Ok(fc) = get_json(&fc_url) {
        if let Some(list) = fc["list"].as_array() {
            hourly = list.iter().take(5).enumerate().map(|(idx, item)| {
                let t = item["dt"].as_i64().unwrap_or(0);
                let dt = chrono::DateTime::from_timestamp(t + tz, 0).unwrap_or_default();
                let h24 = dt.hour();
                let label = if idx == 0 { "Now".to_string() }
                    else { let ap = if h24 < 12 {"AM"} else {"PM"}; let h = if h24 % 12 == 0 {12} else {h24 % 12}; format!("{h}{ap}") };
                slice_json(label, item)
            }).collect();

            // Aggregate by day.
            use std::collections::BTreeMap;
            let mut by_day: BTreeMap<String, (f64, f64, String, i64)> = BTreeMap::new();
            for item in list {
                let t = item["dt"].as_i64().unwrap_or(0);
                let dt = chrono::DateTime::from_timestamp(t, 0).unwrap_or_default();
                let key = dt.format("%Y-%m-%d").to_string();
                let hour = dt.hour() as i64;
                let hi = item["main"]["temp_max"].as_f64().unwrap_or(0.0);
                let lo = item["main"]["temp_min"].as_f64().unwrap_or(0.0);
                let ic = map_icon(item["weather"][0]["icon"].as_str().unwrap_or("")).to_string();
                by_day.entry(key)
                    .and_modify(|e| {
                        e.0 = e.0.max(hi); e.1 = e.1.min(lo);
                        if (hour - 12).abs() < (e.3 - 12).abs() { e.2 = ic.clone(); e.3 = hour; }
                    })
                    .or_insert((hi, lo, ic, hour));
            }
            let today_key = Utc::now().format("%Y-%m-%d").to_string();
            if let Some(t) = by_day.get(&today_key) { today_high = t.0.round() as i64; today_low = t.1.round() as i64; }
            daily = by_day.iter().take(7).enumerate().map(|(idx, (key, v))| {
                let day = if idx == 0 { "Today".to_string() }
                    else { chrono::NaiveDate::parse_from_str(key, "%Y-%m-%d").map(|d| d.format("%a").to_string()).unwrap_or_default() };
                json!({"day":day,"high":v.0.round() as i64,"low":v.1.round() as i64,"icon":v.2})
            }).collect();
        }
    }

    // Air quality (same key, free endpoint).
    let mut air = Value::Null;
    let air_url = format!("{base}/air_pollution?appid={api}&lat={clat}&lon={clon}");
    if let Ok(a) = get_json(&air_url) {
        if let Some(item) = a["list"].get(0) {
            air = air_json(item);
        }
    }

    Ok(json!({
        "location": data["name"].as_str().unwrap_or(&city),
        "temp": round(&data["main"]["temp"]),
        "condition": data["weather"][0]["main"].as_str().unwrap_or("Clear"),
        "humidity": data["main"]["humidity"].as_i64().unwrap_or(0),
        "windSpeed": round(&data["wind"]["speed"]),
        // Additive (Beta row 4): what the reading itself carries beyond the
        // headline. Absent from `mock_weather` on purpose, so the sample never
        // shows a "feels like" or a gust that nobody measured.
        "feelsLike": data["main"]["feels_like"].as_f64().map(|v| v.round() as i64),
        "windDeg": data["wind"]["deg"].as_i64(),
        "windGust": data["wind"]["gust"].as_f64().map(|v| v.round() as i64),
        "icon": map_icon(cur_icon),
        "sunrise": fmt_time(data["sys"]["sunrise"].as_i64().unwrap_or(0), tz),
        "sunset": fmt_time(data["sys"]["sunset"].as_i64().unwrap_or(0), tz),
        "hourly": hourly, "daily": daily, "high": today_high, "low": today_low, "air": air
    }))
}

// ---------------------------------------------------------------------------
// Stocks (Finnhub)
// ---------------------------------------------------------------------------
// Deterministic decorative sparkline (the edge fn used Math.random; the data is
// synthetic either way, so a stable wiggle is fine).
fn sparkline(positive: bool) -> Vec<f64> {
    let trend = if positive { 1.0 } else { -1.0 };
    (0..12).map(|i| (60.0 + ((i as f64) * 1.3).sin() * 8.0 + trend * (i as f64) * 2.0).clamp(10.0, 100.0)).collect()
}

fn mock_stock(symbol: &str) -> Value {
    let known: &[(&str, &str, f64, f64, f64)] = &[
        ("AAPL", "Apple Inc.", 189.84, 1.24, 0.66), ("GOOGL", "Alphabet Inc.", 141.16, -0.89, -0.63),
        ("MSFT", "Microsoft", 378.91, 4.12, 1.10), ("NVDA", "NVIDIA", 495.22, 12.55, 2.60),
        ("AMZN", "Amazon", 178.25, 2.15, 1.22), ("META", "Meta Platforms", 505.35, -3.21, -0.63),
        ("TSLA", "Tesla", 248.50, 5.67, 2.33),
    ];
    let (name, price, change, cp) = known.iter().find(|s| s.0 == symbol)
        .map(|s| (s.1.to_string(), s.2, s.3, s.4))
        .unwrap_or((symbol.to_string(), 100.0, 0.0, 0.0));
    json!({
        "symbol": symbol, "name": name, "price": price, "change": change, "changePercent": cp,
        "sparkline": sparkline(change >= 0.0),
        "open": (price - change), "high": (price * 1.012), "low": (price * 0.991),
        "prevClose": (price - change), "marketCap": Value::Null
    })
}

#[tauri::command(async)]
pub fn fetch_stocks(symbols: Option<Vec<String>>) -> Result<Value, String> {
    let symbols = symbols.unwrap_or_else(|| ["AAPL", "GOOGL", "MSFT", "NVDA"].iter().map(|s| s.to_string()).collect());
    let Some(api) = core_key("finnhub_api_key") else {
        let stocks: Vec<Value> = symbols.iter().map(|s| mock_stock(s)).collect();
        return Ok(json!({"stocks": stocks, "indices": mock_indices()}));
    };

    let round2 = |v: f64| (v * 100.0).round() / 100.0;
    let stocks: Vec<Value> = symbols.iter().map(|symbol| {
        let quote = get_json(&format!("https://finnhub.io/api/v1/quote?symbol={symbol}&token={api}"));
        let profile = get_json(&format!("https://finnhub.io/api/v1/stock/profile2?symbol={symbol}&token={api}"));
        match quote {
            Ok(q) if q["c"].as_f64().unwrap_or(0.0) > 0.0 => {
                let c = q["c"].as_f64().unwrap_or(0.0);
                let pc = q["pc"].as_f64().unwrap_or(c);
                let change = c - pc;
                let cp = if pc != 0.0 { (c - pc) / pc * 100.0 } else { 0.0 };
                let name = profile.as_ref().ok().and_then(|p| p["name"].as_str()).unwrap_or(symbol).to_string();
                let mktcap = profile.as_ref().ok().and_then(|p| p["marketCapitalization"].as_f64()).map(|m| json!(m * 1e6)).unwrap_or(Value::Null);
                json!({
                    "symbol": symbol, "name": name, "price": c, "change": round2(change), "changePercent": round2(cp),
                    "sparkline": sparkline(change >= 0.0),
                    "open": q["o"].clone(), "high": q["h"].clone(), "low": q["l"].clone(), "prevClose": q["pc"].clone(),
                    "marketCap": mktcap
                })
            }
            _ => mock_stock(symbol),
        }
    }).collect();

    // Indices via liquid ETF proxies.
    let index_map = [("SPY", "S&P 500"), ("QQQ", "Nasdaq"), ("DIA", "Dow")];
    let indices: Vec<Value> = index_map.iter().map(|(etf, label)| {
        if let Ok(q) = get_json(&format!("https://finnhub.io/api/v1/quote?symbol={etf}&token={api}")) {
            let c = q["c"].as_f64().unwrap_or(0.0);
            let pc = q["pc"].as_f64().unwrap_or(0.0);
            if c > 0.0 && pc > 0.0 {
                return json!({"label": label, "price": c, "changePercent": round2((c - pc) / pc * 100.0)});
            }
        }
        mock_index(label)
    }).collect();

    Ok(json!({"stocks": stocks, "indices": indices}))
}

fn mock_index(label: &str) -> Value {
    match label {
        "S&P 500" => json!({"label":"S&P 500","price":6284,"changePercent":0.6}),
        "Nasdaq" => json!({"label":"Nasdaq","price":20910,"changePercent":0.8}),
        _ => json!({"label":"Dow","price":44120,"changePercent":-0.1}),
    }
}
fn mock_indices() -> Vec<Value> {
    vec![mock_index("S&P 500"), mock_index("Nasdaq"), mock_index("Dow")]
}

// ---------------------------------------------------------------------------
// News (NewsAPI)
// ---------------------------------------------------------------------------
fn time_ago(iso: &str) -> String {
    match chrono::DateTime::parse_from_rfc3339(iso) {
        Ok(t) => {
            let hours = Utc::now().signed_duration_since(t.with_timezone(&Utc)).num_hours();
            if hours < 1 { "Just now".into() }
            else if hours < 24 { format!("{hours}h ago") }
            else { let d = hours / 24; if d == 1 { "Yesterday".into() } else { format!("{d}d ago") } }
        }
        Err(_) => String::new(),
    }
}

fn mock_news() -> Value {
    json!({"articles": [
        {"id":"1","title":"AI Breakthrough: New Language Models Show Human-Level Reasoning","source":"TechCrunch","time":"2h ago","url":"https://techcrunch.com","trending":true,"category":"Technology"},
        {"id":"2","title":"Global Markets Rally on Positive Economic Data","source":"Bloomberg","time":"4h ago","url":"https://bloomberg.com","trending":true,"category":"Finance"},
        {"id":"3","title":"Space Agency Announces New Moon Mission Timeline","source":"Reuters","time":"6h ago","url":"https://reuters.com","trending":false,"category":"Science"},
        {"id":"4","title":"Climate Summit Reaches Historic Agreement on Emissions","source":"BBC","time":"8h ago","url":"https://bbc.com","trending":true,"category":"World"}
    ]})
}

/// NewsAPI's `top-headlines` categories — the only values its `category`
/// parameter takes. Anything else from the webview is not a category.
const NEWS_CATEGORIES: [&str; 7] = ["business", "entertainment", "general", "health", "science", "sports", "technology"];
/// Briefing topics per fetch. `top-headlines` takes ONE category or one `q`
/// per request, so every topic is a request; the webview stretches its poll
/// interval by the same count so the key's daily quota is spent at the rate
/// one topic always spent it.
const MAX_TOPICS: usize = 4;

/// A Briefing topic: one of the seven categories, or a keyword the user typed
/// (letters, digits, spaces and a little punctuation, 2–40 characters).
#[derive(Debug, PartialEq)]
enum Topic {
    Category(&'static str),
    Keyword(String),
}

fn parse_topic(raw: &str) -> Option<Topic> {
    let t = raw.trim();
    let lower = t.to_lowercase();
    if let Some(c) = NEWS_CATEGORIES.iter().find(|c| **c == lower) {
        return Some(Topic::Category(c));
    }
    let n = t.chars().count();
    let ok = (2..=40).contains(&n)
        && t.chars().all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '&' | '.' | '\''));
    ok.then(|| Topic::Keyword(t.to_string()))
}

fn capitalise(s: &str) -> String {
    let mut c = s.chars();
    c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
}

/// One article in the shape the webview's `NewsItem` reads.
fn article_json(a: &Value, label: &str) -> Value {
    json!({
        "title": a["title"].clone(),
        "description": a["description"].as_str().unwrap_or(""),
        "source": a["source"]["name"].as_str().unwrap_or("Unknown"),
        "time": time_ago(a["publishedAt"].as_str().unwrap_or("")),
        "url": a["url"].clone(),
        "category": label,
    })
}

/// The Briefing's chosen topics: one `top-headlines` request each, merged
/// round-robin so every topic leads somewhere in the first screen, the same
/// story reached by two topics shown once. A topic whose request fails is
/// skipped; when every one fails the error goes back (redacted), so the card
/// keeps its last headlines and says it is offline instead of swapping in
/// the sample.
fn fetch_topics(api: &str, topics: &[Topic]) -> Result<Value, String> {
    let mut lists: Vec<(String, Vec<Value>)> = Vec::new();
    let mut last_err: Option<String> = None;
    for topic in topics {
        let base = crate::http::agent()
            .get("https://newsapi.org/v2/top-headlines")
            .query("pageSize", "5")
            .query("apiKey", api);
        let (req, label) = match topic {
            Topic::Category(c) => (base.query("country", "us").query("category", c), capitalise(c)),
            Topic::Keyword(k) => (base.query("q", k).query("language", "en"), k.clone()),
        };
        // safe_err: `apiKey` is on this URL too.
        match req.call().map_err(safe_err).and_then(|r| r.into_json::<Value>().map_err(|e| e.to_string())) {
            Ok(data) => {
                let items = data["articles"].as_array().map(|arr| arr.iter().map(|a| article_json(a, &label)).collect()).unwrap_or_default();
                lists.push((label, items));
            }
            Err(e) => last_err = Some(e),
        }
    }
    if lists.is_empty() {
        return Err(last_err.unwrap_or_else(|| "no topic answered".into()));
    }
    let mut seen = std::collections::HashSet::new();
    let mut merged: Vec<Value> = Vec::new();
    let longest = lists.iter().map(|(_, l)| l.len()).max().unwrap_or(0);
    for i in 0..longest {
        for (_, list) in &lists {
            if let Some(a) = list.get(i) {
                let key = a["url"].as_str().map(str::to_string).unwrap_or_else(|| a["title"].to_string());
                if seen.insert(key) { merged.push(a.clone()); }
            }
        }
    }
    let articles: Vec<Value> = merged.into_iter().take(12).enumerate().map(|(i, mut a)| {
        a["id"] = json!((i + 1).to_string());
        // The first story of each topic leads its row, as the single-topic
        // fetch marks its first two.
        a["trending"] = json!(i < lists.len().min(2));
        a
    }).collect();
    Ok(json!({"articles": articles}))
}

#[tauri::command(async)]
pub fn fetch_news(category: Option<String>, topics: Option<Vec<String>>) -> Result<Value, String> {
    let Some(api) = core_key("news_api_key") else { return Ok(mock_news()) };
    let chosen: Vec<Topic> = topics.unwrap_or_default().iter().filter_map(|t| parse_topic(t)).take(MAX_TOPICS).collect();
    if !chosen.is_empty() {
        return fetch_topics(&api, &chosen);
    }
    // The webview's category goes into a URL, so only a real category does.
    let category = category
        .map(|c| c.trim().to_lowercase())
        .filter(|c| NEWS_CATEGORIES.contains(&c.as_str()))
        .unwrap_or_else(|| "general".to_string());

    let url = format!("https://newsapi.org/v2/top-headlines?country=us&category={category}&pageSize=5&apiKey={api}");
    let data = match get_json(&url) {
        Ok(d) => d,
        Err(_) => return Ok(mock_news()), // edge fn also fell back to mock on error
    };
    let cap = { let mut c = category.chars(); c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or(category.clone()) };
    let articles: Vec<Value> = data["articles"].as_array().map(|arr| {
        arr.iter().enumerate().map(|(i, a)| json!({
            "id": (i + 1).to_string(),
            "title": a["title"].clone(),
            "description": a["description"].as_str().unwrap_or(""),
            "source": a["source"]["name"].as_str().unwrap_or("Unknown"),
            "time": time_ago(a["publishedAt"].as_str().unwrap_or("")),
            "url": a["url"].clone(),
            "trending": i < 2,
            "category": cap,
        })).collect()
    }).unwrap_or_default();

    Ok(json!({"articles": articles}))
}

// ---------------------------------------------------------------------------
// Weather location (OpenWeather geocoding, same key)
// ---------------------------------------------------------------------------

/// What the place search accepts: a place name as a person types it.
fn valid_place_query(q: &str) -> Result<&str, String> {
    let q = q.trim();
    let n = q.chars().count();
    if n < 2 || n > 100 || q.chars().any(|c| c.is_control()) {
        return Err("Type a place name, 2 to 100 characters.".into());
    }
    Ok(q)
}

/// The Weather screen's place search. Sends only the typed text (and the key)
/// to OpenWeather's geocoding endpoint and returns up to five matches with
/// their coordinates; the webview stores the one picked on this Mac.
#[tauri::command(async)]
pub fn weather_geocode(query: String) -> Result<Value, String> {
    let q = valid_place_query(&query)?;
    let Some(api) = core_key("openweather_api_key") else {
        return Err("No OpenWeather key on this Mac. Add one in Settings to search for a place.".into());
    };
    let data = crate::http::agent()
        .get("https://api.openweathermap.org/geo/1.0/direct")
        .query("q", q)
        .query("limit", "5")
        .query("appid", &api)
        .call()
        // safe_err: `appid` is on this URL.
        .map_err(safe_err)?
        .into_json::<Value>()
        .map_err(|e| e.to_string())?;
    let places: Vec<Value> = data.as_array().map(|arr| {
        arr.iter().filter_map(|p| {
            let lat = p["lat"].as_f64()?;
            let lon = p["lon"].as_f64()?;
            let name = p["name"].as_str()?;
            Some(json!({
                "name": name,
                "country": p["country"].as_str().unwrap_or(""),
                "state": p["state"].as_str(),
                "lat": lat,
                "lon": lon,
            }))
        }).collect()
    }).unwrap_or_default();
    Ok(json!({"places": places}))
}

// ---------------------------------------------------------------------------
// Currency (Frankfurter — ECB reference rates, no key)
// ---------------------------------------------------------------------------

/// An ISO 4217 code as Frankfurter spells it: three ASCII capitals.
fn valid_currency(code: &str) -> Result<String, String> {
    let c = code.trim().to_uppercase();
    if c.len() == 3 && c.bytes().all(|b| b.is_ascii_uppercase()) {
        Ok(c)
    } else {
        Err(format!("{code:?} is not a currency code"))
    }
}

/// The Currency widget's reading: today's ECB reference rate from `base` to
/// `quote`, and the last month of daily rates for its line. Frankfurter needs
/// no key and receives only the two currency codes. The rates are the ECB's
/// once-a-day reference, published around 16:00 CET on working days, so
/// `date` is the day the rate is for, not when it was fetched.
#[tauri::command(async)]
pub fn fetch_fx(base: String, quote: String) -> Result<Value, String> {
    let base = valid_currency(&base)?;
    let quote = valid_currency(&quote)?;
    if base == quote {
        return Ok(json!({"base": base, "quote": quote, "date": Utc::now().format("%Y-%m-%d").to_string(), "rate": 1.0, "series": []}));
    }
    let latest = get_json(&format!("https://api.frankfurter.app/latest?from={base}&to={quote}"))?;
    let rate = latest["rates"][quote.as_str()].as_f64().ok_or("Frankfurter has no rate for that pair")?;
    let date = latest["date"].as_str().unwrap_or("").to_string();

    // The month's line is a nicety: a failure here keeps today's rate.
    let start = (Utc::now() - chrono::Duration::days(31)).format("%Y-%m-%d");
    let mut series: Vec<Value> = Vec::new();
    if let Ok(hist) = get_json(&format!("https://api.frankfurter.app/{start}..?from={base}&to={quote}")) {
        if let Some(days) = hist["rates"].as_object() {
            // The keys are ISO dates, so sorting them as text is date order —
            // whatever order the map happens to keep.
            let mut days: Vec<(&String, f64)> = days.iter().filter_map(|(d, r)| r[quote.as_str()].as_f64().map(|v| (d, v))).collect();
            days.sort_by(|a, b| a.0.cmp(b.0));
            series = days.into_iter().map(|(d, v)| json!({"date": d, "rate": v})).collect();
        }
    }
    Ok(json!({"base": base, "quote": quote, "date": date, "rate": rate, "series": series}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topics_are_categories_or_plain_keywords() {
        assert_eq!(parse_topic(" Technology "), Some(Topic::Category("technology")));
        assert_eq!(parse_topic("climate"), Some(Topic::Keyword("climate".into())));
        assert_eq!(parse_topic("AI & policy"), Some(Topic::Keyword("AI & policy".into())));
        assert_eq!(parse_topic("x"), None);
        assert_eq!(parse_topic("a=b&apiKey=1"), None);
        assert_eq!(parse_topic(&"a".repeat(41)), None);
    }

    #[test]
    fn currency_codes_and_place_queries_are_checked() {
        assert_eq!(valid_currency("eur").unwrap(), "EUR");
        assert!(valid_currency("EU").is_err());
        assert!(valid_currency("E1R").is_err());
        assert!(valid_currency("EUR&to=").is_err());
        assert_eq!(valid_place_query("  Aarhus ").unwrap(), "Aarhus");
        assert!(valid_place_query("a").is_err());
        assert!(valid_place_query("line\nbreak").is_err());
    }

    #[test]
    fn a_slice_carries_rain_chance_feel_and_wind() {
        let item = json!({"main": {"temp": 51.4, "feels_like": 47.6}, "weather": [{"icon": "10d"}], "pop": 0.62, "rain": {"3h": 1.23}, "wind": {"speed": 11.6}});
        let s = slice_json("3PM".into(), &item);
        assert_eq!(s["pop"], json!(62));
        assert_eq!(s["rain"], json!(1.2));
        assert_eq!(s["feelsLike"], json!(48));
        assert_eq!(s["wind"], json!(12));
        assert_eq!(s["icon"], json!("rainy"));
        // No rain block in the payload means none forecast, not unknown.
        let dry = slice_json("6PM".into(), &json!({"main": {"temp": 50}, "weather": [{"icon": "01d"}]}));
        assert_eq!(dry["rain"], json!(0.0));
        assert_eq!(dry["pop"], Value::Null);
    }

    #[test]
    fn air_keeps_unreported_pollutants_null() {
        let a = air_json(&json!({"main": {"aqi": 2}, "components": {"pm2_5": 6.1, "pm10": 12.0, "o3": 41.5}}));
        assert_eq!(a["aqi"], json!(2));
        assert_eq!(a["pm10"], json!(12.0));
        assert_eq!(a["no2"], Value::Null);
    }

    /// The regression test for the credential leak.
    ///
    /// Every provider here authenticates by query parameter, so the API key is
    /// part of the request URL — and ureq's Display prints that URL. Before
    /// `safe_err`, `.map_err(|e| e.to_string())` turned any provider failure
    /// into a string containing a live key, which `fetch_*` returns to the
    /// webview and the control port forwards to the AI brain verbatim.
    ///
    /// Uses a REAL ureq error rather than a hand-built one: loopback port 1
    /// refuses immediately, so this needs no network and cannot flake.
    #[test]
    fn safe_err_never_leaks_the_api_key_from_the_url() {
        let secret = "SUPERSECRET_PROVIDER_KEY";
        let url = format!("http://127.0.0.1:1/data/2.5/weather?appid={secret}&q=Copenhagen");
        let err = ureq::get(&url).call().expect_err("loopback port 1 must refuse");

        // Guard the guard. If ureq ever stops printing the URL, this test would
        // pass for the wrong reason — so first assert the raw Display DOES leak.
        let raw = err.to_string();
        assert!(
            raw.contains(secret),
            "ureq no longer prints the URL — re-check whether safe_err is still needed. Got: {raw}"
        );

        let redacted = safe_err(err);
        assert!(!redacted.contains(secret), "secret survived redaction: {redacted}");
        assert!(!redacted.contains("appid"), "query string survived redaction: {redacted}");
        assert!(!redacted.contains("127.0.0.1"), "host survived redaction: {redacted}");
        assert!(redacted.contains("unreachable"), "lost the diagnostic: {redacted}");
    }
}
