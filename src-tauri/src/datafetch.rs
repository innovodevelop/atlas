// Local data-fetch (Supabase-removal, Phase 5). Ports the get-weather /
// get-stocks / get-news edge functions to on-device Tauri commands: call the
// external API with `ureq`, keys from the Keychain (`atlas-core`), and fall back
// to the same mock data the edge functions used when a key is absent — so the
// dashboard behaves identically until real keys are in place. No auth hop, no
// cloud: the frontend shim routes functions.invoke('get-weather'|…) here.

use chrono::{Timelike, Utc};
use serde_json::{json, Value};

use crate::secrets::core_key;

fn get_json(url: &str) -> Result<Value, String> {
    ureq::get(url)
        .call()
        .map_err(|e| e.to_string())?
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

#[tauri::command]
pub fn fetch_weather(city: Option<String>, lat: Option<f64>, lon: Option<f64>) -> Result<Value, String> {
    let city = city.unwrap_or_else(|| "San Francisco".to_string());
    let Some(api) = core_key("openweather_api_key") else { return Ok(mock_weather(&city)) };

    let base = "https://api.openweathermap.org/data/2.5";
    // ureq's .query() percent-encodes the city (which may contain spaces/commas).
    let data = match (lat, lon) {
        (Some(la), Some(lo)) => get_json(&format!("{base}/weather?appid={api}&units=imperial&lat={la}&lon={lo}"))?,
        _ => ureq::get(&format!("{base}/weather"))
            .query("appid", &api)
            .query("units", "imperial")
            .query("q", &city)
            .call()
            .map_err(|e| e.to_string())?
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
                json!({"time":label,"temp":round(&item["main"]["temp"]),"icon":map_icon(item["weather"][0]["icon"].as_str().unwrap_or(""))})
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
            air = json!({"aqi": item["main"]["aqi"].as_i64().unwrap_or(0), "pm25": item["components"]["pm2_5"].as_f64().unwrap_or(0.0)});
        }
    }

    Ok(json!({
        "location": data["name"].as_str().unwrap_or(&city),
        "temp": round(&data["main"]["temp"]),
        "condition": data["weather"][0]["main"].as_str().unwrap_or("Clear"),
        "humidity": data["main"]["humidity"].as_i64().unwrap_or(0),
        "windSpeed": round(&data["wind"]["speed"]),
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

#[tauri::command]
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

#[tauri::command]
pub fn fetch_news(category: Option<String>) -> Result<Value, String> {
    let category = category.unwrap_or_else(|| "general".to_string());
    let Some(api) = core_key("news_api_key") else { return Ok(mock_news()) };

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
